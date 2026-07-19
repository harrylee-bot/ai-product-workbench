import { blobGcQueue } from "@workbench/workbench-contracts";
import { BlobGcProcessor } from "../src/gc/blob-gc.processor.js";
import { BlobGcReconciler } from "../src/gc/blob-gc.reconciler.js";
import type { BlobGcStore } from "../src/gc/blob-gc.store.js";

const now = new Date("2026-07-15T00:00:00.000Z");

describe("BlobGcProcessor", () => {
  it("soft-deletes before idempotently deleting storage and recording completion", async () => {
    const store = gcStore();
    store.claim.mockResolvedValue({ kind: "delete", storageKey: "blobs/aa/bb/hash/g1", attemptCount: 1 });
    const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
    const processor = new BlobGcProcessor(store, storage, 6, () => now);

    await expect(processor.run("blob_1")).resolves.toBe("deleted");
    expect(store.claim).toHaveBeenCalledWith("blob_1", now, 6);
    expect(storage.deleteObject).toHaveBeenCalledWith("blobs/aa/bb/hash/g1", undefined);
    expect(store.complete).toHaveBeenCalledWith("blob_1", now);
    expect(store.recordFailure).not.toHaveBeenCalled();
  });

  it("persists a bounded failure receipt and lets pg-boss retry the delete", async () => {
    const store = gcStore();
    store.claim.mockResolvedValue({ kind: "delete", storageKey: "blobs/aa/bb/hash/g1", attemptCount: 2 });
    const failure = new Error("provider detail must not be persisted");
    const storage = { deleteObject: vi.fn().mockRejectedValue(failure) };
    const processor = new BlobGcProcessor(store, storage, 6, () => now);

    await expect(processor.run("blob_1")).rejects.toBe(failure);
    expect(store.recordFailure).toHaveBeenCalledWith(
      "blob_1",
      "BLOB_GC_STORAGE_DELETE_FAILED",
      "Object storage delete did not complete",
      now,
    );
    expect(store.complete).not.toHaveBeenCalled();
  });

  it.each(["complete", "exhausted", "missing", "not_due", "referenced"] as const)(
    "does not touch storage for a %s claim",
    async (kind) => {
      const store = gcStore();
      store.claim.mockResolvedValue({ kind });
      const storage = { deleteObject: vi.fn() };
      const processor = new BlobGcProcessor(store, storage, 6, () => now);

      await expect(processor.run("blob_1")).resolves.toBe(kind);
      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(store.complete).not.toHaveBeenCalled();
    },
  );
});

describe("BlobGcReconciler", () => {
  it("marks a grace deadline before queueing only due or crash-recovery candidates", async () => {
    const store = gcStore();
    store.reconcileEligibility.mockResolvedValue({ cleared: 1, marked: 2 });
    store.findCandidates.mockResolvedValue([{ blobId: "blob_due" }, { blobId: "blob_recovery" }]);
    const queue = { send: vi.fn().mockResolvedValue("job_1") };
    const reconciler = new BlobGcReconciler(
      store,
      queue,
      60 * 60_000,
      6,
      100,
      30_000,
      undefined,
      () => now,
    );

    await reconciler.runOnce();

    expect(store.reconcileEligibility).toHaveBeenCalledWith(
      now,
      new Date("2026-07-15T01:00:00.000Z"),
      100,
    );
    expect(store.findCandidates).toHaveBeenCalledWith(now, 6, 100);
    expect(queue.send.mock.calls).toEqual([
      [blobGcQueue, { blobId: "blob_due" }, { singletonKey: "blob_due" }],
      [blobGcQueue, { blobId: "blob_recovery" }, { singletonKey: "blob_recovery" }],
    ]);
  });

  it("reports one enqueue failure and continues with the remaining candidates", async () => {
    const store = gcStore();
    store.reconcileEligibility.mockResolvedValue({ cleared: 0, marked: 0 });
    store.findCandidates.mockResolvedValue([{ blobId: "blob_1" }, { blobId: "blob_2" }]);
    const failure = new Error("queue unavailable");
    const queue = { send: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce("job_2") };
    const onError = vi.fn();
    const reconciler = new BlobGcReconciler(
      store,
      queue,
      60 * 60_000,
      6,
      100,
      30_000,
      onError,
      () => now,
    );

    await reconciler.runOnce();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(queue.send).toHaveBeenCalledTimes(2);
  });
});

function gcStore() {
  return {
    reconcileEligibility: vi.fn<BlobGcStore["reconcileEligibility"]>(),
    findCandidates: vi.fn<BlobGcStore["findCandidates"]>(),
    claim: vi.fn<BlobGcStore["claim"]>(),
    recordFailure: vi.fn<BlobGcStore["recordFailure"]>().mockResolvedValue(undefined),
    complete: vi.fn<BlobGcStore["complete"]>().mockResolvedValue(undefined),
  };
}
