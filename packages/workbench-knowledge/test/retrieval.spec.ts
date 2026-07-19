import {
  createKnowledgeCitation,
  reciprocalRankFusion,
  routesForKnowledgeScope,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("Knowledge retrieval contracts", () => {
  it("uses RRF without mixing provider scores and resolves ties deterministically", () => {
    const fused = reciprocalRankFusion(
      [{ id: "chunk_b" }, { id: "chunk_a" }, { id: "chunk_b" }],
      [{ id: "chunk_a" }, { id: "chunk_c" }],
      60,
    );

    expect(fused.map((candidate) => candidate.id)).toEqual(["chunk_a", "chunk_b", "chunk_c"]);
    expect(fused[0]).toMatchObject({ lexicalRank: 2, denseRank: 1, bestRank: 1 });
    expect(fused[1]).toMatchObject({ lexicalRank: 1, denseRank: null, bestRank: 1 });
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
  });

  it("uses lexical rank before the final stable id tie-breaker", () => {
    const fused = reciprocalRankFusion(
      [{ id: "chunk_b" }, { id: "chunk_a" }],
      [{ id: "chunk_a" }, { id: "chunk_b" }],
      60,
    );

    expect(fused.map((candidate) => candidate.id)).toEqual(["chunk_b", "chunk_a"]);
  });

  it("never admits source lookup content into the production route scope", () => {
    expect(routesForKnowledgeScope("production")).toEqual(["production"]);
    expect(routesForKnowledgeScope("source_lookup")).toEqual(["production", "source_lookup"]);
  });

  it("builds a stable citation locator without relying on mutable line numbers", () => {
    const input = {
      release: { id: "release_1", key: "vault", version: 3 },
      embeddingProfile: { id: "embedding-r1", specSha256: "a".repeat(64), dimension: 1_024 },
      documentId: "document_1",
      chunkId: "chunk_1",
      sourcePath: "00-rules/产品.md",
      title: "产品规则",
      route: "production" as const,
      headingPath: ["范围", "验收"],
      chunkSequence: 4,
      content: "引用正文",
    };

    const first = createKnowledgeCitation(input);
    const second = createKnowledgeCitation(input);
    expect(first).toEqual(second);
    expect(first.id).toMatch(/^knowledge_[0-9a-f]{64}$/u);
    expect(first.locator).toEqual({
      sourceLocator: "vault://knowledge-vault/00-rules/%E4%BA%A7%E5%93%81.md",
      headingPath: ["范围", "验收"],
      chunkSequence: 4,
    });
  });
});
