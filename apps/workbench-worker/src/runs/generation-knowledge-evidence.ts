import { createHash } from "node:crypto";
import {
  canonicalJson,
  knowledgeToolResponseSchema,
  prdDocumentSchema,
  type RuntimeArtifactDraft,
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
    if (
      !parsed.success ||
      parsed.data.evidence.release.id !== scope.releaseId ||
      parsed.data.evidence.mode !== "hybrid" ||
      parsed.data.evidence.routeScope !== "production" ||
      createHash("sha256").update(canonicalJson(invocation.response)).digest("hex") !==
        invocation.responseSha256
    ) {
      throw new Error("KNOWLEDGE_RETRIEVAL_EVIDENCE_INVALID");
    }
    for (const item of parsed.data.items) citations.add(canonicalJson(item.citation));
  }
  if (!citations.size) throw new Error("KNOWLEDGE_RETRIEVAL_REQUIRED");
  for (const artifact of result.artifacts) {
    if (!artifact.citations.length) throw new Error("KNOWLEDGE_CITATION_REQUIRED");
    if (!artifact.citations.some((citation) => citations.has(canonicalJson(citation))))
      throw new Error("KNOWLEDGE_CITATION_CURRENT_REQUIRED");
    let retained: ReadonlySet<string> | undefined;
    for (const citation of artifact.citations) {
      const identity = canonicalJson(citation);
      if (!citations.has(identity)) {
        retained ??= await retainedPrdCitations(tx, scope.projectId, artifact);
        if (!retained.has(identity)) throw new Error("KNOWLEDGE_CITATION_NOT_RETRIEVED");
        continue;
      }
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

/** A fixed PRD is an authorized source, not a new retrieval receipt. Preserve
 * its exact citations only after checking the published source still belongs
 * to this workspace/project. New citations require the current attempt above. */
async function retainedPrdCitations(
  tx: Prisma.TransactionClient,
  projectId: string,
  artifact: RuntimeArtifactDraft,
): Promise<ReadonlySet<string>> {
  if (artifact.kind !== "prd" || artifact.operation.kind !== "revise") return new Set();
  const target = artifact.operation.target;
  const base = await tx.artifactVersion.findFirst({
    where: {
      id: target.artifactVersionId,
      artifactId: target.artifactId,
      projectId,
      status: "ready",
      schemaVersion: 3,
      artifact: { kind: "prd" },
    },
    select: { content: true, citations: true, contentBlobId: true },
  });
  const document = prdDocumentSchema.safeParse(base?.content);
  if (
    !base ||
    base.contentBlobId !== null ||
    !document.success ||
    canonicalJson(base.citations) !== canonicalJson(document.data.citations)
  )
    throw new Error("KNOWLEDGE_PRD_CITATION_BASE_INVALID");
  const project = await tx.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const retained = new Set<string>();
  for (const citation of document.data.citations) {
    const chunk = await tx.knowledgeChunk.findFirst({
      where: {
        id: citation.chunkId,
        documentId: citation.documentId,
        document: {
          sourcePath: citation.sourcePath,
          route: "production",
          release: {
            status: { in: ["ready", "retired"] },
            OR: [{ workspaceId: project.workspaceId }, { workspaceId: null }],
            AND: [{ OR: [{ projectId: null }, { projectId }] }],
          },
        },
      },
      select: { id: true, content: true },
    });
    if (!chunk || citation.quote !== [...chunk.content.trim()].slice(0, 2000).join(""))
      throw new Error("KNOWLEDGE_RETAINED_CITATION_SCOPE_INVALID");
    retained.add(canonicalJson(citation));
  }
  return retained;
}
