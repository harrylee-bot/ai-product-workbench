import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { exportDeliveryQueue } from "@workbench/workbench-contracts";
import { ExternalExportDeliveriesService } from "../src/modules/exports/external-export-deliveries.service.js";
import { ExportsController } from "../src/modules/exports/exports.controller.js";

const now = new Date("2026-07-18T08:00:00.000Z");
const sha256 = "a".repeat(64);

function readyExportJob() {
  return {
    id: "export_1",
    releaseId: "release_1",
    createdById: "principal_1",
    requestHash: "b".repeat(64),
    format: "html" as const,
    packaging: "single_file" as const,
    selectionKind: "release" as const,
    selectionArtifactId: null,
    selectionArtifactVersionId: null,
    selectionScreenId: null,
    selectionNodeIds: [],
    status: "succeeded" as const,
    revision: 1,
    options: {},
    outputBlobId: "blob_1",
    outputBlob: {
      id: "blob_1",
      mediaType: "text/html; charset=utf-8",
      byteSize: 128n,
      sha256,
      status: "ready",
      deletedAt: null,
    },
    failureCode: null,
    failureDetail: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
    release: { projectId: "project_1" },
  };
}

function payload() {
  return {
    exportJobId: "export_1",
    releaseId: "release_1",
    format: "html" as const,
    packaging: "single_file" as const,
    selection: { kind: "release" as const },
    output: {
      mediaType: "text/html; charset=utf-8",
      byteSize: 128,
      sha256,
      fileName: "export_1.html",
    },
  };
}

type DeliveryStatus =
  | "pending_confirmation"
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

function deliveryRecord(status: DeliveryStatus, overrides: Record<string, unknown> = {}) {
  const executed = ["running", "cancelling", "succeeded", "failed"].includes(status);
  const confirmed = status !== "pending_confirmation";
  const started = executed || status === "cancelled" && overrides.startedAt !== undefined;
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    id: "delivery_1",
    exportJobId: "export_1",
    createdById: "principal_1",
    idempotencyKey: "delivery:key:123",
    requestHash: "c".repeat(64),
    target: "netlify" as const,
    authentication: "authenticated" as const,
    status,
    revision: 4,
    attempt: executed ? 1 : 0,
    payload: payload(),
    remoteReference: status === "succeeded" ? "site_1" : null,
    failureCode: status === "failed" ? "EXPORT_DELIVERY_FAILED" : null,
    failureDetail: status === "failed" ? "failed" : null,
    leaseToken: status === "running" || status === "cancelling" ? "lease_1" : null,
    leaseExpiresAt: status === "running" || status === "cancelling"
      ? new Date(now.getTime() + 60_000)
      : null,
    createdAt: now,
    confirmedAt: confirmed ? now : null,
    startedAt: started ? now : null,
    transferAuthorizedAt: status === "succeeded" ? now : null,
    finishedAt: terminal ? now : null,
    updatedAt: now,
    exportJob: readyExportJob(),
    ...overrides,
  };
}

function availableCapabilities() {
  return {
    external: vi.fn().mockReturnValue({
      available: true,
      authentication: "authenticated",
      reasonCode: null,
    }),
  };
}

function transactionHarness(latest: object) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 1 }]),
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
    exportJob: { findUnique: vi.fn().mockResolvedValue(readyExportJob()) },
    externalExportDelivery: {
      findUnique: vi.fn().mockResolvedValue(latest),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue(latest),
    },
  };
  return tx;
}

