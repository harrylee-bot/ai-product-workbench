import { randomUUID } from "node:crypto";
import { knowledgeToolResponseSchema } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { canonicalSha256, parseEmbeddingProfileV1, parseRetrievalProfileV1 } from "@workbench/workbench-knowledge";
import { KnowledgeReleaseProcessor } from "../../apps/workbench-file-worker/src/knowledge/knowledge-release.processor.js";
import { PrismaKnowledgeBuildStore } from "../../apps/workbench-file-worker/src/knowledge/prisma-knowledge-build.store.js";
import {
  JiebaSegmenterAdapter, knowledgeDefaultDictionaryChecksum, knowledgeSegmenterId, knowledgeSegmenterVersion,
} from "../../apps/workbench-file-worker/src/knowledge/jieba-segmenter.adapter.js";
import { PrismaKnowledgeToolGrantIssuer } from "../../apps/workbench-worker/src/runtime/knowledge-tool-grant.service.js";

const segmenter = new JiebaSegmenterAdapter([]);
const segmenterPin = {
  id: knowledgeSegmenterId, version: knowledgeSegmenterVersion,
  dictionaryChecksum: knowledgeDefaultDictionaryChecksum, stopwordsChecksum: segmenter.stopwordsChecksum,
};
const sourcePath = "00-rules/test.md";

// Test-only synthetic embeddings, with the real release builder and database guards.
export async function seedReadyKnowledge(db: Prisma.TransactionClient): Promise<string> {
  const suffix = randomUUID();
  const operator = await db.principal.create({ data: { issuer: "knowledge-fixture", subject: suffix } });
  await db.knowledgeProfileOperatorEvent.create({ data: {
    principalId: operator.id, action: "grant", authorizedBy: "local-test", changeReference: suffix,
  } });
  const embedding = parseEmbeddingProfileV1({
    schema: "workbench.embedding-profile.v1", id: `fixture-embedding-${suffix}`, protocol: "tei.embed.v1",
    engine: { id: "huggingface/text-embeddings-inference", version: "1.8.3", imageDigest: `sha256:${"1".repeat(64)}` },
    model: { id: "test/model", revision: "test-revision", artifactSha256: "2".repeat(64) },
    tokenizer: { id: "test/tokenizer", revision: "test-revision", artifactSha256: "3".repeat(64), modelMaximumTokens: 512, chunkMaximumTokens: 256, overflow: "reject" },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 32, maximumTokens: 8192 }, conformanceProbeSha256: "4".repeat(64),
  });
  const retrieval = parseRetrievalProfileV1({
    schema: "workbench.retrieval-profile.v1", id: `fixture-retrieval-${suffix}`,
    embedding: { profileId: embedding.spec.id, profileSpecSha256: embedding.specSha256, dimension: 3 },
    segmenter: {
      implementationId: segmenterPin.id, version: segmenterPin.version, artifactSha256: segmenterPin.dictionaryChecksum,
      algorithm: "cut_for_search", hmm: false, dictionarySha256: segmenterPin.dictionaryChecksum,
      stopwordsSha256: segmenterPin.stopwordsChecksum, normalization: "utf8-nfc-lf-v1",
    },
    recall: { lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 }, dense: { distance: "cosine", limit: 40 }, fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" } },
    reranker: {
      protocol: "tei.rerank.v1", engine: { id: "huggingface/text-embeddings-inference", version: "1.8.3", imageDigest: `sha256:${"7".repeat(64)}` },
      model: { id: "test/reranker", revision: "test-revision", artifactSha256: "8".repeat(64) },
      tokenizer: { id: "test/reranker-tokenizer", revision: "test-revision", artifactSha256: "9".repeat(64), maximumInputTokens: 512, overflow: "reject" },
      candidateLimit: 24, finalResultLimit: 10, failurePolicy: "degrade_to_rrf", conformanceProbeSha256: "a".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1", citationSchema: "workbench.knowledge-citation.v1",
  });
  await db.embeddingProfile.create({ data: {
    id: embedding.spec.id, spec: embedding.spec as unknown as Prisma.InputJsonValue, specSha256: embedding.specSha256, dimension: 3,
  } });
  for (const status of ["poc", "adopted"] as const) await db.embeddingProfile.update({ where: { id: embedding.spec.id }, data: { status } });
  await db.knowledgeProfileAdoptionReceipt.create({ data: {
    profileKind: "embedding", embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, actorPrincipalId: operator.id,
  } });
  await db.retrievalProfile.create({ data: {
    id: retrieval.spec.id, spec: retrieval.spec as unknown as Prisma.InputJsonValue, specSha256: retrieval.specSha256,
    embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: 3,
  } });
  for (const status of ["poc", "adopted"] as const) await db.retrievalProfile.update({ where: { id: retrieval.spec.id }, data: { status } });
  await db.knowledgeProfileAdoptionReceipt.create({ data: {
    profileKind: "retrieval", retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256, actorPrincipalId: operator.id,
  } });
  const manifest = { schema: "workbench.knowledge-release.building.v1", profile: {
    embedding: { id: embedding.spec.id, specSha256: embedding.specSha256 },
    retrieval: { id: retrieval.spec.id, specSha256: retrieval.specSha256 },
  } };
  const release = await db.knowledgeRelease.create({ data: {
    key: `fixture-${suffix}`, version: 1,
    embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: 3,
    retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256,
    manifest, manifestSha256: canonicalSha256(manifest),
  } });
  const store = new PrismaKnowledgeBuildStore(transactionFacade(db));
  const processor = new KnowledgeReleaseProcessor(store, {
    readSnapshot: async () => ({
      sources: [{ path: sourcePath, content: "---\ntitle: Test knowledge\nstatus: \u5df2\u751f\u6548\ntags: []\naliases: []\n---\n\n# Rules\n\nSource facts for a generated artifact.\n" }],
      assets: [], storageDirectoryReferences: [],
    }),
  }, {
    count: (text: string) => text.length,
    split: ({ text }: { text: string }) => [{ text }],
    assertProfile: () => undefined,
  } as never, segmenter, { segmenter: segmenterPin }, {
    assertProfile: async () => undefined,
    embedDocuments: async (_profile, inputs) => ({ vectors: inputs.map(() => [1, 0, 0]), tokenCounts: inputs.map(() => 1) }),
  });
  const started = await store.beginDelivery(release.id, { queueJobId: randomUUID(), retryCount: 0, retryLimit: 5 }, 6, 60_000);
  if (started.kind !== "run" || await processor.build(started.command) !== "ready") throw new Error("TEST_KNOWLEDGE_BUILD_FAILED");
  return release.id;
}

