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
  it("requeues every unowned or expired running Run with a stable singleton key", async () => {
    const db = {
      $queryRaw: vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]),
    };
    const queue = { send: vi.fn(async () => "job-1") };
    const reconciler = new RuntimeExecutionReconciler(db as never, queue, 25, 5_000);

    await reconciler.runOnce();

    expect(queue.send.mock.calls).toEqual([
      ["runtime.execute", { runId: "run-1" }, { singletonKey: "run-1" }],
      ["runtime.execute", { runId: "run-2" }, { singletonKey: "run-2" }],
    ]);
    const sql = rawSqlText(db.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("execution_owner_id");
    expect(sql).toContain("execution_lease_expires_at");
    expect(sql).toContain("CURRENT_TIMESTAMP");
  });

  it("reports one enqueue failure and continues with the remaining candidates", async () => {
    const failure = new Error("queue unavailable");
    const db = {
      $queryRaw: vi.fn(async () => [{ id: "run-1" }, { id: "run-2" }]),
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

  it("does not overlap reconciliation scans", async () => {
    const gate = deferred<Array<{ id: string }>>();
    const db = { $queryRaw: vi.fn(async () => gate.promise) };
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
