import { afterEach, describe, expect, it, vi } from "vitest";

import { PrototypeCheckpointRecoveryCoordinator } from "./recovery";

describe("Prototype checkpoint recovery coordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces concurrent recovery for the same projection key", async () => {
    const coordinator = new PrototypeCheckpointRecoveryCoordinator<string>();
    coordinator.setScope("project-1:run-1:attempt-1");
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);

    const first = coordinator.recover("version-1:screen-1", load);
    const second = coordinator.recover("version-1:screen-1", load);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledOnce();

    pending.resolve("checkpoint");
    await expect(first).resolves.toEqual({ kind: "loaded", checkpoint: "checkpoint" });
    expect(coordinator.isRecovering("version-1:screen-1")).toBe(false);
  });

  it("aborts old requests and fences late completion on scope switch", async () => {
    const coordinator = new PrototypeCheckpointRecoveryCoordinator<string>();
    coordinator.setScope("project-1:run-1:attempt-1");
    const pending = deferred<string>();
    let signal: AbortSignal | undefined;
    const recovery = coordinator.recover("version-1:screen-1", (value) => {
      signal = value;
      return pending.promise;
    });

    coordinator.setScope("project-2:run-2:attempt-1");
    expect(signal?.aborted).toBe(true);
    await expect(recovery).resolves.toEqual({ kind: "aborted" });

    pending.resolve("old-checkpoint");
  });

  it("retries failures with exponential backoff before returning a checkpoint", async () => {
    vi.useFakeTimers();
    const coordinator = new PrototypeCheckpointRecoveryCoordinator<string>({
      initialDelayMs: 100,
      maxAttempts: 3,
      maxDelayMs: 1_000,
      multiplier: 2,
    });
    coordinator.setScope("project-1:run-1:attempt-1");
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockResolvedValueOnce("checkpoint");
    const recovery = coordinator.recover("version-1", load);

    await vi.advanceTimersByTimeAsync(99);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(recovery).resolves.toEqual({ kind: "loaded", checkpoint: "checkpoint" });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("contains loader failures after the configured attempt cap", async () => {
    vi.useFakeTimers();
    const coordinator = new PrototypeCheckpointRecoveryCoordinator<string>({
      initialDelayMs: 100,
      maxAttempts: 3,
      multiplier: 2,
    });
    coordinator.setScope("project-1:run-1:attempt-1");
    const error = new Error("checkpoint unavailable");
    const load = vi.fn().mockRejectedValue(error);
    const recovery = coordinator.recover("version-1", load);

    await vi.advanceTimersByTimeAsync(300);

    await expect(recovery).resolves.toEqual({ kind: "failed", error });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("aborts an active backoff without starting another attempt", async () => {
    vi.useFakeTimers();
    const coordinator = new PrototypeCheckpointRecoveryCoordinator<string>({
      initialDelayMs: 1_000,
      maxAttempts: 3,
    });
    coordinator.setScope("project-1:run-1:attempt-1");
    const load = vi.fn().mockRejectedValue(new Error("checkpoint unavailable"));
    const recovery = coordinator.recover("version-1", load);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce();

    coordinator.abort("version-1");

    await expect(recovery).resolves.toEqual({ kind: "aborted" });
    expect(load).toHaveBeenCalledOnce();
  });

  it("aborts one projection without disturbing another", async () => {
    const coordinator = new PrototypeCheckpointRecoveryCoordinator<string>();
    coordinator.setScope("project-1:run-1:attempt-1");
    const first = deferred<string>();
    const second = deferred<string>();
    const firstRecovery = coordinator.recover("first", () => first.promise);
    const secondRecovery = coordinator.recover("second", () => second.promise);

    coordinator.abort("first");
    first.resolve("ignored");
    second.resolve("kept");

    await expect(firstRecovery).resolves.toEqual({ kind: "aborted" });
    await expect(secondRecovery).resolves.toEqual({ kind: "loaded", checkpoint: "kept" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
