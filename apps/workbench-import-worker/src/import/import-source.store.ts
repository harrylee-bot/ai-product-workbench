import { randomUUID } from "node:crypto";
import {
  createImportSourceRequestSchema,
  importSourceProcessJobSchema,
  type ImportSourceProcessJob,
  type CreateImportSourceRequest,
} from "@workbench/workbench-contracts";
import {
  Prisma,
  type PrismaClient,
} from "@workbench/workbench-db";
import type { ScanResult } from "@workbench/workbench-content-security";
import { RetryableImportError, TerminalImportError, safeFailure } from "../errors.js";
import type { FrozenImport } from "./source-types.js";

export type ImportDelivery = {
  queueJobId: string;
  leaseMs: number;
};

export type ImportCommand = {
  id: string;
  projectId: string;
  requestHash: string;
  request: Exclude<CreateImportSourceRequest, { kind: "file" | "design_md" }>;
};

export type AttemptStart =
  | { kind: "run"; attemptId: string; attemptNumber: number; leaseToken: string; command: ImportCommand }
  | { kind: "terminal"; status: "ready" | "failed" | "deleted" }
  | { kind: "busy" };

export type ReservedBlob = {
  id: string;
  generation: number;
  status: "pending" | "ready";
  storageKey: string;
  canonicalStorageKey: string;
  sha256: string;
  mediaType: string;
  byteSize: number;
  latestScanStatus: string | null;
};

export type ReconciliationCandidate = {
  sourceId: string;
  projectId: string;
  requestHash: string;
  nextAttempt: number;
};

export type ImportFailureDisposition = "retryable" | "terminal" | "exhausted";

export type LeaseReconciliationResult = {
  expired: number;
  retryable: number;
  exhausted: number;
};