export async function seedKnowledgeReceipt(db: Prisma.TransactionClient, runtimeAttemptId: string) {
  const attempt = await db.runtimeAttempt.findUniqueOrThrow({ where: { id: runtimeAttemptId }, include: { run: true } });
  const run = attempt.run;
  const release = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: run.knowledgeReleaseId! } });
  const chunk = await db.knowledgeChunk.findFirstOrThrow({ where: { releaseId: release.id }, include: { document: true } });
  const citation = {
    id: `citation-${chunk.id}`, documentId: chunk.documentId, chunkId: chunk.id,
    sourcePath: chunk.document.sourcePath, title: chunk.document.title, quote: chunk.content,
    locator: { heading: "Rules", startLine: null, endLine: null },
  };
  const response = knowledgeToolResponseSchema.parse({
    protocol: "workbench.knowledge-retrieval-result.v1",
    evidence: {
      schema: "workbench.knowledge-retrieval-evidence.v1", mode: "hybrid", routeScope: "production",
      release: { id: release.id, key: release.key, version: release.version },
      embeddingProfile: { id: release.embeddingProfileId, specSha256: release.embeddingProfileSpecSha256, dimension: release.embeddingDimension },
      retrievalProfile: { id: release.retrievalProfileId, specSha256: release.retrievalProfileSpecSha256 },
      candidateCounts: { lexical: 1, dense: 1, fused: 1 }, fusion: { algorithm: "rrf", k: 60 },
      reranker: { status: "not_needed" }, degraded: false,
    },
    items: [{ rank: 1, rrfScore: 0.03, rerankerScore: null, citation }],
  });
  const issuer = new PrismaKnowledgeToolGrantIssuer(transactionFacade(db), {
    endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve", secret: Buffer.alloc(32, 1), maximumTtlSeconds: 900,
  });
  await issuer.issue({ runId: run.id, runtimeAttemptId, principalId: run.createdById, projectId: run.projectId, releaseId: release.id });
  const grant = await db.knowledgeToolGrant.findFirstOrThrow({ where: { runtimeAttemptId } });
  const now = new Date();
  await db.knowledgeToolBudget.update({
    where: { runtimeAttemptId }, data: { windowStarts: { increment: 1 }, totalStarts: { increment: 1 } },
  });
  const invocation = await db.knowledgeRetrievalInvocation.create({ data: {
    id: randomUUID(), runtimeAttemptId, invocationId: randomUUID(), lastGrantId: grant.id, querySha256: canonicalSha256("Source facts"),
    status: "in_flight", attemptCount: 1, leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 60_000), lastStartedAt: now,
  } });
  await db.knowledgeRetrievalInvocation.update({ where: { id: invocation.id }, data: {
    status: "succeeded", response, responseSha256: canonicalSha256(response),
    leaseToken: null, leaseExpiresAt: null, finishedAt: new Date(),
  } });
  return [citation];
}

function transactionFacade(db: Prisma.TransactionClient) {
  return { $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) => callback(db) } as PrismaClient;
}
