import { Prisma } from '@workbench/workbench-db';
import { canonicalSha256,parseEmbeddingProfileV1,parseRetrievalProfileV1,type EmbeddingProfileV1,type RetrievalProfileV1,type JsonValue } from '@workbench/workbench-knowledge';
import { JiebaQuerySegmenterAdapter } from '../../src/modules/knowledge/jieba-query-segmenter.adapter.js';
export const integrationSegmenter=new JiebaQuerySegmenterAdapter();
export const segmenterIdentity=integrationSegmenter.identity;
export async function seedFixture(tx: Prisma.TransactionClient,releaseScope?:{workspaceId:string;version:number},productionDocument?:{path:string;content:string}) {
  const suffix =
    `${Date.now()}_${Math.random().toString(36).slice(2)}`.toLowerCase();
  const owner = await tx.principal.create({
    data: { issuer: `knowledge-${suffix}`, subject: `owner-${suffix}` },
  });
  const outsider = await tx.principal.create({
    data: { issuer: `knowledge-${suffix}`, subject: `outsider-${suffix}` },
  });
  await tx.knowledgeProfileOperatorEvent.create({
    data: {
      principalId: owner.id,
      action: "grant",
      authorizedBy: "knowledge-retrieval.postgres.fixture",
      changeReference: `knowledge-retrieval/${suffix}`,
    },
  });
  const workspace = await tx.workspace.create({
    data: {
      slug: `knowledge-${suffix}`,
      name: "Knowledge retrieval",
      createdById: owner.id,
    },
  });
  const outsiderWorkspace = await tx.workspace.create({
    data: {
      slug: `knowledge-outsider-${suffix}`,
      name: "Other workspace",
      createdById: outsider.id,
    },
  });
  await tx.workspaceMember.createMany({
    data: [
      { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
      {
        workspaceId: outsiderWorkspace.id,
        principalId: outsider.id,
        role: "owner",
      },
    ],
  });
  const project = await tx.project.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      title: "Knowledge project",
    },
  });
  const outsiderProject = await tx.project.create({
    data: {
      workspaceId: outsiderWorkspace.id,
      createdById: outsider.id,
      title: "Other project",
    },
  });
  await tx.projectMember.createMany({
    data: [
      {
        projectId: project.id,
        workspaceId: workspace.id,
        principalId: owner.id,
        role: "owner",
      },
      {
        projectId: outsiderProject.id,
        workspaceId: outsiderWorkspace.id,
        principalId: outsider.id,
        role: "owner",
      },
    ],
  });

  const profile = parseEmbeddingProfileV1(
    embeddingSpec(`knowledge-retrieval-${suffix}`),
  );
  await tx.embeddingProfile.create({
    data: {
      id: profile.spec.id,
      spec: profile.spec as unknown as Prisma.InputJsonValue,
      specSha256: profile.specSha256,
      dimension: profile.dimension,
    },
  });
  await tx.embeddingProfile.update({
    where: { id: profile.spec.id },
    data: { status: "poc" },
  });
  await tx.embeddingProfile.update({
    where: { id: profile.spec.id },
    data: { status: "adopted" },
  });
  await tx.knowledgeProfileAdoptionReceipt.create({
    data: {
      id: `embedding-adoption-${suffix}`,
      profileKind: "embedding",
      embeddingProfileId: profile.spec.id,
      embeddingProfileSpecSha256: profile.specSha256,
      actorPrincipalId: owner.id,
    },
  });
  const retrievalProfile = parseRetrievalProfileV1(
    retrievalSpec(
      `knowledge-retrieval-policy-${suffix}`,
      profile.spec.id,
      profile.specSha256,
      profile.dimension,
    ),
  );
  await tx.retrievalProfile.create({
    data: {
      id: retrievalProfile.spec.id,
      spec: retrievalProfile.spec as unknown as Prisma.InputJsonValue,
      specSha256: retrievalProfile.specSha256,
      embeddingProfileId: retrievalProfile.embeddingProfileId,
      embeddingProfileSpecSha256: retrievalProfile.embeddingProfileSpecSha256,
      embeddingDimension: retrievalProfile.embeddingDimension,
    },
  });
  await tx.retrievalProfile.update({
    where: { id: retrievalProfile.spec.id },
    data: { status: "poc" },
  });
  await tx.retrievalProfile.update({
    where: { id: retrievalProfile.spec.id },
    data: { status: "adopted" },
  });
  await tx.knowledgeProfileAdoptionReceipt.create({
    data: {
      id: `retrieval-adoption-${suffix}`,
      profileKind: "retrieval",
      retrievalProfileId: retrievalProfile.spec.id,
      retrievalProfileSpecSha256: retrievalProfile.specSha256,
      actorPrincipalId: owner.id,
    },
  });
  const manifest = {
    schema: "workbench.knowledge-release.v1",
    releaseKey: `knowledge-${suffix}`,
    profile: {
      embedding: { id: profile.spec.id, specSha256: profile.specSha256 },
      retrieval: {
        id: retrievalProfile.spec.id,
        specSha256: retrievalProfile.specSha256,
      },
      segmenter: {
        id: segmenterIdentity.implementationId,
        version: segmenterIdentity.version,
        dictionaryChecksum: segmenterIdentity.dictionarySha256,
        stopwordsChecksum: segmenterIdentity.stopwordsSha256,
      },
    },
  };
  const release = await tx.knowledgeRelease.create({
    data: {
      key: `knowledge-${suffix}`,
      workspaceId: releaseScope?.workspaceId??workspace.id,
      version: releaseScope?.version??1,
      embeddingProfileId: profile.spec.id,
      embeddingProfileSpecSha256: profile.specSha256,
      embeddingDimension: profile.dimension,
      retrievalProfileId: retrievalProfile.spec.id,
      retrievalProfileSpecSha256: retrievalProfile.specSha256,
      manifest: manifest as Prisma.InputJsonValue,
      manifestSha256: canonicalSha256(manifest as JsonValue),
    },
  });

  const documents = [
    {
      id: `kdoc_production_${suffix}`,
      path: productionDocument?.path??"00-rules/product.md",
      title: "产品规则",
      route: "production" as const,
    },
    {
      id: `kdoc_secondary_${suffix}`,
      path: "00-rules/design.md",
      title: "设计规范",
      route: "production" as const,
    },
    {
      id: `kdoc_source_${suffix}`,
      path: "07-sources/internal.md",
      title: "内部来源",
      route: "source_lookup" as const,
    },
  ];
  for (const document of documents) {
    await tx.knowledgeDocument.create({
      data: {
        id: document.id,
        releaseId: release.id,
        sourceKind: "vault_markdown",
        sourcePath: document.path,
        title: document.title,
        checksum: "a".repeat(64),
        route: document.route,
        metadata: { sourceLocator: `vault://knowledge-vault/${document.path}` },
      },
    });
  }
  const chunks = [
    {
      id: `kchunk_production_${suffix}`,
      documentId: documents[0]!.id,
      content: productionDocument?.content??"产品 工作台 用户 规则",
      vector: "[1,0,0]",
    },
    {
      id: `kchunk_secondary_${suffix}`,
      documentId: documents[1]!.id,
      content: "设计 系统 规范",
      vector: "[0.8,0.6,0]",
    },
    {
      id: `kchunk_source_${suffix}`,
      documentId: documents[2]!.id,
      content: "内部 来源 原始 资料",
      vector: "[1,0,0]",
    },
  ];
  for (const [sequence, chunk] of chunks.entries()) {
    await tx.knowledgeChunk.create({
      data: {
        id: chunk.id,
        documentId: chunk.documentId,
        releaseId: release.id,
        sequence,
        headingPath: ["规则"],
        content: chunk.content,
        tokenCount: 4,
      },
    });
    const searchText = integrationSegmenter.segment(chunk.content).join(" ");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "knowledge_chunks"
      SET "search_vector" = to_tsvector('simple', ${searchText})
      WHERE "id" = ${chunk.id}
    `);
  }
  const batchId = `kbatch_${suffix}`;
  await tx.knowledgeEmbeddingBatch.create({
    data: {
      id: batchId,
      releaseId: release.id,
      profileId: profile.spec.id,
      profileSpecSha256: profile.specSha256,
      dimension: profile.dimension,
      sequence: 0,
      chunkIds: chunks.map((chunk) => chunk.id),
      inputCount: chunks.length,
      inputSha256: "b".repeat(64),
    },
  });
  const startedAt = new Date();
  await tx.knowledgeEmbeddingBatch.update({
    where: { id: batchId },
    data: {
      status: "running",
      attemptCount: 1,
      leaseToken: `lease-${suffix}`,
      queueJobId: `job-${suffix}`,
      queueRetryCount: 0,
      startedAt,
    },
  });
  for (const chunk of chunks) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "knowledge_chunk_embeddings" (
        "chunk_id", "release_id", "profile_id", "profile_spec_sha256",
        "dimension", "embedding", "embedding_sha256"
      ) VALUES (
        ${chunk.id}, ${release.id}, ${profile.spec.id}, ${profile.specSha256},
        ${profile.dimension}, ${chunk.vector}::public.vector, ${"c".repeat(64)}
      )
    `);
  }
  await tx.knowledgeEmbeddingBatch.update({
    where: { id: batchId },
    data: {
      status: "ready",
      leaseToken: null,
      tokenCount: 12,
      outputSha256: "d".repeat(64),
      finishedAt: new Date(),
    },
  });
  await tx.knowledgeRelease.update({
    where: { id: release.id },
    data: { chunksReadyAt: new Date(), status: "ready", readyAt: new Date() },
  });

  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    outsiderId: outsider.id,
    projectId: project.id,
    outsiderProjectId: outsiderProject.id,
    releaseId: release.id,
    profileId: profile.spec.id,
    profileSpecSha256: profile.specSha256,
    retrievalProfileId: retrievalProfile.spec.id,
    retrievalProfileSpecSha256: retrievalProfile.specSha256,
    productionChunkId: chunks[0]!.id,
    secondaryChunkId: chunks[1]!.id,
    sourceLookupChunkId: chunks[2]!.id,
  };
}

