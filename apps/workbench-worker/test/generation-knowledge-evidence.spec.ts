import { createHash } from "node:crypto";
import { canonicalJson, type RuntimeResult } from "@workbench/workbench-contracts";
import { assertGenerationKnowledgeEvidence } from "../src/runs/generation-knowledge-evidence.js";
import { knowledgeCitationFixture as citation } from "./runtime-prd-result.fixture.js";

const scope = { runId: "run-1", runtimeAttemptId: "attempt-1", projectId: "project-1", principalId: "principal-1", releaseId: "release-1" };
const response = {
  protocol: "workbench.knowledge-retrieval-result.v1",
  evidence: {
    schema: "workbench.knowledge-retrieval-evidence.v1", mode: "hybrid", routeScope: "production",
    release: { id: scope.releaseId, key: "vault", version: 1 },
    embeddingProfile: { id: "embedding", specSha256: "a".repeat(64), dimension: 3 },
    retrievalProfile: { id: "retrieval", specSha256: "b".repeat(64) },
    candidateCounts: { lexical: 1, dense: 1, fused: 1 }, fusion: { algorithm: "rrf", k: 60 },
    reranker: { status: "not_needed" }, degraded: false,
  },
  items: [{ rank: 1, rrfScore: 0.03, rerankerScore: null, citation }],
};
const result: RuntimeResult = {
  protocol: "workbench.runtime.result.v1", message: "Done",
  artifacts: [{ kind: "document", schemaVersion: 1, title: "Notes", operation: { kind: "create" }, content: { text: "Source facts" }, citations: [citation] }],
};
function harness(payload = response) {
  return {
    knowledgeRetrievalInvocation: { findMany: vi.fn().mockResolvedValue([{
      response: payload, responseSha256: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    }]) },
    knowledgeChunk: { findFirst: vi.fn().mockResolvedValue({ id: citation.chunkId }) },
  };
}

describe("Generation knowledge evidence", () => {
  it("requires a pinned release and current-attempt successful nonempty retrieval", async () => {
    const tx = harness();
    await expect(assertGenerationKnowledgeEvidence(tx as never, { ...scope, releaseId: null }, result)).rejects.toThrow("KNOWLEDGE_RELEASE_REQUIRED");
    tx.knowledgeRetrievalInvocation.findMany.mockResolvedValue([]);
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).rejects.toThrow("KNOWLEDGE_RETRIEVAL_REQUIRED");
    await expect(assertGenerationKnowledgeEvidence(harness({ ...response, items: [] }) as never, scope, result)).rejects.toThrow("KNOWLEDGE_RETRIEVAL_REQUIRED");
  });

  it("scopes evidence to principal, project, run, attempt and release", async () => {
    const tx = harness();
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).resolves.toBeUndefined();
    expect(tx.knowledgeRetrievalInvocation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { runtimeAttemptId: scope.runtimeAttemptId, status: "succeeded", lastGrant: {
        runtimeAttemptId: scope.runtimeAttemptId, runId: scope.runId, projectId: scope.projectId,
        principalId: scope.principalId, releaseId: scope.releaseId,
      } },
    }));
    expect(tx.knowledgeChunk.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: citation.chunkId, documentId: citation.documentId, releaseId: scope.releaseId,
        document: { sourcePath: citation.sourcePath, route: "production" } },
    }));
  });

  it("rejects empty, forged, altered and cross-release citations", async () => {
    for (const citations of [[], [{ ...citation, quote: "Invented" }], [{ ...citation, chunkId: "foreign" }]]) {
      await expect(assertGenerationKnowledgeEvidence(harness() as never, scope, {
        ...result, artifacts: [{ ...result.artifacts[0]!, citations }],
      })).rejects.toThrow(/KNOWLEDGE_CITATION/u);
    }
    const tx = harness();
    tx.knowledgeChunk.findFirst.mockResolvedValue(null);
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).rejects.toThrow("KNOWLEDGE_CITATION_SCOPE_INVALID");
  });

  it("rejects tampered stored retrieval receipts", async () => {
    const tx = harness();
    tx.knowledgeRetrievalInvocation.findMany.mockResolvedValue([{ response, responseSha256: "0".repeat(64) }]);
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).rejects.toThrow("KNOWLEDGE_RETRIEVAL_EVIDENCE_INVALID");
  });
});
