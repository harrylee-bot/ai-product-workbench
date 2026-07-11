import { Injectable, Logger } from "@nestjs/common";
import type { KnowledgeItem } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type EmbeddingSyncStats = {
  enabled: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
};

type ScorableKnowledgeItem = Pick<KnowledgeItem, "id" | "title" | "summary" | "content" | "tags" | "embedding">;
type EmbeddableKnowledgeItem = ScorableKnowledgeItem & Pick<KnowledgeItem, "updatedAt">;

/**
 * 真实向量嵌入（knowledge-core-3，已定决策）。
 *
 * 通过 OpenAI 兼容的 /embeddings 接口（EMBEDDING_API_BASE_URL / EMBEDDING_API_KEY /
 * EMBEDDING_MODEL）生成向量，存入 knowledge_items.embedding（Json 数组），检索时对查询向量
 * 与各知识向量做余弦相似度。
 *
 * 未配置 embedding 端点时 enabled=false，syncItem 跳过、scoreItems 返回空（检索降级为字面匹配），
 * 不再伪装 enabled:true。此前实现是本地字面 token 余弦，名实不符。
 */
@Injectable()
export class KnowledgeEmbeddingService {
  private readonly logger = new Logger(KnowledgeEmbeddingService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get config() {
    const baseUrl = process.env.EMBEDDING_API_BASE_URL?.trim();
    const apiKey = process.env.EMBEDDING_API_KEY?.trim();
    const model = process.env.EMBEDDING_MODEL?.trim();
    return { baseUrl, apiKey, model, enabled: Boolean(baseUrl && apiKey && model) };
  }

  emptyStats(): EmbeddingSyncStats {
    return {
      enabled: this.config.enabled,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** 调用 embedding 接口把文本转向量。失败返回 null。 */
  async embedText(text: string): Promise<number[] | null> {
    const { baseUrl, apiKey, model, enabled } = this.config;
    if (!enabled || !baseUrl || !apiKey || !model) return null;
    const input = text.trim().slice(0, 8000);
    if (!input) return null;
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(readEmbeddingTimeoutMs()),
      });
      if (!response.ok) {
        this.logger.warn(`embedding 请求失败：${response.status} ${response.statusText}`);
        return null;
      }
      const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = data.data?.[0]?.embedding;
      return isValidEmbeddingVector(vector) ? vector : null;
    } catch (error) {
      this.logger.warn(`embedding 调用异常：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async syncItem(item: EmbeddableKnowledgeItem): Promise<EmbeddingSyncStats> {
    const stats = this.emptyStats();
    if (!this.config.enabled) {
      stats.skipped = 1;
      return stats;
    }
    const text = [item.title, item.summary ?? "", item.content].filter(Boolean).join("\n\n");
    const vector = await this.embedText(text);
    if (!vector) {
      stats.failed = 1;
      return stats;
    }
    const update = await this.prisma.knowledgeItem.updateMany({
      where: {
        id: item.id,
        title: item.title,
        content: item.content,
        summary: item.summary,
        updatedAt: item.updatedAt,
      },
      data: { embedding: vector as unknown as never },
    });
    if (update.count === 0) stats.skipped = 1;
    else stats.updated = 1;
    return stats;
  }

  async scoreItems(query: string, items: ScorableKnowledgeItem[]): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    if (!this.config.enabled) return scores;
    const queryVector = await this.embedText(query);
    if (!queryVector || !queryVector.length) return scores;

    for (const item of items) {
      const itemVector = toNumberArray(item.embedding);
      if (!itemVector.length) continue; // 未生成嵌入的知识项跳过（降级为字面匹配）
      const score = cosineSimilarity(queryVector, itemVector);
      if (score > 0) scores.set(item.id, Number(score.toFixed(3)));
    }
    return scores;
  }
}

function readEmbeddingTimeoutMs() {
  const configured = Number(process.env.EMBEDDING_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 1_000) return 15_000;
  return Math.min(configured, 120_000);
}

function toNumberArray(value: unknown): number[] {
  return isValidEmbeddingVector(value) ? value : [];
}

function isValidEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const len = Math.min(left.length, right.length);
  if (!len) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < len; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
