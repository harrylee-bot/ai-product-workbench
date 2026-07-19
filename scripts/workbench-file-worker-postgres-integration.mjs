#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = testDatabaseUrl(process.env.WORKBENCH_TEST_DATABASE_URL);
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
const commandTimeoutMs = positiveInteger("WORKBENCH_FILE_INTEGRATION_COMMAND_TIMEOUT_MS", 180_000);
const maximumUploadByteSize = 25 * 1024 ** 2;
const maximumAttempts = 6;
const integrationDoclingImageDigest = "sha256:7e07522e0240c1db3ff5b837ffa969c2ecd5a71664c0e0369f5a69fc169e30ba";
const prefixes = {
  pending: "pending/blobs",
  canonical: "blobs",
  quarantine: "quarantine/blobs",
};

assertSchemaResetConfirmation(databaseName);
process.env.WORKBENCH_DATABASE_URL = databaseUrl;

let db;
async function main() {
  try {
    console.log(`[file-integration] target database: ${databaseName}`);
    await buildWorkspaces();
    await rebuildSchemas();
    await migrateDatabase();

    const { Prisma, PrismaClient } = await import("@workbench/workbench-db");
    const { fromPrisma, PgBoss } = await import("pg-boss");
    const { FileVerificationProcessor } = await importBuilt("verification/file-verification.processor.js");
    const { PrismaVerificationStore } = await importBuilt("verification/prisma-verification.store.js");
    const { VerificationDeliveryRunner } = await importBuilt("verification/verification-delivery.runner.js");
    const { FileExtractionProcessor } = await importBuilt("extraction/file-extraction.processor.js");
    const { PrismaExtractionStore } = await importBuilt("extraction/prisma-extraction.store.js");
    const { ExtractionDeliveryRunner } = await importBuilt("extraction/extraction-delivery.runner.js");
    const { RetryableExtractionError } = await importBuilt("extraction/extraction.errors.js");
    const { BlobGcProcessor } = await importBuilt("gc/blob-gc.processor.js");
    const { PrismaBlobGcStore } = await importBuilt("gc/prisma-blob-gc.store.js");
    const { PrismaKnowledgeBuildStore } = await importBuilt("knowledge/prisma-knowledge-build.store.js");
    const { KnowledgeDeliveryRunner } = await importBuilt("knowledge/knowledge-delivery.runner.js");
    const { KnowledgeReconciler } = await importBuilt("knowledge/knowledge-reconciler.js");
    const { KnowledgeReleaseProcessor } = await importBuilt("knowledge/knowledge-release.processor.js");
    const {
      JiebaSegmenterAdapter,
      knowledgeDefaultDictionaryChecksum,
      knowledgeSegmenterId,
      knowledgeSegmenterVersion,
    } = await importBuilt("knowledge/jieba-segmenter.adapter.js");
    const extractionContract = await import("@workbench/workbench-contracts");
    const knowledgeCore = await import("@workbench/workbench-knowledge");
    const { createOrQueueKnowledgeRelease } = await import("./workbench-knowledge-release-lib.mjs");
    integrationEmbeddingProfile.specSha256 = knowledgeCore.canonicalSha256(integrationEmbeddingProfile.spec);
    integrationRetrievalProfile.spec.embedding.profileSpecSha256 = integrationEmbeddingProfile.specSha256;
    integrationRetrievalProfile.spec.segmenter.implementationId = knowledgeSegmenterId;
    integrationRetrievalProfile.spec.segmenter.version = knowledgeSegmenterVersion;
    integrationRetrievalProfile.spec.segmenter.artifactSha256 = knowledgeDefaultDictionaryChecksum;
    integrationRetrievalProfile.spec.segmenter.dictionarySha256 = knowledgeDefaultDictionaryChecksum;
    integrationRetrievalProfile.spec.segmenter.stopwordsSha256 = new JiebaSegmenterAdapter().stopwordsChecksum;
    const parsedRetrievalProfile = knowledgeCore.parseRetrievalProfileV1(
      integrationRetrievalProfile.spec,
    );
    integrationRetrievalProfile.id = parsedRetrievalProfile.spec.id;
    integrationRetrievalProfile.spec = parsedRetrievalProfile.spec;
    integrationRetrievalProfile.specSha256 = parsedRetrievalProfile.specSha256;

    db = new PrismaClient();
    await db.$connect();
    await seedOwnership(db, knowledgeCore);

    const dependencies = {
      FileVerificationProcessor,
      PrismaVerificationStore,
      VerificationDeliveryRunner,
      FileExtractionProcessor,
      PrismaExtractionStore,
      ExtractionDeliveryRunner,
      RetryableExtractionError,
      BlobGcProcessor,
      PrismaBlobGcStore,
      extractionContract,
      collectKnowledgeStorageDeclarations: knowledgeCore.collectKnowledgeStorageDeclarations,
      canonicalSha256: knowledgeCore.canonicalSha256,
      knowledgeStorageMediaType: knowledgeCore.knowledgeStorageMediaType,
      PrismaKnowledgeBuildStore,
      KnowledgeDeliveryRunner,
      KnowledgeReconciler,
      KnowledgeReleaseProcessor,
      JiebaSegmenterAdapter,
      knowledgeDefaultDictionaryChecksum,
      knowledgeSegmenterId,
      knowledgeSegmenterVersion,
    };
    const blobGcLifecycle = await runBlobGcLifecycleScenario(db, dependencies);
    const blobGcReferences = await runBlobGcReferenceScenario(db, dependencies);
    const blobGcConcurrency = await runBlobGcConcurrentReferenceScenario(db, PrismaClient);
    const clean = await runCleanScenario(db, dependencies);
    const infected = await runInfectedScenario(db, dependencies);
    const exhausted = await runRetryExhaustionScenario(db, dependencies);
    const replay = await runCrashReplayScenario(db, dependencies);
    const extractionReady = await runExtractionReadyScenario(db, dependencies);
    const extractionReplay = await runExtractionTaskReplayScenario(db, dependencies);
    const extractionAmbiguous = await runExtractionAmbiguousSubmissionScenario(db, dependencies);
    const extractionPublishCrash = await runExtractionPublishCrashReplayScenario(db, dependencies);
    const knowledgeReady = await runKnowledgeReadyScenario(db, dependencies);
    const knowledgeConcurrent = await runKnowledgeConcurrentClaimScenario(db, dependencies);
    const knowledgeInvalidProfile = await runKnowledgeInvalidProfileScenario(db, dependencies);
    const knowledgeBatchRecovery = await runKnowledgeBatchRecoveryScenario(db, dependencies);
    const knowledgeReplay = await runKnowledgeCommitResponseLossScenario(db, dependencies);
    const knowledgeCorruption = await runKnowledgeManifestCorruptionScenario(db, dependencies);
    const knowledgeReconciliation = await runKnowledgeReconciliationScenario(db, dependencies);
    const knowledgeReleaseProducer = await runKnowledgeReleaseProducerScenario(db, {
      Prisma,
      PgBoss,
      createOrQueueKnowledgeRelease,
      extractionContract,
      fromPrisma,
    });

    console.log(JSON.stringify({
      ok: true,
      database: databaseName,
      scenarios: {
        blobGcLifecycle,
        blobGcReferences,
        blobGcConcurrency,
        clean,
        infected,
        exhausted,
        replay,
        extractionReady,
        extractionReplay,
        extractionAmbiguous,
        extractionPublishCrash,
        knowledgeReady,
        knowledgeConcurrent,
        knowledgeInvalidProfile,
        knowledgeBatchRecovery,
        knowledgeReplay,
        knowledgeCorruption,
        knowledgeReconciliation,
        knowledgeReleaseProducer,
      },
    }, null, 2));
  } catch (error) {
    console.error(
      "[file-integration] FAILED",
      formatErrorChain(error),
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect().catch(() => undefined);
  }
}

async function runKnowledgeReleaseProducerScenario(database, dependencies) {
  console.log("[file-integration] Knowledge release producer concurrency and atomic enqueue");
  const {
    assertKnowledgeReleaseBuildQueueConfiguration,
    knowledgeReleaseBuildQueue,
    knowledgeReleaseBuildQueueOptions,
  } = dependencies.extractionContract;
  const boss = new dependencies.PgBoss({
    connectionString: pgConnectionUrl(databaseUrl),
    schema: "workbench_jobs",
    application_name: "workbench-knowledge-release-integration",
    schedule: false,
    supervise: false,
    useListenNotify: false,
  });
  const lockIdentity = async (tx, identity) => {
    const lockKey = JSON.stringify([identity.key, identity.version]);
    await tx.$queryRaw(
      dependencies.Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::TEXT AS "lock_receipt"`,
    );
  };
  const enqueue = (tx, job, singletonKey) => boss.send(
    knowledgeReleaseBuildQueue,
    job,
    { singletonKey, db: dependencies.fromPrisma(tx) },
  );
  const options = {
    key: "producer-integration",
    version: 1,
    workspaceId: null,
    embeddingProfileId: integrationEmbeddingProfile.id,
    retrievalProfileId: integrationRetrievalProfile.id,
  };

  try {
    await boss.start();
    await boss.createQueue(knowledgeReleaseBuildQueue, knowledgeReleaseBuildQueueOptions);
    assertKnowledgeReleaseBuildQueueConfiguration(await boss.getQueue(knowledgeReleaseBuildQueue));

    const concurrent = await Promise.all([
      dependencies.createOrQueueKnowledgeRelease({ db: database, options, lockIdentity, enqueue }),
      dependencies.createOrQueueKnowledgeRelease({ db: database, options, lockIdentity, enqueue }),
    ]);
    const dispositions = concurrent.map((result) => result.queueDisposition).sort();
    assert.deepEqual(dispositions, ["already-queued", "created"]);
    assert.equal(concurrent[0].release.id, concurrent[1].release.id);
    assert.equal(await database.knowledgeRelease.count({
      where: { key: options.key, version: options.version },
    }), 1);

    const releaseId = concurrent[0].release.id;
    const queuedJobs = await boss.findJobs(knowledgeReleaseBuildQueue, { key: releaseId });
    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].state, "created");
    assert.deepEqual(queuedJobs[0].data, { releaseId });
    assert.equal(
      concurrent.find((result) => result.queueDisposition === "created")?.jobId,
      queuedJobs[0].id,
    );

    const rollbackOptions = { ...options, key: "producer-rollback-integration" };
    let rolledBackReleaseId = null;
    let rolledBackJobId = null;
    await assert.rejects(
      dependencies.createOrQueueKnowledgeRelease({
        db: database,
        options: rollbackOptions,
        lockIdentity,
        enqueue: async (tx, job, singletonKey) => {
          rolledBackReleaseId = singletonKey;
          rolledBackJobId = await enqueue(tx, job, singletonKey);
          assert.ok(rolledBackJobId);
          throw new Error("SIMULATED_RELEASE_ENQUEUE_ROLLBACK");
        },
      }),
      /SIMULATED_RELEASE_ENQUEUE_ROLLBACK/,
    );
    assert.ok(rolledBackReleaseId);
    assert.ok(rolledBackJobId);
    assert.equal(await database.knowledgeRelease.count({
      where: { key: rollbackOptions.key, version: rollbackOptions.version },
    }), 0);
    assert.deepEqual(
      await boss.findJobs(knowledgeReleaseBuildQueue, { id: rolledBackJobId }),
      [],
    );
    assert.deepEqual(
      await boss.findJobs(knowledgeReleaseBuildQueue, { key: rolledBackReleaseId }),
      [],
    );

    return {
      concurrentDispositions: dispositions,
      persistedReleases: 1,
      persistedJobs: queuedJobs.length,
      rollbackAtomic: true,
    };
  } finally {
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
  }
}

async function runBlobGcLifecycleScenario(database, dependencies) {
  console.log("[file-integration] Blob GC grace, bounded retry, and crash recovery");
  const bytes = Buffer.from("orphaned blob gc integration bytes", "utf8");
  const sha256 = digest(bytes);
  const storageKey = stableKey(prefixes.canonical, sha256, 1);
  const storage = new HighFidelityStorage();
  storage.put(storageKey, bytes, "application/octet-stream");
  await database.blob.create({
    data: {
      id: "blob-gc-lifecycle",
      sha256,
      generation: 1,
      storageKey,
      mediaType: "application/octet-stream",
      byteSize: BigInt(bytes.byteLength),
      status: "ready",
      verifiedAt: new Date("2026-07-15T00:00:00.000Z"),
    },
  });

  const store = new dependencies.PrismaBlobGcStore(database);
  const markedAt = new Date("2026-07-15T01:00:00.000Z");
  const eligibleAt = new Date("2026-07-15T02:00:00.000Z");
  assert.deepEqual(await store.reconcileEligibility(markedAt, eligibleAt, 100), {
    cleared: 0,
    marked: 1,
  });
  const marked = await database.blob.findUniqueOrThrow({ where: { id: "blob-gc-lifecycle" } });
  assert.deepEqual(marked.gcEligibleAt, eligibleAt);

  const beforeGrace = new dependencies.BlobGcProcessor(store, storage, maximumAttempts, () => markedAt);
  assert.equal(await beforeGrace.run("blob-gc-lifecycle"), "not_due");
  assert.equal(storage.has(storageKey), true);

  const dueAt = new Date("2026-07-15T02:00:01.000Z");
  const processor = new dependencies.BlobGcProcessor(store, storage, maximumAttempts, () => dueAt);
  storage.failBeforeNextDelete = true;
  await assert.rejects(
    processor.run("blob-gc-lifecycle"),
    /SIMULATED_DELETE_RESULT_LOSS/,
  );
  const failed = await database.blob.findUniqueOrThrow({ where: { id: "blob-gc-lifecycle" } });
  assert.equal(failed.status, "deleted");
  assert.equal(failed.gcAttemptCount, 1);
  assert.equal(failed.storageDeletedAt, null);
  assert.equal(failed.gcLastErrorCode, "BLOB_GC_STORAGE_DELETE_FAILED");
  assert.equal(storage.has(storageKey), true);
  assert.deepEqual(await store.findCandidates(dueAt, maximumAttempts, 100), [
    { blobId: "blob-gc-lifecycle" },
  ]);

  assert.equal(await processor.run("blob-gc-lifecycle"), "deleted");
  const completed = await database.blob.findUniqueOrThrow({ where: { id: "blob-gc-lifecycle" } });
  assert.equal(completed.status, "deleted");
  assert.equal(completed.gcAttemptCount, 2);
  assert.deepEqual(completed.storageDeletedAt, dueAt);
  assert.equal(completed.gcLastErrorCode, null);
  assert.equal(storage.has(storageKey), false);
  assert.deepEqual(storage.deleted, [storageKey]);

  assert.equal(await processor.run("blob-gc-lifecycle"), "complete");
  assert.deepEqual(storage.deleted, [storageKey]);
  return { attempts: completed.gcAttemptCount, storageDeletes: storage.deleted.length };
}

async function runBlobGcReferenceScenario(database, dependencies) {
  console.log("[file-integration] Blob GC durable byte references and non-owning scan evidence");
  const bytes = Buffer.from("retained blob gc integration bytes", "utf8");
  const sha256 = digest(bytes);
  const storageKey = stableKey(prefixes.canonical, sha256, 1);
  const staleEligibility = new Date("2026-07-14T00:00:00.000Z");
  await database.blob.create({
    data: {
      id: "blob-gc-reference",
      sha256,
      generation: 1,
      storageKey,
      mediaType: "application/octet-stream",
      byteSize: BigInt(bytes.byteLength),
      status: "ready",
      verifiedAt: new Date("2026-07-13T00:00:00.000Z"),
      gcEligibleAt: staleEligibility,
    },
  });
  await database.fileAsset.create({
    data: {
      id: "file-gc-reference",
      projectId: "integration-project",
      blobId: "blob-gc-reference",
      uploadedById: "integration-principal",
      originalName: "retained.bin",
      declaredMediaType: "application/octet-stream",
      detectedMediaType: "application/octet-stream",
      byteSize: BigInt(bytes.byteLength),
      status: "deleted",
      deletedAt: new Date("2026-07-14T12:00:00.000Z"),
    },
  });

  const store = new dependencies.PrismaBlobGcStore(database);
  const now = new Date("2026-07-15T03:00:00.000Z");
  const nextEligibility = new Date("2026-07-15T04:00:00.000Z");
  const referenced = await database.blob.findUniqueOrThrow({ where: { id: "blob-gc-reference" } });
  assert.equal(referenced.gcEligibleAt, null, "a new byte-owning reference must cancel eligibility");
  assert.deepEqual(await store.reconcileEligibility(now, nextEligibility, 100), {
    cleared: 0,
    marked: 0,
  });
  assert.equal((await store.claim("blob-gc-reference", now, maximumAttempts)).kind, "referenced");

  await database.fileAsset.delete({ where: { id: "file-gc-reference" } });
  await database.blobScan.create({
    data: {
      id: "scan-gc-reference",
      blobId: "blob-gc-reference",
      attempt: 1,
      status: "queued",
      scanner: "integration-audit-scanner",
      scannerVersion: "1",
    },
  });
  assert.deepEqual(await store.reconcileEligibility(now, nextEligibility, 100), {
    cleared: 0,
    marked: 1,
  });
  const scanOnly = await database.blob.findUniqueOrThrow({ where: { id: "blob-gc-reference" } });
  assert.deepEqual(scanOnly.gcEligibleAt, nextEligibility, "BlobScan must remain non-owning audit evidence");

  const definitions = await database.$queryRawUnsafe(`
    SELECT pg_get_functiondef('workbench.blob_has_durable_byte_references(text)'::regprocedure) AS "referencesDef",
           pg_get_functiondef('workbench.guard_blob_artifact_references()'::regprocedure) AS "guardDef"
  `);
  assert.match(definitions[0].referencesDef, /artifact_creation_receipts/);
  assert.match(definitions[0].guardDef, /artifact_creation_receipts/);
  assert.doesNotMatch(definitions[0].referencesDef, /blob_scans/);
  return { deletedFileRetained: true, scanEvidenceNonOwning: true, receiptGuarded: true };
}

async function runBlobGcConcurrentReferenceScenario(database, PrismaClient) {
  console.log("[file-integration] Blob GC row lock rejects a concurrent new byte owner");
  const bytes = Buffer.from("concurrent blob gc integration bytes", "utf8");
  const sha256 = digest(bytes);
  await database.blob.create({
    data: {
      id: "blob-gc-concurrent",
      sha256,
      generation: 1,
      storageKey: stableKey(prefixes.canonical, sha256, 1),
      mediaType: "application/octet-stream",
      byteSize: BigInt(bytes.byteLength),
      status: "ready",
      verifiedAt: new Date("2026-07-13T00:00:00.000Z"),
      gcEligibleAt: new Date("2026-07-14T00:00:00.000Z"),
    },
  });

  const contender = new PrismaClient();
  await contender.$connect();
  let lockedResolve;
  const locked = new Promise((resolve) => { lockedResolve = resolve; });
  let releaseResolve;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  try {
    const gc = database.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "blobs" WHERE "id" = 'blob-gc-concurrent' FOR UPDATE`);
      lockedResolve();
      await release;
      await tx.blob.update({
        where: { id: "blob-gc-concurrent" },
        data: {
          status: "deleted",
          deletedAt: new Date("2026-07-15T05:00:00.000Z"),
          gcAttemptCount: { increment: 1 },
        },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
    await locked;

    let referenceSettled = false;
    const reference = contender.fileAsset.create({
      data: {
        id: "file-gc-concurrent",
        projectId: "integration-project",
        blobId: "blob-gc-concurrent",
        uploadedById: "integration-principal",
        originalName: "concurrent.bin",
        declaredMediaType: "application/octet-stream",
        detectedMediaType: "application/octet-stream",
        byteSize: BigInt(bytes.byteLength),
        status: "deleted",
        deletedAt: new Date("2026-07-15T05:00:00.000Z"),
      },
    }).finally(() => { referenceSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(referenceSettled, false, "new reference did not wait on the Blob GC row lock");

    releaseResolve();
    await gc;
    await assert.rejects(reference, (error) => {
      assert.equal(error?.code, "P2003");
      return true;
    });
    assert.equal(await database.fileAsset.count({ where: { id: "file-gc-concurrent" } }), 0);
    assert.equal((await database.blob.findUniqueOrThrow({
      where: { id: "blob-gc-concurrent" },
      select: { status: true },
    })).status, "deleted");
  } finally {
    releaseResolve?.();
    await contender.$disconnect();
  }
  return { blockedUntilCommit: true, referenceRejected: true };
}

async function runKnowledgeReadyScenario(database, dependencies) {
  console.log("[file-integration] Knowledge release atomic publication and Chinese FTS");
  const release = await createKnowledgeRelease(database, "knowledge-ready", 1);
  const suite = createKnowledgeSuite(database, dependencies);

  assert.equal(await suite.runner.run(release.id, delivery("knowledge-ready", 0, 5)), "ready");
  const state = await loadKnowledgeRelease(database, release.id);
  assert.equal(state.status, "ready");
  assert.equal(state.buildAttempt, 1);
  assert.equal(state.leaseToken, null);
  assert.equal(state.leaseExpiresAt, null);
  assert.ok(state.startedAt);
  assert.ok(state.readyAt);
  assert.match(state.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(state.manifest.assetClosure.referencedAssetCount, 1);
  assert.equal(state.manifest.assetClosure.assets[0].path, "storage/imports/integration-source.bin");
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].sourcePath, "00-rules/integration.md");
  assert.ok(state.documents[0].chunks.length > 0);
  assert.equal(
    state.documents[0].chunks.every((chunk) => chunk.releaseId === release.id),
    true,
    "Knowledge chunks did not retain their database-proven release identity",
  );

  const searchState = await database.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS "count",
            COUNT(*) FILTER (WHERE chunk."search_vector" IS NOT NULL)::int AS "indexedCount",
            COUNT(*) FILTER (
              WHERE chunk."search_vector" @@ plainto_tsquery('simple', $2)
            )::int AS "matchCount"
       FROM "knowledge_chunks" AS chunk
       JOIN "knowledge_documents" AS document ON document."id" = chunk."document_id"
      WHERE document."release_id" = $1`,
    release.id,
    "知识库",
  );
  assert.equal(Number(searchState[0]?.indexedCount ?? 0), Number(searchState[0]?.count ?? -1));
  assert.ok(Number(searchState[0]?.matchCount ?? 0) > 0, "Chinese FTS did not match the segmented Knowledge text");
  return {
    status: state.status,
    documents: state.documents.length,
    assets: state.manifest.assetClosure.referencedAssetCount,
    chunks: state.documents[0].chunks.length,
    searchMatches: Number(searchState[0]?.matchCount ?? 0),
  };
}

async function runKnowledgeConcurrentClaimScenario(database, dependencies) {
  console.log("[file-integration] Knowledge release concurrent claim exclusion");
  const release = await createKnowledgeRelease(database, "knowledge-concurrent", 1);
  const suite = createKnowledgeSuite(database, dependencies);
  const starts = await Promise.all([
    suite.store.beginDelivery(release.id, delivery("knowledge-concurrent-a", 0, 5), 6, 60_000),
    suite.store.beginDelivery(release.id, delivery("knowledge-concurrent-b", 0, 5), 6, 60_000),
  ]);
  assert.deepEqual(starts.map((start) => start.kind).sort(), ["busy", "run"]);
  const claimed = starts.find((start) => start.kind === "run");
  assert.ok(claimed && claimed.kind === "run");
  const claimedState = await database.knowledgeRelease.findUniqueOrThrow({ where: { id: release.id } });
  assert.equal(claimedState.buildAttempt, 1);
  assert.ok(claimedState.leaseToken);

  assert.equal(await suite.processor.build(claimed.command), "ready");
  const state = await loadKnowledgeRelease(database, release.id);
  assert.equal(state.status, "ready");
  assert.equal(state.buildAttempt, 1);
  return { status: state.status, claims: starts.map((start) => start.kind).sort(), buildAttempt: state.buildAttempt };
}

async function runKnowledgeInvalidProfileScenario(database, dependencies) {
  console.log("[file-integration] invalid pinned embedding profile fails before lease acquisition");
  const profileId = "integration-invalid-embedding-3-r1";
  const spec = {
    schema: "workbench.embedding-profile.v1",
    id: profileId,
    output: { dimension: 3 },
  };
  const specSha256 = dependencies.canonicalSha256(spec);
  await database.embeddingProfile.create({
    data: { id: profileId, spec, specSha256, dimension: 3 },
  });
  await database.embeddingProfile.update({ where: { id: profileId }, data: { status: "poc" } });
  await database.embeddingProfile.update({ where: { id: profileId }, data: { status: "adopted" } });
  const retrievalSpec = structuredClone(integrationRetrievalProfile.spec);
  retrievalSpec.id = "integration-invalid-retrieval-r1";
  retrievalSpec.embedding = {
    profileId,
    profileSpecSha256: specSha256,
    dimension: 3,
  };
  const retrievalSpecSha256 = dependencies.canonicalSha256(retrievalSpec);
  await database.retrievalProfile.create({
    data: {
      id: retrievalSpec.id,
      spec: retrievalSpec,
      specSha256: retrievalSpecSha256,
      embeddingProfileId: profileId,
      embeddingProfileSpecSha256: specSha256,
      embeddingDimension: 3,
    },
  });
  await database.retrievalProfile.update({
    where: { id: retrievalSpec.id },
    data: { status: "poc" },
  });
  await database.retrievalProfile.update({
    where: { id: retrievalSpec.id },
    data: { status: "adopted" },
  });
  const release = await createKnowledgeRelease(database, "knowledge-invalid-profile", 1, {
    embeddingProfileId: profileId,
    embeddingProfileSpecSha256: specSha256,
    embeddingDimension: 3,
    retrievalProfileId: retrievalSpec.id,
    retrievalProfileSpecSha256: retrievalSpecSha256,
  });
  const suite = createKnowledgeSuite(database, dependencies);

  assert.equal(
    await suite.runner.run(release.id, delivery("knowledge-invalid-profile", 0, 5)),
    "failed",
  );
  const failed = await database.knowledgeRelease.findUniqueOrThrow({ where: { id: release.id } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.buildAttempt, 0);
  assert.equal(failed.leaseToken, null);
  assert.equal(failed.manifest.code, "KNOWLEDGE_EMBEDDING_PROFILE_INVALID");
  return { status: failed.status, code: failed.manifest.code, buildAttempt: failed.buildAttempt };
}

async function runKnowledgeCommitResponseLossScenario(database, dependencies) {
  console.log("[file-integration] Knowledge release replay after ready commit response loss");
  const release = await createKnowledgeRelease(database, "knowledge-replay", 1);
  const durable = createKnowledgeSuite(database, dependencies);
  let loseResponse = true;
  const lossyStore = new Proxy(durable.store, {
    get(target, property) {
      if (property === "publishEmbeddingBatch") {
        return async (...args) => {
          const result = await target.publishEmbeddingBatch(...args);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("SIMULATED_KNOWLEDGE_READY_COMMIT_RESPONSE_LOSS");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lossy = createKnowledgeSuite(database, dependencies, { store: lossyStore });

  await assert.rejects(
    lossy.runner.run(release.id, delivery("knowledge-replay", 0, 5)),
    (error) => error?.code === "KNOWLEDGE_RELEASE_INFRASTRUCTURE_ERROR"
      || error?.code === "KNOWLEDGE_EMBEDDING_BATCH_REPLAY_CONFLICT",
  );
  const committed = await loadKnowledgeRelease(database, release.id);
  const firstDocumentIds = committed.documents.map((document) => document.id);
  const firstChunkIds = committed.documents.flatMap((document) => document.chunks.map((chunk) => chunk.id));
  assert.equal(committed.status, "building");
  assert.equal(committed.buildAttempt, 1);

  assert.equal(await durable.runner.run(release.id, delivery("knowledge-replay-redelivery", 1, 5)), "ready");
  const replayed = await loadKnowledgeRelease(database, release.id);
  assert.deepEqual(replayed.documents.map((document) => document.id), firstDocumentIds);
  assert.deepEqual(
    replayed.documents.flatMap((document) => document.chunks.map((chunk) => chunk.id)),
    firstChunkIds,
  );
  assert.equal(replayed.buildAttempt, 2);
  return { status: replayed.status, buildAttempt: replayed.buildAttempt, chunks: firstChunkIds.length };
}

async function runKnowledgeBatchRecoveryScenario(database, dependencies) {
  console.log("[file-integration] Knowledge embedding batch checkpoint recovery");
  const release = await createKnowledgeRelease(database, "knowledge-batch-recovery", 1);
  let calls = 0;
  let failSecondCall = true;
  const embedding = {
    async assertProfile() {},
    async embedDocuments(_profile, inputs) {
      calls += 1;
      if (failSecondCall && calls === 2) {
        failSecondCall = false;
        const { RetryableKnowledgeBuildError } = await importBuilt("knowledge/knowledge.errors.js");
        throw new RetryableKnowledgeBuildError("TEI_HTTP_503", "simulated TEI outage");
      }
      return {
        vectors: inputs.map(() => [1, 0, 0]),
        tokenCounts: inputs.map(() => 3),
      };
    },
  };
  const reader = {
    async readSnapshot() {
      return {
        sources: [
          { path: "00-rules/one.md", content: knowledgeMarkdown("One", "第一条") },
          { path: "00-rules/two.md", content: knowledgeMarkdown("Two", "第二条") },
          { path: "00-rules/three.md", content: knowledgeMarkdown("Three", "第三条") },
        ],
        assets: [],
        storageDirectoryReferences: [],
      };
    },
  };
  const suite = createKnowledgeSuite(database, dependencies, { reader, embedding });
  await assert.rejects(
    suite.runner.run(release.id, delivery("knowledge-batch-recovery", 0, 5)),
    (error) => error?.code === "TEI_HTTP_503",
  );
  const afterFailure = await database.knowledgeEmbeddingBatch.findMany({
    where: { releaseId: release.id },
    orderBy: { sequence: "asc" },
  });
  assert.ok(afterFailure.some((batch) => batch.status === "ready"));
  assert.ok(afterFailure.some((batch) => batch.status === "pending"));

  assert.equal(await suite.runner.run(release.id, delivery("knowledge-batch-recovery", 1, 5)), "ready");
  const final = await database.knowledgeRelease.findUniqueOrThrow({
    where: { id: release.id },
    include: { embeddingBatches: { orderBy: { sequence: "asc" } }, documents: { include: { chunks: true } } },
  });
  assert.equal(final.status, "ready");
  assert.equal(final.embeddingBatches.every((batch) => batch.status === "ready"), true);
  assert.equal(final.embeddingBatches.some((batch) => batch.attemptCount > 1), true);
  const count = await database.knowledgeChunkEmbedding.count({ where: { releaseId: release.id } });
  assert.equal(count, final.documents.reduce((total, document) => total + document.chunks.length, 0));
  return { status: final.status, calls, batches: final.embeddingBatches.length, embeddings: count };
}

async function runKnowledgeManifestCorruptionScenario(database, dependencies) {
  console.log("[file-integration] Knowledge release manifest corruption detection");
  const release = await database.knowledgeRelease.create({
    data: {
      id: "knowledge-corrupt-release",
      key: "knowledge-corrupt",
      workspaceId: "integration-workspace",
      version: 1,
      status: "ready",
      embeddingProfileId: integrationEmbeddingProfile.id,
      embeddingProfileSpecSha256: integrationEmbeddingProfile.specSha256,
      embeddingDimension: integrationEmbeddingProfile.dimension,
      retrievalProfileId: integrationRetrievalProfile.id,
      retrievalProfileSpecSha256: integrationRetrievalProfile.specSha256,
      manifest: { schema: "tampered" },
      manifestSha256: "0".repeat(64),
      chunksReadyAt: new Date(),
      readyAt: new Date(),
    },
  });
  const suite = createKnowledgeSuite(database, dependencies);
  await assert.rejects(
    suite.store.beginDelivery(release.id, delivery("knowledge-corrupt", 0, 5), 6, 60_000),
    (error) => error?.code === "KNOWLEDGE_RELEASE_MANIFEST_CORRUPT",
  );
  return { detected: true };
}

async function runKnowledgeReconciliationScenario(database, dependencies) {
  console.log("[file-integration] Knowledge release stale reconciliation and exhaustion");
  const staleAt = new Date(Date.now() - 60 * 60_000);
  const stale = await createKnowledgeRelease(database, "knowledge-stale", 1, { updatedAt: staleAt });
  const exhausted = await createKnowledgeRelease(database, "knowledge-exhausted", 1, {
    buildAttempt: 6,
    startedAt: staleAt,
    updatedAt: staleAt,
  });
  const suite = createKnowledgeSuite(database, dependencies);
  const sent = [];
  const queue = {
    async send(name, data, options) {
      sent.push({ name, data, options });
      return `reconciled-${data.releaseId}`;
    },
  };
  const reconciler = new dependencies.KnowledgeReconciler(
    suite.store,
    queue,
    6,
    5 * 60_000,
    100,
    60_000,
  );
  await reconciler.runOnce();
  assert.equal(sent.some((entry) => entry.data.releaseId === stale.id), true);
  assert.equal(sent.some((entry) => entry.data.releaseId === exhausted.id), false);
  const exhaustedState = await database.knowledgeRelease.findUniqueOrThrow({ where: { id: exhausted.id } });
  assert.equal(exhaustedState.status, "failed");
  assert.equal(exhaustedState.leaseToken, null);
  return { queued: sent.map((entry) => entry.data.releaseId), exhaustedStatus: exhaustedState.status };
}

function createKnowledgeSuite(database, dependencies, overrides = {}) {
  const store = overrides.store ?? new dependencies.PrismaKnowledgeBuildStore(database);
  const segmenter = new dependencies.JiebaSegmenterAdapter();
  const content = [
    "---",
    "title: 集成知识规则",
    "status: 已生效",
    "tags: []",
    "aliases: []",
    "---",
    "",
    "# 集成知识规则",
    "",
    "知识库用于产品决策和需求分析。",
    "",
    "来源资产：`storage/imports/integration-source.bin`",
    "",
  ].join("\n");
  const assetDeclaration = dependencies.collectKnowledgeStorageDeclarations([{
    relativePath: "00-rules/integration.md",
    raw: content,
  }]).assets[0];
  const assetPayload = Buffer.from("integration source asset", "utf8");
  const reader = overrides.reader ?? {
    async readSnapshot() {
      return {
        sources: [{
          path: "00-rules/integration.md",
          content: Buffer.from(content, "utf8"),
        }],
        assets: [{
          ...assetDeclaration,
          mediaType: dependencies.knowledgeStorageMediaType(assetDeclaration.path),
          byteSize: assetPayload.byteLength,
          sha256: createHash("sha256").update(assetPayload).digest("hex"),
          symbolicLink: false,
        }],
        storageDirectoryReferences: [],
      };
    },
  };
  const processor = new dependencies.KnowledgeReleaseProcessor(
    store,
    reader,
    new IntegrationTokenizer(),
    segmenter,
    {
      segmenter: {
        id: dependencies.knowledgeSegmenterId,
        version: dependencies.knowledgeSegmenterVersion,
        dictionaryChecksum: dependencies.knowledgeDefaultDictionaryChecksum,
        stopwordsChecksum: segmenter.stopwordsChecksum,
      },
    },
    overrides.embedding ?? {
      async assertProfile() {},
      async embedDocuments(_profile, inputs) {
        return {
          vectors: inputs.map(() => [1, 0, 0]),
          tokenCounts: inputs.map(() => 3),
        };
      },
    },
  );
  return {
    store,
    processor,
    runner: new dependencies.KnowledgeDeliveryRunner(store, processor, 6, 60_000),
  };
}

class IntegrationTokenizer {
  assertProfile() {}

  count(text) {
    return Array.from(text).length;
  }

  split({ text, maximumTokens }) {
    if (!Number.isSafeInteger(maximumTokens) || maximumTokens < 1) {
      throw new RangeError("maximumTokens must be a positive safe integer");
    }
    const characters = Array.from(text);
    const slices = [];
    for (let start = 0; start < characters.length; start += maximumTokens) {
      const slice = characters.slice(start, start + maximumTokens).join("");
      slices.push({ text: slice, tokenCount: this.count(slice) });
    }
    return slices;
  }
}

function knowledgeMarkdown(title, body) {
  return [
    "---",
    `title: ${title}`,
    "status: 已生效",
    "tags: []",
    "aliases: []",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

async function createKnowledgeRelease(database, key, version, overrides = {}) {
  return database.knowledgeRelease.create({
    data: {
      id: `${key}-release-${version}`,
      key,
      workspaceId: "integration-workspace",
      version,
      embeddingProfileId: integrationEmbeddingProfile.id,
      embeddingProfileSpecSha256: integrationEmbeddingProfile.specSha256,
      embeddingDimension: integrationEmbeddingProfile.dimension,
      retrievalProfileId: integrationRetrievalProfile.id,
      retrievalProfileSpecSha256: integrationRetrievalProfile.specSha256,
      manifest: { schema: "workbench.knowledge-release-building.v1" },
      manifestSha256: "0".repeat(64),
      ...overrides,
    },
  });
}

const integrationEmbeddingProfile = {
  id: "integration-embedding-3-r1",
  dimension: 3,
  spec: {
    schema: "workbench.embedding-profile.v1",
    id: "integration-embedding-3-r1",
    protocol: "tei.embed.v1",
    engine: { id: "integration-tei", version: "1.0.0", imageDigest: `sha256:${"9".repeat(64)}` },
    model: { id: "integration/model", revision: "revision-1", artifactSha256: "a".repeat(64) },
    tokenizer: {
      id: "integration/tokenizer",
      revision: "revision-1",
      artifactSha256: "b".repeat(64),
      modelMaximumTokens: 128,
      chunkMaximumTokens: 80,
      overflow: "reject",
    },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 2, maximumTokens: 160 },
    conformanceProbeSha256: "c".repeat(64),
  },
  specSha256: "",
};

const integrationRetrievalProfile = {
  id: "integration-retrieval-r1",
  specSha256: "",
  spec: {
    schema: "workbench.retrieval-profile.v1",
    id: "integration-retrieval-r1",
    embedding: {
      profileId: "integration-embedding-3-r1",
      profileSpecSha256: "",
      dimension: 3,
    },
    segmenter: {
      implementationId: "jieba-wasm/cut_for_search/hmm=false",
      version: "2.4.0",
      artifactSha256: "d".repeat(64),
      algorithm: "cut_for_search",
      hmm: false,
      dictionarySha256: "d".repeat(64),
      stopwordsSha256: "e".repeat(64),
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 },
      dense: { distance: "cosine", limit: 40 },
      fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
    },
    reranker: {
      protocol: "tei.rerank.v1",
      engine: {
        id: "integration-reranker-tei",
        version: "1.0.0",
        imageDigest: `sha256:${"f".repeat(64)}`,
      },
      model: {
        id: "integration/reranker",
        revision: "revision-1",
        artifactSha256: "1".repeat(64),
      },
      tokenizer: {
        id: "integration/reranker-tokenizer",
        revision: "revision-1",
        artifactSha256: "2".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 24,
      finalResultLimit: 10,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "3".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  },
};

async function loadKnowledgeRelease(database, releaseId) {
  return database.knowledgeRelease.findUniqueOrThrow({
    where: { id: releaseId },
    include: {
      documents: {
        orderBy: { sourcePath: "asc" },
        include: { chunks: { orderBy: { sequence: "asc" } } },
      },
    },
  });
}

async function runExtractionReadyScenario(database, dependencies) {
  console.log("[file-integration] extraction atomic ready publication");
  const storage = new HighFidelityStorage();
  const source = await createReadyExtraction(database, storage, dependencies, "extract-ready");
  const parser = new DeterministicParser({ taskId: "docling-task-extract-ready" });
  const runner = createExtractionRunner(database, storage, parser, dependencies);

  assert.equal(await runner.run(source.extractionId, delivery("extract-ready", 0, 5)), "ready");
  const state = await loadExtractionState(database, source.extractionId);
  assert.equal(state.status, "ready");
  assert.equal(state.processingAttempts, 1);
  assert.equal(state.submissionGeneration, 1);
  assert.equal(state.externalTaskId, parser.taskId);
  assert.ok(state.taskCheckpointedAt);
  assert.equal(state.leaseToken, null);
  assert.deepEqual(state.outputs.map((output) => output.kind).sort(), ["docling_json", "markdown"]);
  assert.equal(state.outputs.every((output) => output.blob.status === "ready"), true);
  const markdown = state.outputs.find((output) => output.kind === "markdown");
  assert.ok(markdown);
  assert.equal(state.contentSha256, markdown.blob.sha256);
  assert.equal(state.file.currentExtractionId, state.id);
  assert.equal(state.metadata.parserImageDigest, integrationDoclingImageDigest);
  assert.equal(state.metadata.parserOptionsSha256, parser.optionsSha256);
  assert.deepEqual(state.metadata.parserComponents, dependencies.extractionContract.fileExtractionParserComponents);
  assert.equal(parser.submitCalls, 1);
  assert.equal(storage.contentAddressedCreates, 2);

  assert.equal(await runner.run(source.extractionId, delivery("extract-ready-replay", 0, 5)), "ready");
  const replayed = await loadExtractionState(database, source.extractionId);
  assert.equal(replayed.processingAttempts, 1);
  assert.equal(parser.submitCalls, 1);
  assert.equal(storage.contentAddressedCreates, 2);
  return { status: state.status, outputs: state.outputs.map((output) => output.kind).sort() };
}

async function runExtractionTaskReplayScenario(database, dependencies) {
  console.log("[file-integration] extraction resumes checkpointed Docling task");
  const storage = new HighFidelityStorage();
  const source = await createReadyExtraction(database, storage, dependencies, "extract-task-replay");
  const parser = new DeterministicParser({
    taskId: "docling-task-extract-replay",
    firstPollFailure: true,
    RetryableExtractionError: dependencies.RetryableExtractionError,
  });
  const runner = createExtractionRunner(database, storage, parser, dependencies);

  await assert.rejects(
    runner.run(source.extractionId, delivery("extract-task-replay", 0, 5)),
    (error) => {
      if (error?.code !== "DOCLING_STATUS_UNAVAILABLE") throw error;
      return true;
    },
  );
  const interrupted = await loadExtractionState(database, source.extractionId);
  assert.equal(interrupted.status, "running");
  assert.equal(interrupted.externalTaskId, parser.taskId);
  assert.equal(interrupted.submissionGeneration, 1);
  assert.equal(interrupted.processingAttempts, 1);
  assert.equal(interrupted.leaseToken, null);
  assert.equal(interrupted.outputs.length, 0);

  assert.equal(await runner.run(source.extractionId, delivery("extract-task-replay", 1, 5)), "ready");
  const state = await loadExtractionState(database, source.extractionId);
  assert.equal(state.status, "ready");
  assert.equal(state.processingAttempts, 2);
  assert.equal(state.externalTaskId, parser.taskId);
  assert.equal(parser.submitCalls, 1);
  assert.ok(parser.pollCalls >= 2);
  return { status: state.status, processingAttempts: state.processingAttempts, submitCalls: parser.submitCalls };
}

async function runExtractionAmbiguousSubmissionScenario(database, dependencies) {
  console.log("[file-integration] ambiguous submission never resubmits");
  const storage = new HighFidelityStorage();
  const source = await createReadyExtraction(database, storage, dependencies, "extract-ambiguous");
  const parser = new DeterministicParser();
  const store = createExtractionStore(database, parser, dependencies);

  const first = await store.beginDelivery(
    source.extractionId,
    delivery("extract-ambiguous", 0, 5),
    maximumAttempts,
    15 * 60_000,
  );
  assert.equal(first.kind, "run");
  assert.equal(first.needsSubmission, true);
  const concurrent = await store.beginDelivery(
    source.extractionId,
    delivery("extract-ambiguous-concurrent", 0, 5),
    maximumAttempts,
    15 * 60_000,
  );
  assert.equal(concurrent.kind, "busy");

  await database.fileExtraction.update({
    where: { id: source.extractionId },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });
  const recovered = await store.beginDelivery(
    source.extractionId,
    delivery("extract-ambiguous-recovery", 0, 5),
    maximumAttempts,
    15 * 60_000,
  );
  assert.deepEqual(recovered, { kind: "terminal", outcome: "failed" });
  const state = await loadExtractionState(database, source.extractionId);
  assert.equal(state.status, "failed");
  assert.equal(state.failureCode, "DOCLING_SUBMISSION_AMBIGUOUS");
  assert.equal(state.submissionGeneration, 1);
  assert.equal(state.externalTaskId, null);
  assert.equal(state.leaseToken, null);
  assert.equal(parser.submitCalls, 0);
  return { status: state.status, failureCode: state.failureCode, submitCalls: parser.submitCalls };
}

async function runExtractionPublishCrashReplayScenario(database, dependencies) {
  console.log("[file-integration] extraction replay after ready commit response loss");
  const storage = new HighFidelityStorage();
  const source = await createReadyExtraction(database, storage, dependencies, "extract-publish-crash");
  const parser = new DeterministicParser({ taskId: "docling-task-extract-publish-crash" });
  const durableStore = createExtractionStore(database, parser, dependencies);
  let loseResponse = true;
  const lossyStore = new Proxy(durableStore, {
    get(target, property) {
      if (property === "publishReady") {
        return async (...args) => {
          const result = await target.publishReady(...args);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("SIMULATED_EXTRACTION_READY_COMMIT_RESPONSE_LOSS");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const start = await durableStore.beginDelivery(
    source.extractionId,
    delivery("extract-publish-crash", 0, 5),
    maximumAttempts,
    15 * 60_000,
  );
  assert.equal(start.kind, "run");
  const crashingProcessor = new dependencies.FileExtractionProcessor(
    lossyStore,
    storage,
    parser,
    64 * 1024 ** 2,
    10 * 60_000,
  );
  await assert.rejects(
    crashingProcessor.extract(start),
    /SIMULATED_EXTRACTION_READY_COMMIT_RESPONSE_LOSS/,
  );
  const committed = await loadExtractionState(database, source.extractionId);
  assert.equal(committed.status, "ready");
  assert.equal(committed.outputs.length, 2);
  assert.equal(committed.leaseToken, null);

  const freshRunner = createExtractionRunner(database, storage, parser, dependencies);
  assert.equal(
    await freshRunner.run(source.extractionId, delivery("extract-publish-crash-replay", 0, 5)),
    "ready",
  );
  const replayed = await loadExtractionState(database, source.extractionId);
  assert.equal(replayed.processingAttempts, 1);
  assert.equal(parser.submitCalls, 1);
  assert.equal(storage.contentAddressedCreates, 2);
  return {
    status: replayed.status,
    processingAttempts: replayed.processingAttempts,
    submitCalls: parser.submitCalls,
  };
}

async function runCleanScenario(database, dependencies) {
  console.log("[file-integration] clean verification");
  const bytes = Buffer.from("clean integration payload\n", "utf8");
  const storage = new HighFidelityStorage();
  const scanner = new VerdictScanner("clean");
  const upload = await createCompletedUpload(database, storage, "clean", bytes);
  const runner = createRunner(database, storage, scanner, dependencies);

  assert.equal(await runner.run(upload.id, delivery("clean", 0, 5)), "ready");

  const state = await loadUploadState(database, upload.id);
  const blob = requiredBlob(state);
  assert.equal(state.file.status, "ready");
  assert.equal(state.file.failureCode, null);
  assert.equal(blob.status, "ready");
  assert.equal(blob.storageKey, stableKey(prefixes.canonical, upload.sha256, 1));
  assert.equal(blob.scans.length, 1);
  assert.equal(blob.scans[0].status, "clean");
  assert.deepEqual(
    state.verificationAttempts.map((attempt) => [attempt.status, attempt.fileStatus]),
    [["succeeded", "ready"]],
  );
  assert.equal(scanner.calls, 1);
  assert.equal(storage.has(upload.stagingKey), false);
  assert.equal(storage.has(blob.storageKey), true);
  return { fileStatus: state.file.status, scanStatus: blob.scans[0].status };
}

async function runInfectedScenario(database, dependencies) {
  console.log("[file-integration] infected verification");
  const bytes = Buffer.from("infected integration payload\n", "utf8");
  const storage = new HighFidelityStorage();
  const scanner = new VerdictScanner("infected");
  const upload = await createCompletedUpload(database, storage, "infected", bytes);
  const runner = createRunner(database, storage, scanner, dependencies);

  assert.equal(await runner.run(upload.id, delivery("infected", 0, 5)), "quarantined");

  const state = await loadUploadState(database, upload.id);
  const blob = requiredBlob(state);
  assert.equal(state.file.status, "quarantined");
  assert.equal(state.file.failureCode, "FILE_MALWARE_DETECTED");
  assert.equal(blob.status, "quarantined");
  assert.equal(blob.storageKey, stableKey(prefixes.quarantine, upload.sha256, 1));
  assert.equal(blob.scans.length, 1);
  assert.equal(blob.scans[0].status, "infected");
  assert.match(JSON.stringify(blob.scans[0].evidence), /integration-signature/);
  assert.deepEqual(
    state.verificationAttempts.map((attempt) => [attempt.status, attempt.fileStatus]),
    [["succeeded", "quarantined"]],
  );
  assert.equal(storage.has(upload.stagingKey), false);
  assert.equal(storage.has(blob.storageKey), true);
  return { fileStatus: state.file.status, scanStatus: blob.scans[0].status };
}

async function runRetryExhaustionScenario(database, dependencies) {
  console.log("[file-integration] retry exhaustion");
  const bytes = Buffer.from("retry exhaustion integration payload\n", "utf8");
  const storage = new HighFidelityStorage();
  const scanner = new OutageScanner("SCANNER_TIMEOUT");
  const upload = await createCompletedUpload(database, storage, "exhausted", bytes);
  const runner = createRunner(database, storage, scanner, dependencies);

  await assert.rejects(
    runner.run(upload.id, delivery("exhausted", 0, 1)),
    (error) => error?.code === "SCANNER_TIMEOUT",
  );
  const retryable = await loadUploadState(database, upload.id);
  assert.equal(retryable.file.status, "verifying");
  assert.deepEqual(
    retryable.verificationAttempts.map((attempt) => [attempt.status, attempt.failureCode]),
    [["retryable_failed", "SCANNER_TIMEOUT"]],
  );

  assert.equal(await runner.run(upload.id, delivery("exhausted", 1, 1)), "failed");

  const state = await loadUploadState(database, upload.id);
  assert.equal(state.file.status, "failed");
  assert.equal(state.file.failureCode, "FILE_VERIFICATION_RETRY_EXHAUSTED");
  assert.match(state.file.failureDetail ?? "", /SCANNER_TIMEOUT/);
  assert.deepEqual(
    state.verificationAttempts.map((attempt) => [
      attempt.sequence,
      attempt.status,
      attempt.fileStatus,
      attempt.failureCode,
    ]),
    [
      [1, "retryable_failed", null, "SCANNER_TIMEOUT"],
      [2, "terminal_failed", "failed", "FILE_VERIFICATION_RETRY_EXHAUSTED"],
    ],
  );
  assert.equal(storage.promotions.length, 0);
  assert.equal(storage.has(upload.stagingKey), true);
  return { fileStatus: state.file.status, attempts: state.verificationAttempts.length };
}

async function runCrashReplayScenario(database, dependencies) {
  console.log("[file-integration] crash replay after publish");
  const bytes = Buffer.from("crash replay integration payload\n", "utf8");
  const storage = new HighFidelityStorage();
  storage.failAfterNextPublish = true;
  const scanner = new VerdictScanner("clean");
  const upload = await createCompletedUpload(database, storage, "replay", bytes);
  const runner = createRunner(database, storage, scanner, dependencies);
  const canonicalKey = stableKey(prefixes.canonical, upload.sha256, 1);

  await assert.rejects(
    runner.run(upload.id, delivery("replay", 0, 5)),
    (error) => error?.code === "FILE_VERIFICATION_INFRASTRUCTURE_ERROR",
  );

  const interrupted = await loadUploadState(database, upload.id);
  assert.equal(interrupted.file.status, "verifying");
  assert.equal(interrupted.file.blobId, null);
  assert.equal(interrupted.verificationAttempts[0].status, "retryable_failed");
  assert.equal(storage.has(canonicalKey), true);
  const reserved = await database.blob.findFirstOrThrow({ where: { sha256: upload.sha256 } });
  assert.equal(reserved.status, "pending");
  assert.equal(reserved.storageKey, stableKey(prefixes.pending, upload.sha256, 1));

  assert.equal(await runner.run(upload.id, delivery("replay", 1, 5)), "ready");

  const state = await loadUploadState(database, upload.id);
  const blob = requiredBlob(state);
  assert.equal(state.file.status, "ready");
  assert.equal(blob.status, "ready");
  assert.equal(blob.storageKey, canonicalKey);
  assert.equal(blob.scans.length, 1);
  assert.equal(scanner.calls, 2);
  assert.equal(storage.destinationCreates, 1);
  assert.equal(storage.destinationReuses, 1);
  assert.equal(storage.has(upload.stagingKey), false);
  assert.deepEqual(
    state.verificationAttempts.map((attempt) => [attempt.status, attempt.fileStatus]),
    [["retryable_failed", null], ["succeeded", "ready"]],
  );

  const cleanupBytes = Buffer.from("committed cleanup replay payload\n", "utf8");
  const cleanupStorage = new HighFidelityStorage();
  cleanupStorage.failBeforeNextDelete = true;
  const cleanupScanner = new VerdictScanner("clean");
  const cleanupUpload = await createCompletedUpload(
    database,
    cleanupStorage,
    "cleanup-replay",
    cleanupBytes,
  );
  const cleanupRunner = createRunner(database, cleanupStorage, cleanupScanner, dependencies);

  assert.equal(
    await cleanupRunner.run(cleanupUpload.id, delivery("cleanup-replay", 0, 5)),
    "ready",
  );
  assert.equal(cleanupStorage.has(cleanupUpload.stagingKey), true);
  const committed = await loadUploadState(database, cleanupUpload.id);
  assert.deepEqual(
    committed.verificationAttempts.map((attempt) => [attempt.status, attempt.fileStatus]),
    [["succeeded", "ready"]],
  );

  assert.equal(
    await cleanupRunner.run(cleanupUpload.id, delivery("cleanup-replay", 1, 5)),
    "ready",
  );
  assert.equal(cleanupStorage.has(cleanupUpload.stagingKey), false);
  assert.equal(cleanupScanner.calls, 1);
  const cleaned = await loadUploadState(database, cleanupUpload.id);
  assert.equal(cleaned.verificationAttempts.length, 1);

  return {
    fileStatus: state.file.status,
    publishLossAttempts: state.verificationAttempts.length,
    cleanupLossAttempts: cleaned.verificationAttempts.length,
  };
}

function createRunner(database, storage, scanner, dependencies) {
  const store = new dependencies.PrismaVerificationStore(database, prefixes);
  const processor = new dependencies.FileVerificationProcessor(
    store,
    storage,
    scanner,
    maximumUploadByteSize,
  );
  return new dependencies.VerificationDeliveryRunner(store, processor, maximumAttempts, 60_000);
}

function createExtractionStore(database, parser, dependencies) {
  return new dependencies.PrismaExtractionStore(database, {
    canonicalBlobPrefix: prefixes.canonical,
    pendingBlobPrefix: prefixes.pending,
    doclingImageDigest: integrationDoclingImageDigest,
    parserOptionsSha256: parser.optionsSha256,
    parserComponents: dependencies.extractionContract.fileExtractionParserComponents,
  });
}

function createExtractionRunner(database, storage, parser, dependencies) {
  const store = createExtractionStore(database, parser, dependencies);
  const processor = new dependencies.FileExtractionProcessor(
    store,
    storage,
    parser,
    64 * 1024 ** 2,
    10 * 60_000,
  );
  return new dependencies.ExtractionDeliveryRunner(store, processor, maximumAttempts, 15 * 60_000);
}

async function createReadyExtraction(database, storage, dependencies, scenario) {
  const bytes = Buffer.from(`verified extraction source for ${scenario}\n`, "utf8");
  const sha256 = digest(bytes);
  const blobId = `integration-source-blob-${scenario}`;
  const fileId = `integration-source-file-${scenario}`;
  const extractionId = `integration-extraction-${scenario}`;
  const storageKey = stableKey(prefixes.canonical, sha256, 1);
  storage.put(storageKey, bytes, "text/plain");

  await database.blob.create({
    data: {
      id: blobId,
      sha256,
      generation: 1,
      storageKey,
      mediaType: "text/plain",
      byteSize: BigInt(bytes.byteLength),
      status: "pending",
    },
  });
  const scan = await database.blobScan.create({
    data: {
      id: `integration-source-scan-${scenario}`,
      blobId,
      attempt: 1,
      status: "queued",
      scanner: "integration-scanner",
      scannerVersion: "1.0.0",
      signatureVersion: "integration-signatures",
    },
  });
  await database.blobScan.update({
    where: { id: scan.id },
    data: { status: "running", startedAt: new Date() },
  });
  await database.blobScan.update({
    where: { id: scan.id },
    data: {
      status: "clean",
      evidence: { verdict: "clean", sha256, byteSize: bytes.byteLength, mediaType: "text/plain" },
      finishedAt: new Date(),
    },
  });
  await database.blob.update({
    where: { id: blobId },
    data: { status: "ready", verifiedAt: new Date() },
  });
  await database.fileAsset.create({
    data: {
      id: fileId,
      projectId: "integration-project",
      blobId,
      uploadedById: "integration-principal",
      originalName: `${scenario}.txt`,
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      byteSize: BigInt(bytes.byteLength),
      status: "ready",
      verifiedAt: new Date(),
    },
  });
  await database.fileExtraction.create({
    data: {
      id: extractionId,
      fileAssetId: fileId,
      sourceBlobId: blobId,
      attempt: 1,
      status: "queued",
      parser: dependencies.extractionContract.fileExtractionParser,
      parserVersion: dependencies.extractionContract.fileExtractionParserVersion,
      outputSchemaVersion: dependencies.extractionContract.fileExtractionOutputSchemaVersion,
      idempotencyKey: `integration-extraction-key-${scenario}`,
      requestHash: digest(Buffer.from(`extraction:${scenario}`)),
    },
  });
  return { extractionId, fileId, blobId, storageKey, sha256 };
}

async function loadExtractionState(database, extractionId) {
  return database.fileExtraction.findUniqueOrThrow({
    where: { id: extractionId },
    include: {
      file: true,
      outputs: { orderBy: [{ kind: "asc" }, { position: "asc" }], include: { blob: true } },
    },
  });
}

async function createCompletedUpload(database, storage, scenario, bytes) {
  const id = `integration-upload-${scenario}`;
  const fileId = `integration-file-${scenario}`;
  const stagingKey = `staging/integration/${scenario}`;
  const sha256 = digest(bytes);
  storage.put(stagingKey, bytes, "application/x-untrusted");

  await database.fileAsset.create({
    data: {
      id: fileId,
      projectId: "integration-project",
      uploadedById: "integration-principal",
      originalName: `${scenario}.txt`,
      declaredMediaType: "application/x-untrusted",
      byteSize: BigInt(bytes.byteLength),
      status: "verifying",
    },
  });
  await database.fileUploadSession.create({
    data: {
      id,
      projectId: "integration-project",
      fileAssetId: fileId,
      provider: "s3",
      providerUploadId: `integration-provider-${scenario}`,
      stagingKey,
      status: "completed",
      expectedByteSize: BigInt(bytes.byteLength),
      expectedSha256: sha256,
      partSize: 5 * 1024 ** 2,
      idempotencyKey: `integration-upload-key-${scenario}`,
      requestHash: digest(Buffer.from(`request:${scenario}`)),
      completionIdempotencyKey: `integration-completion-key-${scenario}`,
      completionRequestHash: digest(Buffer.from(`completion:${scenario}`)),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      completedAt: new Date(),
    },
  });
  return { id, fileId, stagingKey, sha256 };
}

async function loadUploadState(database, uploadSessionId) {
  return database.fileUploadSession.findUniqueOrThrow({
    where: { id: uploadSessionId },
    include: {
      file: {
        include: {
          blob: {
            include: { scans: { orderBy: { attempt: "asc" } } },
          },
        },
      },
      verificationAttempts: { orderBy: { sequence: "asc" } },
    },
  });
}

function requiredBlob(state) {
  assert.ok(state.file.blob, "verification did not attach a Blob to the FileAsset");
  return state.file.blob;
}

function delivery(scenario, retryCount, retryLimit) {
  return {
    queueJobId: `integration-job-${scenario}`,
    retryCount,
    retryLimit,
  };
}

class HighFidelityStorage {
  objects = new Map();
  promotions = [];
  deleted = [];
  destinationCreates = 0;
  destinationReuses = 0;
  contentAddressedCreates = 0;
  contentAddressedReuses = 0;
  failAfterNextPublish = false;
  failBeforeNextDelete = false;

  put(key, bytes, mediaType) {
    this.objects.set(key, {
      bytes: Buffer.from(bytes),
      mediaType,
      sha256: digest(bytes),
    });
  }

  has(key) {
    return this.objects.has(key);
  }

  async getObject(key, signal) {
    abortIfNeeded(signal);
    const object = this.objects.get(key);
    if (!object) throw new Error(`FAKE_STORAGE_OBJECT_MISSING:${key}`);
    const midpoint = Math.max(1, Math.floor(object.bytes.byteLength / 2));
    return {
      body: Readable.from([
        object.bytes.subarray(0, midpoint),
        object.bytes.subarray(midpoint),
      ]),
      byteSize: object.bytes.byteLength,
      mediaType: object.mediaType,
    };
  }

  async promoteObject(input, signal) {
    abortIfNeeded(signal);
    const source = this.objects.get(input.sourceKey);
    if (!source) throw new Error(`FAKE_STORAGE_SOURCE_MISSING:${input.sourceKey}`);
    assert.equal(source.bytes.byteLength, input.byteSize, "promotion byte size mismatch");
    assert.equal(digest(source.bytes), input.sha256, "promotion digest mismatch");

    const existing = this.objects.get(input.destinationKey);
    if (existing) {
      assert.equal(existing.bytes.equals(source.bytes), true, "promotion attempted to overwrite different bytes");
      assert.equal(existing.sha256, input.sha256, "promotion destination digest mismatch");
      assert.equal(existing.mediaType, input.mediaType, "promotion destination media type mismatch");
      this.destinationReuses += 1;
    } else {
      this.objects.set(input.destinationKey, {
        bytes: Buffer.from(source.bytes),
        mediaType: input.mediaType,
        sha256: input.sha256,
      });
      this.destinationCreates += 1;
    }
    this.promotions.push({ ...input });

    if (this.failAfterNextPublish) {
      this.failAfterNextPublish = false;
      throw new Error("SIMULATED_PROMOTION_RESULT_LOSS");
    }
  }

  async putContentAddressed(input, signal) {
    abortIfNeeded(signal);
    const chunks = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.byteLength, input.byteSize, "content-addressed byte size mismatch");
    assert.equal(digest(bytes), input.sha256, "content-addressed digest mismatch");
    const existing = this.objects.get(input.destinationKey);
    if (existing) {
      assert.equal(existing.bytes.equals(bytes), true, "content-addressed write changed existing bytes");
      assert.equal(existing.mediaType, input.mediaType, "content-addressed media type mismatch");
      assert.equal(existing.sha256, input.sha256, "content-addressed stored digest mismatch");
      this.contentAddressedReuses += 1;
      return;
    }
    this.objects.set(input.destinationKey, {
      bytes: Buffer.from(bytes),
      mediaType: input.mediaType,
      sha256: input.sha256,
    });
    this.contentAddressedCreates += 1;
  }

  async deleteObject(key, signal) {
    abortIfNeeded(signal);
    if (this.failBeforeNextDelete) {
      this.failBeforeNextDelete = false;
      throw new Error("SIMULATED_DELETE_RESULT_LOSS");
    }
    this.objects.delete(key);
    this.deleted.push(key);
  }
}

class VerdictScanner {
  calls = 0;

  constructor(status) {
    this.status = status;
  }

  async scan(input) {
    this.calls += 1;
    const chunks = [];
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.byteLength, input.byteSize, "scanner did not receive the complete object");
    assert.equal(digest(bytes), input.sha256, "scanner input digest mismatch");
    const now = new Date();
    return {
      status: this.status,
      scanner: "integration-scanner",
      scannerVersion: "1.0.0",
      signatureVersion: "integration-signatures",
      evidence: this.status === "clean"
        ? { verdict: "clean" }
        : { verdict: "infected", signature: "integration-signature" },
      startedAt: now,
      finishedAt: now,
    };
  }
}

class OutageScanner {
  constructor(code) {
    this.code = code;
  }

  async scan() {
    const { RetryableVerificationError } = await importBuilt("errors.js");
    throw new RetryableVerificationError(this.code, "Integration scanner outage");
  }
}

class DeterministicParser {
  optionsSha256 = digest(Buffer.from("integration-docling-options-v1"));
  submitCalls = 0;
  pollCalls = 0;
  resultCalls = 0;

  constructor(options = {}) {
    this.taskId = options.taskId ?? "docling-task-1";
    this.firstPollFailure = options.firstPollFailure ?? false;
    this.RetryableExtractionError = options.RetryableExtractionError;
  }

  async submit(source) {
    this.submitCalls += 1;
    const chunks = [];
    for await (const chunk of source.body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.byteLength, source.byteSize, "parser source byte size mismatch");
    assert.equal(digest(bytes), source.sha256, "parser source digest mismatch");
    return this.taskId;
  }

  async poll(taskId) {
    this.pollCalls += 1;
    assert.equal(taskId, this.taskId);
    if (this.firstPollFailure) {
      this.firstPollFailure = false;
      throw new this.RetryableExtractionError(
        "DOCLING_STATUS_UNAVAILABLE",
        "Integration Docling status outage",
      );
    }
    return { state: "succeeded" };
  }

  async result(taskId) {
    this.resultCalls += 1;
    assert.equal(taskId, this.taskId);
    return {
      markdown: "# Integration extraction\n\nNormalized content.\n",
      doclingJson: {
        schema_name: "DoclingDocument",
        version: "1.0.0",
        name: "integration",
        texts: [{ text: "Normalized content." }],
      },
      status: "success",
      processingTimeSeconds: 0.25,
      errorCount: 0,
    };
  }
}

async function seedOwnership(database, knowledgeCore) {
  await database.embeddingProfile.create({
    data: {
      id: integrationEmbeddingProfile.id,
      spec: integrationEmbeddingProfile.spec,
      specSha256: integrationEmbeddingProfile.specSha256,
      dimension: integrationEmbeddingProfile.dimension,
    },
  });
  await database.embeddingProfile.update({
    where: { id: integrationEmbeddingProfile.id },
    data: { status: "poc" },
  });
  await database.embeddingProfile.update({
    where: { id: integrationEmbeddingProfile.id },
    data: { status: "adopted" },
  });
  await database.retrievalProfile.create({
    data: {
      id: integrationRetrievalProfile.id,
      spec: integrationRetrievalProfile.spec,
      specSha256: integrationRetrievalProfile.specSha256,
      embeddingProfileId: integrationEmbeddingProfile.id,
      embeddingProfileSpecSha256: integrationEmbeddingProfile.specSha256,
      embeddingDimension: integrationEmbeddingProfile.dimension,
    },
  });
  await database.retrievalProfile.update({
    where: { id: integrationRetrievalProfile.id },
    data: { status: "poc" },
  });
  await database.retrievalProfile.update({
    where: { id: integrationRetrievalProfile.id },
    data: { status: "adopted" },
  });
  await database.principal.create({
    data: {
      id: "integration-principal",
      issuer: "integration-test",
      subject: "integration-principal",
      email: "file-worker-integration@test.local",
      displayName: "File Worker Integration",
    },
  });
  await database.workspace.create({
    data: {
      id: "integration-workspace",
      slug: "file-worker-integration",
      name: "File Worker Integration",
      createdById: "integration-principal",
    },
  });
  await database.workspaceMember.create({
    data: {
      workspaceId: "integration-workspace",
      principalId: "integration-principal",
      role: "owner",
    },
  });
  await database.$transaction(async (tx) => {
    await tx.project.create({
      data: {
        id: "integration-project",
        workspaceId: "integration-workspace",
        createdById: "integration-principal",
        title: "File Worker Integration",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: "integration-project",
        workspaceId: "integration-workspace",
        principalId: "integration-principal",
        role: "owner",
      },
    });
  });
}

async function buildWorkspaces() {
  console.log("[file-integration] building contracts, Knowledge core, Prisma client, and File Worker");
  await runCommand(npm, ["--workspace", "@workbench/workbench-contracts", "run", "build"]);
  await runCommand(npm, ["--workspace", "@workbench/workbench-knowledge", "run", "build"]);
  await runCommand(
    npm,
    ["--workspace", "@workbench/workbench-db", "run", "generate"],
    { WORKBENCH_DATABASE_URL: databaseUrl },
  );
  await runCommand(npm, ["--workspace", "@workbench/workbench-file-worker", "run", "build"]);
}

async function rebuildSchemas() {
  const reset = new Client({
    connectionString: pgConnectionUrl(databaseUrl),
    application_name: "workbench-file-integration-reset",
  });
  await reset.connect();
  try {
    const result = await reset.query("SELECT current_database() AS name");
    const actualName = result.rows[0]?.name;
    if (actualName !== databaseName || !isTestDatabaseName(actualName)) {
      throw new Error(`Refusing to reset unexpected database: ${String(actualName)}`);
    }
    await reset.query('DROP SCHEMA IF EXISTS "workbench_jobs" CASCADE');
    await reset.query('DROP SCHEMA IF EXISTS "workbench" CASCADE');
    await reset.query('CREATE SCHEMA "workbench"');
  } finally {
    await reset.end();
  }
}

async function migrateDatabase() {
  console.log("[file-integration] applying current Workbench migrations");
  await runCommand(
    npm,
    ["--workspace", "@workbench/workbench-db", "run", "migrate:deploy"],
    { WORKBENCH_DATABASE_URL: databaseUrl },
  );
}

async function importBuilt(relativePath) {
  return import(pathToFileURL(path.join(root, "apps/workbench-file-worker/dist", relativePath)).href);
}

async function runCommand(command, args, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output = boundedAppend(output, chunk); });
  child.stderr.on("data", (chunk) => { output = boundedAppend(output, chunk); });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, commandTimeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (timedOut || result.code !== 0) {
    throw new Error(
      `command failed (${timedOut ? "timeout" : `exit ${result.code}, signal ${result.signal}`})\n${output}`,
    );
  }
}

function stableKey(prefix, sha256, generation) {
  return `${prefix}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g${generation}`;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("FAKE_STORAGE_ABORTED");
}

function testDatabaseUrl(raw) {
  if (!raw?.trim()) throw new Error("WORKBENCH_TEST_DATABASE_URL is required");
  const url = new URL(raw);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("WORKBENCH_TEST_DATABASE_URL must use postgresql:// or postgres://");
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || !isTestDatabaseName(name) || ["postgres", "template0", "template1"].includes(name.toLowerCase())) {
    throw new Error(`Refusing to use unsafe database: ${name || "(empty)"}`);
  }
  url.searchParams.set("schema", "workbench");
  return url.toString();
}

function assertSchemaResetConfirmation(name) {
  if (process.env.WORKBENCH_SCHEMA_RESET_CONFIRM !== name) {
    throw new Error(`WORKBENCH_SCHEMA_RESET_CONFIRM must exactly equal the test database name (${name})`);
  }
}

function isTestDatabaseName(name) {
  return typeof name === "string" && /(?:^|[_-])test(?:$|[_-])/i.test(name);
}

function pgConnectionUrl(value) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  url.searchParams.delete("options");
  return url.toString();
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boundedAppend(current, incoming, limit = 256_000) {
  const combined = current + incoming;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function formatErrorChain(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    parts.push(current instanceof Error ? current.stack ?? current.message : String(current));
    current = typeof current === "object" && current !== null ? current.cause : null;
  }
  return parts.join("\nCaused by: ");
}

await main();