export function embeddingSpec(id: string): EmbeddingProfileV1 {
  return {
    schema: "workbench.embedding-profile.v1",
    id,
    protocol: "tei.embed.v1",
    engine: {
      id: "huggingface/text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: {
      id: "integration/model",
      revision: "commit-r1",
      artifactSha256: "2".repeat(64),
    },
    tokenizer: {
      id: "integration/tokenizer",
      revision: "commit-r1",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 512,
      chunkMaximumTokens: 256,
      overflow: "reject",
    },
    input: {
      queryPrefix: "",
      documentPrefix: "",
      normalization: "utf8-nfc-lf-v1",
    },
    output: {
      dimension: 3,
      dtype: "float32",
      pooling: "cls",
      normalization: "l2",
      distance: "cosine",
    },
    batch: { maximumInputs: 32, maximumTokens: 8_192 },
    conformanceProbeSha256: "4".repeat(64),
  };
}

export function retrievalSpec(
  id: string,
  embeddingProfileId: string,
  embeddingProfileSpecSha256: string,
  embeddingDimension: number,
): RetrievalProfileV1 {
  return {
    schema: "workbench.retrieval-profile.v1",
    id,
    embedding: {
      profileId: embeddingProfileId,
      profileSpecSha256: embeddingProfileSpecSha256,
      dimension: embeddingDimension,
    },
    segmenter: {
      ...segmenterIdentity,
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: {
        algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1",
        limit: 40,
      },
      dense: { distance: "cosine", limit: 40 },
      fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
    },
    reranker: {
      protocol: "tei.rerank.v1",
      engine: {
        id: "huggingface/text-embeddings-inference",
        version: "1.8.3",
        imageDigest: `sha256:${"7".repeat(64)}`,
      },
      model: {
        id: "integration/reranker",
        revision: "commit-reranker-r1",
        artifactSha256: "8".repeat(64),
      },
      tokenizer: {
        id: "integration/reranker-tokenizer",
        revision: "commit-reranker-r1",
        artifactSha256: "9".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 24,
      finalResultLimit: 10,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "a".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
}
