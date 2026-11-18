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
  storageKey: string;
  blobId: string;
  generation: number;
  canonicalStorageKey: string;
};

export type ExecutionLease = {
  owner: string;
  id: string;
};

export class ExportExecutionLeaseLostError extends Error {
  constructor() { super("EXPORT_EXECUTION_LEASE_LOST"); }
}

const leaseDurationSeconds = 15;
const databaseTime = Prisma.sql`clock_timestamp() AT TIME ZONE 'UTC'`;

export class PrismaExportStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: Pick<ExportWorkerConfig, "pendingBlobPrefix" | "canonicalBlobPrefix">,
  ) {}

  async start(exportJobId: string, executionOwner: string): Promise<
    | { kind: "missing" }
    | { kind: "terminal"; status: "succeeded" | "failed" | "cancelled" }
    | { kind: "skipped"; status: "running" | "cancelling" }
    | { kind: "run"; lease: ExecutionLease }
  > {
    const lease = { owner: executionOwner, id: randomUUID() };
    const claimed = await this.db.$executeRaw(Prisma.sql`
      UPDATE "export_jobs"
      SET "status" = 'running',
          "started_at" = COALESCE("started_at", ${databaseTime}),
          "updated_at" = CASE WHEN "status" = 'queued' THEN ${databaseTime} ELSE "updated_at" END,
          "revision" = "revision" + CASE WHEN "status" = 'queued' THEN 1 ELSE 0 END,
          "execution_owner" = ${lease.owner},
          "execution_lease_id" = ${lease.id},
          "execution_lease_expires_at" = clock_timestamp() + make_interval(secs => ${leaseDurationSeconds}::double precision)
      WHERE "id" = ${exportJobId} AND "status" IN ('queued', 'running')
        AND ("execution_lease_expires_at" IS NULL OR "execution_lease_expires_at" <= clock_timestamp())
    `);
    if (claimed === 1) return { kind: "run", lease };
    const status = await this.status(exportJobId);
    if (status === "running" || status === "cancelling") return { kind: "skipped", status };
    if (status === "succeeded" || status === "failed" || status === "cancelled") return { kind: "terminal", status };
    if (status === null) return { kind: "missing" };
    throw new Error("EXPORT_JOB_CLAIM_STATE_INVALID");
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

  async pulseExecutionLease(exportJobId: string, lease: ExecutionLease): Promise<"running" | "cancelling" | "lost"> {
    const [row] = await this.db.$queryRaw<{ status: "running" | "cancelling" }[]>(Prisma.sql`
      UPDATE "export_jobs"
      SET "execution_lease_expires_at" = clock_timestamp() + make_interval(secs => ${leaseDurationSeconds}::double precision)
      WHERE "id" = ${exportJobId} AND "status" IN ('running', 'cancelling') AND ${ownsLease(lease)}
      RETURNING "status"::text AS "status"
    `);
    return row?.status ?? "lost";
  }

  async retirePreviousContainerRuns(containerId: string, incarnation: string) {
    // A restarted Docker container has the same ID and a new PID 1. All
    // processes and sockets from the previous PID namespace have exited.
    await this.db.$executeRaw(Prisma.sql`
      DELETE FROM "export_active_executions" WHERE
        split_part("owner", ':', 1) = 'export-worker'
        AND split_part("owner", ':', 2) = ${containerId}
        AND split_part("owner", ':', 3) <> ${incarnation}
        AND split_part("owner", ':', 4) <> ''
    `);
  }

  async beginExecutionResources(exportJobId: string, lease: ExecutionLease) {
    // Serialize the first external operation with cancellation and claim replacement.
    const inserted = await this.db.$executeRaw(Prisma.sql`
      INSERT INTO "export_active_executions" ("job_id", "lease_id", "owner")
      SELECT "id", "execution_lease_id", "execution_owner" FROM "export_jobs"
      WHERE "id" = ${exportJobId} AND "status" = 'running' AND ${ownsLease(lease)}
      FOR UPDATE
    `);
    if (inserted !== 1) throw new ExportExecutionLeaseLostError();
  }

  async endExecutionResources(exportJobId: string, lease: ExecutionLease) {
    // Even a fenced owner must be able to confirm its own cleanup.
    await this.db.$executeRaw(Prisma.sql`
      DELETE FROM "export_active_executions"
      WHERE "job_id" = ${exportJobId} AND "lease_id" = ${lease.id} AND "owner" = ${lease.owner}
    `);
  }

  async releaseExecutionLease(exportJobId: string, lease: ExecutionLease): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "export_jobs"
      SET "execution_owner" = NULL, "execution_lease_id" = NULL, "execution_lease_expires_at" = NULL
      WHERE "id" = ${exportJobId} AND ${leaseIdentity(lease)}
    `);
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
        if (
          active.status === "pending"
          && (active.storageKey.startsWith(`${this.config.pendingBlobPrefix}/`)
            || active.storageKey.startsWith(`${this.config.canonicalBlobPrefix}/`))
        ) {
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
          storageKey: stableKey(this.config.canonicalBlobPrefix, identity.sha256, generation),
          mediaType: identity.mediaType,
          byteSize: BigInt(identity.byteSize),
          status: "pending",
        },
      });
      return reservation(created, identity, this.config.canonicalBlobPrefix);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async publishSucceeded(exportJobId: string, output: OutputReservation, lease: ExecutionLease) {
    return this.db.$transaction(async (tx) => {
      const [job] = await tx.$queryRaw<{ status: string; ownsLease: boolean }[]>(Prisma.sql`
        SELECT "status"::text AS "status", COALESCE(${ownsLease(lease)}, false) AS "ownsLease"
        FROM "export_jobs" WHERE "id" = ${exportJobId} FOR UPDATE
      `);
      if (job?.status === "cancelling" || job?.status === "cancelled") return job.status;
      if (job?.status !== "running" || !job.ownsLease) throw new ExportExecutionLeaseLostError();

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
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "export_jobs"
        SET "status" = 'succeeded', "output_blob_id" = ${output.blobId},
            "finished_at" = ${databaseTime}, "updated_at" = ${databaseTime}, "revision" = "revision" + 1,
            "execution_owner" = NULL, "execution_lease_id" = NULL, "execution_lease_expires_at" = NULL
        WHERE "id" = ${exportJobId} AND "status" = 'running' AND ${ownsLease(lease)}
      `);
      if (updated !== 1) throw new ExportExecutionLeaseLostError();
      return "succeeded" as const;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  /** Leave pending bytes with Blob GC so a concurrent publisher can reuse them. */
  async abandonOutput(output: OutputReservation): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "blobs" WHERE "id" = ${output.blobId} FOR UPDATE`);
      const blob = await tx.blob.findUnique({
        where: { id: output.blobId },
        select: { status: true, sha256: true, generation: true, byteSize: true, mediaType: true },
      });
      if (!blob || blob.status !== "pending") return;
      if (
        blob.sha256 !== output.sha256
        || blob.generation !== output.generation
        || safeByteSize(blob.byteSize) !== output.byteSize
        || blob.mediaType !== output.mediaType
      ) return;
      await tx.blob.updateMany({
        where: { id: output.blobId, status: "pending" },
        data: {
          // Leave enough time for another exporter to finish verification
          // before the normal Blob GC pass considers the shared key.
          gcEligibleAt: new Date(Date.now() + 15 * 60_000),
        },
      });
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async acknowledgeCancellation(exportJobId: string, lease?: ExecutionLease): Promise<"cancelled" | "pending" | "terminal"> {
    const eligible = lease ? ownsLease(lease)
      : Prisma.sql`("execution_lease_expires_at" IS NULL OR "execution_lease_expires_at" <= clock_timestamp())`;
    const updated = await this.db.$executeRaw(Prisma.sql`
      UPDATE "export_jobs"
      SET "status" = 'cancelled', "finished_at" = ${databaseTime},
          "updated_at" = ${databaseTime}, "revision" = "revision" + 1,
          "cancellation_acknowledged_at" = GREATEST(clock_timestamp(), "cancel_requested_at"),
          "execution_owner" = NULL, "execution_lease_id" = NULL, "execution_lease_expires_at" = NULL
      WHERE "id" = ${exportJobId} AND "status" = 'cancelling' AND ${eligible}
        AND NOT EXISTS (SELECT 1 FROM "export_active_executions" WHERE "job_id" = ${exportJobId})
    `);
    if (updated === 1) return "cancelled";
    const status = await this.status(exportJobId);
    if (status === "cancelled") return "cancelled";
    return status === "cancelling" ? "pending" : "terminal";
  }

  async fail(exportJobId: string, code: string, detail: string, lease: ExecutionLease): Promise<boolean> {
    const updated = await this.db.$executeRaw(Prisma.sql`
      UPDATE "export_jobs"
      SET "status" = 'failed', "failure_code" = ${code.slice(0, 120)}, "failure_detail" = ${detail.slice(0, 4_000)},
          "finished_at" = ${databaseTime}, "updated_at" = ${databaseTime}, "revision" = "revision" + 1,
          "execution_owner" = NULL, "execution_lease_id" = NULL, "execution_lease_expires_at" = NULL
      WHERE "id" = ${exportJobId} AND "status" = 'running' AND ${ownsLease(lease)}
    `);
    return updated === 1;
  }

  async reconciliationCandidates(staleBefore: Date, limit = 100) {
    return this.db.$queryRaw<{ id: string; status: "queued" | "running" | "cancelling" }[]>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "export_jobs"
      WHERE "status" IN ('queued', 'cancelling')
        OR ("status" = 'running' AND (
          "execution_lease_expires_at" <= clock_timestamp()
          OR ("execution_lease_expires_at" IS NULL AND "started_at" < (${staleBefore}::timestamptz AT TIME ZONE 'UTC'))
        ))
      ORDER BY "updated_at", "id" LIMIT ${limit}
    `);
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
    storageKey: blob.storageKey,
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

function leaseIdentity(lease: ExecutionLease) {
  return Prisma.sql`"execution_owner" = ${lease.owner} AND "execution_lease_id" = ${lease.id}`;
}

function ownsLease(lease: ExecutionLease) {
  return Prisma.sql`${leaseIdentity(lease)} AND "execution_lease_expires_at" > clock_timestamp()`;
}

function safeByteSize(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("EXPORT_BLOB_SIZE_INVALID");
  return number;
}
