import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { canonicalJson, canonicalSha256, parseEmbeddingProfileV1, parseRetrievalProfileV1, type JsonValue } from "@workbench/workbench-knowledge";
import { ArtifactFinalizationsService, artifactKnowledgeMarkdown, mapArtifactFinalization } from "../src/modules/artifacts/artifact-finalizations.service.js";
import { AccessService } from "../src/modules/access/access.service.js";
import { PrismaKnowledgeRetrievalStore } from "../src/modules/knowledge/prisma-knowledge-retrieval.store.js";
import { createBatches, PrismaKnowledgeBuildStore } from "../../workbench-file-worker/src/knowledge/prisma-knowledge-build.store.js";
import { KnowledgeReleaseProcessor } from "../../workbench-file-worker/src/knowledge/knowledge-release.processor.js";
import { JiebaSegmenterAdapter, knowledgeSegmenterId, knowledgeSegmenterVersion, knowledgeDefaultDictionaryChecksum } from "../../workbench-file-worker/src/knowledge/jieba-segmenter.adapter.js";
import { TerminalKnowledgeBuildError } from "../../workbench-file-worker/src/knowledge/knowledge.errors.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const segmenter = new JiebaSegmenterAdapter([]);
const segmenterPin = {
  id: knowledgeSegmenterId, version: knowledgeSegmenterVersion,
  dictionaryChecksum: knowledgeDefaultDictionaryChecksum, stopwordsChecksum: segmenter.stopwordsChecksum,
};

describe("Artifact knowledge conversion", () => {
  it("keeps source text and emits a valid project-local knowledge source", async () => {
    const { parseKnowledgeSource } = await import("@workbench/workbench-knowledge");
    const content = artifactKnowledgeMarkdown("Business v1", { text: "Confirmed business rules", assets: [{ storageKey: "private" }] });
    const document = parseKnowledgeSource({ path: "02-finalized/version.md", content });
    expect(document.route).toBe("production");
    expect(document.issues).toEqual([]);
    expect(content).toContain("Confirmed business rules");
    expect(content).not.toContain("private");
  });
});

