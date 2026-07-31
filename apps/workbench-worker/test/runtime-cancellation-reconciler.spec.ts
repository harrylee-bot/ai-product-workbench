import { describe, expect, it, vi } from "vitest";

const recordRuntimeLivenessMetric = vi.hoisted(() => vi.fn());

vi.mock("@workbench/workbench-telemetry", () => ({ recordRuntimeLivenessMetric }));

import { RuntimeCancellationReconciler } from "../src/runs/runtime-cancellation-reconciler.js";

describe("RuntimeCancellationReconciler", () => {
  beforeEach(() => recordRuntimeLivenessMetric.mockClear());

  it("requeues stale cancelling Runs with a singleton key", async () => {
    const findMany = vi.fn(async () => [{ id: "run-2" }, { id: "run-1" }]);
    const send = vi.fn(async () => "job-1");
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
    );

    await reconciler.runOnce();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: "cancelling",
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
    const send = vi.fn(async () => null);
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany } } as never,
      { send } as never,
      5_000,
      10,
      60_000,
    );

    await reconciler.runOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(recordRuntimeLivenessMetric).not.toHaveBeenCalled();
  });

  it("reports a queue failure and continues with the remaining stale Runs", async () => {
    const firstError = new Error("queue unavailable");
    const findMany = vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]);
    const send = vi.fn()
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce("job-2");
    const onError = vi.fn();
    const reconciler = new RuntimeCancellationReconciler(
      { run: { findMany } } as never,
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
    expect(recordRuntimeLivenessMetric).toHaveBeenCalledWith(expect.objectContaining({
      operation: "reconcile",
      outcome: "error",
      errorCode: "RUNTIME_CANCELLATION_RECONCILE_FAILED",
    }));
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
