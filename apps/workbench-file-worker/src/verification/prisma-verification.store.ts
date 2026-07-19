import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
} from "@workbench/workbench-db";
import type { ScanResult } from "@workbench/workbench-content-security";
import type { RetryableVerificationError } from "../errors.js";
import {
  ContentIdentityConflictError,
  type AttemptStart,
  type BlobReservation,
  type ContentIdentity,
  type FinalizeVerificationInput,
  type ReconciliationCandidate,
  type VerificationDelivery,
  type VerificationOutcome,
  type VerificationStore,
} from "./verification.store.js";

const RESERVATION_RETRIES = 5;

const blobSelect = {
  id: true,
  sha256: true,
  generation: true,
  storageKey: true,
  mediaType: true,
  byteSize: true,
  status: true,
  scans: {
    orderBy: { attempt: "desc" as const },
    take: 1,
    select: { status: true },
  },
} as const;

export class PrismaVerificationStore implements VerificationStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly prefixes: {
      pending: string;
      canonical: string;
      quarantine: string;
    },
  ) {}

  async beginAttempt(
    uploadSessionId: string,
    delivery: VerificationDelivery,
    maximumAttempts: number,
  ): Promise<AttemptStart> {
    return this.db.$transaction(async (tx) => {
      await lockUploadFile(tx, uploadSessionId);
      const command = await tx.fileUploadSession.findUnique({
        where: { id: uploadSessionId },
        select: { file: { select: { status: true } } },
      });
      if (!command) return { kind: "terminal", outcome: "missing" };
      const terminal = terminalOutcome(command.file.status);
      if (terminal) {
        await tx.fileVerificationAttempt.updateMany({
          where: { uploadSessionId, status: "running" },
          data: { status: "succeeded", fileStatus: terminal, finishedAt: new Date() },
        });
        return { kind: "terminal", outcome: terminal };
      }

      const existing = await tx.fileVerificationAttempt.findUnique({
        where: {
          queueJobId_queueRetryCount: {
            queueJobId: delivery.queueJobId,
            queueRetryCount: delivery.retryCount,
          },
        },
        select: {
          id: true,
          status: true,
          fileStatus: true,
          failureCode: true,
          failureDetail: true,
        },
      });
      if (existing) {
        if (existing.status === "running") return { kind: "run", attemptId: existing.id };
        if (existing.status === "retryable_failed") {
          return {
            kind: "retryable_replay",
            code: existing.failureCode ?? "FILE_VERIFICATION_INFRASTRUCTURE_ERROR",
            detail: existing.failureDetail ?? "File verification infrastructure failed",
          };
        }
        return { kind: "terminal", outcome: terminalOutcome(existing.fileStatus ?? "failed") ?? "failed" };
      }

      const now = new Date();
      await tx.fileVerificationAttempt.updateMany({
        where: { uploadSessionId, status: "running" },
        data: {
          status: "retryable_failed",
          failureCode: "WORKER_DELIVERY_REPLACED",
          failureDetail: "A later queue delivery resumed this verification",
          finishedAt: now,
        },
      });
      const aggregate = await tx.fileVerificationAttempt.aggregate({
        where: { uploadSessionId },
        _count: { _all: true },
        _max: { sequence: true },
      });
      if (aggregate._count._all >= maximumAttempts) {
        await failVerifyingFile(tx, uploadSessionId, "FILE_VERIFICATION_RETRY_EXHAUSTED", "File verification retry budget was exhausted");
        return { kind: "terminal", outcome: "failed" };
      }

      const attempt = await tx.fileVerificationAttempt.create({
        data: {
          id: `verify_${randomUUID()}`,
          uploadSessionId,
          sequence: (aggregate._max.sequence ?? 0) + 1,
          queueJobId: delivery.queueJobId,
          queueRetryCount: delivery.retryCount,
          status: "running",
        },
        select: { id: true },
      });
      return { kind: "run", attemptId: attempt.id };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async touchAttempt(attemptId: string) {
    await this.db.fileVerificationAttempt.updateMany({
      where: { id: attemptId, status: "running" },
      data: { updatedAt: new Date() },
    });
  }

  async completeAttempt(attemptId: string, outcome: VerificationOutcome) {
    if (outcome === "missing") return;
    const updated = await this.db.fileVerificationAttempt.updateMany({
      where: { id: attemptId, status: "running" },
      data: {
        status: "succeeded",
        fileStatus: outcome,
        finishedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      const current = await this.db.fileVerificationAttempt.findUnique({
        where: { id: attemptId },
        select: { status: true, fileStatus: true },
      });
      if (current?.status !== "succeeded" || current.fileStatus !== outcome) {
        throw new Error("FILE_VERIFICATION_ATTEMPT_COMPLETION_LOST");
      }
    }
  }

  async recordRetryableFailure(
    attemptId: string,
    error: RetryableVerificationError,
    exhausted: boolean,
  ): Promise<VerificationOutcome | null> {
    return this.db.$transaction(async (tx) => {
      const identity = await tx.fileVerificationAttempt.findUnique({
        where: { id: attemptId },
        select: { uploadSessionId: true },
      });
      if (!identity) return "missing";
      await lockUploadFile(tx, identity.uploadSessionId);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "file_verification_attempts" WHERE "id" = ${attemptId} FOR UPDATE`,
      );
      const attempt = await tx.fileVerificationAttempt.findUnique({
        where: { id: attemptId },
        select: {
          status: true,
          fileStatus: true,
          uploadSessionId: true,
        },
      });
      if (!attempt) return "missing";
      if (attempt.status !== "running") return attempt.fileStatus ? terminalOutcome(attempt.fileStatus) : null;

      const command = await tx.fileUploadSession.findUnique({
        where: { id: attempt.uploadSessionId },
        select: { file: { select: { status: true } } },
      });
      const committedOutcome = command ? terminalOutcome(command.file.status) : "missing";
      if (committedOutcome) {
        if (committedOutcome !== "missing") {
          await tx.fileVerificationAttempt.update({
            where: { id: attemptId },
            data: { status: "succeeded", fileStatus: committedOutcome, finishedAt: new Date() },
          });
        }
        return committedOutcome;
      }

      const now = new Date();
      if (!exhausted) {
        await tx.fileVerificationAttempt.update({
          where: { id: attemptId },
          data: {
            status: "retryable_failed",
            failureCode: error.code,
            failureDetail: safeDetail(error.safeDetail),
            finishedAt: now,
          },
        });
        return null;
      }

      const outcome = await failVerifyingFile(
        tx,
        attempt.uploadSessionId,
        "FILE_VERIFICATION_RETRY_EXHAUSTED",
        `Last retryable failure: ${error.code}`,
      );
      await tx.fileVerificationAttempt.update({
        where: { id: attemptId },
        data: {
          status: "terminal_failed",
          fileStatus: "failed",
          failureCode: "FILE_VERIFICATION_RETRY_EXHAUSTED",
          failureDetail: `Last retryable failure: ${error.code}`,
          finishedAt: now,
        },
      });
      return outcome;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async exhaustUpload(uploadSessionId: string, lastFailureCode: string): Promise<VerificationOutcome> {
    return this.db.$transaction(async (tx) => {
      await lockUploadFile(tx, uploadSessionId);
      const outcome = await failVerifyingFile(
        tx,
        uploadSessionId,
        "FILE_VERIFICATION_RETRY_EXHAUSTED",
        `Last retryable failure: ${lastFailureCode}`,
      );
      await tx.fileVerificationAttempt.updateMany({
        where: { uploadSessionId, status: "running" },
        data: {
          status: "terminal_failed",
          fileStatus: "failed",
          failureCode: "FILE_VERIFICATION_RETRY_EXHAUSTED",
          failureDetail: `Last retryable failure: ${lastFailureCode}`,
          finishedAt: new Date(),
        },
      });
      return outcome;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async findReconciliationCandidates(before: Date, limit: number): Promise<ReconciliationCandidate[]> {
    const rows = await this.db.fileUploadSession.findMany({
      where: {
        status: "completed",
        file: { is: { status: "verifying" } },
        verificationAttempts: {
          none: { status: "running", updatedAt: { gte: before } },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: {
        id: true,
        _count: { select: { verificationAttempts: true } },
      },
    });
    return rows.map((row) => ({
      uploadSessionId: row.id,
      attemptCount: row._count.verificationAttempts,
    }));
  }

  async load(uploadSessionId: string) {
    const command = await this.db.fileUploadSession.findUnique({
      where: { id: uploadSessionId },
      select: {
        id: true,
        status: true,
        stagingKey: true,
        expectedByteSize: true,
        expectedSha256: true,
        file: {
          select: {
            id: true,
            status: true,
            byteSize: true,
            blobId: true,
          },
        },
      },
    });
    if (!command) return null;
    return {
      uploadSessionId: command.id,
      uploadStatus: command.status,
      stagingKey: command.stagingKey,
      expectedByteSize: command.expectedByteSize,
      expectedSha256: command.expectedSha256,
      file: command.file,
    };
  }

  async reserveBlob(identity: ContentIdentity): Promise<BlobReservation> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RESERVATION_RETRIES; attempt += 1) {
      try {
        return await this.reserveOnce(identity);
      } catch (error) {
        lastError = error;
        if (!isUniqueConflict(error) || attempt === RESERVATION_RETRIES) throw error;
      }
    }
    throw lastError;
  }

  async finalize(input: FinalizeVerificationInput): Promise<VerificationOutcome> {
    return this.db.$transaction(async (tx) => {
      const blobIdentity = await tx.blob.findUnique({
        where: { id: input.blobId },
        select: { sha256: true },
      });
      if (!blobIdentity) throw new Error("FILE_VERIFY_BLOB_MISSING");
      await advisoryShaLock(tx, blobIdentity.sha256);

      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "file_assets"
        WHERE "id" = (
          SELECT "file_asset_id" FROM "file_upload_sessions" WHERE "id" = ${input.uploadSessionId}
        ) OR "blob_id" = ${input.blobId}
        ORDER BY "id"
        FOR UPDATE
      `);
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "blobs" WHERE "id" = ${input.blobId} FOR UPDATE`,
      );

      const command = await tx.fileUploadSession.findUnique({
        where: { id: input.uploadSessionId },
        select: {
          status: true,
          file: { select: { id: true, status: true } },
        },
      });
      if (!command) return "missing";
      const terminal = terminalOutcome(command.file.status);
      if (terminal) return terminal;
      if (command.status !== "completed" || command.file.status !== "verifying") {
        throw new Error("FILE_VERIFY_COMMAND_NOT_READY");
      }

      let blob = await tx.blob.findUnique({ where: { id: input.blobId }, select: blobSelect });
      if (!blob || blob.status === "deleted") throw new Error("FILE_VERIFY_BLOB_UNAVAILABLE");
      const latestScanStatus = blob.scans[0]?.status ?? null;

      if (blob.status === "quarantined" || latestScanStatus === "infected") {
        return this.finishFile(tx, command.file.id, blob, "quarantined", "FILE_MALWARE_DETECTED");
      }

      // A concurrent verifier may have committed clean evidence after this job
      // decided a scan was needed. Keep an infected result authoritative, but a
      // scanner outage must not supersede already-committed clean evidence.
      if (blob.status === "ready" && latestScanStatus === "clean" && input.scan?.status !== "infected") {
        return this.finishFile(tx, command.file.id, blob, "ready", null);
      }

      if (input.scan?.status === "infected") {
        const expectedQuarantineKey = stableKey(this.prefixes.quarantine, blob.sha256, blob.generation);
        if (input.promotedStorageKey !== expectedQuarantineKey) {
          throw new Error("FILE_VERIFY_QUARANTINE_KEY_INVALID");
        }
        if (blob.storageKey !== expectedQuarantineKey) {
          blob = await tx.blob.update({
            where: { id: blob.id },
            data: { storageKey: expectedQuarantineKey },
            select: blobSelect,
          });
        }
        await this.insertScan(tx, blob.id, input.scan);
        blob = await tx.blob.findUnique({ where: { id: blob.id }, select: blobSelect });
        if (!blob || blob.status !== "quarantined") throw new Error("FILE_VERIFY_QUARANTINE_FAILED");
        return this.finishFile(tx, command.file.id, blob, "quarantined", "FILE_MALWARE_DETECTED");
      }

      if (latestScanStatus !== "clean") {
        if (input.scan?.status !== "clean") throw new Error("FILE_VERIFY_CLEAN_EVIDENCE_REQUIRED");
        await this.insertScan(tx, blob.id, input.scan);
      }

      if (blob.status === "pending") {
        const expectedCanonicalKey = stableKey(this.prefixes.canonical, blob.sha256, blob.generation);
        if (input.promotedStorageKey !== expectedCanonicalKey) {
          throw new Error("FILE_VERIFY_CANONICAL_KEY_INVALID");
        }
        blob = await tx.blob.update({
          where: { id: blob.id },
          data: {
            status: "ready",
            storageKey: expectedCanonicalKey,
            verifiedAt: new Date(),
            gcEligibleAt: null,
          },
          select: blobSelect,
        });
      }
      if (blob.status !== "ready") throw new Error("FILE_VERIFY_BLOB_NOT_READY");
      return this.finishFile(tx, command.file.id, blob, "ready", null);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async failFile(uploadSessionId: string, code: string, detail: string | null): Promise<VerificationOutcome> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "file_assets"
        WHERE "id" = (
          SELECT "file_asset_id" FROM "file_upload_sessions" WHERE "id" = ${uploadSessionId}
        )
        FOR UPDATE
      `);
      const command = await tx.fileUploadSession.findUnique({
        where: { id: uploadSessionId },
        select: { status: true, file: { select: { id: true, status: true } } },
      });
      if (!command) return "missing";
      const terminal = terminalOutcome(command.file.status);
      if (terminal) return terminal;
      if (command.status !== "completed" || command.file.status !== "verifying") {
        throw new Error("FILE_VERIFY_COMMAND_NOT_READY");
      }
      const updated = await tx.fileAsset.updateMany({
        where: { id: command.file.id, status: "verifying" },
        data: {
          status: "failed",
          failureCode: code,
          failureDetail: safeDetail(detail),
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("FILE_VERIFY_FINALIZE_LOST");
      return "failed";
    });
  }

  private async reserveOnce(identity: ContentIdentity): Promise<BlobReservation> {
    return this.db.$transaction(async (tx) => {
      await advisoryShaLock(tx, identity.sha256);
      const active = await tx.blob.findFirst({
        where: { sha256: identity.sha256, status: { not: "deleted" } },
        select: blobSelect,
      });
      if (active) {
        if (safeBigInt(active.byteSize) !== identity.byteSize) throw new ContentIdentityConflictError();
        return mapBlob(active, this.prefixes);
      }

      const generation = ((await tx.blob.aggregate({
        where: { sha256: identity.sha256 },
        _max: { generation: true },
      }))._max.generation ?? 0) + 1;
      const created = await tx.blob.create({
        data: {
          id: `blob_${randomUUID()}`,
          sha256: identity.sha256,
          generation,
          storageKey: stableKey(this.prefixes.pending, identity.sha256, generation),
          mediaType: identity.mediaType,
          byteSize: BigInt(identity.byteSize),
          status: "pending",
        },
        select: blobSelect,
      });
      return mapBlob(created, this.prefixes);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async insertScan(
    tx: Prisma.TransactionClient,
    blobId: string,
    scan: ScanResult,
  ) {
    if ((scan.status === "clean" || scan.status === "infected") && scan.evidence === null) {
      throw new Error("FILE_VERIFY_SCAN_EVIDENCE_REQUIRED");
    }
    const latest = await tx.blobScan.aggregate({
      where: { blobId },
      _max: { attempt: true },
    });
    await tx.blobScan.create({
      data: {
        id: `scan_${randomUUID()}`,
        blobId,
        attempt: (latest._max.attempt ?? 0) + 1,
        status: scan.status,
        scanner: scan.scanner,
        scannerVersion: scan.scannerVersion,
        signatureVersion: scan.signatureVersion,
        evidence: scan.evidence === null ? Prisma.DbNull : scan.evidence as Prisma.InputJsonValue,
        failureCode: null,
        failureDetail: null,
        startedAt: scan.startedAt,
        finishedAt: scan.finishedAt,
      },
    });
  }

  private async finishFile(
    tx: Prisma.TransactionClient,
    fileId: string,
    blob: Pick<BlobReservation, "id" | "mediaType"> | null,
    status: "ready" | "failed" | "quarantined",
    failureCode: string | null,
    failureDetail: string | null = null,
  ): Promise<VerificationOutcome> {
    const updated = await tx.fileAsset.updateMany({
      where: { id: fileId, status: "verifying" },
      data: {
        status,
        ...(blob
          ? {
              blobId: blob.id,
              detectedMediaType: blob.mediaType,
              verifiedAt: new Date(),
            }
          : {}),
        failureCode,
        failureDetail,
        revision: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new Error("FILE_VERIFY_FINALIZE_LOST");
    return status;
  }
}

async function advisoryShaLock(tx: Prisma.TransactionClient, sha256: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${sha256}, 0))::TEXT AS "lock_receipt"`,
  );
}

async function lockUploadFile(tx: Prisma.TransactionClient, uploadSessionId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "file_assets"
    WHERE "id" = (
      SELECT "file_asset_id" FROM "file_upload_sessions" WHERE "id" = ${uploadSessionId}
    )
    FOR UPDATE
  `);
}

async function failVerifyingFile(
  tx: Prisma.TransactionClient,
  uploadSessionId: string,
  failureCode: string,
  failureDetail: string,
): Promise<VerificationOutcome> {
  const command = await tx.fileUploadSession.findUnique({
    where: { id: uploadSessionId },
    select: { file: { select: { id: true, status: true } } },
  });
  if (!command) return "missing";
  const terminal = terminalOutcome(command.file.status);
  if (terminal) return terminal;
  if (command.file.status !== "verifying") throw new Error("FILE_VERIFY_COMMAND_NOT_READY");
  const updated = await tx.fileAsset.updateMany({
    where: { id: command.file.id, status: "verifying" },
    data: {
      status: "failed",
      failureCode,
      failureDetail: safeDetail(failureDetail),
      revision: { increment: 1 },
    },
  });
  if (updated.count !== 1) throw new Error("FILE_VERIFY_FINALIZE_LOST");
  return "failed";
}

function mapBlob(
  blob: Prisma.BlobGetPayload<{ select: typeof blobSelect }>,
  prefixes: { canonical: string; quarantine: string },
): BlobReservation {
  if (blob.status === "deleted") throw new Error("FILE_VERIFY_DELETED_BLOB_SELECTED");
  return {
    id: blob.id,
    sha256: blob.sha256,
    generation: blob.generation,
    storageKey: blob.storageKey,
    canonicalStorageKey: stableKey(prefixes.canonical, blob.sha256, blob.generation),
    quarantineStorageKey: stableKey(prefixes.quarantine, blob.sha256, blob.generation),
    mediaType: blob.mediaType,
    byteSize: blob.byteSize,
    status: blob.status,
    latestScanStatus: blob.scans[0]?.status ?? null,
  };
}

function stableKey(prefix: string, sha256: string, generation: number) {
  return `${prefix}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g${generation}`;
}

function terminalOutcome(status: string): Exclude<VerificationOutcome, "missing"> | null {
  if (status === "ready" || status === "failed" || status === "quarantined" || status === "deleted") return status;
  return null;
}

function safeBigInt(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("FILE_VERIFY_SIZE_INVALID");
  return number;
}

function safeDetail(detail: string | null) {
  if (!detail) return null;
  return detail.replace(/[\r\n\0]/g, " ").slice(0, 512) || null;
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