describePostgres("Finalization and ingestion PostgreSQL lifecycle", () => {
  it("confirms once, publishes immutable descendants, retries failures and rolls back project knowledge", async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("LOCAL_TEST_DATABASE_REQUIRED");
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("test-queue-job") };
    try {
      const fixture = await seed(db);
      const service = new ArtifactFinalizationsService(db as never, new AccessService(db as never), queue as never);
      const store = new PrismaKnowledgeBuildStore(db);
      const reader = { readSnapshot: vi.fn(async () => ({
        sources: [{ path: "00-rules/base.md", content: artifactKnowledgeMarkdown("Base", { text: "Base rules stay immutable" }) }],
        assets: [], storageDirectoryReferences: [],
      })) };
      const processor = new KnowledgeReleaseProcessor(store, reader, {
        count: (text: string) => Math.max(1, Array.from(text).length),
        split: ({ text, maximumTokens }: { text: string; maximumTokens: number }) => {
          const points = Array.from(text);
          return Array.from({ length: Math.ceil(points.length / maximumTokens) }, (_, index) => ({
            text: points.slice(index * maximumTokens, (index + 1) * maximumTokens).join(""),
          }));
        },
        assertProfile: () => undefined,
      } as never, segmenter, { segmenter: segmenterPin }, {
        assertProfile: async () => undefined,
        embedDocuments: async (_profile, inputs) => ({
          vectors: inputs.map(() => [1, 0, 0]), tokenCounts: inputs.map(() => 1),
        }),
      });
      const build = async (releaseId: string) => {
        const started = await store.beginDelivery(releaseId, { queueJobId: randomUUID(), retryCount: 0, retryLimit: 5 }, 6, 60_000);
        expect(started.kind).toBe("run");
        if (started.kind !== "run") throw new Error("BUILD_NOT_STARTED");
        return processor.build(started.command);
      };
      const thread = await db.thread.create({ data: {
        projectId: fixture.projectId, createdById: fixture.principalId, title: "Generation guard",
      } });
      const runData = {
        projectId: fixture.projectId, threadId: thread.id, createdById: fixture.principalId,
        idempotencyKey: `guard-${randomUUID()}`, requestId: `request-${randomUUID()}`,
        requestHash: "a".repeat(64), modelId: "test-model", traceId: `trace-${randomUUID()}`,
        request: {
          prompt: "Generate from knowledge", modelId: "test-model", workflow: "generate",
          targetSurface: "web", designStyle: { kind: "automatic" }, sourceIds: [],
          artifactTargets: [], requestedArtifactKinds: ["document"],
        },
      };
      await expect(db.run.create({ data: runData })).rejects.toThrow(/KNOWLEDGE_RELEASE_REQUIRED/u);
      await expect(db.run.create({ data: { ...runData, knowledgeReleaseId: fixture.base.id } }))
        .rejects.toThrow(/RUN_KNOWLEDGE_SCOPE_INVALID/u);
      expect(await db.run.count({ where: { threadId: thread.id } })).toBe(0);
      expect(await build(fixture.base.id)).toBe("ready");
      const projectBaseline = await createProjectBaseline(db, fixture);
      expect(await build(projectBaseline.id)).toBe("ready");
      await expect(db.run.create({ data: {
        ...runData, knowledgeReleaseId: fixture.base.id, status: "succeeded",
        startedAt: new Date(), finishedAt: new Date(), progress: 1,
      } })).rejects.toThrow(/KNOWLEDGE_RETRIEVAL_REQUIRED/u);
      expect(await db.run.count({ where: { threadId: thread.id } })).toBe(0);
      const run = await db.run.create({ data: { ...runData, knowledgeReleaseId: fixture.base.id } });
      await expect(db.run.update({
        where: { id: run.id },
        data: { status: "succeeded", startedAt: new Date(), finishedAt: new Date(), progress: 1 },
      })).rejects.toThrow(/KNOWLEDGE_RETRIEVAL_REQUIRED/u);
      expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("queued");
      await expect(db.artifactVersion.create({ data: {
        artifactId: fixture.artifactId, projectId: fixture.projectId, version: 2, schemaVersion: 1,
        status: "ready", createdByRunId: run.id, knowledgeReleaseId: fixture.base.id,
        content: { text: "Unsupported" }, checksum: canonicalSha256({ text: "Unsupported" }), citations: [],
      } })).rejects.toThrow(/GENERATED_VERSION_KNOWLEDGE_REQUIRED/u);
      const base = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: fixture.base.id }, include: { documents: true } });
      queue.sendInTransaction.mockRejectedValueOnce(new Error("TEST_QUEUE_UNAVAILABLE"));
      await expect(service.confirm(fixture.principalId, fixture.artifactId, fixture.versionId, fixture.checksum))
        .rejects.toThrow("TEST_QUEUE_UNAVAILABLE");
      expect(await service.get(fixture.principalId, fixture.artifactId, fixture.versionId)).toBeNull();
      expect(await db.knowledgeIngestionJob.count({ where: { finalization: { projectId: fixture.projectId } } })).toBe(0);
      expect(await db.knowledgeRelease.count({ where: { projectId: fixture.projectId } })).toBe(1);
      queue.sendInTransaction.mockClear();
      const [confirmed, duplicate] = await Promise.all([
        service.confirm(fixture.principalId, fixture.artifactId, fixture.versionId, fixture.checksum),
        service.confirm(fixture.principalId, fixture.artifactId, fixture.versionId, fixture.checksum),
      ]);
      expect(duplicate.id).toBe(confirmed.id);
      expect(queue.sendInTransaction).toHaveBeenCalledTimes(1);
      expect(await db.knowledgeIngestionJob.count({ where: { finalizationId: confirmed.id } })).toBe(1);
      const child = confirmed.ingestionJob!.releases[0]!;
      const concurrent = await createDocument(db, fixture.projectId, "Concurrent confirmation");
      await expect(service.confirm(fixture.principalId, concurrent.artifactId, concurrent.id, concurrent.checksum))
        .rejects.toMatchObject({ response: expect.objectContaining({ detail: "KNOWLEDGE_INGESTION_IN_PROGRESS" }) });
      expect(await service.get(fixture.principalId, concurrent.artifactId, concurrent.id)).toBeNull();
      expect(queue.sendInTransaction).toHaveBeenCalledTimes(1);
      const stageChunks = vi.spyOn(store, "stageChunks");
      const finalizeChild = vi.spyOn(store, "finalize").mockResolvedValueOnce("busy");
      expect(await build(child.id)).toBe("busy");
      finalizeChild.mockRestore();
      const [childCommand, childBundle] = stageChunks.mock.calls[0]!;
      stageChunks.mockRestore();
      await expect(store.stageChunks(childCommand, childBundle)).resolves.toBe("staged");
      expect(await processor.build(childCommand)).toBe("ready");
      await expect(store.stageChunks(childCommand, childBundle)).resolves.toBe("ready");
      const changedManifest = {
        ...childBundle.manifest,
        documents: childBundle.manifest.documents.map((document) => ({ ...document, title: "Changed on replay" })),
      };
      await expect(store.stageChunks(childCommand, {
        ...childBundle,
        manifest: changedManifest,
        manifestCanonicalJson: canonicalJson(changedManifest as unknown as JsonValue),
        manifestChecksum: canonicalSha256(changedManifest as unknown as JsonValue),
      })).rejects.toThrow("KNOWLEDGE_RELEASE_REPLAY_CONFLICT");
      expect(reader.readSnapshot).toHaveBeenCalledTimes(2);
      const ingested = await service.get(fixture.principalId, fixture.artifactId, fixture.versionId);
      expect(mapArtifactFinalization(ingested)?.status).toBe("ingested");
      expect(ingested?.ingestionJob?.status).toBe("published");
      expect(await db.knowledgeDocument.count({ where: { releaseId: child.id } })).toBe(base.documents.length + 1);
      expect(await db.knowledgeDocumentSource.count({ where: { artifactVersionId: fixture.versionId } })).toBe(1);
      await expect(db.knowledgeDocumentSource.updateMany({
        where: { artifactVersionId: fixture.versionId }, data: { checksum: "0".repeat(64) },
      })).rejects.toThrow(/KNOWLEDGE_DOCUMENT_SOURCE_IMMUTABLE/u);
      await expect(db.knowledgeDocumentSource.deleteMany({
        where: { artifactVersionId: fixture.versionId },
      })).rejects.toThrow(/KNOWLEDGE_DOCUMENT_SOURCE_IMMUTABLE/u);
      expect((await db.knowledgeRelease.findUniqueOrThrow({ where: { id: base.id } })).manifestSha256).toBe(base.manifestSha256);
      const retrieval = new PrismaKnowledgeRetrievalStore(db);
      expect(await retrieval.findScopedRelease(child.id, fixture.workspaceId, fixture.projectId)).not.toBeNull();
      expect(await retrieval.findScopedRelease(child.id, fixture.workspaceId, "other-project")).toBeNull();
      const next = await createDocument(db, fixture.projectId, "Second confirmed version");
      const second = await service.confirm(fixture.principalId, next.artifactId, next.id, next.checksum);
      const failedId = second.ingestionJob!.releases[0]!.id;
      const started = await store.beginDelivery(failedId, { queueJobId: randomUUID(), retryCount: 0, retryLimit: 0 }, 6, 60_000);
      if (started.kind !== "run") throw new Error("BUILD_NOT_STARTED");
      await store.fail(started.command, new TerminalKnowledgeBuildError("TEST_EMBEDDING_FAILED", "Injected failure"));
      expect((await db.knowledgeRelease.findUniqueOrThrow({ where: { id: child.id } })).status).toBe("ready");
      const retried = await service.retry(fixture.principalId, next.artifactId, next.id);
      expect(retried.ingestionJob!.id).toBe(second.ingestionJob!.id);
      expect(retried.ingestionJob!.releases).toHaveLength(2);
      expect(retried.ingestionJob!.releases[0]!.id).not.toBe(failedId);
      expect(await build(retried.ingestionJob!.releases[0]!.id)).toBe("ready");
      const racingVersion = await createDocument(db, fixture.projectId, "Concurrent publication");
      const racing = await service.confirm(fixture.principalId, racingVersion.artifactId, racingVersion.id, racingVersion.checksum);
      const racingReleaseId = racing.ingestionJob!.releases[0]!.id;
      // Stage every chunk and embedding, pausing only the final ready transition.
      const finalize = vi.spyOn(store, "finalize").mockResolvedValueOnce("busy");
      expect(await build(racingReleaseId)).toBe("busy");
      finalize.mockRestore();
      const locked = deferred();
      const publish = deferred();
      const publishing = db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM knowledge_releases WHERE id = ${racingReleaseId} FOR UPDATE`);
        locked.resolve();
        await publish.promise;
        await tx.knowledgeRelease.update({
          where: { id: racingReleaseId }, data: { status: "ready", readyAt: new Date(), leaseToken: null, leaseExpiresAt: null },
        });
      }, { timeout: 15_000 });
      await locked.promise;
      const withdrawing = service.withdraw(fixture.principalId, fixture.artifactId, fixture.versionId);
      try {
        await expect.poll(async () => {
          const waiting = await db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%knowledge_releases%'
          `);
          return Number(waiting[0]?.count ?? 0);
        }, { timeout: 5_000 }).toBeGreaterThan(0);
      } finally {
        publish.resolve();
        await publishing;
      }
      const withdrawn = await withdrawing;
      expect(withdrawn.status).toBe("withdrawn");
      expect((await db.knowledgeRelease.findUniqueOrThrow({ where: { id: racingReleaseId } })).status).toBe("retired");
      expect((await db.knowledgeRelease.findMany({ where: { projectId: fixture.projectId, status: "ready" }, select: { id: true } })).map((release) => release.id)).toEqual([projectBaseline.id]);
      expect((await db.knowledgeRelease.findUniqueOrThrow({ where: { id: base.id } })).status).toBe("ready");
      await expect(service.retry(fixture.principalId, fixture.artifactId, fixture.versionId))
        .rejects.toMatchObject({ response: expect.objectContaining({ detail: "ARTIFACT_FINALIZATION_WITHDRAWN" }) });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);
});

