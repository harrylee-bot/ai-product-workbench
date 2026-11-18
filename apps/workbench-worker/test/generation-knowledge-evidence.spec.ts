import { createHash } from "node:crypto";
import { canonicalJson, type RuntimeResult } from "@workbench/workbench-contracts";
import { assertGenerationKnowledgeEvidence } from "../src/runs/generation-knowledge-evidence.js";
import { knowledgeCitationFixture as citation } from "./runtime-prd-result.fixture.js";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";

const scope = {
  runId: "run-1",
  runtimeAttemptId: "attempt-1",
  projectId: "project-1",
  principalId: "principal-1",
  releaseId: "release-1",
};
const response = {
  protocol: "workbench.knowledge-retrieval-result.v1",
  evidence: {
    schema: "workbench.knowledge-retrieval-evidence.v1",
    mode: "hybrid",
    routeScope: "production",
    release: { id: scope.releaseId, key: "vault", version: 1 },
    embeddingProfile: { id: "embedding", specSha256: "a".repeat(64), dimension: 3 },
    retrievalProfile: { id: "retrieval", specSha256: "b".repeat(64) },
    candidateCounts: { lexical: 1, dense: 1, fused: 1 },
    fusion: { algorithm: "rrf", k: 60 },
    reranker: { status: "not_needed" },
    degraded: false,
  },
  items: [{ rank: 1, rrfScore: 0.03, rerankerScore: null, citation }],
};
const result: RuntimeResult = {
  protocol: "workbench.runtime.result.v1",
  message: "Done",
  artifacts: [
    {
      kind: "document",
      schemaVersion: 1,
      title: "Notes",
      operation: { kind: "create" },
      content: { text: "Source facts" },
      citations: [citation],
    },
  ],
};
function harness(payload = response) {
  return {
    knowledgeRetrievalInvocation: {
      findMany: vi.fn().mockResolvedValue([
        {
          response: payload,
          responseSha256: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
        },
      ]),
    },
    knowledgeChunk: { findFirst: vi.fn().mockResolvedValue({ id: citation.chunkId }) },
  };
}

