import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type {
  BlobGcCandidate,
  BlobGcClaim,
  BlobGcEligibilityResult,
  BlobGcStore,
} from "./blob-gc.store.js";

type LockedBlob = {
  id: string;
  status: "pending" | "ready" | "quarantined" | "deleted";
  storageKey: string;
  gcEligibleAt: Date | null;
  gcAttemptCount: number;
  storageDeletedAt: Date | null;
};

export class PrismaBlobGcStore implements BlobGcStore {
  constructor(private readonly db: PrismaClient) {}

  async reconcileEligibility(
    now: Date,
    eligibleAt: Date,
    limit: number,
  ): Promise<BlobGcEligibilityResult> {
    const nowUtc = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
    const eligibleAtUtc = Prisma.sql`(${eligibleAt}::timestamptz AT TIME ZONE 'UTC')`;
    return this.db.$transaction(async (tx) => {
      const cleared = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH candidates AS (
          SELECT blob."id"
          FROM "blobs" AS blob
          WHERE blob."status" <> 'deleted'
            AND blob."gc_eligible_at" IS NOT NULL
            AND (
              "blob_has_durable_byte_references"(blob."id")
              OR ${activeIntegrityHold("blob")}
            )
          ORDER BY blob."gc_eligible_at", blob."id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE "blobs" AS blob
        SET "gc_eligible_at" = NULL,
            "updated_at" = ${nowUtc}
        FROM candidates
        WHERE blob."id" = candidates."id"
        RETURNING blob."id"
      `);
      const marked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH candidates AS (
          SELECT blob."id"
          FROM "blobs" AS blob
          WHERE blob."status" <> 'deleted'
            AND blob."gc_eligible_at" IS NULL
            AND NOT "blob_has_durable_byte_references"(blob."id")
            AND NOT ${activeIntegrityHold("blob")}
          ORDER BY blob."updated_at", blob."id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE "blobs" AS blob
        SET "gc_eligible_at" = ${eligibleAtUtc},
            "updated_at" = ${nowUtc}
        FROM candidates
        WHERE blob."id" = candidates."id"
        RETURNING blob."id"
      `);
      return { cleared: cleared.length, marked: marked.length };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async findCandidates(now: Date, maximumAttempts: number, limit: number): Promise<BlobGcCandidate[]> {
    const nowUtc = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
    const rows = await this.db.$queryRaw<Array<{ blobId: string }>>(Prisma.sql`
      SELECT blob."id" AS "blobId"
      FROM "blobs" AS blob
      WHERE blob."storage_deleted_at" IS NULL
        AND blob."gc_attempt_count" < ${maximumAttempts}
        AND NOT "blob_has_durable_byte_references"(blob."id")
        AND NOT ${activeIntegrityHold("blob")}
        AND (
          (blob."status" <> 'deleted' AND blob."gc_eligible_at" <= ${nowUtc})
          OR blob."status" = 'deleted'
        )
      ORDER BY COALESCE(blob."gc_eligible_at", blob."deleted_at"), blob."id"
      LIMIT ${limit}
    `);
    return rows;
  }

  async claim(blobId: string, now: Date, maximumAttempts: number): Promise<BlobGcClaim> {
    return this.db.$transaction(async (tx) => {
      const identity = await tx.blob.findUnique({
        where: { id: blobId },
        select: { storageKey: true },
      });
      if (!identity) return { kind: "missing" };
      await lockReadyObjectStorageKey(tx, identity.storageKey);
      const rows = await tx.$queryRaw<LockedBlob[]>(Prisma.sql`
        SELECT
          blob."id",
          blob."status",
          blob."storage_key" AS "storageKey",
          blob."gc_eligible_at" AS "gcEligibleAt",
          blob."gc_attempt_count" AS "gcAttemptCount",
          blob."storage_deleted_at" AS "storageDeletedAt"
        FROM "blobs" AS blob
        WHERE blob."id" = ${blobId}
        FOR UPDATE
      `);
      const blob = rows[0];
      if (!blob) return { kind: "missing" };
      if (blob.storageDeletedAt) return { kind: "complete" };
      if (await hasActiveIntegrityHold(tx, blob.storageKey)) {
        if (blob.status !== "deleted" && blob.gcEligibleAt) {
          await tx.blob.update({
            where: { id: blob.id },
            data: { gcEligibleAt: null },
          });
        }
        return { kind: "referenced" };
      }
      if (await hasDurableByteReferences(tx, blob.id)) {
        if (blob.status !== "deleted" && blob.gcEligibleAt) {
          await tx.blob.update({
            where: { id: blob.id },
            data: { gcEligibleAt: null },
          });
        }
        return { kind: "referenced" };
      }
      if (blob.gcAttemptCount >= maximumAttempts) return { kind: "exhausted" };
      if (blob.status !== "deleted" && (!blob.gcEligibleAt || blob.gcEligibleAt > now)) {
        return { kind: "not_due" };
      }

      const updated = await tx.blob.update({
        where: { id: blob.id },
        data: {
          ...(blob.status === "deleted" ? {} : { status: "deleted", deletedAt: now }),
          gcAttemptCount: { increment: 1 },
          gcLastErrorCode: null,
          gcLastErrorDetail: null,
          gcLastErrorAt: null,
        },
        select: { gcAttemptCount: true },
      });
      return {
        kind: "delete",
        storageKey: blob.storageKey,
        attemptCount: updated.gcAttemptCount,
      };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async deleteClaimed(
    blobId: string,
    storageKey: string,
    completedAt: Date,
    deleteObject: () => Promise<void>,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockReadyObjectStorageKey(tx, storageKey);
      const rows = await tx.$queryRaw<Array<{
        id: string;
        status: "pending" | "ready" | "quarantined" | "deleted";
        storageKey: string;
        storageDeletedAt: Date | null;
      }>>(Prisma.sql`
        SELECT
          "id",
          "status",
          "storage_key" AS "storageKey",
          "storage_deleted_at" AS "storageDeletedAt"
        FROM "blobs"
        WHERE "id" = ${blobId}
        FOR UPDATE
      `);
      const blob = rows[0];
      if (!blob) return "missing" as const;
      if (blob.storageKey !== storageKey) throw new Error("BLOB_GC_STORAGE_KEY_CHANGED");
      if (blob.storageDeletedAt) return "complete" as const;
      if (await hasActiveIntegrityHold(tx, storageKey)) return "referenced" as const;
      if (blob.status !== "deleted") throw new Error("BLOB_GC_DELETE_CLAIM_LOST");

      // The storage call stays inside the owner-row transaction. A recorder
      // must acquire the same advisory and row locks before publishing a hold,
      // so an uncommitted incident cannot slip between authorization and delete.
      await deleteObject();
      const completed = await tx.blob.updateMany({
        where: { id: blobId, status: "deleted", storageKey, storageDeletedAt: null },
        data: {
          storageDeletedAt: completedAt,
          gcLastErrorCode: null,
          gcLastErrorDetail: null,
          gcLastErrorAt: null,
        },
      });
      if (completed.count !== 1) throw new Error("BLOB_GC_COMPLETION_LOST");
      return "deleted" as const;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async recordFailure(blobId: string, code: string, detail: string, occurredAt: Date): Promise<void> {
    await this.db.blob.updateMany({
      where: { id: blobId, status: "deleted", storageDeletedAt: null },
      data: {
        gcLastErrorCode: code.slice(0, 120),
        gcLastErrorDetail: detail.slice(0, 1_000),
        gcLastErrorAt: occurredAt,
      },
    });
  }

  async complete(blobId: string, completedAt: Date): Promise<void> {
    const updated = await this.db.blob.updateMany({
      where: { id: blobId, status: "deleted", storageDeletedAt: null },
      data: {
        storageDeletedAt: completedAt,
        gcLastErrorCode: null,
        gcLastErrorDetail: null,
        gcLastErrorAt: null,
      },
    });
    if (updated.count > 0) return;
    const current = await this.db.blob.findUnique({
      where: { id: blobId },
      select: { status: true, storageDeletedAt: true },
    });
    if (current?.status !== "deleted" || !current.storageDeletedAt) {
      throw new Error("BLOB_GC_COMPLETION_LOST");
    }
  }
}

function activeIntegrityHold(blobAlias: "blob") {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "ready_object_integrity_incidents" AS integrity_incident
    WHERE integrity_incident."storage_key" = ${Prisma.raw(`${blobAlias}."storage_key"`)}
      AND NOT EXISTS (
        SELECT 1
        FROM "ready_object_integrity_retention_releases" AS integrity_release
        WHERE integrity_release."incident_id" = integrity_incident."id"
          AND integrity_release."released_occurrence_count" >= integrity_incident."occurrence_count"
      )
  )`;
}

async function hasDurableByteReferences(
  tx: Prisma.TransactionClient,
  blobId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ referenced: boolean }>>(Prisma.sql`
    SELECT "blob_has_durable_byte_references"(${blobId}) AS "referenced"
  `);
  return rows[0]?.referenced ?? true;
}

async function lockReadyObjectStorageKey(
  tx: Prisma.TransactionClient,
  storageKey: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`workbench:ready-object-integrity:v1:${storageKey}`}, 0)
    )::TEXT AS "lockReceipt"
  `);
}

async function hasActiveIntegrityHold(
  tx: Prisma.TransactionClient,
  storageKey: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ held: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "ready_object_integrity_incidents" AS integrity_incident
      WHERE integrity_incident."storage_key" = ${storageKey}
        AND NOT EXISTS (
          SELECT 1
          FROM "ready_object_integrity_retention_releases" AS integrity_release
          WHERE integrity_release."incident_id" = integrity_incident."id"
            AND integrity_release."released_occurrence_count" >= integrity_incident."occurrence_count"
        )
    ) AS "held"
  `);
  return rows[0]?.held ?? true;
}
