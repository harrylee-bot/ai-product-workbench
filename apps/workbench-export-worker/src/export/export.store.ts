import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  exportBoardNodeIdsSchema,
  type ExportSelection,
} from "@workbench/workbench-contracts";
import type { ExportWorkerConfig } from "../config.js";

export type ExportCommand = Awaited<ReturnType<PrismaExportStore["loadRunning"]>>;

export type OutputIdentity = {
  sha256: string;
  byteSize: number;
  mediaType: string;
};

export type OutputReservation = OutputIdentity & {
  blobId: string;
  generation: number;
  canonicalStorageKey: string;
};

export class PrismaExportStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: Pick<ExportWorkerConfig, "pendingBlobPrefix" | "canonicalBlobPrefix">,
  ) {}

  async start(exportJobId: string): Promise<
    | { kind: "missing" }
    | { kind: "terminal"; status: string }
    | { kind: "run"; command: ExportCommand }
  > {
    const current = await this.db.exportJob.findUnique({
      where: { id: exportJobId },
      select: { status: true },
    });
    if (!current) return { kind: "missing" as const };
    if (["succeeded", "failed", "cancelled"].includes(current.status)) {
      return { kind: "terminal" as const, status: current.status };
    }
    if (current.status === "queued") {
      const claimed = await this.db.exportJob.updateMany({
        where: { id: exportJobId, status: "queued", outputBlobId: null, finishedAt: null },
        data: {
          status: "running",
          startedAt: new Date(),
          failureCode: null,
          failureDetail: null,
          revision: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        const status = await this.status(exportJobId);
        if (!status) return { kind: "missing" };
        if (["succeeded", "failed", "cancelled"].includes(status)) return { kind: "terminal", status };
        if (status !== "running") throw new Error("EXPORT_JOB_CLAIM_STATE_INVALID");
      }
    }
    return { kind: "run" as const, command: await this.loadRunning(exportJobId) };
  }

  async loadRunning(exportJobId: string) {
    const job = await this.db.exportJob.findUnique({
      where: { id: exportJobId },
      include: {
        release: {
          include: {
            artifactPins: {
              orderBy: { position: "asc" },
              include: {
                artifactVersion: {
                  include: {
                    artifact: { select: { id: true, projectId: true } },
                    contentBlob: true,
                    assets: {
                      orderBy: { assetId: "asc" },
                      include: { blob: true },
                    },
                  },
                },
              },
            },
          },
        },
        preview: {
          include: {
            artifactPins: {
              orderBy: { position: "asc" },
              include: {
                artifactVersion: {
                  include: {
                    artifact: { select: { id: true, projectId: true } },
                    contentBlob: true,
                    assets: {
                      orderBy: { assetId: "asc" },
                      include: { blob: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!job) throw new Error(`EXPORT_JOB_NOT_FOUND:${exportJobId}`);
    if (job.status !== "running" || job.startedAt === null || job.finishedAt !== null || job.outputBlobId !== null) {
      throw new Error("EXPORT_JOB_RUNNING_INVARIANT_VIOLATED");
    }
    if (
      (job.purpose === "export" && (!job.release || job.preview))
      || (job.purpose === "preview" && (job.release || !job.preview))
    ) {
      throw new Error("EXPORT_JOB_SOURCE_SNAPSHOT_MISSING");
    }
    return {
      id: job.id,
      createdById: job.createdById,
      format: job.format,
      packaging: job.packaging,
      selection: selection(job),
      options: job.options,
      purpose: job.purpose,
      release: job.release,
      preview: job.preview,
    };
  }

  async status(exportJobId: string) {
    return (await this.db.exportJob.findUnique({ where: { id: exportJobId }, select: { status: true } }))?.status ?? null;
  }

  async reserveOutput(identity: OutputIdentity): Promise<OutputReservation> {
    return this.db.$transaction(async (tx) => {
      await advisoryShaLock(tx, identity.sha256);
      const active = await tx.blob.findFirst({
        where: { sha256: identity.sha256, status: { not: "deleted" } },
        orderBy: { generation: "desc" },
      });
      if (active) {
        if (active.status === "quarantined") throw new Error("EXPORT_OUTPUT_DIGEST_QUARANTINED");
        if (safeByteSize(active.byteSize) !== identity.byteSize || active.mediaType !== identity.mediaType) {
          throw new Error("EXPORT_OUTPUT_DIGEST_IDENTITY_CONFLICT");
        }
        if (active.status === "ready") return reservation(active, identity, this.config.canonicalBlobPrefix);
        if (active.status === "pending" && active.storageKey.startsWith(`${this.config.pendingBlobPrefix}/`)) {
          return reservation(active, identity, this.config.canonicalBlobPrefix);
        }
        throw new Error("EXPORT_OUTPUT_DIGEST_BUSY");
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
      return reservation(created, identity, this.config.canonicalBlobPrefix);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async publishSucceeded(exportJobId: string, output: OutputReservation) {
    return this.db.$transaction(async (tx) => {
      const job = await tx.exportJob.findUnique({ where: { id: exportJobId }, select: { status: true, outputBlobId: true } });
      if (!job) throw new Error("EXPORT_JOB_NOT_FOUND");
      if (job.status === "succeeded") {
        if (job.outputBlobId !== output.blobId) throw new Error("EXPORT_OUTPUT_PUBLICATION_CONFLICT");
        return "succeeded" as const;
      }
      if (job.status === "cancelled") return "cancelled" as const;
      if (job.status !== "running" || job.outputBlobId !== null) throw new Error("EXPORT_PUBLICATION_STATE_INVALID");

      const blob = await tx.blob.findUnique({ where: { id: output.blobId } });
      if (!blob
        || blob.sha256 !== output.sha256
        || blob.generation !== output.generation
        || safeByteSize(blob.byteSize) !== output.byteSize
        || blob.mediaType !== output.mediaType
        || !["pending", "ready"].includes(blob.status)) {
        throw new Error("EXPORT_OUTPUT_BLOB_IDENTITY_MISMATCH");
      }
      if (blob.status === "pending") {
        const updatedBlob = await tx.blob.updateMany({
          where: { id: blob.id, status: "pending", storageKey: blob.storageKey },
          data: {
            status: "ready",
            storageKey: output.canonicalStorageKey,
            verifiedAt: new Date(),
            gcEligibleAt: null,
            deletedAt: null,
          },
        });
        if (updatedBlob.count !== 1) throw new Error("EXPORT_OUTPUT_BLOB_PUBLICATION_LOST");
      } else if (blob.storageKey !== output.canonicalStorageKey) {
        throw new Error("EXPORT_OUTPUT_BLOB_STORAGE_KEY_MISMATCH");
      }
      const updated = await tx.exportJob.updateMany({
        where: { id: exportJobId, status: "running", outputBlobId: null, finishedAt: null },
        data: {
          status: "succeeded",
          outputBlobId: output.blobId,
          failureCode: null,
          failureDetail: null,
          finishedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("EXPORT_PUBLICATION_LOST");
      return "succeeded" as const;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async fail(exportJobId: string, code: string, detail: string) {
    const updated = await this.db.exportJob.updateMany({
      where: { id: exportJobId, status: { in: ["queued", "running"] }, outputBlobId: null, finishedAt: null },
      data: {
        status: "failed",
        failureCode: code.slice(0, 120),
        failureDetail: detail.slice(0, 4_000),
        finishedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      const status = await this.status(exportJobId);
      if (!status || !["succeeded", "failed", "cancelled"].includes(status)) throw new Error("EXPORT_FAILURE_PUBLICATION_LOST");
    }
  }

  async reconciliationCandidates(staleBefore: Date, limit = 100) {
    return this.db.exportJob.findMany({
      where: {
        OR: [
          { status: "queued" },
          { status: "running", startedAt: { lt: staleBefore } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true },
    });
  }
}

function selection(job: {
  selectionKind: "release" | "board" | "board_nodes" | "artifact";
  selectionArtifactId: string | null;
  selectionArtifactVersionId: string | null;
  selectionScreenId: string | null;
  selectionNodeIds: string[];
}): ExportSelection {
  if (job.selectionKind === "release") return { kind: "release" };
  if (job.selectionKind === "board") return { kind: "board" };
  if (job.selectionKind === "board_nodes") {
    return {
      kind: "board_nodes",
      nodeIds: exportBoardNodeIdsSchema.parse(job.selectionNodeIds),
    };
  }
  if (!job.selectionArtifactId || !job.selectionArtifactVersionId) throw new Error("EXPORT_ARTIFACT_SELECTION_INCOMPLETE");
  return {
    kind: "artifact",
    artifactId: job.selectionArtifactId,
    artifactVersionId: job.selectionArtifactVersionId,
    ...(job.selectionScreenId === null ? {} : { screenId: job.selectionScreenId }),
  };
}

function reservation(
  blob: {
    id: string;
    generation: number;
    sha256: string;
    byteSize: bigint;
    mediaType: string;
    status: "pending" | "ready" | "quarantined" | "deleted";
    storageKey: string;
  },
  identity: OutputIdentity,
  canonicalPrefix: string,
): OutputReservation {
  return {
    ...identity,
    blobId: blob.id,
    generation: blob.generation,
    canonicalStorageKey: blob.status === "ready"
      ? blob.storageKey
      : stableKey(canonicalPrefix, identity.sha256, blob.generation),
  };
}

async function advisoryShaLock(tx: Prisma.TransactionClient, sha256: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${sha256}, 0))::TEXT AS "lock_receipt"`);
}

function stableKey(prefix: string, sha256: string, generation: number) {
  return `${prefix}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g${generation}`;
}

function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("EXPORT_BLOB_SIZE_INVALID");
  return number;
}