describePostgres("Offline Knowledge bootstrap", () => {
  it("creates candidates without publication, adopts through receipts and safely replays", async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("LOCAL_TEST_DATABASE_REQUIRED");
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const modulePath = new URL("../../../scripts/workbench-knowledge-bootstrap-lib.mjs", import.meta.url).href;
    const { parseBootstrapProfiles, prepareKnowledgeBootstrap, adoptBootstrapProfiles } = await import(modulePath);
    try {
      const fixture = await seed(db);
      const suffix = randomUUID();
      const existingEmbedding = await db.embeddingProfile.findUniqueOrThrow({ where: { id: fixture.base.embeddingProfileId } });
      const existingRetrieval = await db.retrievalProfile.findUniqueOrThrow({ where: { id: fixture.base.retrievalProfileId } });
      const embeddingSpec = { ...(existingEmbedding.spec as Record<string, Prisma.JsonValue>), id: `bootstrap-embedding-${suffix}` };
      const retrievalSpec = { ...(existingRetrieval.spec as Record<string, Prisma.JsonValue>), id: `bootstrap-retrieval-${suffix}`, embedding: { profileId: embeddingSpec.id, profileSpecSha256: canonicalSha256(embeddingSpec), dimension: 3 } };
      const profiles = parseBootstrapProfiles(embeddingSpec, retrievalSpec);
      const username = `boot_${suffix.slice(0, 12)}`;
      const input = { profiles, account: { name: username, username, email: `${username}@example.test`, password: `Test-only-${suffix}` }, issuer: "http://localhost:3000", authorizedBy: "local-test", changeReference: `bootstrap-${suffix}` };
      const prepared = await prepareKnowledgeBootstrap(db, input);
      expect(prepared.accountCreated).toBe(true);
      expect(await db.embeddingProfile.findUniqueOrThrow({ where: { id: embeddingSpec.id } })).toMatchObject({ status: "candidate" });
      expect(await db.knowledgeProfileAdoptionReceipt.count({ where: { embeddingProfileId: embeddingSpec.id } })).toBe(0);
      expect(await db.knowledgeRelease.count({ where: { embeddingProfileId: embeddingSpec.id } })).toBe(0);
      // The CLI calls adoption only after its independently tested live conformance succeeds.
      await adoptBootstrapProfiles(db, prepared.principalId, profiles);
      expect(await db.embeddingProfile.findUniqueOrThrow({ where: { id: embeddingSpec.id } })).toMatchObject({ status: "adopted" });
      expect(await db.retrievalProfile.findUniqueOrThrow({ where: { id: retrievalSpec.id } })).toMatchObject({ status: "adopted" });
      expect(await db.knowledgeProfileAdoptionReceipt.count({ where: { actorPrincipalId: prepared.principalId } })).toBe(2);
      expect(await prepareKnowledgeBootstrap(db, input)).toMatchObject({ accountId: prepared.accountId, principalId: prepared.principalId, accountCreated: false });
      await adoptBootstrapProfiles(db, prepared.principalId, profiles);
      expect(await db.knowledgeProfileAdoptionReceipt.count({ where: { actorPrincipalId: prepared.principalId } })).toBe(2);
      await db.knowledgeProfileOperatorEvent.create({ data: { principalId: prepared.principalId, action: "revoke", authorizedBy: "local-test", changeReference: `revoke-${suffix}` } });
      await expect(adoptBootstrapProfiles(db, prepared.principalId, profiles)).rejects.toThrow("BOOTSTRAP_OPERATOR_NOT_GRANTED");
    } finally { await db.$disconnect(); }
  }, 30_000);
});

