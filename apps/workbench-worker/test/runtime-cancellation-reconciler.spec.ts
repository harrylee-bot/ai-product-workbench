import { describe, expect, it, vi } from "vitest";

const recordRuntimeLivenessMetric = vi.hoisted(() => vi.fn());

vi.mock("@workbench/workbench-telemetry", () => ({ recordRuntimeLivenessMetric }));

import { RuntimeCancellationReconciler } from "../src/runs/runtime-cancellation-reconciler.js";

describe("RuntimeCancellationReconciler", () => {
  beforeEach(() => recordRuntimeLivenessMetric.mockClear());

  it("requeues stale cancelling Runs with a singleton key", async () => {
    const findMany = vi.fn(async () => [{ id: "run-2" }, { id: "run-1" }]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const send = vi.fn(async () => "job-1");
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany, updateMany } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
    );

    await reconciler.runOnce();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { status: "cancelling" },
          {
            status: "failed",
            errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
            runtimeAttempts: {
              some: {
                status: "failed",
                errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
                providerCancellationResolution: { is: null },
              },
            },
          },
        ],
        updatedAt: { lte: expect.any(Date) },
      }),
      take: 10,
    }));
    expect(send).toHaveBeenNthCalledWith(
      1,
      "runtime.cancel",
      { runId: "run-2" },
      { singletonKey: "run-2" },
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      "runtime.cancel",
      { runId: "run-1" },
      { singletonKey: "run-1" },
    );
    expect(recordRuntimeLivenessMetric).toHaveBeenCalledTimes(2);
    expect(recordRuntimeLivenessMetric).toHaveBeenCalledWith(expect.objectContaining({
      operation: "reconcile",
      outcome: "recovered",
    }));
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "run-2",
        OR: [
          { status: "cancelling" },
          {
            status: "failed",
            errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
            runtimeAttempts: {
              some: {
                status: "failed",
                errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
                providerCancellationResolution: { is: null },
              },
            },
          },
        ],
      },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it("does not overlap a slow reconciliation pass", async () => {
    let release!: () => void;
    const findMany = vi.fn(() => new Promise<[]>(resolve => { release = () => resolve([]); }));
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany } } as never,
      { send: vi.fn() } as never,
      1,
      10,
      60_000,
    );

    const first = reconciler.runOnce();
    const second = reconciler.runOnce();
    expect(findMany).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
  });

  it("does not report recovery when the singleton queue rejects a duplicate job", async () => {
    const findMany = vi.fn(async () => [{ id: "run-1" }]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const send = vi.fn(async () => null);
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany, updateMany } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
    );

    await reconciler.runOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(recordRuntimeLivenessMetric).not.toHaveBeenCalled();
  });

  it("reports a queue failure and continues with the remaining stale Runs", async () => {
    const firstError = new Error("queue unavailable");
    const findMany = vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const send = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce("job-2");
    const onError = vi.fn();
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany, updateMany } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
      onError,
    );

    await reconciler.runOnce();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      "runtime.cancel",
      { runId: "run-1" },
      { singletonKey: "run-1" },
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      "runtime.cancel",
      { runId: "run-2" },
      { singletonKey: "run-2" },
    );
    expect(onError).toHaveBeenCalledWith(firstError);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "run-2" }),
    }));
    expect(recordRuntimeLivenessMetric).toHaveBeenCalledWith(expect.objectContaining({
      operation: "reconcile",
      outcome: "error",
      errorCode: "RUNTIME_CANCELLATION_RECONCILE_FAILED",
    }));
  });

  it("includes failed Runs whose provider cancellation is still unconfirmed", async () => {
    const findMany = vi.fn(async () => [{ id: "run-failed" }]);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const send = vi.fn(async () => "job-failed");
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany, updateMany } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
    );

    await reconciler.runOnce();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          {
            status: "failed",
            errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
            runtimeAttempts: {
              some: {
                status: "failed",
                errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
                providerCancellationResolution: { is: null },
              },
            },
          },
        ]),
      }),
    }));
    expect(send).toHaveBeenCalledWith(
      "runtime.cancel",
      { runId: "run-failed" },
      { singletonKey: "run-failed" },
    );
  });

  it("requires an unconfirmed failed RuntimeAttempt before requeueing a failed Run", async () => {
    const findMany = vi.fn(async () => []);
    const send = vi.fn();
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany, updateMany: vi.fn() } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
    );

    await reconciler.runOnce();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([{
          status: "failed",
          errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
          runtimeAttempts: {
            some: {
              status: "failed",
              errorCode: "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED",
              providerCancellationResolution: { is: null },
            },
          },
        }]),
      }),
    }));
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps start and stop idempotent", () => {
    vi.useFakeTimers();
    try {
      const findMany = vi.fn(async () => []);
      const reconciler = new RuntimeCancellationReconciler(
        { run: { findMany } } as never,
        { send: vi.fn(async () => null) } as never,
        5_000,
        10,
        1_000,
      );

      reconciler.start();
      reconciler.start();
      reconciler.stop();
      reconciler.stop();

      expect(findMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
