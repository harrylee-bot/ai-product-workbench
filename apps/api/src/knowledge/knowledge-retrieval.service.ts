import { Injectable } from "@nestjs/common";
import { KnowledgeStatus, KnowledgeType, Prisma } from "@prisma/client";
import { toInputJson } from "../ai/ai-vibe.helpers";
import { PrismaService } from "../prisma/prisma.service";
import { jsonArray } from "./knowledge-item.service";
import type {
  KnowledgeReference,
  KnowledgeRetrievalResult,
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
} from "./knowledge.types";

type KnowledgeItemRow = Prisma.KnowledgeItemGetPayload<{
  include: { category: true };
}>;

@Injectable()
export class KnowledgeRetrievalService {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchOutput> {
    const query = input.query.trim();
    const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);
    const preferredTypes = input.preferredTypes?.length
      ? [...new Set(input.preferredTypes)]
      : undefined;

    const items = await this.prisma.knowledgeItem.findMany({
      where: {
        status: KnowledgeStatus.active,
        ...(preferredTypes ? { type: { in: preferredTypes } } : {}),
        OR: [
          { scope: "global" },
          ...(input.projectId
            ? [{ scope: "project" as const, sourceProjectId: input.projectId }]
            : []),
        ],
      },
      include: { category: true },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    });

    const scored = items
      .map((item) => scoreItem(item, query, preferredTypes))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || priorityWeight(b.priority) - priorityWeight(a.priority))
      .slice(0, limit);

    await this.prisma.knowledgeRetrievalLog.create({
      data: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        runId: input.runId,
        agentName: input.agentName,
        query,
        taskType: input.taskType ? String(input.taskType) : undefined,
        matchedKnowledgeIds: toInputJson(scored.map((item) => item.itemId)),
        selectedKnowledgeIds: toInputJson(scored.slice(0, limit).map((item) => item.itemId)),
      },
    });

    return {
      results: scored,
      references: scored.map((item, index) => toReference(item, input.agentName, index)),
    };
  }
}

function scoreItem(
  item: KnowledgeItemRow,
  query: string,
  preferredTypes?: KnowledgeType[],
): KnowledgeRetrievalResult {
  const tokens = tokenize(query);
  const tags = jsonArray(item.tags);
  const fields = {
    title: normalizeText(item.title),
    summary: normalizeText(item.summary ?? ""),
    content: normalizeText(item.content),
    tags: normalizeText(tags.join(" ")),
    category: normalizeText(item.category?.name ?? ""),
    type: item.type,
  };

  const reasons: string[] = [];
  let score = 0;
  if (!tokens.length) {
    score += 0.1;
    reasons.push("无关键词时按最近活跃知识兜底");
  }

  for (const token of tokens) {
    if (fields.title.includes(token)) {
      score += fields.title === token ? 0.6 : 0.34;
      reasons.push(`标题匹配 ${token}`);
    }
    if (fields.tags.includes(token)) {
      score += 0.28;
      reasons.push(`标签匹配 ${token}`);
    }
    if (fields.summary.includes(token)) {
      score += 0.2;
      reasons.push(`摘要匹配 ${token}`);
    }
    if (fields.content.includes(token)) {
      score += 0.14;
      reasons.push(`正文匹配 ${token}`);
    }
    if (fields.category.includes(token)) {
      score += 0.12;
      reasons.push(`分类匹配 ${token}`);
    }
    if (fields.type.includes(token)) {
      score += 0.08;
      reasons.push(`类型匹配 ${token}`);
    }
  }

  if (preferredTypes?.includes(item.type)) {
    score += 0.16;
    reasons.push("符合 Agent 偏好类型");
  }
  score += priorityWeight(item.priority);
  if (item.priority === "high") reasons.push("高优先级知识");

  return {
    itemId: item.id,
    title: item.title,
    content: item.content,
    summary: item.summary ?? undefined,
    type: item.type,
    priority: item.priority,
    score: Number(Math.min(score, 1).toFixed(3)),
    reason: [...new Set(reasons)].slice(0, 5).join("；") || "按知识优先级命中",
  };
}

function toReference(
  result: KnowledgeRetrievalResult,
  usedByAgent: string | undefined,
  index: number,
): KnowledgeReference {
  return {
    id: `knowledge_ref_${result.itemId}_${index + 1}`,
    knowledgeId: result.itemId,
    title: result.title,
    snippet: result.summary || result.content.slice(0, 160),
    content: result.content,
    type: result.type,
    usedByAgent,
    sourceType: "knowledge_base",
    sourceId: result.itemId,
  };
}

function tokenize(query: string) {
  return normalizeText(query)
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 16);
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function priorityWeight(priority: KnowledgeRetrievalResult["priority"]) {
  if (priority === "high") return 0.15;
  if (priority === "medium") return 0.08;
  return 0.03;
}
