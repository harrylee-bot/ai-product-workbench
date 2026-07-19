import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  FakeExternalExportDeliveryAdapter,
  UnavailableExternalExportDeliveryAdapter,
} from "../src/delivery/external-export-delivery.adapter.js";
import { ExternalExportDeliveryProcessor } from "../src/delivery/external-export-delivery.processor.js";
import type { ExternalDeliveryCommand } from "../src/delivery/external-export-delivery.store.js";

const bytes = Buffer.from("<!doctype html><title>Products</title>", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function command(overrides: Partial<ExternalDeliveryCommand> = {}): ExternalDeliveryCommand {
  return {
    id: "delivery-1",
    leaseToken: "lease-1",
    status: "running",
    target: "netlify",
    payload: {
      exportJobId: "export-1",
      releaseId: "release-1",
      format: "html",
      packaging: "zip",
      selection: { kind: "release" },
      output: {
        mediaType: "application/zip",
        byteSize: bytes.byteLength,
        sha256,
        fileName: "products.zip",
      },
    },
    remoteReference: null,
    transferAuthorizedAt: null,
    output: {
      blobId: "blob-1",
      storageKey: "blobs/output",
      mediaType: "application/zip",
      byteSize: bytes.byteLength,
      sha256,
    },
    ...overrides,
  };
}

function harness(adapter = new FakeExternalExportDeliveryAdapter("netlify")) {
  const store = {
    claim: vi.fn(async () => ({ kind: "run" as const, leaseToken: "lease-1" })),
    load: vi.fn(async () => command()),
    authorizeTransfer: vi.fn(async () => "authorized" as const),
    recordRemoteReceipt: vi.fn(async () => "succeeded" as const),
    finalizeCancelled: vi.fn(async () => undefined),
    releaseForRetry: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    status: vi.fn(async () => "running" as string | null),
  };
  const storage = { readVerified: vi.fn(async () => new Uint8Array(bytes)) };
  const processor = new ExternalExportDeliveryProcessor(
    store as never,
    storage as never,
    [adapter],
    { maximumInputBytes: 1024 * 1024 },
  );
  return { adapter, processor, storage, store };
}

describe("ExternalExportDeliveryProcessor", () => {
  it("claims, authorizes, and publishes verified immutable bytes", async () => {
    const test = harness();
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 0, retryLimit: 3 }))
      .resolves.toMatchObject({ kind: "published", status: "succeeded", remoteReference: "fake://netlify/delivery-1" });
    expect(test.storage.readVerified).toHaveBeenCalledWith(command().output, 1024 * 1024, undefined);
    expect(test.store.authorizeTransfer).toHaveBeenCalledWith(command());
    expect(test.store.recordRemoteReceipt).toHaveBeenCalledWith("delivery-1", "lease-1", "fake://netlify/delivery-1");
    expect(test.adapter.calls[0]).toMatchObject({
      deliveryId: "delivery-1",
      idempotencyKey: "delivery-1",
      payload: command().payload,
    });
  });

  it("does no work when another lease owner is active", async () => {
    const test = harness();
    test.store.claim.mockResolvedValueOnce({ kind: "busy" });
    await expect(test.processor.process("delivery-1")).resolves.toEqual({ kind: "busy" });
    expect(test.store.load).not.toHaveBeenCalled();
    expect(test.storage.readVerified).not.toHaveBeenCalled();
  });

  it("finalizes cancellation before transfer without reading or delivering bytes", async () => {
    const test = harness();
    test.store.load.mockResolvedValueOnce(command({ status: "cancelling" }));
    await expect(test.processor.process("delivery-1")).resolves.toEqual({ kind: "terminal", status: "cancelled" });
    expect(test.store.finalizeCancelled).toHaveBeenCalledWith("delivery-1", "lease-1", null);
    expect(test.storage.readVerified).not.toHaveBeenCalled();
    expect(test.adapter.calls).toHaveLength(0);
  });

  it("revokes a persisted remote receipt before publishing cancellation", async () => {
    const test = harness();
    const cancelling = command({
      status: "cancelling",
      transferAuthorizedAt: new Date("2026-07-18T00:00:00.000Z"),
      remoteReference: "fake://netlify/delivery-1",
    });
    test.store.load.mockResolvedValueOnce(cancelling);
    await expect(test.processor.process("delivery-1")).resolves.toEqual({ kind: "terminal", status: "cancelled" });
    expect(test.adapter.revocations).toEqual([{
      idempotencyKey: "delivery-1",
      remoteReference: "fake://netlify/delivery-1",
    }]);
    expect(test.store.finalizeCancelled).toHaveBeenCalledWith(
      "delivery-1",
      "lease-1",
      "fake://netlify/delivery-1",
    );
  });

  it("closes the cancellation race at the transfer authorization boundary", async () => {
    const test = harness();
    test.store.authorizeTransfer.mockResolvedValueOnce("cancelling");
    await expect(test.processor.process("delivery-1")).resolves.toEqual({ kind: "terminal", status: "cancelled" });
    expect(test.store.finalizeCancelled).toHaveBeenCalledWith("delivery-1", "lease-1", null);
    expect(test.adapter.calls).toHaveLength(0);
  });

  it("recovers and revokes an authorized transfer after its Blob is quarantined", async () => {
    const test = harness();
    test.store.load.mockResolvedValueOnce(command({
      transferAuthorizedAt: new Date("2026-07-18T00:00:00.000Z"),
    }));
    test.store.authorizeTransfer.mockResolvedValueOnce("cancelling");
    test.store.recordRemoteReceipt.mockResolvedValueOnce("cancelling");

    await expect(test.processor.process("delivery-1")).resolves.toEqual({
      kind: "terminal",
      status: "cancelled",
    });
    expect(test.adapter.calls).toHaveLength(1);
    await expect(test.adapter.calls[0]!.isCancelled()).resolves.toBe(false);
    expect(test.adapter.revocations).toEqual([{
      idempotencyKey: "delivery-1",
      remoteReference: "fake://netlify/delivery-1",
    }]);
    expect(test.store.finalizeCancelled).toHaveBeenCalledWith(
      "delivery-1",
      "lease-1",
      "fake://netlify/delivery-1",
    );
  });

  it("records a remote receipt before compensating a concurrent cancellation", async () => {
    const test = harness();
    test.store.recordRemoteReceipt.mockResolvedValueOnce("cancelling");
    await expect(test.processor.process("delivery-1")).resolves.toEqual({ kind: "terminal", status: "cancelled" });
    expect(test.store.recordRemoteReceipt).toHaveBeenCalledBefore(test.store.finalizeCancelled);
    expect(test.adapter.revocations).toEqual([{
      idempotencyKey: "delivery-1",
      remoteReference: "fake://netlify/delivery-1",
    }]);
    expect(test.store.finalizeCancelled).toHaveBeenCalledWith(
      "delivery-1",
      "lease-1",
      "fake://netlify/delivery-1",
    );
  });

  it("keeps cancellation non-terminal when remote revocation fails", async () => {
    const adapter = new FakeExternalExportDeliveryAdapter("netlify");
    vi.spyOn(adapter, "revoke").mockRejectedValueOnce(new Error("REMOTE_REVOKE_UNAVAILABLE"));
    const test = harness(adapter);
    test.store.recordRemoteReceipt.mockResolvedValueOnce("cancelling");
    test.store.load
      .mockResolvedValueOnce(command())
      .mockResolvedValueOnce(command({
        status: "cancelling",
        transferAuthorizedAt: new Date("2026-07-18T00:00:00.000Z"),
        remoteReference: "fake://netlify/delivery-1",
      }));
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 3, retryLimit: 3 }))
      .rejects.toThrow("REMOTE_REVOKE_UNAVAILABLE");
    expect(test.store.releaseForRetry).toHaveBeenCalledWith("delivery-1", "lease-1");
    expect(test.store.fail).not.toHaveBeenCalled();
    expect(test.store.finalizeCancelled).not.toHaveBeenCalled();
  });

  it("releases its lease before asking the queue to retry a transient failure", async () => {
    const adapter = new FakeExternalExportDeliveryAdapter("netlify", { failCount: 1 });
    const test = harness(adapter);
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 0, retryLimit: 1 }))
      .rejects.toThrow("EXPORT_EXTERNAL_FAKE_FAILURE");
    expect(test.store.releaseForRetry).toHaveBeenCalledWith("delivery-1", "lease-1");
    expect(test.store.fail).not.toHaveBeenCalled();
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 1, retryLimit: 1 }))
      .resolves.toMatchObject({ kind: "published", status: "succeeded" });
  });

  it("replays provider success with the same idempotency key after receipt persistence fails", async () => {
    const test = harness();
    test.store.recordRemoteReceipt
      .mockRejectedValueOnce(new Error("DATABASE_TEMPORARILY_UNAVAILABLE"))
      .mockResolvedValueOnce("succeeded");
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 0, retryLimit: 1 }))
      .rejects.toThrow("DATABASE_TEMPORARILY_UNAVAILABLE");
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 1, retryLimit: 1 }))
      .resolves.toMatchObject({ kind: "published", remoteReference: "fake://netlify/delivery-1" });
    expect(test.adapter.calls).toHaveLength(2);
    expect(test.adapter.calls.map((call) => call.idempotencyKey)).toEqual(["delivery-1", "delivery-1"]);
  });

  it("records retry exhaustion without leaking adapter internals", async () => {
    const test = harness(new FakeExternalExportDeliveryAdapter("netlify", { failCount: 2 }));
    await expect(test.processor.process("delivery-1", undefined, { retryCount: 1, retryLimit: 1 }))
      .resolves.toEqual({ kind: "failed", code: "EXPORT_DELIVERY_RETRY_EXHAUSTED" });
    expect(test.store.fail).toHaveBeenCalledWith(
      "delivery-1",
      "lease-1",
      "EXPORT_DELIVERY_RETRY_EXHAUSTED",
      "EXPORT_EXTERNAL_FAKE_FAILURE",
    );
    expect(test.store.releaseForRetry).not.toHaveBeenCalled();
  });

  it("does not overwrite the active owner after losing its lease", async () => {
    const test = harness();
    test.store.recordRemoteReceipt.mockRejectedValueOnce(new Error("EXPORT_DELIVERY_LEASE_LOST"));
    await expect(test.processor.process("delivery-1")).resolves.toEqual({ kind: "busy" });
    expect(test.store.fail).not.toHaveBeenCalled();
    expect(test.store.releaseForRetry).not.toHaveBeenCalled();
  });

  it("fails closed when verified bytes no longer match the payload identity", async () => {
    const test = harness();
    test.storage.readVerified.mockResolvedValueOnce(new Uint8Array(Buffer.from("tampered", "utf8")));
    await expect(test.processor.process("delivery-1")).resolves.toEqual({
      kind: "failed",
      code: "EXPORT_DELIVERY_OUTPUT_IDENTITY_MISMATCH",
    });
    expect(test.store.authorizeTransfer).not.toHaveBeenCalled();
    expect(test.adapter.calls).toHaveLength(0);
  });

  it("persists the stable production capability failure code", async () => {
    const test = harness(new UnavailableExternalExportDeliveryAdapter(
      "netlify",
      "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
    ));
    await expect(test.processor.process("delivery-1")).resolves.toEqual({
      kind: "failed",
      code: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
    });
    expect(test.store.fail).toHaveBeenCalledWith(
      "delivery-1",
      "lease-1",
      "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
      "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
    );
  });
});
