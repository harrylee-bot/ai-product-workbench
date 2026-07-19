import { randomUUID } from "node:crypto";
import {
  fileExtractionOutputSchemaVersion,
  fileExtractionParser,
  fileExtractionParserVersion,
} from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { RetryableExtractionError, TerminalExtractionError } from "./extraction.errors.js";
import type {
  ExtractionCommand,
  ExtractionDelivery,
  ExtractionOutcome,
  ExtractionReconciliationCandidate,
  ExtractionStart,
  ExtractionStore,
  ExtractionTerminalMetadata,
  NormalizedOutputIdentity,
  OutputBlobReservation,
} from "./extraction.store.js";

const RESERVATION_RETRIES = 3;

const commandSelect = {
  id: true,
  fileAssetId: true,
  status: true,
  parser: true,
  parserVersion: true,
  outputSchemaVersion: true,
  processingAttempts: true,
  submissionGeneration: true,
  submissionStartedAt: true,
  externalTaskId: true,
  startedAt: true,
  leaseToken: true,
  leaseExpiresAt: true,
  file: {
    select: {
      status: true,
      originalName: true,
      blobId: true,
      detectedMediaType: true,
    },
  },
  sourceBlob: {
    select: {
      id: true,
      storageKey: true,
      sha256: true,
      byteSize: true,
      mediaType: true,
      status: true,
      deletedAt: true,
      scans: { orderBy: { attempt: "desc" as const }, take: 1, select: { status: true } },
    },
  },
} as const satisfies Prisma.FileExtractionSelect;

type CommandRow = Prisma.FileExtractionGetPayload<{ select: typeof commandSelect }>;

