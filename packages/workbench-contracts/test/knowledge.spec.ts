import { describe, expect, it } from "vitest";
import {
  createKnowledgeProfileRequestSchema,
  knowledgeProfileAdoptionReceiptSchema,
  knowledgeProfilePromotionResultSchema,
  promoteKnowledgeProfileRequestSchema,
  retireKnowledgeProfileRequestSchema,
  knowledgeToolDescriptorSchema,
  knowledgeToolReferenceSchema,
  knowledgeToolRequestSchema,
  knowledgeToolResponseSchema,
} from "../src/knowledge.js";

const citation = {
  id: "knowledge_abc",
  documentId: "document_1",
  chunkId: "chunk_1",
  sourcePath: "00-rules/product.md",
  title: "产品规则",
  quote: "产品工作台规则",
  locator: { heading: "规则", startLine: null, endLine: null },
};

const response = {
  protocol: "workbench.knowledge-retrieval-result.v1",
  evidence: {
    schema: "workbench.knowledge-retrieval-evidence.v1",
    mode: "hybrid",
    routeScope: "production",
    release: { id: "release_1", key: "vault", version: 1 },
    embeddingProfile: { id: "embedding-r1", specSha256: "a".repeat(64), dimension: 1_024 },
    retrievalProfile: { id: "retrieval-r1", specSha256: "b".repeat(64) },
    candidateCounts: { lexical: 1, dense: 1, fused: 1 },
    fusion: { algorithm: "rrf", k: 60 },
    reranker: { status: "applied", id: "reranker", revision: "commit-r1" },
    degraded: false,
  },
  items: [{ rank: 1, rrfScore: 0.03, rerankerScore: 0.9, citation }],
};

describe("Knowledge tool contracts", () => {
  it("accepts only the versioned production hybrid request and citation-ready result", () => {
    expect(knowledgeToolRequestSchema.parse({
      protocol: "workbench.knowledge-retrieval-request.v1",
      query: "  产品工作台  ",
    })).toEqual({ protocol: "workbench.knowledge-retrieval-request.v1", query: "产品工作台" });
    expect(knowledgeToolResponseSchema.safeParse(response).success).toBe(true);
    expect(knowledgeToolResponseSchema.safeParse({
      ...response,
      items: [response.items[0], { ...response.items[0], rank: 3 }],
    }).success).toBe(false);
  });

  it("rejects unsafe endpoints and malformed capability tokens", () => {
    const descriptor = {
      protocol: "workbench.knowledge-tool.v1",
      endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
      token: `wbkg1.${"a".repeat(64)}.${"b".repeat(43)}`,
      expiresAt: "2026-07-14T00:05:00.000Z",
      releaseId: "release_1",
      mode: "hybrid",
      routeScope: "production",
    };
    expect(knowledgeToolDescriptorSchema.safeParse(descriptor).success).toBe(true);
    expect(knowledgeToolDescriptorSchema.safeParse({
      ...descriptor,
      endpoint: "https://user:pass@workbench.test/retrieve#secret",
    }).success).toBe(false);
    expect(knowledgeToolDescriptorSchema.safeParse({ ...descriptor, token: "not-a-grant" }).success).toBe(false);
  });

  it("keeps the model-visible Knowledge tool reference free of endpoints and credentials", () => {
    const reference = knowledgeToolReferenceSchema.parse({
      protocol: "workbench.knowledge-tool-reference.v1",
      toolName: "workbench_knowledge_retrieve",
      releaseId: "release_1",
      mode: "hybrid",
      routeScope: "production",
    });
    expect(JSON.stringify(reference)).not.toMatch(/token|endpoint|expiresAt|wbkg1/u);
    expect(knowledgeToolReferenceSchema.safeParse({ ...reference, token: "secret" }).success).toBe(false);
  });

  it("keeps Profile lifecycle commands adjacent and returns a receipt only for adoption", () => {
    expect(createKnowledgeProfileRequestSchema.safeParse({
      kind: "embedding",
      spec: { schema: "workbench.embedding-profile.v1", id: "embedding-r1" },
    }).success).toBe(true);
    expect(promoteKnowledgeProfileRequestSchema.safeParse({
      expectedStatus: "candidate",
      targetStatus: "poc",
    }).success).toBe(true);
    expect(promoteKnowledgeProfileRequestSchema.safeParse({
      expectedStatus: "candidate",
      targetStatus: "adopted",
    }).success).toBe(false);
    expect(retireKnowledgeProfileRequestSchema.safeParse({ expectedStatus: "retired" }).success).toBe(false);

    const profile = {
      kind: "embedding" as const,
      id: "embedding-r1",
      profileVersion: 1 as const,
      specSha256: "a".repeat(64),
      status: "adopted" as const,
      scope: "global" as const,
      spec: { schema: "workbench.embedding-profile.v1", id: "embedding-r1" },
      dimension: 1_024,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
    };
    const adoptionReceipt = knowledgeProfileAdoptionReceiptSchema.parse({
      id: "adoption_1",
      profileKind: "embedding",
      profileId: profile.id,
      profileVersion: 1,
      profileSpecSha256: profile.specSha256,
      actorPrincipalId: "principal_1",
      scope: "global",
      adoptedAt: profile.updatedAt,
    });
    expect(knowledgeProfilePromotionResultSchema.safeParse({ profile, adoptionReceipt }).success).toBe(true);
    expect(knowledgeProfilePromotionResultSchema.safeParse({ profile, adoptionReceipt: null }).success).toBe(false);
    expect(knowledgeProfileAdoptionReceiptSchema.safeParse({ ...adoptionReceipt, deletedAt: profile.updatedAt }).success)
      .toBe(false);
  });
});