export class PrismaImportSourceStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly prefixes: { pending: string; canonical: string },
  ) {}

  async beginAttempt(sourceId: string, delivery: ImportDelivery): Promise<AttemptStart> {
    return this.db.$transaction(async (tx) => {
      await lockSource(tx, sourceId);
      const source = await tx.importSource.findUnique({
        where: { id: sourceId },
        select: {
          id: true,
          projectId: true,
          status: true,
          request: true,
          requestHash: true,
          attempts: { where: { queueJobId: delivery.queueJobId }, take: 1 },
        },
      });
      if (!source) return { kind: "terminal", status: "deleted" };
      if (source.status !== "pending") return { kind: "terminal", status: source.status };
      const attempt = source.attempts[0];
      if (!attempt || !["queued", "running"].includes(attempt.status)) return { kind: "busy" };
      const parsed = createImportSourceRequestSchema.parse(source.request);
      if (parsed.kind === "file" || parsed.kind === "design_md") throw new TerminalImportError("IMPORT_LOCAL_SOURCE_QUEUED", "Local files must not enter the external import queue");
      if (attempt.status === "running") return { kind: "busy" };
      const leaseToken = randomUUID();
      const now = new Date();
      const updated = await tx.importSourceAttempt.updateMany({
        where: { id: attempt.id, status: "queued" },
        data: {
          status: "running",
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + delivery.leaseMs),
          startedAt: now,
        },
      });
      if (updated.count !== 1) return { kind: "busy" };
      return {
        kind: "run",
        attemptId: attempt.id,
        attemptNumber: attempt.attempt,
        leaseToken,
        command: { id: source.id, projectId: source.projectId, requestHash: source.requestHash, request: parsed },
      };
    });
  }

  async touchAttempt(attemptId: string, leaseToken: string, leaseMs: number) {
    const now = new Date();
    const result = await this.db.importSourceAttempt.updateMany({
      where: { id: attemptId, status: "running", leaseToken, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) },
    });
    if (result.count !== 1) throw new RetryableImportError("IMPORT_LEASE_LOST", "The import attempt lease was lost");
  }

  async reserveBlob(input: { sha256: string; mediaType: string; byteSize: number }): Promise<ReservedBlob> {
    return this.db.$transaction(async (tx) => {
      await advisoryShaLock(tx, input.sha256);
      const active = await tx.blob.findFirst({
        where: { sha256: input.sha256, status: { not: "deleted" } },
        include: { scans: { orderBy: { attempt: "desc" }, take: 1 } },
      });
      if (active) {
        if (Number(active.byteSize) !== input.byteSize || active.mediaType !== input.mediaType || active.status === "quarantined") {
          throw new TerminalImportError("IMPORT_BLOB_IDENTITY_CONFLICT", "Downloaded source content conflicts with an existing content identity");
        }
        return mapBlob(active, this.prefixes);
      }
      const generation = ((await tx.blob.aggregate({ where: { sha256: input.sha256 }, _max: { generation: true } }))._max.generation ?? 0) + 1;
      const created = await tx.blob.create({
        data: {
          id: `blob_${randomUUID()}`,
          sha256: input.sha256,
          generation,
          storageKey: stableKey(this.prefixes.pending, input.sha256, generation),
          mediaType: input.mediaType,
          byteSize: BigInt(input.byteSize),
          status: "pending",
        },
        include: { scans: { orderBy: { attempt: "desc" }, take: 1 } },
      });
      return mapBlob(created, this.prefixes);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async publishCleanBlob(blob: ReservedBlob, scan: ScanResult): Promise<void> {
    if (scan.status !== "clean" || scan.evidence === null) throw new TerminalImportError("IMPORT_CLEAN_SCAN_REQUIRED", "Import source blobs require clean malware scan evidence");
    await this.db.$transaction(async (tx) => {
      await advisoryShaLock(tx, blob.sha256);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "blobs" WHERE "id" = ${blob.id} FOR UPDATE`);
      const current = await tx.blob.findUnique({
        where: { id: blob.id },
        include: { scans: { orderBy: { attempt: "desc" }, take: 1 } },
      });
      if (!current || current.status === "deleted" || current.status === "quarantined") throw new TerminalImportError("IMPORT_BLOB_UNAVAILABLE", "The reserved source blob is unavailable");
      if (current.status === "ready" && current.scans[0]?.status === "clean") return;
      const attempt = ((await tx.blobScan.aggregate({ where: { blobId: blob.id }, _max: { attempt: true } }))._max.attempt ?? 0) + 1;
      await tx.blobScan.create({
        data: {
          id: `scan_${randomUUID()}`,
          blobId: blob.id,
          attempt,
          status: "clean",
          scanner: scan.scanner,
          scannerVersion: scan.scannerVersion,
          signatureVersion: scan.signatureVersion,
          evidence: scan.evidence as Prisma.InputJsonValue,
          startedAt: scan.startedAt,
          finishedAt: scan.finishedAt,
        },
      });
      await tx.blob.update({
        where: { id: blob.id },
        data: {
          status: "ready",
          storageKey: blob.canonicalStorageKey,
          verifiedAt: new Date(),
          gcEligibleAt: null,
        },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async completeReady(attemptId: string, leaseToken: string, frozen: FrozenImport, blobs: readonly ReservedBlob[]) {
    if (frozen.blobs.length !== blobs.length || blobs.length === 0) throw new Error("IMPORT_BLOB_MANIFEST_INVALID");
    await this.db.$transaction(async (tx) => {
      const attempt = await lockAttempt(tx, attemptId);
      if (!hasActiveLease(attempt, leaseToken)) throw new RetryableImportError("IMPORT_LEASE_LOST", "The import attempt lease was lost");
      await lockSource(tx, attempt.importSourceId);
      const source = await tx.importSource.findUnique({ where: { id: attempt.importSourceId }, select: { status: true, projectId: true } });
      if (!source || source.status !== "pending" || source.projectId !== attempt.projectId) throw new RetryableImportError("IMPORT_SOURCE_STATE_CHANGED", "The import source changed while it was being frozen");
      for (const [position, [manifest, blob]] of frozen.blobs.map((item, index) => [item, blobs[index]!] as const).entries()) {
        await tx.importSourceBlob.create({
          data: {
            id: `source_blob_${randomUUID()}`,
            importSourceId: attempt.importSourceId,
            projectId: attempt.projectId,
            position,
            blobId: blob.id,
            fileAssetId: null,
            role: position === 0 ? "primary" : "source_file",
            path: manifest.path,
            mediaType: manifest.mediaType,
            byteSize: BigInt(manifest.bytes.byteLength),
            sha256: manifest.sha256,
          },
        });
      }
      await tx.importSource.update({
        where: { id: attempt.importSourceId },
        data: { status: "ready", descriptor: frozen.descriptor as Prisma.InputJsonValue, checksum: frozen.checksum, revision: { increment: 1 } },
      });
      await tx.importSourceAttempt.update({
        where: { id: attempt.id },
        data: { status: "succeeded", leaseToken: null, leaseExpiresAt: null, finishedAt: new Date() },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async recordFailure(attemptId: string, leaseToken: string, error: unknown, disposition: ImportFailureDisposition) {
    const attemptFailure = safeFailure(error);
    const sourceFailure = disposition === "exhausted"
      ? {
          code: "IMPORT_ATTEMPTS_EXHAUSTED",
          detail: "The source could not be frozen after the maximum number of attempts",
        }
      : attemptFailure;
    await this.db.$transaction(async (tx) => {
      const attempt = await lockAttempt(tx, attemptId);
      if (!hasActiveLease(attempt, leaseToken)) return;
      await lockSource(tx, attempt.importSourceId);
      const finishedAt = new Date();
      await tx.importSourceAttempt.update({
        where: { id: attempt.id },
        data: {
          status: disposition === "retryable" ? "retryable_failed" : "terminal_failed",
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: attemptFailure.code,
          failureDetail: attemptFailure.detail,
          finishedAt,
        },
      });
      if (disposition !== "retryable") {
        await tx.importSource.updateMany({
          where: { id: attempt.importSourceId, status: "pending" },
          data: { status: "failed", failureCode: sourceFailure.code, failureDetail: sourceFailure.detail, revision: { increment: 1 } },
        });
      }
    });
  }

  async expireStaleAttempts(before: Date, maximumAttempts: number, limit: number): Promise<LeaseReconciliationResult> {
    const now = new Date();
    return this.db.$transaction(async (tx) => {
      const attempts = await tx.$queryRaw<Array<{ id: string; sourceId: string; attempt: number }>>(Prisma.sql`
        SELECT attempt."id", attempt."import_source_id" AS "sourceId", attempt."attempt"
        FROM "import_source_attempts" AS attempt
        INNER JOIN "import_sources" AS source ON source."id" = attempt."import_source_id"
        WHERE source."status" = 'pending'
          AND attempt."status" = 'running'
          AND attempt."lease_expires_at" <= ${now}
          AND attempt."updated_at" <= ${before}
        ORDER BY attempt."updated_at", attempt."id"
        LIMIT ${limit}
        FOR UPDATE OF attempt, source SKIP LOCKED
      `);
      let retryable = 0;
      let exhausted = 0;
      for (const attempt of attempts) {
        const isExhausted = attempt.attempt >= maximumAttempts;
        const updated = await tx.importSourceAttempt.updateMany({
          where: {
            id: attempt.id,
            status: "running",
            leaseExpiresAt: { lte: now },
            updatedAt: { lte: before },
          },
          data: {
            status: isExhausted ? "terminal_failed" : "retryable_failed",
            leaseToken: null,
            leaseExpiresAt: null,
            failureCode: "IMPORT_LEASE_EXPIRED",
            failureDetail: "The import worker stopped renewing its attempt lease",
            finishedAt: now,
          },
        });
        if (updated.count !== 1) continue;
        if (isExhausted) {
          await tx.importSource.updateMany({
            where: { id: attempt.sourceId, status: "pending" },
            data: {
              status: "failed",
              failureCode: "IMPORT_ATTEMPTS_EXHAUSTED",
              failureDetail: "The source could not be frozen after the maximum number of attempts",
              revision: { increment: 1 },
            },
          });
          exhausted += 1;
        } else {
          retryable += 1;
        }
      }
      return { expired: retryable + exhausted, retryable, exhausted };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async scheduleRetry(
    candidate: ReconciliationCandidate,
    enqueue: (tx: Prisma.TransactionClient, payload: ImportSourceProcessJob) => Promise<string>,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockSource(tx, candidate.sourceId);
      const source = await tx.importSource.findUnique({
        where: { id: candidate.sourceId },
        select: { id: true, projectId: true, status: true, requestHash: true, attempts: { orderBy: { attempt: "desc" }, take: 1 } },
      });
      if (!source || source.status !== "pending" || source.requestHash !== candidate.requestHash) return false;
      if (source.attempts[0] && ["queued", "running"].includes(source.attempts[0].status)) return false;
      const attempt = (source.attempts[0]?.attempt ?? 0) + 1;
      if (attempt !== candidate.nextAttempt) return false;
      const payload = importSourceProcessJobSchema.parse({ sourceId: source.id, projectId: source.projectId, requestHash: source.requestHash });
      const queueJobId = await enqueue(tx, payload);
      await tx.importSourceAttempt.create({
        data: {
          id: `import_attempt_${randomUUID()}`,
          importSourceId: source.id,
          projectId: source.projectId,
          attempt,
          queueJobId,
          status: "queued",
        },
      });
      return true;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async reconciliationCandidates(before: Date, maximumAttempts: number, limit: number): Promise<ReconciliationCandidate[]> {
    const rows = await this.db.$queryRaw<Array<{ sourceId: string; projectId: string; requestHash: string; attemptCount: bigint }>>(Prisma.sql`
      SELECT source."id" AS "sourceId", source."project_id" AS "projectId",
             source."request_hash" AS "requestHash", COUNT(attempt."id")::BIGINT AS "attemptCount"
      FROM "import_sources" AS source
      LEFT JOIN "import_source_attempts" AS attempt ON attempt."import_source_id" = source."id"
      WHERE source."status" = 'pending'
        AND source."kind" IN ('url_snapshot', 'github_snapshot', 'figma_snapshot')
        AND NOT EXISTS (
          SELECT 1 FROM "import_source_attempts" AS active
          WHERE active."import_source_id" = source."id" AND active."status" IN ('queued', 'running')
        )
        AND EXISTS (
          SELECT 1 FROM "import_source_attempts" AS failed
          WHERE failed."import_source_id" = source."id"
            AND failed."status" = 'retryable_failed'
            AND (failed."failure_code" = 'IMPORT_LEASE_EXPIRED' OR failed."updated_at" <= ${before})
        )
      GROUP BY source."id", source."project_id", source."request_hash", source."created_at"
      HAVING COUNT(attempt."id") < ${maximumAttempts}
      ORDER BY source."created_at", source."id"
      LIMIT ${limit}
    `);
    return rows.map((row) => ({ sourceId: row.sourceId, projectId: row.projectId, requestHash: row.requestHash, nextAttempt: Number(row.attemptCount) + 1 }));
  }

}

async function lockSource(tx: Prisma.TransactionClient, sourceId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "import_sources" WHERE "id" = ${sourceId} FOR UPDATE`);
}

async function lockAttempt(tx: Prisma.TransactionClient, attemptId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; importSourceId: string; projectId: string; status: string; leaseToken: string | null; leaseExpiresAt: Date | null }>>(Prisma.sql`
    SELECT "id", "import_source_id" AS "importSourceId", "project_id" AS "projectId", "status"::TEXT,
           "lease_token" AS "leaseToken", "lease_expires_at" AS "leaseExpiresAt"
    FROM "import_source_attempts" WHERE "id" = ${attemptId} FOR UPDATE
  `);
  return rows[0] ?? null;
}

function hasActiveLease(
  attempt: { status: string; leaseToken: string | null; leaseExpiresAt: Date | null } | null,
  leaseToken: string,
) {
  return Boolean(
    attempt
    && attempt.status === "running"
    && attempt.leaseToken === leaseToken
    && attempt.leaseExpiresAt
    && attempt.leaseExpiresAt.getTime() > Date.now(),
  );
}

async function advisoryShaLock(tx: Prisma.TransactionClient, sha256: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${sha256}, 0))::TEXT AS "lock_receipt"`);
}

function mapBlob(blob: { id: string; generation: number; status: string; storageKey: string; sha256: string; mediaType: string; byteSize: bigint; scans: Array<{ status: string }> }, prefixes: { pending: string; canonical: string }): ReservedBlob {
  if (blob.status !== "pending" && blob.status !== "ready") throw new TerminalImportError("IMPORT_BLOB_UNAVAILABLE", "The reserved source blob is unavailable");
  const byteSize = Number(blob.byteSize);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new TerminalImportError("IMPORT_BLOB_SIZE_INVALID", "The reserved source blob size is invalid");
  return {
    id: blob.id,
    generation: blob.generation,
    status: blob.status,
    storageKey: blob.storageKey,
    canonicalStorageKey: stableKey(prefixes.canonical, blob.sha256, blob.generation),
    sha256: blob.sha256,
    mediaType: blob.mediaType,
    byteSize,
    latestScanStatus: blob.scans[0]?.status ?? null,
  };
}

function stableKey(prefix: string, sha256: string, generation: number) {
  return `${prefix}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g${generation}`;
}