export class PrismaExtractionStore implements ExtractionStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: {
      canonicalBlobPrefix: string;
      pendingBlobPrefix: string;
      doclingImageDigest: string;
      parserOptionsSha256: string;
      parserComponents: Record<string, string>;
    },
  ) {}

  async beginDelivery(
    extractionId: string,
    delivery: ExtractionDelivery,
    maximumAttempts: number,
    leaseMs: number,
  ): Promise<ExtractionStart> {
    const leaseToken = `${delivery.queueJobId}:${delivery.retryCount}`;
    return this.db.$transaction(async (tx) => {
      await lockExtraction(tx, extractionId);
      const row = await tx.fileExtraction.findUnique({ where: { id: extractionId }, select: commandSelect });
      if (!row) return { kind: "terminal", outcome: "missing" };
      const terminal = terminalOutcome(row.status);
      if (terminal) return { kind: "terminal", outcome: terminal };

      const now = new Date();
      if (row.leaseToken !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > now) {
        return { kind: "busy" };
      }

      if (!validParserContract(row)) {
        await this.finishFailure(tx, row, new TerminalExtractionError(
          "failed",
          "FILE_EXTRACTION_PARSER_CONTRACT_MISMATCH",
          "The extraction parser contract does not match this worker",
        ));
        return { kind: "terminal", outcome: "failed" };
      }
      if (!validSource(row)) {
        await this.finishFailure(tx, row, new TerminalExtractionError(
          "failed",
          "FILE_EXTRACTION_SOURCE_UNAVAILABLE",
          "The verified extraction source is no longer available",
        ));
        return { kind: "terminal", outcome: "failed" };
      }
      if (row.processingAttempts >= maximumAttempts) {
        await this.finishFailure(tx, row, exhaustedError("FILE_EXTRACTION_ATTEMPTS_EXHAUSTED"));
        return { kind: "terminal", outcome: "failed" };
      }

      if (row.status === "running" && row.externalTaskId === null) {
        await this.finishFailure(tx, row, new TerminalExtractionError(
          "failed",
          "DOCLING_SUBMISSION_AMBIGUOUS",
          "A Docling submission started without a durable task checkpoint; this extraction will not be resubmitted",
        ));
        return { kind: "terminal", outcome: "failed" };
      }

      const needsSubmission = row.status === "queued";
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const updated = await tx.fileExtraction.update({
        where: { id: extractionId },
        data: {
          status: "running",
          startedAt: row.startedAt ?? now,
          processingAttempts: { increment: 1 },
          leaseToken,
          leaseExpiresAt,
          ...(needsSubmission
            ? { submissionGeneration: 1, submissionStartedAt: now }
            : {}),
        },
        select: commandSelect,
      });
      return {
        kind: "run",
        leaseToken,
        needsSubmission,
        command: mapCommand(updated),
      };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async checkpointTask(extractionId: string, leaseToken: string, taskId: string) {
    await this.db.$transaction(async (tx) => {
      await lockExtraction(tx, extractionId);
      const row = await tx.fileExtraction.findUnique({
        where: { id: extractionId },
        select: { status: true, leaseToken: true, submissionGeneration: true, externalTaskId: true },
      });
      if (!row) throw new TerminalExtractionError("failed", "FILE_EXTRACTION_MISSING", "The extraction no longer exists");
      if (row.status !== "running" || row.leaseToken !== leaseToken || row.submissionGeneration !== 1) {
        throw new TerminalExtractionError("failed", "FILE_EXTRACTION_LEASE_LOST", "The extraction lease was lost before task checkpoint");
      }
      if (row.externalTaskId !== null) {
        if (row.externalTaskId !== taskId) {
          throw new TerminalExtractionError("failed", "DOCLING_TASK_ID_CONFLICT", "The extraction already checkpoints another Docling task");
        }
        return;
      }
      await tx.fileExtraction.update({
        where: { id: extractionId },
        data: { externalTaskId: taskId, taskCheckpointedAt: new Date() },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async reserveOutputBlob(identity: NormalizedOutputIdentity) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RESERVATION_RETRIES; attempt += 1) {
      try {
        return await this.reserveOutputOnce(identity);
      } catch (error) {
        lastError = error;
        if (!isUniqueConflict(error) || attempt === RESERVATION_RETRIES) throw error;
      }
    }
    throw lastError;
  }

  async publishReady(
    extractionId: string,
    leaseToken: string,
    outputs: OutputBlobReservation[],
    metadata: ExtractionTerminalMetadata,
  ): Promise<ExtractionOutcome> {
    if (outputs.length !== 2 || new Set(outputs.map((output) => output.kind)).size !== 2) {
      throw new TerminalExtractionError("failed", "FILE_EXTRACTION_OUTPUT_SET_INVALID", "The normalized output set is incomplete");
    }
    return this.db.$transaction(async (tx) => {
      for (const sha256 of [...new Set(outputs.map((output) => output.sha256))].sort()) {
        await advisoryShaLock(tx, sha256);
      }
      await lockExtraction(tx, extractionId);
      const extraction = await tx.fileExtraction.findUnique({
        where: { id: extractionId },
        select: {
          id: true,
          fileAssetId: true,
          sourceBlobId: true,
          status: true,
          leaseToken: true,
          externalTaskId: true,
          submissionGeneration: true,
        },
      });
      if (!extraction) return "missing";
      const terminal = terminalOutcome(extraction.status);
      if (terminal) return terminal;
      if (
        extraction.status !== "running"
        || extraction.leaseToken !== leaseToken
        || extraction.externalTaskId !== metadata.taskId
        || extraction.submissionGeneration !== 1
      ) {
        throw new TerminalExtractionError("failed", "FILE_EXTRACTION_LEASE_LOST", "The extraction lease was lost before publication");
      }

      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "file_assets" WHERE "id" = ${extraction.fileAssetId} FOR UPDATE
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "blobs"
        WHERE "id" IN (${Prisma.join(outputs.map((output) => output.blobId))})
        ORDER BY "id" FOR UPDATE
      `);
      const file = await tx.fileAsset.findUnique({
        where: { id: extraction.fileAssetId },
        select: {
          status: true,
          blobId: true,
          currentExtraction: { select: { attempt: true } },
        },
      });
      if (!file || file.status !== "ready" || file.blobId !== extraction.sourceBlobId) {
        throw new TerminalExtractionError("failed", "FILE_EXTRACTION_SOURCE_UNAVAILABLE", "The source file is no longer ready");
      }

      for (const output of outputs) {
        const blob = await tx.blob.findUnique({ where: { id: output.blobId } });
        if (
          !blob
          || blob.sha256 !== output.sha256
          || safeByteSize(blob.byteSize) !== output.byteSize
          || blob.mediaType !== output.storedMediaType
          || !["pending", "ready"].includes(blob.status)
        ) {
          throw new TerminalExtractionError("failed", "FILE_EXTRACTION_OUTPUT_BLOB_INVALID", "A normalized output Blob changed before publication");
        }
        if (blob.status === "pending") {
          await tx.blob.update({
            where: { id: blob.id },
            data: {
              status: "ready",
              storageKey: output.canonicalStorageKey,
              verifiedAt: new Date(),
              gcEligibleAt: null,
            },
          });
        } else if (blob.storageKey !== output.canonicalStorageKey) {
          throw new TerminalExtractionError("failed", "FILE_EXTRACTION_OUTPUT_STORAGE_INVALID", "A normalized output Blob has an invalid storage locator");
        }
      }

      const existingOutputs = await tx.fileExtractionOutput.findMany({
        where: { extractionId },
        orderBy: [{ kind: "asc" }, { position: "asc" }],
      });
      if (existingOutputs.length > 0) {
        const exact = existingOutputs.length === outputs.length && existingOutputs.every((existing) =>
          outputs.some((output) => existing.kind === output.kind && existing.position === output.position && existing.blobId === output.blobId));
        if (!exact) throw new TerminalExtractionError("failed", "FILE_EXTRACTION_OUTPUT_CONFLICT", "The extraction already has different normalized outputs");
      } else {
        await tx.fileExtractionOutput.createMany({
          data: outputs.map((output) => ({
            extractionId,
            kind: output.kind,
            position: output.position,
            blobId: output.blobId,
            metadata: {
              schemaVersion: fileExtractionOutputSchemaVersion,
              format: output.kind,
              sha256: output.sha256,
              byteSize: output.byteSize,
            },
          })),
        });
      }

      const markdown = outputs.find((output) => output.kind === "markdown");
      if (!markdown) throw new Error("FILE_EXTRACTION_MARKDOWN_OUTPUT_MISSING");
      const currentAttempt = file.currentExtraction?.attempt ?? 0;
      const current = await tx.fileExtraction.update({
        where: { id: extractionId },
        data: {
          status: "ready",
          contentSha256: markdown.sha256,
          failureCode: null,
          failureDetail: null,
          metadata: this.terminalMetadata(metadata.taskId, 1, "ready", metadata),
          finishedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
        select: { attempt: true },
      });
      if (current.attempt >= currentAttempt) {
        await tx.fileAsset.update({
          where: { id: extraction.fileAssetId },
          data: { currentExtractionId: extractionId, revision: { increment: 1 } },
        });
      }
      return "ready";
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  async fail(extractionId: string, leaseToken: string | null, error: TerminalExtractionError) {
    return this.db.$transaction(async (tx) => {
      await lockExtraction(tx, extractionId);
      const row = await tx.fileExtraction.findUnique({ where: { id: extractionId }, select: commandSelect });
      if (!row) return "missing";
      const terminal = terminalOutcome(row.status);
      if (terminal) return terminal;
      if (leaseToken !== null && row.leaseToken !== leaseToken) return "busy";
      await this.finishFailure(tx, row, error);
      return error.terminalStatus;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async recordRetryableFailure(
    extractionId: string,
    leaseToken: string,
    error: RetryableExtractionError,
    exhausted: boolean,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockExtraction(tx, extractionId);
      const row = await tx.fileExtraction.findUnique({ where: { id: extractionId }, select: commandSelect });
      if (!row) return "missing";
      const terminal = terminalOutcome(row.status);
      if (terminal) return terminal;
      if (row.leaseToken !== leaseToken) return "busy";
      if (exhausted) {
        await this.finishFailure(tx, row, exhaustedError(error.code));
        return "failed";
      }
      await tx.fileExtraction.update({
        where: { id: extractionId },
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
          failureCode: error.code,
          failureDetail: safeDetail(error.safeDetail),
        },
      });
      return null;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async exhaust(extractionId: string, code: string) {
    return this.db.$transaction(async (tx) => {
      await lockExtraction(tx, extractionId);
      const row = await tx.fileExtraction.findUnique({ where: { id: extractionId }, select: commandSelect });
      if (!row) return "missing";
      const terminal = terminalOutcome(row.status);
      if (terminal) return terminal;
      await this.finishFailure(tx, row, exhaustedError(code));
      return "failed";
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async findReconciliationCandidates(before: Date, limit: number): Promise<ExtractionReconciliationCandidate[]> {
    const rows = await this.db.fileExtraction.findMany({
      where: {
        status: { in: ["queued", "running"] },
        updatedAt: { lt: before },
        OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: new Date() } }],
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true, processingAttempts: true },
    });
    return rows.map((row) => ({ extractionId: row.id, processingAttempts: row.processingAttempts }));
  }

  private async reserveOutputOnce(identity: NormalizedOutputIdentity): Promise<OutputBlobReservation> {
    return this.db.$transaction(async (tx) => {
      await advisoryShaLock(tx, identity.sha256);
      const active = await tx.blob.findFirst({
        where: { sha256: identity.sha256, status: { not: "deleted" } },
        orderBy: { generation: "desc" },
      });
      if (active) {
        if (
          active.status === "quarantined"
          || safeByteSize(active.byteSize) !== identity.byteSize
          || active.mediaType !== identity.mediaType
        ) {
          throw new TerminalExtractionError("failed", "FILE_EXTRACTION_OUTPUT_IDENTITY_CONFLICT", "A normalized output digest conflicts with an unavailable Blob");
        }
        return mapReservation(active, identity, this.config.canonicalBlobPrefix);
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
          storageKey: stableKey(this.config.pendingBlobPrefix, identity.sha256, generation),
          mediaType: identity.mediaType,
          byteSize: BigInt(identity.byteSize),
          status: "pending",
        },
      });
      return mapReservation(created, identity, this.config.canonicalBlobPrefix);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async finishFailure(tx: Prisma.TransactionClient, row: CommandRow, error: TerminalExtractionError) {
    await tx.fileExtraction.update({
      where: { id: row.id },
      data: {
        status: error.terminalStatus,
        contentSha256: null,
        failureCode: error.code,
        failureDetail: safeDetail(error.safeDetail),
        metadata: this.terminalMetadata(row.externalTaskId, row.submissionGeneration, error.terminalStatus),
        finishedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }

  private terminalMetadata(
    taskId: string | null,
    submissionGeneration: number,
    outcome: "ready" | "failed" | "unsupported",
    result?: ExtractionTerminalMetadata,
  ): Prisma.InputJsonValue {
    return {
      protocol: "workbench.file-extraction.docling.v1",
      parserImageDigest: this.config.doclingImageDigest,
      parserOptionsSha256: this.config.parserOptionsSha256,
      parserComponents: this.config.parserComponents,
      submissionGeneration,
      externalTaskId: taskId,
      outcome,
      ...(result
        ? {
            doclingStatus: result.doclingStatus,
            processingTimeSeconds: result.processingTimeSeconds,
            errorCount: result.errorCount,
          }
        : {}),
    };
  }
}

function mapCommand(row: CommandRow): ExtractionCommand {
  if (row.status !== "running" || row.startedAt === null) throw new Error("FILE_EXTRACTION_COMMAND_NOT_RUNNING");
  return {
    id: row.id,
    fileAssetId: row.fileAssetId,
    status: row.status,
    parser: row.parser,
    parserVersion: row.parserVersion,
    outputSchemaVersion: row.outputSchemaVersion,
    processingAttempts: row.processingAttempts,
    submissionGeneration: row.submissionGeneration,
    startedAt: row.startedAt,
    externalTaskId: row.externalTaskId,
    source: {
      storageKey: row.sourceBlob.storageKey,
      sha256: row.sourceBlob.sha256,
      byteSize: safeByteSize(row.sourceBlob.byteSize),
      mediaType: row.sourceBlob.mediaType,
      fileName: row.file.originalName,
    },
  };
}

function validParserContract(row: CommandRow) {
  return row.parser === fileExtractionParser
    && row.parserVersion === fileExtractionParserVersion
    && row.outputSchemaVersion === fileExtractionOutputSchemaVersion;
}

function validSource(row: CommandRow) {
  return row.file.status === "ready"
    && row.file.blobId === row.sourceBlob.id
    && row.file.detectedMediaType === row.sourceBlob.mediaType
    && row.sourceBlob.status === "ready"
    && row.sourceBlob.deletedAt === null
    && row.sourceBlob.scans[0]?.status === "clean";
}

function mapReservation(
  blob: { id: string; sha256: string; generation: number; storageKey: string; mediaType: string; byteSize: bigint; status: string },
  identity: NormalizedOutputIdentity,
  canonicalPrefix: string,
): OutputBlobReservation {
  if (blob.status !== "pending" && blob.status !== "ready") throw new Error("FILE_EXTRACTION_OUTPUT_BLOB_UNAVAILABLE");
  return {
    ...identity,
    blobId: blob.id,
    generation: blob.generation,
    storageKey: blob.storageKey,
    canonicalStorageKey: stableKey(canonicalPrefix, blob.sha256, blob.generation),
    storedMediaType: blob.mediaType,
    status: blob.status,
  };
}

async function lockExtraction(tx: Prisma.TransactionClient, extractionId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "file_extractions" WHERE "id" = ${extractionId} FOR UPDATE
  `);
}

async function advisoryShaLock(tx: Prisma.TransactionClient, sha256: string) {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${sha256}, 0))::TEXT AS "lock_receipt"`,
  );
}

function stableKey(prefix: string, sha256: string, generation: number) {
  return `${prefix}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g${generation}`;
}

function terminalOutcome(status: string): Exclude<ExtractionOutcome, "missing" | "busy"> | null {
  if (status === "ready" || status === "unsupported" || status === "failed") return status;
  return null;
}

function exhaustedError(lastCode: string) {
  return new TerminalExtractionError(
    "failed",
    "FILE_EXTRACTION_RETRY_EXHAUSTED",
    `File extraction retry budget was exhausted after ${safeCode(lastCode)}`,
  );
}

function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || BigInt(number) !== value) {
    throw new Error("FILE_EXTRACTION_SIZE_INVALID");
  }
  return number;
}

function safeDetail(value: string) {
  return value.replace(/[\r\n\0]/g, " ").slice(0, 512) || "File extraction failed";
}

function safeCode(value: string) {
  return value.replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 120) || "UNKNOWN";
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
