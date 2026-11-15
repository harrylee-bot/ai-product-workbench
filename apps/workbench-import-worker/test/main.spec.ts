import { afterEach, describe, expect, it, vi } from "vitest";
import { importSourceProcessQueue, importSourceProcessQueueOptions } from "@workbench/workbench-contracts";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  boss: {
    on: vi.fn(), start: vi.fn(), createQueue: vi.fn(), getQueue: vi.fn(), work: vi.fn(),
    stop: vi.fn(), send: vi.fn(),
  },
  db: { $connect: vi.fn(), $disconnect: vi.fn() },
  store: { expireStaleAttempts: vi.fn(), reconciliationCandidates: vi.fn(), scheduleRetry: vi.fn() },
  telemetry: { shutdown: vi.fn() },
}));

vi.mock("pg-boss", () => ({
  PgBoss: class { constructor() { return mocks.boss; } },
  fromPrisma: (tx: unknown) => tx,
}));
vi.mock("../src/db.js", () => ({ db: mocks.db }));
vi.mock("../src/config.js", () => ({
  loadImportWorkerConfig: () => ({
    scanMode: "fail_closed", reconciliationIntervalMs: 100, staleRunningMs: 1_000,
    maximumAttempts: 3, concurrency: 1, pendingBlobPrefix: "pending", canonicalBlobPrefix: "blobs",
  }),
}));
vi.mock("../src/import/import-source.store.js", () => ({
  PrismaImportSourceStore: class { constructor() { return mocks.store; } },
}));
vi.mock("../src/storage/s3-import-storage.adapter.js", () => ({ S3ImportStorageAdapter: class {} }));
vi.mock("@workbench/workbench-telemetry", () => ({
  initializeTelemetry: () => mocks.telemetry,
  queuePayload: (payload: unknown) => payload,
  traceQueueConsume: vi.fn(), traceQueuePublish: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.resetAllMocks();
  mocks.events.length = 0;
});

async function startWorker() {
  vi.useFakeTimers();
  mocks.boss.getQueue.mockResolvedValue({ name: importSourceProcessQueue, ...importSourceProcessQueueOptions });
  mocks.store.expireStaleAttempts.mockResolvedValue(undefined);
  mocks.store.reconciliationCandidates.mockResolvedValue([]);
  mocks.boss.stop.mockImplementation(async () => { mocks.events.push("queue stopped"); });
  mocks.db.$disconnect.mockImplementation(async () => { mocks.events.push("database disconnected"); });
  mocks.telemetry.shutdown.mockResolvedValue(undefined);
  const handlers = new Map<string, () => void>();
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      handlers.set(event, listener as () => void);
      return process;
    }
    return originalOnce(event, listener);
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await vi.importActual("../src/main.js");
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`[import-worker] listening on ${importSourceProcessQueue}`));
  return { stop: handlers.get("SIGTERM")!, interrupt: handlers.get("SIGINT")!, exit };
}

function holdReconciliation() {
  let complete!: () => void;
  mocks.store.expireStaleAttempts.mockImplementationOnce(() => new Promise<void>((resolve) => {
    complete = () => {
      mocks.events.push("reconciliation finished");
      resolve();
    };
  }));
  return () => complete();
}

describe("Import Worker reconciliation lifecycle", () => {
  it("keeps one reconciliation in flight when a database pass exceeds its interval", async () => {
    const worker = await startWorker();
    const complete = holdReconciliation();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(400);
    expect(mocks.store.expireStaleAttempts).toHaveBeenCalledTimes(2);
    complete();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.store.expireStaleAttempts).toHaveBeenCalledTimes(3);
    worker.stop();
    await vi.waitFor(() => expect(worker.exit).toHaveBeenCalledWith(0));
  });

  it("waits for the active reconciliation before stopping its queue and database", async () => {
    const worker = await startWorker();
    const complete = holdReconciliation();
    await vi.advanceTimersByTimeAsync(100);
    worker.stop();
    worker.interrupt();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.boss.stop).not.toHaveBeenCalled();
    expect(mocks.db.$disconnect).not.toHaveBeenCalled();
    expect(worker.exit).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(worker.exit).toHaveBeenCalledWith(0));
    expect(mocks.events).toEqual([
      "reconciliation finished", "queue stopped", "database disconnected",
    ]);
    expect(mocks.store.expireStaleAttempts).toHaveBeenCalledTimes(2);
  });
});
