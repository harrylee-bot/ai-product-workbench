import { describe, expect, it, vi } from "vitest";
import { CanvasAgentExpiryReconciler } from "../src/modules/canvas-agent/canvas-agent-expiry-reconciler.js";

describe("CanvasAgentExpiryReconciler", () => {
  it("atomically expires a revoked session family with database-time, skip-locked batching", async () => {
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([{
        id: "session_1",
        failureCode: "GRANT_REVOKED",
      }])
      .mockResolvedValueOnce([invocation({ status: "waiting_client" })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { db, reconciler } = harness(tx);

    await expect(reconciler.runOnce()).resolves.toEqual({
      expiredSessions: 1,
      expiredCommands: 0,
      expiredInvocationLeases: 0,
    });

    expect(db.$transaction).toHaveBeenCalledTimes(3);
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["session_1"] }, status: "active" },
      data: { status: "expired", activeMutationToolCallId: null },
    });
    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: { in: ["session_1"] }, status: "pending" },
      data: { status: "cancelled" },
    });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    const invocationSql = rawSqlText(tx.$executeRaw.mock.calls[0]![0]);
    expect(invocationSql).toContain("canvas_state_sha256_after");
    expect(invocationSql).toContain("COALESCE");
    expect(invocationSql).toContain('"completed_at" = CURRENT_TIMESTAMP');
    expect(queryValues(tx.$executeRaw.mock.calls[0]![0])).toEqual(expect.arrayContaining([
      "GRANT_REVOKED",
      "invocation_1",
      "waiting_client",
    ]));
    const response = JSON.parse(queryValues(tx.$executeRaw.mock.calls[0]![0])[1] as string);
    expect(response).toMatchObject({
      status: "failed",
      failure: { code: "GRANT_REVOKED", retryable: false },
    });
    const candidateSql = rawSqlText(tx.$queryRaw.mock.calls[0]![0]);
    expect(candidateSql).toContain("CURRENT_TIMESTAMP");
    expect(candidateSql).toContain("FOR UPDATE OF session SKIP LOCKED");
    expect(queryValues(tx.$queryRaw.mock.calls[0]![0])).toContain(25);
  });

  it("expires a pending command and fails only its waiting-client invocation", async () => {
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "session_1" }])
      .mockResolvedValueOnce([{
        ...invocation({ status: "waiting_client" }),
        commandId: "command_1",
        invocationId: "invocation_1",
      }])
      .mockResolvedValueOnce([]);
    const { reconciler } = harness(tx);

    await expect(reconciler.runOnce()).resolves.toEqual({
      expiredSessions: 0,
      expiredCommands: 1,
      expiredInvocationLeases: 0,
    });

    expect(tx.canvasClientCommand.updateMany).toHaveBeenCalledWith({
      where: { id: "command_1", status: "pending" },
      data: { status: "expired" },
    });
    expect(queryValues(tx.$executeRaw.mock.calls[0]![0])).toEqual(expect.arrayContaining([
      "COMMAND_EXPIRED",
      "invocation_1",
      "waiting_client",
    ]));
    const commandSql = rawSqlText(tx.$queryRaw.mock.calls[2]![0]);
    expect(commandSql).toContain("CURRENT_TIMESTAMP");
    expect(commandSql).toContain("FOR UPDATE OF command, invocation SKIP LOCKED");
  });

  it("fails an expired in-flight lease and releases only its mutation slot", async () => {
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "session_1" }])
      .mockResolvedValueOnce([{
        ...invocation({ status: "in_flight" }),
      }]);
    const { reconciler } = harness(tx);

    await expect(reconciler.runOnce()).resolves.toEqual({
      expiredSessions: 0,
      expiredCommands: 0,
      expiredInvocationLeases: 1,
    });

    expect(queryValues(tx.$executeRaw.mock.calls[0]![0])).toEqual(expect.arrayContaining([
      "INVOCATION_LEASE_EXPIRED",
      "invocation_1",
      "in_flight",
    ]));
    expect(tx.canvasAgentSession.updateMany).toHaveBeenCalledWith({
      where: { id: "session_1", activeMutationToolCallId: "call_1" },
      data: { activeMutationToolCallId: null },
    });
    const leaseSql = rawSqlText(tx.$queryRaw.mock.calls[3]![0]);
    expect(leaseSql).toContain("CURRENT_TIMESTAMP");
    expect(leaseSql).toContain("FOR UPDATE OF invocation SKIP LOCKED");
  });

  it("shares one in-flight pass across overlapping timer or replica-local calls", async () => {
    let release!: () => void;
    const tx = transaction();
    tx.$queryRaw
      .mockImplementationOnce(() => new Promise<[]>(resolve => { release = () => resolve([]); }))
      .mockResolvedValue([]);
    const { db, reconciler } = harness(tx);

    const first = reconciler.runOnce();
    const second = reconciler.runOnce();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { expiredSessions: 0, expiredCommands: 0, expiredInvocationLeases: 0 },
      { expiredSessions: 0, expiredCommands: 0, expiredInvocationLeases: 0 },
    ]);
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });

  it("starts immediately, polls on the configured interval, and stops on destroy", async () => {
    vi.useFakeTimers();
    try {
      const tx = transaction();
      tx.$queryRaw.mockResolvedValue([]);
      const { reconciler } = harness(tx, 1_000);
      const runOnce = vi.spyOn(reconciler, "runOnce").mockResolvedValue({
        expiredSessions: 0,
        expiredCommands: 0,
        expiredInvocationLeases: 0,
      });

      reconciler.onModuleInit();
      expect(runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runOnce).toHaveBeenCalledTimes(3);

      await reconciler.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runOnce).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

function harness(tx: ReturnType<typeof transaction>, intervalMs = 5_000) {
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const config = {
    expiryReconciliationBatchSize: 25,
    expiryReconciliationIntervalMs: intervalMs,
  };
  return {
    db,
    reconciler: new CanvasAgentExpiryReconciler(db as never, config as never),
  };
}

function transaction() {
  return {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    canvasAgentSession: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    canvasClientCommand: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function invocation(overrides: { status: "in_flight" | "waiting_client" | "waiting_approval" }) {
  return {
    id: "invocation_1",
    agentSessionId: "session_1",
    toolCallId: "call_1",
    toolName: "navigate_canvas",
    status: overrides.status,
    boardRevisionBefore: 7,
    boardRevisionAfter: null,
    canvasStateRevisionBefore: 3,
    canvasStateRevisionAfter: null,
  };
}

function rawSqlText(value: unknown): string {
  if (!value || typeof value !== "object" || !("strings" in value)) return "";
  const strings = (value as { strings?: unknown }).strings;
  return Array.isArray(strings) ? strings.join("?").replace(/\s+/gu, " ") : "";
}

function queryValues(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || !("values" in value)) return [];
  const values = (value as { values?: unknown }).values;
  return Array.isArray(values) ? values : [];
}
