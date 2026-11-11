import { describe, expect, it, vi } from "vitest";
import { shutdownWorker, shutdownWorkerWithExitCode } from "../src/shutdown.js";

function dependencies(overrides: Partial<Parameters<typeof shutdownWorker>[1]> = {}) {
  return {
    stopReconcilers: vi.fn(),
    stopQueue: vi.fn(async () => undefined),
    disconnectDatabase: vi.fn(async () => undefined),
    shutdownTelemetry: vi.fn(async () => undefined),
    log: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

describe("Worker shutdown", () => {
  it("reports every graceful shutdown phase in order", async () => {
    const events: string[] = [];
    const deps = dependencies({
      stopReconcilers: async () => events.push("reconcilers"),
      stopQueue: async () => events.push("queue"),
      disconnectDatabase: async () => events.push("database"),
      shutdownTelemetry: async () => events.push("telemetry"),
      log: (message) => events.push(message),
    });

    await shutdownWorker("SIGTERM", deps);

    expect(events).toEqual([
      "[worker] received SIGTERM",
      "reconcilers",
      "[worker] shutdown phase=reconcilers-stopped",
      "queue",
      "[worker] shutdown phase=queue-stopped",
      "database",
      "[worker] shutdown phase=database-disconnected",
      "telemetry",
      "[worker] shutdown phase=telemetry-stopped",
      "[worker] shutdown complete SIGTERM",
    ]);
  });

  it("returns a nonzero exit code when graceful shutdown rejects", async () => {
    const error = new Error("queue stop failed");
    const deps = dependencies({
      stopQueue: vi.fn(async () => { throw error; }),
    });

    await expect(shutdownWorkerWithExitCode("SIGTERM", deps)).resolves.toBe(1);
    expect(deps.logError).toHaveBeenCalledWith("[worker] shutdown failed SIGTERM", error);
    expect(deps.disconnectDatabase).not.toHaveBeenCalled();
    expect(deps.shutdownTelemetry).not.toHaveBeenCalled();
  });
});
