import { createHash } from "node:crypto";
import {
  canonicalJson,
  knowledgeToolResponseSchema,
  type RuntimeResult,
} from "@workbench/workbench-contracts";
import type { Prisma } from "@workbench/workbench-db";

export async function assertGenerationKnowledgeEvidence(
  tx: Prisma.TransactionClient,
  scope: {
    runId: string;
    runtimeAttemptId: string;
    projectId: string;
    principalId: string;
    releaseId: string | null;
  },
  result: RuntimeResult,
): Promise<void> {
  if (!scope.releaseId) throw new Error("KNOWLEDGE_RELEASE_REQUIRED");
  const invocations = await tx.knowledgeRetrievalInvocation.findMany({
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
    select: { response: true, responseSha256: true },
  });
  const citations = new Set<string>();
  for (const invocation of invocations) {
    const parsed = knowledgeToolResponseSchema.safeParse(invocation.response);
    if (!parsed.success
      || parsed.data.evidence.release.id !== scope.releaseId
      || parsed.data.evidence.mode !== "hybrid"
      || parsed.data.evidence.routeScope !== "production"
      || createHash("sha256").update(canonicalJson(invocation.response)).digest("hex") !== invocation.responseSha256) {
      throw new Error("KNOWLEDGE_RETRIEVAL_EVIDENCE_INVALID");
    }
    for (const item of parsed.data.items) citations.add(canonicalJson(item.citation));
  }
  if (!citations.size) throw new Error("KNOWLEDGE_RETRIEVAL_REQUIRED");
  for (const artifact of result.artifacts) {
    if (!artifact.citations.length) throw new Error("KNOWLEDGE_CITATION_REQUIRED");
    for (const citation of artifact.citations) {
      if (!citations.has(canonicalJson(citation))) throw new Error("KNOWLEDGE_CITATION_NOT_RETRIEVED");
      const chunk = await tx.knowledgeChunk.findFirst({
        where: {
          id: citation.chunkId,
          documentId: citation.documentId,
          releaseId: scope.releaseId,
          document: { sourcePath: citation.sourcePath, route: "production" },
        },
        select: { id: true },
      });
      if (!chunk) throw new Error("KNOWLEDGE_CITATION_SCOPE_INVALID");
    }
  }
}
