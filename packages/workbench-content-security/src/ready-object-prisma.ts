import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import type {
  ReadyObjectIntegrityFailure,
  ReadyObjectIntegrityRecorder,
} from "./ready-object.js";

export const READY_OBJECT_INTEGRITY_QUARANTINE_CODE = "READY_OBJECT_INTEGRITY_FAILURE";
export const READY_OBJECT_INTEGRITY_QUARANTINE_DETAIL =
  "Object bytes failed immutable manifest verification";

export type ReadyObjectIntegrityRecordResult = {
  incidentId: string;
  fingerprint: string;
  failureCode: ReadyObjectIntegrityFailure["failureCode"];
  blobsQuarantined: number;
  filesQuarantined: number;
  visualsFailed: number;
};

type ReadyObjectIntegrityDatabase = Pick<PrismaClient, "$transaction">;

export function prismaReadyObjectIntegrityRecorder(
  db: ReadyObjectIntegrityDatabase,
): ReadyObjectIntegrityRecorder {
  return async (failure) => {
    await recordReadyObjectIntegrityFailure(db, failure);
  };
}

export async function recordReadyObjectIntegrityFailure(
  db: ReadyObjectIntegrityDatabase,
  failure: ReadyObjectIntegrityFailure,
): Promise<ReadyObjectIntegrityRecordResult> {
  const normalizedFailure = normalizeReadyObjectIntegrityFailure(failure);
  const fingerprint = fingerprintNormalizedFailure(normalizedFailure);
  const detectedAt = new Date();
  try {
    const result = await db.$transaction(async (tx) => {
      await lockReadyObjectStorageKey(tx, normalizedFailure.storageKey);
      const matchingBlobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "blobs"
        WHERE "storage_key" = ${normalizedFailure.storageKey}
          AND "sha256" = ${normalizedFailure.expectedSha256}
          AND "byte_size" = ${BigInt(normalizedFailure.expectedByteSize)}
          AND "media_type" = ${normalizedFailure.expectedMediaType}
        ORDER BY "id"
        FOR UPDATE
      `);
      const matchingVisuals = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "canvas_visual_capabilities"
        WHERE "storage_key" = ${normalizedFailure.storageKey}
          AND "sha256" = ${normalizedFailure.expectedSha256}
          AND "byte_size" = ${BigInt(normalizedFailure.expectedByteSize)}
          AND "media_type" = ${normalizedFailure.expectedMediaType}
        ORDER BY "id"
        FOR UPDATE
      `);

      const incident = await tx.readyObjectIntegrityIncident.upsert({
        where: { fingerprint },
        create: {
          fingerprint,
          storageKey: normalizedFailure.storageKey,
          failureCode: normalizedFailure.failureCode,
          expectedSha256: normalizedFailure.expectedSha256,
          expectedByteSize: BigInt(normalizedFailure.expectedByteSize),
          expectedMediaType: normalizedFailure.expectedMediaType,
          observedSha256: normalizedFailure.observedSha256,
          observedByteSize: normalizedFailure.observedByteSize === null
            ? null
            : BigInt(normalizedFailure.observedByteSize),
          observedMediaType: normalizedFailure.observedMediaType,
          observedContentRange: normalizedFailure.observedContentRange,
          firstDetectedAt: detectedAt,
          lastDetectedAt: detectedAt,
        },
        update: {
          occurrenceCount: { increment: 1 },
          lastDetectedAt: detectedAt,
        },
        select: { id: true },
      });

      let blobsQuarantined = 0;
      let filesQuarantined = 0;
      for (const blob of matchingBlobs) {
        const blobUpdate = await tx.blob.updateMany({
          where: { id: blob.id, status: { in: ["pending", "ready"] } },
          data: { status: "quarantined", gcEligibleAt: null },
        });
        blobsQuarantined += blobUpdate.count;
        const fileUpdate = await tx.fileAsset.updateMany({
          where: { blobId: blob.id, status: { in: ["verifying", "ready"] } },
          data: {
            status: "quarantined",
            failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
            failureDetail: READY_OBJECT_INTEGRITY_QUARANTINE_DETAIL,
            revision: { increment: 1 },
          },
        });
        filesQuarantined += fileUpdate.count;
      }

      const visualsFailed = await tx.canvasVisualCapability.updateMany({
        where: {
          id: { in: matchingVisuals.map((visual) => visual.id) },
          status: { in: ["pending", "ready"] },
          storageDeletedAt: null,
        },
        data: {
          status: "failed",
          failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
        },
      });

      return {
        incidentId: incident.id,
        blobsQuarantined,
        filesQuarantined,
        visualsFailed: visualsFailed.count,
      };
    }, { maxWait: 10_000, timeout: 30_000 });

    return {
      ...result,
      fingerprint,
      failureCode: normalizedFailure.failureCode,
    };
  } catch (cause) {
    throw new Error("READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED", { cause });
  }
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

export function readyObjectIntegrityFingerprint(
  failure: ReadyObjectIntegrityFailure,
): string {
  return fingerprintNormalizedFailure(normalizeReadyObjectIntegrityFailure(failure));
}

function fingerprintNormalizedFailure(
  failure: ReadyObjectIntegrityFailure,
): string {
  return createHash("sha256").update(JSON.stringify([
    failure.storageKey,
    failure.failureCode,
    failure.expectedSha256,
    failure.expectedByteSize,
    failure.expectedMediaType,
    failure.observedSha256,
    failure.observedByteSize,
    failure.observedMediaType,
    failure.observedContentRange,
  ])).digest("hex");
}

function normalizeReadyObjectIntegrityFailure(
  failure: ReadyObjectIntegrityFailure,
): ReadyObjectIntegrityFailure {
  return {
    ...failure,
    observedMediaType: boundedEvidence(failure.observedMediaType, 512),
    observedContentRange: boundedEvidence(failure.observedContentRange, 512),
  };
}

function boundedEvidence(value: string | null, maximumLength: number): string | null {
  return value === null ? null : value.slice(0, maximumLength);
}
