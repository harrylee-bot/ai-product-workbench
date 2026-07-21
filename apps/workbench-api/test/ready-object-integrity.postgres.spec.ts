import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { describe, expect, it, vi } from "vitest";
import { PrismaBlobGcStore } from "../../workbench-file-worker/src/gc/prisma-blob-gc.store.js";
import { BlobGcProcessor } from "../../workbench-file-worker/src/gc/blob-gc.processor.js";
import {
  READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
  readyObjectIntegrityRecorder,
  recordReadyObjectIntegrityFailure,
} from "../src/platform/object-storage/ready-object-integrity.js";
import { readReadyObject } from "../src/platform/object-storage/read-ready-object.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("ready object integrity PostgreSQL quarantine", () => {
  it("deduplicates failures and commits Blob/File quarantine before exposing any range bytes", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID().replaceAll("-", "");
    const bytes = Buffer.from(`0123456789-${suffix}`, "utf8");
    const tampered = Buffer.from(`abcdefghij-${suffix}`, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const observedSha256 = createHash("sha256").update(tampered).digest("hex");
    const storageKey = `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g1`;
    const principalId = `principal_integrity_${suffix}`;
    const workspaceId = `workspace_integrity_${suffix}`;
    const projectId = `project_integrity_${suffix}`;
    const blobId = `blob_integrity_${suffix}`;
    const fileId = `file_integrity_${suffix}`;
    const storage = {
      getObject: vi.fn(async () => ({
        body: Readable.from([tampered.subarray(0, 3), tampered.subarray(3)]),
        byteSize: tampered.byteLength,
        mediaType: "application/octet-stream",
        contentRange: null,
      })),
    };

    try {
      await db.$transaction(async (tx) => {
        await tx.principal.create({
          data: { id: principalId, issuer: `integrity-${suffix}`, subject: principalId },
        });
        await tx.workspace.create({
          data: {
            id: workspaceId,
            slug: `integrity-${suffix}`,
            name: "Ready object integrity",
            createdById: principalId,
          },
        });
        await tx.workspaceMember.create({
          data: { workspaceId, principalId, role: "owner" },
        });
        await tx.project.create({
          data: { id: projectId, workspaceId, createdById: principalId, title: "Integrity" },
        });
        await tx.projectMember.create({
          data: { projectId, workspaceId, principalId, role: "owner" },
        });
        await tx.blob.create({
          data: {
            id: blobId,
            sha256,
            generation: 1,
            storageKey,
            mediaType: "application/octet-stream",
            byteSize: BigInt(bytes.byteLength),
            status: "ready",
            verifiedAt: new Date(),
          },
        });
        const scannedAt = new Date();
        await tx.blobScan.create({
          data: {
            blobId,
            attempt: 1,
            status: "clean",
            scanner: "test-scanner",
            scannerVersion: "1",
            signatureVersion: "test-signatures",
            evidence: { result: "clean" },
            startedAt: scannedAt,
            finishedAt: scannedAt,
          },
        });
        await tx.fileAsset.create({
          data: {
            id: fileId,
            projectId,
            blobId,
            uploadedById: principalId,
            originalName: "integrity.bin",
            declaredMediaType: "application/octet-stream",
            detectedMediaType: "application/octet-stream",
            byteSize: BigInt(bytes.byteLength),
            status: "ready",
            verifiedAt: new Date(),
          },
        });
      });

      const pointer = {
        storageKey,
        sha256,
        byteSize: bytes.byteLength,
        mediaType: "application/octet-stream",
      };
      const recordIntegrityFailure = readyObjectIntegrityRecorder(db as never);
      let exposedBody: Readable | undefined;
      await expect((async () => {
        const result = await readReadyObject(
          storage as never,
          pointer,
          "bytes=2-4",
          undefined,
          { recordIntegrityFailure },
        );
        exposedBody = result.body;
      })()).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");
      expect(exposedBody).toBeUndefined();

      await expect(readReadyObject(
        storage as never,
        pointer,
        undefined,
        undefined,
        { recordIntegrityFailure },
      )).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");

      const incidents = await db.readyObjectIntegrityIncident.findMany({
        where: { storageKey },
        select: {
          id: true,
          failureCode: true,
          expectedSha256: true,
          expectedByteSize: true,
          observedSha256: true,
          observedByteSize: true,
          occurrenceCount: true,
        },
      });
      expect(incidents).toEqual([{
        id: expect.any(String),
        failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
        expectedSha256: sha256,
        expectedByteSize: BigInt(bytes.byteLength),
        observedSha256,
        observedByteSize: BigInt(tampered.byteLength),
        occurrenceCount: 2,
      }]);
      const incidentId = incidents[0]!.id;
      await expect(db.readyObjectIntegrityIncident.delete({
        where: { id: incidentId },
      })).rejects.toThrow(/READY_OBJECT_INTEGRITY_INCIDENT_DELETE_FORBIDDEN/u);
      await expect(db.readyObjectIntegrityIncident.update({
        where: { id: incidentId },
        data: { occurrenceCount: { increment: 2 } },
      })).rejects.toThrow(/READY_OBJECT_INTEGRITY_INCIDENT_IMMUTABLE/u);
      await expect(db.$executeRaw(Prisma.sql`
        TRUNCATE TABLE
          "ready_object_integrity_retention_releases",
          "ready_object_integrity_incidents"
      `)).rejects.toThrow(/READY_OBJECT_INTEGRITY_AUDIT_TRUNCATE_FORBIDDEN/u);
      await expect(db.blob.findUniqueOrThrow({
        where: { id: blobId },
        select: {
          status: true,
          storageKey: true,
          deletedAt: true,
          storageDeletedAt: true,
          gcEligibleAt: true,
        },
      })).resolves.toEqual({
        status: "quarantined",
        storageKey,
        deletedAt: null,
        storageDeletedAt: null,
        gcEligibleAt: null,
      });
      await expect(db.fileAsset.findUniqueOrThrow({
        where: { id: fileId },
        select: { status: true, revision: true, failureCode: true, failureDetail: true },
      })).resolves.toEqual({
        status: "quarantined",
        revision: 1,
        failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
        failureDetail: "Object bytes failed immutable manifest verification",
      });
      expect(storage.getObject).toHaveBeenCalledTimes(2);
      expect(storage.getObject).toHaveBeenNthCalledWith(1, { key: storageKey });

      // Remove the last business reference, then prove the integrity hold is a
      // separate GC fence that only an owner-issued release can clear.
      await db.fileAsset.update({
        where: { id: fileId },
        data: { status: "deleted", deletedAt: new Date(), revision: { increment: 1 } },
      });
      await db.workspace.delete({ where: { id: workspaceId } });
      const dueAt = new Date(Date.now() - 60_000);
      await db.blob.update({ where: { id: blobId }, data: { gcEligibleAt: dueAt } });
      const gc = new PrismaBlobGcStore(db);
      await expect(gc.claim(blobId, new Date(), 6)).resolves.toEqual({ kind: "referenced" });
      await expect(db.blob.findUniqueOrThrow({
        where: { id: blobId },
        select: { status: true, gcEligibleAt: true, storageDeletedAt: true },
      })).resolves.toEqual({
        status: "quarantined",
        gcEligibleAt: null,
        storageDeletedAt: null,
      });

      await expect(db.readyObjectIntegrityRetentionRelease.create({
        data: {
          incidentId,
          releasedOccurrenceCount: 1,
          releaseReference: "D020-STALE-RELEASE",
        },
      })).rejects.toThrow(/READY_OBJECT_INTEGRITY_RELEASE_OCCURRENCE_STALE/u);
      const release = await db.readyObjectIntegrityRetentionRelease.create({
        data: {
          incidentId,
          releasedOccurrenceCount: 2,
          releaseReference: "D020-FORENSIC-APPROVAL",
        },
      });
      await expect(db.readyObjectIntegrityRetentionRelease.update({
        where: { id: release.id },
        data: { releaseReference: "MUTATED" },
      })).rejects.toThrow(/READY_OBJECT_INTEGRITY_RELEASE_APPEND_ONLY/u);
      await expect(db.readyObjectIntegrityRetentionRelease.delete({
        where: { id: release.id },
      })).rejects.toThrow(/READY_OBJECT_INTEGRITY_RELEASE_APPEND_ONLY/u);

      await db.blob.update({ where: { id: blobId }, data: { gcEligibleAt: dueAt } });
      await expect(gc.claim(blobId, new Date(), 6)).resolves.toEqual({
        kind: "delete",
        storageKey,
        attemptCount: 1,
      });
      await expect(db.blob.findUniqueOrThrow({
        where: { id: blobId },
        select: { status: true, storageDeletedAt: true },
      })).resolves.toEqual({ status: "deleted", storageDeletedAt: null });
    } finally {
      await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
      await db.blob.deleteMany({ where: { id: blobId } }).catch(() => undefined);
      await db.principal.deleteMany({ where: { id: principalId } }).catch(() => undefined);
      await db.$disconnect();
    }
  }, 30_000);

  it("serializes an uncommitted incident ahead of Blob physical deletion", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const blobId = `blob_integrity_race_${suffix}`;
    const bytes = Buffer.from(`integrity-race-${suffix}`, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g1`;
    const failure = {
      failureCode: "OBJECT_STORAGE_SHA256_MISMATCH" as const,
      storageKey,
      expectedSha256: sha256,
      expectedByteSize: bytes.byteLength,
      expectedMediaType: "application/octet-stream",
      observedSha256: "f".repeat(64),
      observedByteSize: bytes.byteLength,
      observedMediaType: "application/octet-stream",
      observedContentRange: null,
    };
    const owner = new PrismaClient({ datasourceUrl: databaseUrl! });
    const blockerName = `integrity_blocker_${suffix}`;
    const recorderName = `integrity_recorder_${suffix}`;
    const gcName = `integrity_gc_${suffix}`;
    const blocker = new PrismaClient({ datasourceUrl: connectionUrl(blockerName) });
    const recorder = new PrismaClient({ datasourceUrl: connectionUrl(recorderName) });
    const gcDb = new PrismaClient({ datasourceUrl: connectionUrl(gcName) });
    const observer = new PrismaClient({ datasourceUrl: connectionUrl(`integrity_observer_${suffix}`) });
    const releaseBlocker = deferred<void>();
    let blockingTransaction: Promise<void> | undefined;
    let recording: Promise<void> | undefined;
    let deletion: Promise<unknown> | undefined;

    try {
      await owner.blob.create({
        data: {
          id: blobId,
          sha256,
          generation: 1,
          storageKey,
          mediaType: failure.expectedMediaType,
          byteSize: BigInt(bytes.byteLength),
          status: "ready",
          verifiedAt: new Date(),
        },
      });
      await recordReadyObjectIntegrityFailure(owner as never, failure);
      const incident = await owner.readyObjectIntegrityIncident.findFirstOrThrow({
        where: { storageKey },
        select: { id: true, occurrenceCount: true },
      });
      await owner.readyObjectIntegrityRetentionRelease.create({
        data: {
          incidentId: incident.id,
          releasedOccurrenceCount: incident.occurrenceCount,
          releaseReference: "D020-CONCURRENCY-BASELINE",
        },
      });
      await owner.blob.update({
        where: { id: blobId },
        data: { gcEligibleAt: new Date(Date.now() - 60_000) },
      });

      const blockerStarted = deferred<number>();
      blockingTransaction = blocker.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
          SELECT pg_backend_pid() AS "pid"
          FROM "ready_object_integrity_incidents"
          WHERE "id" = ${incident.id}
          FOR UPDATE
        `);
        if (!rows[0]) throw new Error("INTEGRITY_RACE_INCIDENT_NOT_FOUND");
        blockerStarted.resolve(rows[0].pid);
        await releaseBlocker.promise;
      }, { timeout: 30_000 });
      const blockerPid = await blockerStarted.promise;

      recording = recordReadyObjectIntegrityFailure(recorder as never, failure);
      const recorderPid = await waitForBlockedBy(observer, recorderName, blockerPid);

      const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
      const processor = new BlobGcProcessor(
        new PrismaBlobGcStore(gcDb),
        storage,
        6,
        () => new Date(),
      );
      deletion = processor.run(blobId);
      await waitForBlockedBy(observer, gcName, recorderPid);
      expect(storage.deleteObject).not.toHaveBeenCalled();

      releaseBlocker.resolve();
      await blockingTransaction;
      await recording;
      await expect(deletion).resolves.toBe("referenced");
      expect(storage.deleteObject).not.toHaveBeenCalled();
      await expect(owner.readyObjectIntegrityIncident.findUniqueOrThrow({
        where: { id: incident.id },
        select: { occurrenceCount: true },
      })).resolves.toEqual({ occurrenceCount: 2 });
      await expect(owner.blob.findUniqueOrThrow({
        where: { id: blobId },
        select: { status: true, storageDeletedAt: true, gcEligibleAt: true },
      })).resolves.toEqual({
        status: "quarantined",
        storageDeletedAt: null,
        gcEligibleAt: null,
      });
    } finally {
      releaseBlocker.resolve();
      await blockingTransaction?.catch(() => undefined);
      await recording?.catch(() => undefined);
      await deletion?.catch(() => undefined);
      await owner.blob.deleteMany({ where: { id: blobId } }).catch(() => undefined);
      await Promise.all([owner, blocker, recorder, gcDb, observer].map((client) => client.$disconnect()));
    }
  }, 45_000);

  it("rolls back both evidence and quarantine when the durable transaction is forced to fail", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID().replaceAll("-", "");
    const bytes = Buffer.from(`rollback00-${suffix}`, "utf8");
    const tampered = Buffer.from(`ROLLBACK00-${suffix}`, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g1`;
    const principalId = `principal_integrity_rollback_${suffix}`;
    const workspaceId = `workspace_integrity_rollback_${suffix}`;
    const projectId = `project_integrity_rollback_${suffix}`;
    const blobId = `blob_integrity_rollback_${suffix}`;
    const fileId = `file_integrity_rollback_${suffix}`;
    const storage = {
      getObject: vi.fn(async () => ({
        body: Readable.from([tampered]),
        byteSize: tampered.byteLength,
        mediaType: "application/octet-stream",
        contentRange: null,
      })),
    };

    try {
      await db.$transaction(async (tx) => {
        await tx.principal.create({
          data: { id: principalId, issuer: `integrity-rollback-${suffix}`, subject: principalId },
        });
        await tx.workspace.create({
          data: {
            id: workspaceId,
            slug: `integrity-rollback-${suffix}`,
            name: "Ready object integrity rollback",
            createdById: principalId,
          },
        });
        await tx.workspaceMember.create({ data: { workspaceId, principalId, role: "owner" } });
        await tx.project.create({
          data: { id: projectId, workspaceId, createdById: principalId, title: "Rollback" },
        });
        await tx.projectMember.create({
          data: { projectId, workspaceId, principalId, role: "owner" },
        });
        await tx.blob.create({
          data: {
            id: blobId,
            sha256,
            generation: 1,
            storageKey,
            mediaType: "application/octet-stream",
            byteSize: BigInt(bytes.byteLength),
            status: "ready",
            verifiedAt: new Date(),
          },
        });
        const scannedAt = new Date();
        await tx.blobScan.create({
          data: {
            blobId,
            attempt: 1,
            status: "clean",
            scanner: "test-scanner",
            scannerVersion: "1",
            evidence: { result: "clean" },
            startedAt: scannedAt,
            finishedAt: scannedAt,
          },
        });
        await tx.fileAsset.create({
          data: {
            id: fileId,
            projectId,
            blobId,
            uploadedById: principalId,
            originalName: "rollback.bin",
            declaredMediaType: "application/octet-stream",
            detectedMediaType: "application/octet-stream",
            byteSize: BigInt(bytes.byteLength),
            status: "ready",
            verifiedAt: new Date(),
          },
        });
      });

      const failingDb = {
        $transaction: vi.fn((
          callback: (client: never) => Promise<unknown>,
          options?: { maxWait?: number; timeout?: number },
        ) => db.$transaction(async (tx) => callback({
          readyObjectIntegrityIncident: tx.readyObjectIntegrityIncident,
          $queryRaw: tx.$queryRaw.bind(tx),
          blob: tx.blob,
          fileAsset: tx.fileAsset,
          canvasVisualCapability: {
            updateMany: vi.fn(async () => {
              throw new Error("FORCED_INTEGRITY_TRANSACTION_ROLLBACK");
            }),
          },
        } as never), options)),
      };
      let exposedBody: Readable | undefined;
      await expect((async () => {
        const result = await readReadyObject(
          storage as never,
          {
            storageKey,
            sha256,
            byteSize: bytes.byteLength,
            mediaType: "application/octet-stream",
          },
          undefined,
          undefined,
          { recordIntegrityFailure: readyObjectIntegrityRecorder(failingDb as never) },
        );
        exposedBody = result.body;
      })()).rejects.toThrow("READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED");
      expect(exposedBody).toBeUndefined();
      await expect(db.readyObjectIntegrityIncident.count({ where: { storageKey } })).resolves.toBe(0);
      await expect(db.blob.findUniqueOrThrow({
        where: { id: blobId },
        select: { status: true, storageDeletedAt: true, gcEligibleAt: true },
      })).resolves.toEqual({ status: "ready", storageDeletedAt: null, gcEligibleAt: null });
      await expect(db.fileAsset.findUniqueOrThrow({
        where: { id: fileId },
        select: { status: true, revision: true, failureCode: true },
      })).resolves.toEqual({ status: "ready", revision: 0, failureCode: null });
      expect(storage.getObject).toHaveBeenCalledOnce();
    } finally {
      await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
      await db.blob.deleteMany({ where: { id: blobId } }).catch(() => undefined);
      await db.principal.deleteMany({ where: { id: principalId } }).catch(() => undefined);
      await db.$disconnect();
    }
  }, 30_000);
});

async function waitForBlockedBy(
  observer: PrismaClient,
  applicationName: string,
  blockerPid: number,
): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{
      pid: number;
      blockingPids: number[];
      waitEventType: string | null;
    }>>(Prisma.sql`
      SELECT
        "pid",
        pg_blocking_pids("pid") AS "blockingPids",
        "wait_event_type" AS "waitEventType"
      FROM pg_stat_activity
      WHERE "application_name" = ${applicationName}
        AND "state" = 'active'
      ORDER BY "query_start" DESC
    `);
    const blocked = rows.find((row) => (
      row.blockingPids.includes(blockerPid) && row.waitEventType === "Lock"
    ));
    if (blocked) return blocked.pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`INTEGRITY_TEST_EXPECTED_LOCK_NOT_OBSERVED:${applicationName}:${blockerPid}`);
}

function connectionUrl(applicationName: string): string {
  const url = new URL(databaseUrl!);
  url.searchParams.set("application_name", applicationName);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
