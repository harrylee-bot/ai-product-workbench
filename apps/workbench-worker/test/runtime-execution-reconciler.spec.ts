import { RuntimeExecutionReconciler } from "../src/runs/runtime-execution-reconciler.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rawSqlText(query: unknown) {
  if (!query || typeof query !== "object") return String(query);
  const value = query as { sql?: unknown; text?: unknown; strings?: unknown };
  if (typeof value.sql === "string") return value.sql;
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.strings)) return value.strings.join("");
  return String(query);
}

describe("RuntimeExecutionReconciler", () => {
  it("atomically requeues every unowned or expired running Run with its thread group", async () => {
    const transactionQueries = vi.fn()
      .mockResolvedValueOnce([{ id: "run-1", threadId: "thread-1" }])
      .mockResolvedValueOnce([{ id: "run-2", threadId: "thread-2" }]);
    const db = {
      $queryRaw: vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]),
      $transaction: vi.fn(async (
        callback: (tx: { $queryRaw: typeof transactionQueries }) => Promise<unknown>,
      ) => callback({ $queryRaw: transactionQueries })),
    };
    const queue = { send: vi.fn(async () => "job-1") };
    const reconciler = new RuntimeExecutionReconciler(db as never, queue, 25, 5_000);

    await reconciler.runOnce();

    expect(queue.send).toHaveBeenNthCalledWith(
      1,
      "runtime.execute",
      { runId: "run-1" },
      expect.objectContaining({ singletonKey: "run-1", group: { id: "thread-1" } }),
    );
    expect(queue.send).toHaveBeenNthCalledWith(
      2,
      "runtime.execute",
      { runId: "run-2" },
      expect.objectContaining({ singletonKey: "run-2", group: { id: "thread-2" } }),
    );
    const sql = rawSqlText(db.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("execution_owner_id");
    expect(sql).toContain("execution_lease_expires_at");
    expect(sql).toContain("CURRENT_TIMESTAMP");
    const lockedSql = rawSqlText(transactionQueries.mock.calls[0]?.[0]);
    expect(lockedSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(lockedSql).toContain("thread_id");
  });

  it("reports one enqueue failure and continues with the remaining candidates", async () => {
    const failure = new Error("queue unavailable");
    const transactionQueries = vi.fn()
      .mockResolvedValueOnce([{ id: "run-1", threadId: "thread-1" }])
      .mockResolvedValueOnce([{ id: "run-2", threadId: "thread-2" }]);
    const db = {
      $queryRaw: vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]),
      $transaction: vi.fn(async (
        callback: (tx: { $queryRaw: typeof transactionQueries }) => Promise<unknown>,
      ) => callback({ $queryRaw: transactionQueries })),
    };
    const queue = {
      send: vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce("job-2"),
    };
    const onError = vi.fn();
    const reconciler = new RuntimeExecutionReconciler(db as never, queue, 25, 5_000, onError);

    await reconciler.runOnce();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it("does not enqueue when the locked Run no longer needs recovery", async () => {
    const transactionQueries = vi.fn(async () => []);
    const db = {
      $queryRaw: vi.fn(async () => [{ id: "run-1" }]),
      $transaction: vi.fn(async (
        callback: (tx: { $queryRaw: typeof transactionQueries }) => Promise<unknown>,
      ) => callback({ $queryRaw: transactionQueries })),
    };
    const queue = { send: vi.fn(async () => "job-1") };
    const reconciler = new RuntimeExecutionReconciler(db as never, queue, 25, 5_000);

    await reconciler.runOnce();

    expect(queue.send).not.toHaveBeenCalled();
  });

  it("does not overlap reconciliation scans", async () => {
    const gate = deferred<Array<{ id: string }>>();
    const db = {
      $queryRaw: vi.fn(async () => gate.promise),
      $transaction: vi.fn(async (
        callback: (tx: { $queryRaw: () => Promise<Array<{ id: string; threadId: string }>> }) => Promise<unknown>,
      ) => callback({
        $queryRaw: async () => [{ id: "run-1", threadId: "thread-1" }],
      })),
    };
    const queue = { send: vi.fn(async () => "job-1") };
    const reconciler = new RuntimeExecutionReconciler(db as never, queue, 25, 5_000);

    const first = reconciler.runOnce();
    await reconciler.runOnce();
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);

    gate.resolve([{ id: "run-1" }]);
    await first;
    expect(queue.send).toHaveBeenCalledTimes(1);
  });
});
