import { Injectable } from "@nestjs/common";
import type { KnowledgeItem, Prisma } from "@prisma/client";

export type EmbeddingSyncStats = {
  enabled: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
};

type ScorableKnowledgeItem = Pick<KnowledgeItem, "id" | "title" | "summary" | "content" | "tags">;

@Injectable()
export class KnowledgeEmbeddingService {
  emptyStats(): EmbeddingSyncStats {
    return {
      enabled: true,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    };
  }

  async syncItem(_item: ScorableKnowledgeItem): Promise<EmbeddingSyncStats> {
    return {
      ...this.emptyStats(),
      skipped: 1,
    };
  }

  async scoreItems(query: string, items: ScorableKnowledgeItem[]): Promise<Map<string, number>> {
    const queryVector = buildWeightedVector(query);
    const scores = new Map<string, number>();

    if (!queryVector.size) return scores;

    for (const item of items) {
      const itemVector = mergeVectors(
        buildWeightedVector(item.title, 2.4),
        buildWeightedVector(item.summary ?? "", 1.8),
        buildWeightedVector(tagsToText(item.tags), 1.5),
        buildWeightedVector(item.content, 1),
      );
      const score = cosineSimilarity(queryVector, itemVector);
      if (score > 0) scores.set(item.id, Number(score.toFixed(3)));
    }

    return scores;
  }
}

function buildWeightedVector(text: string, weight = 1) {
  const vector = new Map<string, number>();
  for (const token of tokenize(text)) {
    vector.set(token, (vector.get(token) ?? 0) + weight);
  }
  return vector;
}

function mergeVectors(...vectors: Map<string, number>[]) {
  const merged = new Map<string, number>();
  for (const vector of vectors) {
    for (const [token, value] of vector.entries()) {
      merged.set(token, (merged.get(token) ?? 0) + value);
    }
  }
  return merged;
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>) {
  if (!left.size || !right.size) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [token, value] of left.entries()) dot += value * (right.get(token) ?? 0);

  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function tokenize(text: string) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const rawTokens = normalized.match(/[a-z0-9]{2,}|[\u4e00-\u9fa5]{2,}/gi) ?? [];
  const tokens: string[] = [];

  for (const token of rawTokens) {
    if (/^[a-z0-9]+$/i.test(token)) {
      tokens.push(token);
      continue;
    }
    tokens.push(token);
    for (let index = 0; index < token.length - 1; index += 1) {
      tokens.push(token.slice(index, index + 2));
    }
    for (let index = 0; index < token.length - 2 && index < 24; index += 1) {
      tokens.push(token.slice(index, index + 3));
    }
  }

  return [...new Set(tokens.filter((token) => token.length >= 2))].slice(0, 160);
}

function tagsToText(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join(" ");
}