describePostgres("Project knowledge baseline refresh", () => {
  it("keeps fixed Run pins, retained finalizations and embedding evidence while advancing the baseline", async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.includes("test")) throw new Error("LOCAL_TEST_DATABASE_REQUIRED");
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    // Operator scripts import their built adapters in production; inject this source implementation for regression.
    const modulePath = new URL("../../../scripts/workbench-project-knowledge-refresh-lib.mjs", import.meta.url).href;
    const { planProjectKnowledgeRefresh, refreshProjectKnowledge } = await import(modulePath);
    try {
      const fixture = await seed(db);
      const service = new ArtifactFinalizationsService(db as never, new AccessService(db as never), { sendInTransaction: vi.fn().mockResolvedValue("test-job") } as never);
      const store = new PrismaKnowledgeBuildStore(db);
      const reader = { readSnapshot: vi.fn(async () => ({
        sources: [{ path: "00-rules/base.md", content: artifactKnowledgeMarkdown("Base", { text: "Baseline before revision" }) }],
        assets: [], storageDirectoryReferences: [],
      })) };
      const embedDocuments = vi.fn(async (_profile: unknown, inputs: readonly unknown[]) => ({ vectors: inputs.map(() => [1, 0, 0]), tokenCounts: inputs.map(() => 1) }));
      const processor = new KnowledgeReleaseProcessor(store, reader, {
        count: () => 1, split: ({ text }: { text: string }) => [{ text }], assertProfile: () => undefined,
      } as never, segmenter, { segmenter: segmenterPin }, { assertProfile: async () => undefined, embedDocuments });
      const build = async (releaseId: string) => {
        const started = await store.beginDelivery(releaseId, { queueJobId: randomUUID(), retryCount: 0, retryLimit: 5 }, 6, 60_000);
        if (started.kind !== "run") throw new Error("BUILD_NOT_STARTED");
        expect(await processor.build(started.command)).toBe("ready");
      };
      await build(fixture.base.id);
      const projectBaseline = await createProjectBaseline(db, fixture);
      await build(projectBaseline.id);
      embedDocuments.mockClear();
      const finalized = await service.confirm(fixture.principalId, fixture.artifactId, fixture.versionId, fixture.checksum);
      const snapshotId = finalized.ingestionJob!.releases[0]!.id;
      await build(snapshotId);
      expect(embedDocuments.mock.calls.flatMap((call) => call[1])).not.toEqual([]);
      expect(JSON.stringify(embedDocuments.mock.calls)).not.toContain("Baseline before revision");
      const snapshot = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: snapshotId } });
      const base = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: fixture.base.id } });
      const nextBase = await db.knowledgeRelease.create({ data: {
        key: base.key, version: 2, workspaceId: fixture.workspaceId,
        embeddingProfileId: base.embeddingProfileId, embeddingProfileSpecSha256: base.embeddingProfileSpecSha256, embeddingDimension: base.embeddingDimension,
        retrievalProfileId: base.retrievalProfileId, retrievalProfileSpecSha256: base.retrievalProfileSpecSha256,
        manifest: fixture.base.manifest as Prisma.InputJsonValue, manifestSha256: fixture.base.manifestSha256,
      } });
      reader.readSnapshot.mockResolvedValueOnce({ sources: [{ path: "00-rules/base.md", content: artifactKnowledgeMarkdown("Base", { text: "Baseline after revision" }) }], assets: [], storageDirectoryReferences: [] });
      await build(nextBase.id);
      const thread = await db.thread.create({ data: { projectId: fixture.projectId, createdById: fixture.principalId, title: "Pinned before refresh" } });
      const run = await db.run.create({ data: {
        projectId: fixture.projectId, threadId: thread.id, createdById: fixture.principalId, knowledgeReleaseId: snapshotId,
        idempotencyKey: randomUUID(), requestId: randomUUID(), requestHash: "b".repeat(64), modelId: "test-model", traceId: randomUUID(),
        request: { prompt: "Generate", modelId: "test-model", workflow: "generate", targetSurface: "web", designStyle: { kind: "automatic" }, sourceIds: [], artifactTargets: [], requestedArtifactKinds: ["document"] },
      } });
      const input = { projectId: fixture.projectId, principalId: fixture.principalId, baselineReleaseId: nextBase.id };
      await expect(planProjectKnowledgeRefresh(db, { ...input, principalId: "not-an-owner" })).rejects.toThrow("KNOWLEDGE_REFRESH_PROJECT_OWNER_REQUIRED");
      const plan = await planProjectKnowledgeRefresh(db, input);
      expect(plan.changed).toEqual(["00-rules/base.md"]);
      expect(plan.retainedFinalizations).toHaveLength(1);
      await expect(refreshProjectKnowledge(db, { ...input, expectedPlanSha256: "0".repeat(64) }, { PrismaKnowledgeBuildStore, createBatches })).rejects.toThrow("KNOWLEDGE_REFRESH_PLAN_STALE");
      const published = await refreshProjectKnowledge(db, { ...input, expectedPlanSha256: plan.planSha256 }, { PrismaKnowledgeBuildStore, createBatches });
      expect(published).toMatchObject({ status: "ready", created: true });
      expect(await refreshProjectKnowledge(db, { ...input, expectedPlanSha256: plan.planSha256 }, { PrismaKnowledgeBuildStore, createBatches })).toMatchObject({ releaseId: published.releaseId, created: false });
      const refreshed = await db.knowledgeRelease.findUniqueOrThrow({ where: { id: published.releaseId }, include: { documents: { include: { chunks: true, source: true } }, embeddingBatches: true } });
      expect(refreshed.parentReleaseId).toBe(snapshotId);
      expect(refreshed.documents).toHaveLength(2);
      expect(refreshed.documents.filter((doc) => doc.source)).toHaveLength(1);
      expect(refreshed.documents.flatMap((doc) => doc.chunks.map((chunk) => chunk.content)).join(" ")).toContain("Baseline after revision");
      expect(refreshed.embeddingBatches.every((batch) => batch.status === "ready")).toBe(true);
      expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).knowledgeReleaseId).toBe(snapshotId);
      expect((await db.knowledgeRelease.findUniqueOrThrow({ where: { id: snapshotId } })).manifestSha256).toBe(snapshot.manifestSha256);
      await service.withdraw(fixture.principalId, fixture.artifactId, fixture.versionId);
      expect((await db.knowledgeRelease.findUniqueOrThrow({ where: { id: published.releaseId } })).status).toBe("retired");
    } finally { await db.$disconnect(); }
  }, 60_000);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createDocument(db: PrismaClient, projectId: string, text: string) {
  const content = { text };
  const checksum = canonicalSha256(content);
  const artifact = await db.artifact.create({ data: { projectId, kind: "document", title: text } });
  const version = await db.artifactVersion.create({ data: {
    artifactId: artifact.id, projectId, version: 1, schemaVersion: 1, status: "ready", content, citations: [], checksum,
  } });
  await db.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
  return version;
}