function serviceHarness(current: object | null, latest = current) {
  const tx = transactionHarness(latest ?? {});
  const db = {
    exportJob: { findFirst: vi.fn().mockResolvedValue(readyExportJob()) },
    externalExportDelivery: {
      findFirst: vi.fn().mockResolvedValue(current),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const queue = { sendInTransaction: vi.fn().mockResolvedValue("queue_job_1") };
  const capabilities = availableCapabilities();
  const service = new ExternalExportDeliveriesService(
    db as never,
    queue as never,
    capabilities as never,
  );
  return { service, db, tx, queue, capabilities };
}

describe("ExternalExportDeliveriesService", () => {
  beforeEach(() => vi.useFakeTimers({ now }));
  afterEach(() => vi.useRealTimers());

  it("reports external delivery cancellation as asynchronously accepted", () => {
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      ExportsController.prototype.cancelExternalDelivery,
    )).toBe(202);
  });

  it("prevents shared or retained caching of external delivery audit lists", async () => {
    const list = { items: [deliveryRecord("pending_confirmation")] };
    const externalDeliveries = { list: vi.fn().mockResolvedValue(list) };
    const response = { setHeader: vi.fn() };
    const controller = new ExportsController({} as never, externalDeliveries as never);

    await expect(controller.listExternalDeliveries(
      { id: "principal_1" } as never,
      "export_1",
      response as never,
    )).resolves.toBe(list);

    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(externalDeliveries.list).toHaveBeenCalledWith("principal_1", "export_1");
  });

  it("creates a confirmation-only delivery from an INNER JOIN locked readable Export output", async () => {
    const created = deliveryRecord("pending_confirmation", { revision: 0 });
    const test = serviceHarness(null, created);
    test.tx.externalExportDelivery.findUnique.mockResolvedValueOnce(null);

    await expect(test.service.create(
      "principal_1",
      "export_1",
      "delivery:key:123",
      { target: "netlify" },
    )).resolves.toMatchObject({
      id: "delivery_1",
      status: "pending_confirmation",
      attempt: 0,
    });

    const outputLock = test.tx.$queryRaw.mock.calls[0]![0] as { strings?: readonly string[] };
    const outputLockSql = outputLock.strings?.join(" ") ?? "";
    expect(outputLockSql).toContain('INNER JOIN "blobs" AS blob');
    expect(outputLockSql).toContain("FOR UPDATE OF job, blob");
    expect(test.tx.externalExportDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "pending_confirmation",
        revision: 0,
        attempt: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        transferAuthorizedAt: null,
      }),
    });
    expect(test.queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("confirms only pending delivery state and initializes a lease-free queued attempt", async () => {
    const current = deliveryRecord("pending_confirmation");
    const queued = deliveryRecord("queued", { revision: 5 });
    const test = serviceHarness(current, queued);

    await expect(test.service.confirm("principal_1", "delivery_1", 4))
      .resolves.toMatchObject({ status: "queued", revision: 5, attempt: 0 });

    expect(test.tx.externalExportDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery_1", revision: 4, status: "pending_confirmation" },
      data: expect.objectContaining({
        status: "queued",
        attempt: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        transferAuthorizedAt: null,
        remoteReference: null,
      }),
    });
    expect(test.queue.sendInTransaction).toHaveBeenCalledWith(
      test.tx,
      exportDeliveryQueue,
      { deliveryId: "delivery_1" },
      { singletonKey: "delivery_1" },
    );
  });

  it("retries only failed state while preserving the attempt counter and clearing execution ownership", async () => {
    const current = deliveryRecord("failed", {
      attempt: 3,
      startedAt: now,
      transferAuthorizedAt: now,
    });
    const queued = deliveryRecord("queued", { revision: 5, attempt: 3 });
    const test = serviceHarness(current, queued);

    await expect(test.service.retry("principal_1", "delivery_1", 4))
      .resolves.toMatchObject({ status: "queued", revision: 5, attempt: 3 });

    const update = test.tx.externalExportDelivery.updateMany.mock.calls[0]![0];
    expect(update).toEqual({
      where: { id: "delivery_1", revision: 4, status: "failed" },
      data: expect.objectContaining({
        status: "queued",
        startedAt: null,
        transferAuthorizedAt: null,
        finishedAt: null,
        remoteReference: null,
        failureCode: null,
        failureDetail: null,
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
    expect(update.data).not.toHaveProperty("attempt");
    expect(test.queue.sendInTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["pending_confirmation", "queued"] as const)(
    "cancels %s without scheduling remote revocation",
    async (status) => {
      const current = deliveryRecord(status);
      const cancelled = deliveryRecord("cancelled", {
        revision: 5,
        attempt: current.attempt,
        confirmedAt: current.confirmedAt,
        startedAt: current.startedAt,
        transferAuthorizedAt: current.transferAuthorizedAt,
      });
      const test = serviceHarness(current, cancelled);

      await expect(test.service.cancel("principal_1", "delivery_1", 4))
        .resolves.toMatchObject({ status: "cancelled", revision: 5 });

      expect(test.tx.externalExportDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: "delivery_1", revision: 4, status },
        data: expect.objectContaining({
          status: "cancelled",
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      });
      expect(test.queue.sendInTransaction).not.toHaveBeenCalled();
    },
  );

  it("moves a running delivery to cancelling without stealing the worker lease", async () => {
    const current = deliveryRecord("running", {
      leaseToken: "worker_lease",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    const cancelling = deliveryRecord("cancelling", {
      revision: 5,
      leaseToken: "worker_lease",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    const test = serviceHarness(current, cancelling);

    await expect(test.service.cancel("principal_1", "delivery_1", 4))
      .resolves.toMatchObject({ status: "cancelling", revision: 5 });

    const update = test.tx.externalExportDelivery.updateMany.mock.calls[0]![0];
    expect(update.where).toEqual({ id: "delivery_1", revision: 4, status: "running" });
    expect(update.data).toEqual({
      status: "cancelling",
      finishedAt: null,
      revision: { increment: 1 },
    });
    expect(update.data).not.toHaveProperty("leaseToken");
    expect(update.data).not.toHaveProperty("leaseExpiresAt");
    expect(test.queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("moves a succeeded delivery to cancelling and queues durable remote revocation", async () => {
    const current = deliveryRecord("succeeded");
    const cancelling = deliveryRecord("cancelling", {
      revision: 5,
      leaseToken: null,
      leaseExpiresAt: null,
      transferAuthorizedAt: now,
      remoteReference: "site_1",
    });
    const test = serviceHarness(current, cancelling);

    await expect(test.service.cancel("principal_1", "delivery_1", 4))
      .resolves.toMatchObject({
        status: "cancelling",
        remoteReference: "site_1",
        transferAuthorizedAt: now.toISOString(),
      });

    expect(test.tx.externalExportDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "delivery_1", revision: 4, status: "succeeded" },
      data: {
        status: "cancelling",
        finishedAt: null,
        revision: { increment: 1 },
      },
    });
    expect(test.queue.sendInTransaction).toHaveBeenCalledWith(
      test.tx,
      exportDeliveryQueue,
      { deliveryId: "delivery_1" },
      { singletonKey: "delivery_1" },
    );
  });

  it("treats an already-cancelling delivery as idempotent and leaves its lease untouched", async () => {
    const current = deliveryRecord("cancelling", {
      leaseToken: "worker_lease",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    const test = serviceHarness(current);

    await expect(test.service.cancel("principal_1", "delivery_1", 4))
      .resolves.toMatchObject({ status: "cancelling", revision: 4 });

    expect(test.db.$transaction).not.toHaveBeenCalled();
    expect(test.queue.sendInTransaction).not.toHaveBeenCalled();
  });
});
