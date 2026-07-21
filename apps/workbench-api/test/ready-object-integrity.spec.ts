import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
  readyObjectIntegrityFingerprint,
  readyObjectIntegrityRecorder,
  recordReadyObjectIntegrityFailure,
} from "../src/platform/object-storage/ready-object-integrity.js";
import type { ReadyObjectIntegrityFailure } from "../src/platform/object-storage/read-ready-object.js";

const failure: ReadyObjectIntegrityFailure = {
  failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
  storageKey: "blobs/secret-tenant/object-g1",
  expectedSha256: "a".repeat(64),
  expectedByteSize: 10,
  expectedMediaType: "application/octet-stream",
  observedSha256: "b".repeat(64),
  observedByteSize: 10,
  observedMediaType: "application/octet-stream",
  observedContentRange: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ready object integrity persistence", () => {
  it("deduplicates evidence and atomically quarantines every matching database owner", async () => {
    const tx = transaction();
    const db = database(tx);
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    await recordReadyObjectIntegrityFailure(db as never, failure);

    const fingerprint = readyObjectIntegrityFingerprint(failure);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.readyObjectIntegrityIncident.upsert).toHaveBeenCalledWith({
      where: { fingerprint },
      create: expect.objectContaining({
        fingerprint,
        storageKey: failure.storageKey,
        failureCode: failure.failureCode,
        expectedSha256: failure.expectedSha256,
        expectedByteSize: 10n,
        observedSha256: failure.observedSha256,
        observedByteSize: 10n,
      }),
      update: {
        occurrenceCount: { increment: 1 },
        lastDetectedAt: expect.any(Date),
      },
      select: { id: true },
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
        failureDetail: "Object bytes failed immutable manifest verification",
        revision: { increment: 1 },
      },
    });
    expect(tx.canvasVisualCapability.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["visual_1"] },
        status: { in: ["pending", "ready"] },
        storageDeletedAt: null,
      },
      data: {
        status: "failed",
        failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
      },
    });

    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("incident=incident_1");
    expect(logged).toContain(`fingerprint=${fingerprint}`);
    expect(logged).toContain(`code=${failure.failureCode}`);
    expect(logged).not.toContain(failure.storageKey);
    expect(logged).not.toContain(failure.expectedSha256);
    expect(logged).not.toContain(failure.observedSha256!);

    const lockOrder = tx.$queryRaw.mock.invocationCallOrder;
    expect(lockOrder).toHaveLength(3);
    expect(lockOrder[0]).toBeLessThan(lockOrder[1]!);
    expect(lockOrder[1]).toBeLessThan(lockOrder[2]!);
    expect(lockOrder[2]).toBeLessThan(tx.readyObjectIntegrityIncident.upsert.mock.invocationCallOrder[0]!);
  });

  it("fingerprints the same bounded observation that is persisted", async () => {
    const tx = transaction();
    const db = database(tx);
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const oversized = {
      ...failure,
      observedMediaType: "m".repeat(700),
      observedContentRange: "r".repeat(700),
    };

    await recordReadyObjectIntegrityFailure(db as never, oversized);

    const create = tx.readyObjectIntegrityIncident.upsert.mock.calls[0]![0].create;
    expect(create.observedMediaType).toBe("m".repeat(512));
    expect(create.observedContentRange).toBe("r".repeat(512));
    expect(readyObjectIntegrityFingerprint(oversized)).toBe(readyObjectIntegrityFingerprint({
      ...oversized,
      observedMediaType: create.observedMediaType,
      observedContentRange: create.observedContentRange,
    }));
  });

  it("uses a stable evidence fingerprint and changes it for a distinct observation", () => {
    const first = readyObjectIntegrityFingerprint(failure);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(readyObjectIntegrityFingerprint({ ...failure })).toBe(first);
    expect(readyObjectIntegrityFingerprint({
      ...failure,
      observedSha256: "c".repeat(64),
    })).not.toBe(first);
  });

  it("fails closed with a secret-safe log if the atomic transaction rolls back", async () => {
    const db = {
      $transaction: vi.fn(async () => Promise.reject(new Error("postgresql://user:password@db"))),
    };
    const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    await expect(readyObjectIntegrityRecorder(db as never)(failure)).rejects.toThrow(
      "READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED",
    );
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("persistence_failed");
    expect(logged).not.toContain("password");
    expect(logged).not.toContain(failure.storageKey);
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
    blob: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    fileAsset: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    canvasVisualCapability: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function database(tx: ReturnType<typeof transaction>) {
  return {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
}
