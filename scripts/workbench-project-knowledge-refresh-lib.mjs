import { randomUUID } from "node:crypto";
import { Prisma } from "@workbench/workbench-db";
import { canonicalSha256 } from "@workbench/workbench-knowledge";

export async function planProjectKnowledgeRefresh(db, input) {
  return db.$transaction(async (tx) => (await loadContext(tx, input)).plan, { isolationLevel: "RepeatableRead" });
}

export async function refreshProjectKnowledge(db, input, buildTools) {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedPlanSha256 ?? "")) throw new Error("KNOWLEDGE_REFRESH_PLAN_REQUIRED");
  const tools = buildTools ?? await import("../apps/workbench-file-worker/dist/knowledge/prisma-knowledge-build.store.js");
  // Keep the source hash helper behind the same injection boundary as the
  // build store.  Production CLI calls use the built File Worker modules by
  // default; tests can inject source implementations without requiring a
  // File Worker dist tree to exist in the CI workspace.
  const { embeddingVectorSha256 } = typeof tools.embeddingVectorSha256 === "function"
    ? tools
    : await import("../apps/workbench-file-worker/dist/knowledge/embedding-input.js");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`);
    await assertOwner(tx, input);
    const id = `krel_refresh_${input.expectedPlanSha256}`;
    const replay = await tx.knowledgeRelease.findUnique({ where: { id } });
    if (replay) {
      if (replay.projectId !== input.projectId || canonicalSha256(replay.manifest) !== replay.manifestSha256) throw new Error("KNOWLEDGE_REFRESH_REPLAY_INVALID");
      return { releaseId: replay.id, status: replay.status, created: false };
    }
    const context = await loadContext(tx, input);
    if (context.plan.planSha256 !== input.expectedPlanSha256) throw new Error("KNOWLEDGE_REFRESH_PLAN_STALE");
    if (await tx.knowledgeRelease.count({ where: { projectId: input.projectId, status: "building" } })) throw new Error("KNOWLEDGE_INGESTION_IN_PROGRESS");
    const { baseline, current, documents } = context;
    const key = `project:${input.projectId}`;
    const latest = await tx.knowledgeRelease.aggregate({ where: { key }, _max: { version: true } });
    const version = (latest._max.version ?? 0) + 1;
    const retainedPaths = new Set(documents.filter((doc) => doc.source).map((doc) => doc.sourcePath));
    const manifest = {
      ...baseline.manifest, releaseKey: key, releaseVersion: version,
      documents: [...baseline.manifest.documents, ...current.manifest.documents.filter((doc) => retainedPaths.has(doc.sourcePath))]
        .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
      issues: [...baseline.manifest.issues, ...current.manifest.issues.filter((issue) => retainedPaths.has(issue.sourceLocator))],
    };
    await tx.knowledgeRelease.create({ data: {
      id, key, version, projectId: input.projectId, workspaceId: context.project.workspaceId,
      parentReleaseId: current.id,
      embeddingProfileId: baseline.embeddingProfileId, embeddingProfileSpecSha256: baseline.embeddingProfileSpecSha256,
      embeddingDimension: baseline.embeddingDimension, retrievalProfileId: baseline.retrievalProfileId,
      retrievalProfileSpecSha256: baseline.retrievalProfileSpecSha256,
      manifest, manifestSha256: canonicalSha256(manifest),
    } });
    const facade = { $transaction: (callback) => callback(tx) };
    const store = new tools.PrismaKnowledgeBuildStore(facade);
    const started = await store.beginDelivery(id, { queueJobId: randomUUID(), retryCount: 0, retryLimit: 0 }, 1, 120_000);
    if (started.kind !== "run") throw new Error("KNOWLEDGE_REFRESH_START_FAILED");
    const command = started.command;
    const chunks = [];
    const vectors = new Map();
    for (const source of documents) {
      const documentId = `kdoc_${canonicalSha256([id, source.id])}`;
      const chunkIds = new Map(source.chunks.map((chunk) => [chunk.id, `kchunk_${canonicalSha256([id, chunk.id])}`]));
      const metadata = structuredClone(source.metadata);
      if (Array.isArray(metadata?.chunkIdentities)) metadata.chunkIdentities = metadata.chunkIdentities.map((item) => ({ ...item, databaseId: chunkIds.get(item.databaseId) ?? item.databaseId }));
      await tx.knowledgeDocument.create({ data: {
        id: documentId, releaseId: id, sourceKind: source.sourceKind, sourcePath: source.sourcePath,
        title: source.title, checksum: source.checksum, route: source.route, sourceBlobId: source.sourceBlobId, metadata,
      } });
      if (source.source) await tx.knowledgeDocumentSource.create({ data: {
        documentId, artifactVersionId: source.source.artifactVersionId, checksum: source.source.checksum,
      } });
      if (!source.chunks.length) continue;
      await tx.knowledgeChunk.createMany({ data: source.chunks.map((chunk) => ({
        id: chunkIds.get(chunk.id), documentId, releaseId: id, sequence: chunk.sequence,
        headingPath: chunk.headingPath, content: chunk.content, tokenCount: chunk.tokenCount,
      })) });
      const inherited = await tx.$queryRaw(Prisma.sql`
        SELECT embedding.chunk_id AS id, embedding.embedding::TEXT AS vector, embedding.embedding_sha256 AS sha256
        FROM knowledge_chunk_embeddings embedding
        JOIN knowledge_chunks chunk ON chunk.id = embedding.chunk_id
        WHERE chunk.document_id = ${source.id}
          AND embedding.profile_id = ${baseline.embeddingProfileId}
          AND embedding.profile_spec_sha256 = ${baseline.embeddingProfileSpecSha256}
          AND embedding.dimension = ${baseline.embeddingDimension}
      `);
      if (inherited.length !== source.chunks.length) throw new Error("KNOWLEDGE_REFRESH_EMBEDDINGS_INCOMPLETE");
      for (const row of inherited) {
        const vector = JSON.parse(row.vector);
        if (embeddingVectorSha256(vector) !== row.sha256) throw new Error("KNOWLEDGE_REFRESH_EMBEDDING_CORRUPT");
        vectors.set(chunkIds.get(row.id), vector);
      }
      for (let offset = 0; offset < source.chunks.length; offset += 250) {
        const batch = source.chunks.slice(offset, offset + 250);
        await tx.$executeRaw(Prisma.sql`
          UPDATE knowledge_chunks target SET search_vector = source.search_vector
          FROM knowledge_chunks source,
            (VALUES ${Prisma.join(batch.map((chunk) => Prisma.sql`(${chunkIds.get(chunk.id)}, ${chunk.id})`))}) AS mapping(target_id, source_id)
          WHERE target.id = mapping.target_id AND source.id = mapping.source_id
        `);
        for (const chunk of batch) chunks.push({ id: chunkIds.get(chunk.id), content: chunk.content, tokenCount: chunk.tokenCount });
      }
    }
    const batches = tools.createBatches(command, chunks);
    if (batches.length) await tx.knowledgeEmbeddingBatch.createMany({ data: batches });
    await tx.knowledgeRelease.update({ where: { id }, data: { chunksReadyAt: new Date() } });
    for (;;) {
      const batch = await store.claimNextEmbeddingBatch(command);
      if (batch === null) break;
      if (typeof batch === "string") throw new Error("KNOWLEDGE_REFRESH_BATCH_FAILED");
      const result = { vectors: batch.inputs.map((input) => vectors.get(input.chunkId)), tokenCounts: batch.inputs.map(() => 0) };
      if (await store.publishEmbeddingBatch(command, batch, result) !== "published") throw new Error("KNOWLEDGE_REFRESH_BATCH_FAILED");
    }
    if (await store.finalize(command) !== "ready") throw new Error("KNOWLEDGE_REFRESH_PUBLISH_FAILED");
    return { releaseId: id, version, status: "ready", created: true, planSha256: context.plan.planSha256 };
  }, { maxWait: 10_000, timeout: 120_000 });
}

async function assertOwner(tx, input) {
  const member = await tx.projectMember.findUnique({ where: { projectId_principalId: { projectId: input.projectId, principalId: input.principalId } }, include: { principal: true, project: true } });
  if (member?.role !== "owner" || member.principal.status !== "active" || member.project.status !== "active") throw new Error("KNOWLEDGE_REFRESH_PROJECT_OWNER_REQUIRED");
  return member.project;
}

async function loadContext(tx, input) {
  const project = await assertOwner(tx, input);
  const include = { documents: { include: { chunks: { orderBy: { sequence: "asc" } }, source: true }, orderBy: { sourcePath: "asc" } } };
  const [current, baseline] = await Promise.all([
    tx.knowledgeRelease.findFirst({ where: { projectId: input.projectId, status: "ready" }, orderBy: { version: "desc" }, include }),
    tx.knowledgeRelease.findUnique({ where: { id: input.baselineReleaseId }, include }),
  ]);
  if (!current) throw new Error("KNOWLEDGE_REFRESH_PROJECT_SNAPSHOT_REQUIRED");
  if (!baseline || baseline.status !== "ready" || baseline.projectId !== null
    || (baseline.workspaceId !== null && baseline.workspaceId !== project.workspaceId)) throw new Error("KNOWLEDGE_REFRESH_BASELINE_SCOPE_INVALID");
  for (const release of [current, baseline]) if (canonicalSha256(release.manifest) !== release.manifestSha256) throw new Error("KNOWLEDGE_REFRESH_MANIFEST_CORRUPT");
  for (const key of ["embeddingProfileId", "embeddingProfileSpecSha256", "embeddingDimension", "retrievalProfileId", "retrievalProfileSpecSha256"]) {
    if (current[key] !== baseline[key]) throw new Error("KNOWLEDGE_REFRESH_PROFILE_CHANGE_REQUIRES_REBUILD");
  }
  const retained = current.documents.filter((doc) => doc.source);
  const active = await tx.artifactFinalization.findMany({ where: { projectId: project.id, status: "ingested", artifactVersionId: { in: retained.map((doc) => doc.source.artifactVersionId) } } });
  if (retained.some((doc) => !active.some((finalization) => finalization.artifactVersionId === doc.source.artifactVersionId && finalization.checksum === doc.source.checksum))) throw new Error("KNOWLEDGE_REFRESH_FINALIZATION_NOT_ACTIVE");
  if (retained.some((doc) => baseline.documents.some((base) => base.sourcePath === doc.sourcePath))) throw new Error("KNOWLEDGE_REFRESH_SOURCE_PATH_CONFLICT");
  const oldByPath = new Map(current.documents.filter((doc) => !doc.source).map((doc) => [doc.sourcePath, doc.checksum]));
  const newByPath = new Map(baseline.documents.map((doc) => [doc.sourcePath, doc.checksum]));
  const plan = {
    schema: "workbench.project-knowledge-refresh-plan.v1", projectId: project.id, principalId: input.principalId,
    currentReleaseId: current.id, currentManifestSha256: current.manifestSha256,
    baselineReleaseId: baseline.id, baselineManifestSha256: baseline.manifestSha256,
    added: [...newByPath.keys()].filter((path) => !oldByPath.has(path)).sort(),
    changed: [...newByPath.keys()].filter((path) => oldByPath.has(path) && oldByPath.get(path) !== newByPath.get(path)).sort(),
    removed: [...oldByPath.keys()].filter((path) => !newByPath.has(path)).sort(),
    retainedFinalizations: retained.map((doc) => ({ sourcePath: doc.sourcePath, artifactVersionId: doc.source.artifactVersionId, checksum: doc.source.checksum })),
  };
  return { project, current, baseline, documents: [...baseline.documents, ...retained], plan: { ...plan, planSha256: canonicalSha256(plan) } };
}
