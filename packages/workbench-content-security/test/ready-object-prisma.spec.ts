import { describe, expect, it, vi } from "vitest";
import {
  READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
  READY_OBJECT_INTEGRITY_QUARANTINE_DETAIL,
  prismaReadyObjectIntegrityRecorder,
  readyObjectIntegrityFingerprint,
  recordReadyObjectIntegrityFailure,
} from "../src/ready-object-prisma.js";
import type { ReadyObjectIntegrityFailure } from "../src/ready-object.js";

const failure: ReadyObjectIntegrityFailure = {
  failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
  storageKey: "blobs/private/object-g1",
  expectedSha256: "a".repeat(64),
  expectedByteSize: 10,
  expectedMediaType: "application/octet-stream",
  observedSha256: "b".repeat(64),
  observedByteSize: 10,
  observedMediaType: "application/octet-stream",
  observedContentRange: null,
};

describe("ready-object Prisma recorder", () => {
  it("locks the storage key and owners before atomically recording and quarantining", async () => {
    const tx = transaction();
    const db = database(tx);

    await expect(recordReadyObjectIntegrityFailure(db as never, failure)).resolves.toEqual({
      incidentId: "incident_1",
      fingerprint: readyObjectIntegrityFingerprint(failure),
      failureCode: failure.failureCode,
      blobsQuarantined: 1,
      filesQuarantined: 2,
      visualsFailed: 1,
    });

    expect(tx.blob.updateMany).toHaveBeenCalledWith({
      where: { id: "blob_1", status: { in: ["pending", "ready"] } },
      data: { status: "quarantined", gcEligibleAt: null },
    });
    expect(tx.fileAsset.updateMany).toHaveBeenCalledWith({
      where: { blobId: "blob_1", status: { in: ["verifying", "ready"] } },
      data: {
        status: "quarantined",
        failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
        failureDetail: READY_OBJECT_INTEGRITY_QUARANTINE_DETAIL,
        revision: { increment: 1 },
      },
    });
    const queryOrder = tx.$queryRaw.mock.invocationCallOrder;
    expect(queryOrder).toHaveLength(3);
    expect(queryOrder[0]).toBeLessThan(queryOrder[1]!);
    expect(queryOrder[1]).toBeLessThan(queryOrder[2]!);
    expect(queryOrder[2]).toBeLessThan(
      tx.readyObjectIntegrityIncident.upsert.mock.invocationCallOrder[0]!,
    );
  });

  it("normalizes bounded evidence consistently and hides persistence causes", async () => {
    const oversized = {
      ...failure,
      observedMediaType: "m".repeat(700),
      observedContentRange: "r".repeat(700),
    };
    const tx = transaction();
    await recordReadyObjectIntegrityFailure(database(tx) as never, oversized);
    const create = tx.readyObjectIntegrityIncident.upsert.mock.calls[0]![0].create;
    expect(create.observedMediaType).toBe("m".repeat(512));
    expect(create.observedContentRange).toBe("r".repeat(512));
    expect(readyObjectIntegrityFingerprint(oversized)).toBe(readyObjectIntegrityFingerprint({
      ...oversized,
      observedMediaType: create.observedMediaType,
      observedContentRange: create.observedContentRange,
    }));

    const failedDb = { $transaction: vi.fn(async () => { throw new Error("secret DSN"); }) };
    await expect(prismaReadyObjectIntegrityRecorder(failedDb as never)(failure))
      .rejects.toMatchObject({ message: "READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED" });
  });
});

function transaction() {
  return {
    readyObjectIntegrityIncident: {
      upsert: vi.fn().mockResolvedValue({ id: "incident_1" }),
    },
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ lockReceipt: "" }])
      .mockResolvedValueOnce([{ id: "blob_1" }])
      .mockResolvedValueOnce([{ id: "visual_1" }]),
    blob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    fileAsset: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    canvasVisualCapability: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

function database(tx: ReturnType<typeof transaction>) {
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
}