describe("Generation knowledge evidence", () => {
  it("requires a pinned release and current-attempt successful nonempty retrieval", async () => {
    const tx = harness();
    await expect(
      assertGenerationKnowledgeEvidence(tx as never, { ...scope, releaseId: null }, result),
    ).rejects.toThrow("KNOWLEDGE_RELEASE_REQUIRED");
    tx.knowledgeRetrievalInvocation.findMany.mockResolvedValue([]);
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).rejects.toThrow(
      "KNOWLEDGE_RETRIEVAL_REQUIRED",
    );
    await expect(
      assertGenerationKnowledgeEvidence(harness({ ...response, items: [] }) as never, scope, result),
    ).rejects.toThrow("KNOWLEDGE_RETRIEVAL_REQUIRED");
  });

  it("scopes evidence to principal, project, run, attempt and release", async () => {
    const tx = harness();
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).resolves.toBeUndefined();
    expect(tx.knowledgeRetrievalInvocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runtimeAttemptId: scope.runtimeAttemptId,
          status: "succeeded",
          lastGrant: {
            runtimeAttemptId: scope.runtimeAttemptId,
            runId: scope.runId,
            projectId: scope.projectId,
            principalId: scope.principalId,
            releaseId: scope.releaseId,
          },
        },
      }),
    );
    expect(tx.knowledgeChunk.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: citation.chunkId,
          documentId: citation.documentId,
          releaseId: scope.releaseId,
          document: { sourcePath: citation.sourcePath, route: "production" },
        },
      }),
    );
  });

  it("rejects empty, forged, altered and cross-release citations", async () => {
    for (const citations of [
      [],
      [{ ...citation, quote: "Invented" }],
      [{ ...citation, chunkId: "foreign" }],
    ]) {
      await expect(
        assertGenerationKnowledgeEvidence(harness() as never, scope, {
          ...result,
          artifacts: [{ ...result.artifacts[0]!, citations }],
        }),
      ).rejects.toThrow(/KNOWLEDGE_CITATION/u);
    }
    const tx = harness();
    tx.knowledgeChunk.findFirst.mockResolvedValue(null);
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).rejects.toThrow(
      "KNOWLEDGE_CITATION_SCOPE_INVALID",
    );
  });

  it("rejects tampered stored retrieval receipts", async () => {
    const tx = harness();
    tx.knowledgeRetrievalInvocation.findMany.mockResolvedValue([
      { response, responseSha256: "0".repeat(64) },
    ]);
    await expect(assertGenerationKnowledgeEvidence(tx as never, scope, result)).rejects.toThrow(
      "KNOWLEDGE_RETRIEVAL_EVIDENCE_INVALID",
    );
  });
  function revisionHarness() {
    const old = {
      ...citation,
      id: "old-citation",
      documentId: "old-document",
      chunkId: "old-chunk",
      quote: "Verified historical business facts",
    };
    const content = { ...structuredClone(prdDocumentV3Example), citations: [old] };
    const tx = {
      ...harness(),
      artifactVersion: {
        findFirst: vi.fn().mockResolvedValue({ content, citations: [old], contentBlobId: null }),
      },
      project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ workspaceId: "workspace-1" }) },
    };
    tx.knowledgeChunk.findFirst.mockImplementation(async ({ where }: { where: { releaseId?: string } }) =>
      where.releaseId ? { id: citation.chunkId } : { id: old.chunkId, content: old.quote },
    );
    const draft = {
      kind: "prd",
      schemaVersion: 3,
      title: "Revised requirements",
      operation: {
        kind: "revise",
        target: { artifactId: "prd-1", artifactVersionId: "prd-v1", screenIds: [] },
      },
      content: { ...content, citations: [old, citation] },
      citations: [old, citation],
    } as RuntimeResult["artifacts"][number];
    return { tx, old, draft, result: { ...result, artifacts: [draft] } };
  }
  it("inherits only exact fixed PRD citations while retaining current-attempt evidence", async () => {
    const h = revisionHarness();
    await expect(assertGenerationKnowledgeEvidence(h.tx as never, scope, h.result)).resolves.toBeUndefined();
    expect(h.tx.artifactVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "prd-v1",
          artifactId: "prd-1",
          projectId: scope.projectId,
          status: "ready",
          schemaVersion: 3,
          artifact: { kind: "prd" },
        },
      }),
    );
    expect(h.tx.knowledgeChunk.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: h.old.chunkId,
          documentId: h.old.documentId,
          document: {
            sourcePath: h.old.sourcePath,
            route: "production",
            release: {
              status: { in: ["ready", "retired"] },
              OR: [{ workspaceId: "workspace-1" }, { workspaceId: null }],
              AND: [{ OR: [{ projectId: null }, { projectId: scope.projectId }] }],
            },
          },
        },
      }),
    );
  });
  it("never substitutes a historical citation for this attempts actual retrieval", async () => {
    const h = revisionHarness();
    await expect(
      assertGenerationKnowledgeEvidence(h.tx as never, scope, {
        ...h.result,
        artifacts: [{ ...h.draft, citations: [h.old] }],
      }),
    ).rejects.toThrow("KNOWLEDGE_CITATION_CURRENT_REQUIRED");
  });
  it("rejects invented historical citations and inheritance on newly created artifacts", async () => {
    const h = revisionHarness();
    for (const draft of [
      { ...h.draft, citations: [citation, { ...h.old, quote: "Invented" }] },
      { ...h.draft, operation: { kind: "create" } },
    ])
      await expect(
        assertGenerationKnowledgeEvidence(h.tx as never, scope, { ...h.result, artifacts: [draft as never] }),
      ).rejects.toThrow("KNOWLEDGE_CITATION_NOT_RETRIEVED");
  });
  it("rejects historical references outside scope or whose quoted bytes differ from the published chunk", async () => {
    for (const row of [null, { id: "old-chunk", content: "Different actual facts" }]) {
      const h = revisionHarness();
      h.tx.knowledgeChunk.findFirst.mockImplementation(
        async ({ where }: { where: { releaseId?: string } }) =>
          where.releaseId ? { id: citation.chunkId } : (row as never),
      );
      await expect(assertGenerationKnowledgeEvidence(h.tx as never, scope, h.result)).rejects.toThrow(
        "KNOWLEDGE_RETAINED_CITATION_SCOPE_INVALID",
      );
    }
  });
  it("rejects mismatched fixed PRD citation metadata", async () => {
    const h = revisionHarness();
    h.tx.artifactVersion.findFirst.mockResolvedValue({
      content: h.draft.content,
      citations: [h.old],
      contentBlobId: null,
    });
    await expect(assertGenerationKnowledgeEvidence(h.tx as never, scope, h.result)).rejects.toThrow(
      "KNOWLEDGE_PRD_CITATION_BASE_INVALID",
    );
  });
});
