const recordRuntimeLivenessMetric = vi.hoisted(() => vi.fn());

vi.mock("@workbench/workbench-telemetry", () => ({ recordRuntimeLivenessMetric }));

import {
  RuntimeLivenessError,
  RuntimeProviderCancellationBudget,
  RuntimeProviderLivenessBudget,
  RuntimeWallClockBudget,
  raceWithAbort,
} from "../src/runtime/runtime-liveness.js";

describe("Runtime liveness budgets", () => {
  beforeEach(() => {
    recordRuntimeLivenessMetric.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the 899ms boundary active and expires exactly at 900ms", async () => {
    const budget = new RuntimeWallClockBudget(900, performance.now());

    await vi.advanceTimersByTimeAsync(899);
    expect(budget.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(budget.signal.reason).toMatchObject({
      code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      retryable: false,
    });
  });

  it("does not treat an active stream as idle", async () => {
    const budget = new RuntimeProviderLivenessBudget(100, 100);

    for (let elapsed = 0; elapsed < 900; elapsed += 90) {
      await vi.advanceTimersByTimeAsync(90);
      budget.providerActivity();
      expect(budget.signal.aborted).toBe(false);
    }

    budget.stop();
  });

  it("distinguishes provider first-byte latency from subsequent stream idle intervals", () => {
    const budget = new RuntimeProviderLivenessBudget(100, 250);

    budget.providerActivity();
    budget.providerActivity();

    expect(recordRuntimeLivenessMetric).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: "provider-first-byte",
      outcome: "ok",
    }));
    expect(recordRuntimeLivenessMetric).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: "stream-idle",
      outcome: "ok",
    }));
    budget.stop();
  });

  it("separates submission timeout from hard stream-idle timeout", async () => {
    const submission = new RuntimeProviderLivenessBudget(100, 250);
    await vi.advanceTimersByTimeAsync(100);
    expect(submission.signal.reason).toMatchObject({
      code: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
      retryable: true,
    });

    const stream = new RuntimeProviderLivenessBudget(100, 250);
    stream.providerActivity();
    await vi.advanceTimersByTimeAsync(249);
    expect(stream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.signal.reason).toMatchObject({
      code: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
      retryable: true,
    });
  });

  it("preserves the original wall-clock deadline across lease takeover", async () => {
    const originalStart = performance.now();
    await vi.advanceTimersByTimeAsync(700);
    const takeover = new RuntimeWallClockBudget(900, originalStart);

    await vi.advanceTimersByTimeAsync(199);
    expect(takeover.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(takeover.signal.reason).toBeInstanceOf(RuntimeLivenessError);
  });

  it("bounds provider cancellation at the configured deadline", async () => {
    const budget = new RuntimeProviderCancellationBudget(900);

    await vi.advanceTimersByTimeAsync(899);
    expect(budget.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.signal.reason).toMatchObject({
      code: "RUNTIME_PROVIDER_CANCEL_TIMEOUT",
      retryable: true,
    });
  });

  it("returns control when a provider ignores abort", async () => {
    const controller = new AbortController();
    const ignored = new Promise<never>(() => undefined);
    const raced = raceWithAbort(ignored, controller.signal);

    controller.abort(new RuntimeLivenessError(
      "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
      false,
    ));

    await expect(raced).rejects.toMatchObject({
      code: "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED",
    });
  });

  it("observes a provider rejection even when the signal was already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("WORKER_DISCONNECTED");
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    controller.abort(reason);

    const raced = raceWithAbort(operation, controller.signal);
    await expect(raced).rejects.toBe(reason);

    rejectOperation(new Error("LATE_PROVIDER_FAILURE"));
    await Promise.resolve();
  });

  it("propagates worker disconnect abort independently of provider timers", async () => {
    const worker = new AbortController();
    const budget = new RuntimeProviderLivenessBudget(900, 900, worker.signal);
    const reason = new Error("WORKER_DISCONNECTED");

    worker.abort(reason);

    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBe(reason);
    budget.stop();
  });
});