async function createProjectBaseline(db: PrismaClient, fixture: Awaited<ReturnType<typeof seed>>) {
  // Scope the fixture before calling production's latest-release selection: other
  // concurrently running suites may publish newer global releases in this database.
  return db.knowledgeRelease.create({ data: {
    key: `project:${fixture.projectId}`, version: 1, projectId: fixture.projectId, workspaceId: fixture.workspaceId,
    parentReleaseId: fixture.base.id,
    embeddingProfileId: fixture.base.embeddingProfileId, embeddingProfileSpecSha256: fixture.base.embeddingProfileSpecSha256,
    embeddingDimension: fixture.base.embeddingDimension, retrievalProfileId: fixture.base.retrievalProfileId,
    retrievalProfileSpecSha256: fixture.base.retrievalProfileSpecSha256,
    manifest: fixture.base.manifest as Prisma.InputJsonValue, manifestSha256: fixture.base.manifestSha256,
  } });
}

async function seed(db: PrismaClient) {
  const suffix = randomUUID();
  const principalId = `principal-${suffix}`, workspaceId = `workspace-${suffix}`, projectId = `project-${suffix}`;
  const embedding = parseEmbeddingProfileV1({
    schema: "workbench.embedding-profile.v1", id: `embedding-${suffix}`, protocol: "tei.embed.v1",
    engine: { id: "huggingface/text-embeddings-inference", version: "1.8.3", imageDigest: `sha256:${"1".repeat(64)}` },
    model: { id: "test/model", revision: "commit-test", artifactSha256: "2".repeat(64) },
    tokenizer: { id: "test/tokenizer", revision: "commit-test", artifactSha256: "3".repeat(64), modelMaximumTokens: 512, chunkMaximumTokens: 256, overflow: "reject" },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 32, maximumTokens: 8192 }, conformanceProbeSha256: "4".repeat(64),
  });
  const retrieval = parseRetrievalProfileV1({
    schema: "workbench.retrieval-profile.v1", id: `retrieval-${suffix}`,
    embedding: { profileId: embedding.spec.id, profileSpecSha256: embedding.specSha256, dimension: 3 },
    segmenter: {
      implementationId: knowledgeSegmenterId, version: knowledgeSegmenterVersion, artifactSha256: knowledgeDefaultDictionaryChecksum,
      algorithm: "cut_for_search", hmm: false, dictionarySha256: knowledgeDefaultDictionaryChecksum,
      stopwordsSha256: segmenter.stopwordsChecksum, normalization: "utf8-nfc-lf-v1",
    },
    recall: { lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 }, dense: { distance: "cosine", limit: 40 }, fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" } },
    reranker: {
      protocol: "tei.rerank.v1", engine: { id: "huggingface/text-embeddings-inference", version: "1.8.3", imageDigest: `sha256:${"7".repeat(64)}` },
      model: { id: "test/reranker", revision: "commit-test", artifactSha256: "8".repeat(64) },
      tokenizer: { id: "test/reranker-tokenizer", revision: "commit-test", artifactSha256: "9".repeat(64), maximumInputTokens: 512, overflow: "reject" },
      candidateLimit: 24, finalResultLimit: 10, failurePolicy: "degrade_to_rrf", conformanceProbeSha256: "a".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1", citationSchema: "workbench.knowledge-citation.v1",
  });
  const base = await db.$transaction(async (tx) => {
    await tx.principal.create({ data: { id: principalId, issuer: "lifecycle-test", subject: suffix } });
    await tx.workspace.create({ data: { id: workspaceId, slug: suffix, name: "Test", createdById: principalId } });
    await tx.workspaceMember.create({ data: { workspaceId, principalId, role: "owner" } });
    await tx.project.create({ data: { id: projectId, workspaceId, createdById: principalId, title: "Test" } });
    await tx.projectMember.create({ data: { projectId, workspaceId, principalId, role: "owner" } });
    await tx.knowledgeProfileOperatorEvent.create({ data: { principalId, action: "grant", authorizedBy: "local-test", changeReference: suffix } });
    await tx.embeddingProfile.create({ data: { id: embedding.spec.id, spec: embedding.spec as unknown as Prisma.InputJsonValue, specSha256: embedding.specSha256, dimension: 3 } });
    for (const status of ["poc", "adopted"] as const) await tx.embeddingProfile.update({ where: { id: embedding.spec.id }, data: { status } });
    await tx.knowledgeProfileAdoptionReceipt.create({ data: { profileKind: "embedding", embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, actorPrincipalId: principalId } });
    await tx.retrievalProfile.create({ data: {
      id: retrieval.spec.id, spec: retrieval.spec as unknown as Prisma.InputJsonValue, specSha256: retrieval.specSha256,
      embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: 3,
    } });
    for (const status of ["poc", "adopted"] as const) await tx.retrievalProfile.update({ where: { id: retrieval.spec.id }, data: { status } });
    await tx.knowledgeProfileAdoptionReceipt.create({ data: { profileKind: "retrieval", retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256, actorPrincipalId: principalId } });
    const manifest = { schema: "workbench.knowledge-release.building.v1", profile: {
      embedding: { id: embedding.spec.id, specSha256: embedding.specSha256 }, retrieval: { id: retrieval.spec.id, specSha256: retrieval.specSha256 },
    } };
    return tx.knowledgeRelease.create({ data: {
      key: `base-${suffix}`, version: 1, workspaceId,
      embeddingProfileId: embedding.spec.id, embeddingProfileSpecSha256: embedding.specSha256, embeddingDimension: 3,
      retrievalProfileId: retrieval.spec.id, retrievalProfileSpecSha256: retrieval.specSha256,
      manifest, manifestSha256: canonicalSha256(manifest as JsonValue),
    } });
  });
  const version = await createDocument(db, projectId, "Confirmed business knowledge");
  return { principalId, workspaceId, projectId, base, artifactId: version.artifactId, versionId: version.id, checksum: version.checksum };
}
