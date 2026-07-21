import { describe, expect, it, vi } from "vitest";
import { CanvasAgentExpiryReconciler } from "../src/modules/canvas-agent/canvas-agent-expiry-reconciler.js";
import { READY_OBJECT_INTEGRITY_QUARANTINE_CODE } from "../src/platform/object-storage/ready-object-integrity.js";

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
      .mockResolvedValueOnce([{
        id: "session_1",
        canvasStateRevision: 3,
        databaseNow: new Date("2026-07-20T09:00:00.000Z"),
      }])
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
    expect(tx.canvasToolGrant.updateMany).not.toHaveBeenCalled();
  });

  it("revokes the grant when a provisional client-command state expires without ACK", async () => {
    const databaseNow = new Date("2026-07-20T09:00:00.000Z");
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "session_1",
        canvasStateRevision: 4,
        databaseNow,
      }])
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
    expect(tx.canvasToolGrant.updateMany).toHaveBeenCalledWith({
      where: { agentSessionId: "session_1", revokedAt: null },
      data: { revokedAt: databaseNow },
    });
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

  it("expires a revoked visual, deletes its object, and records completion", async () => {
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([{
      id: "visual_1",
      status: "ready",
      storageKey: "canvas-visuals/visual_1.webp",
      storageDeletedAt: null,
      lifecycleFailureCode: "VISUAL_GRANT_REVOKED",
      }])
      .mockResolvedValueOnce([{ lockReceipt: "" }])
      .mockResolvedValueOnce([{
        id: "visual_1",
        storageKey: "canvas-visuals/visual_1.webp",
        storageDeletedAt: null,
      }])
      .mockResolvedValueOnce([{ held: false }]);
    const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "visual_1" }]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const reconciler = new CanvasAgentExpiryReconciler(
      db as never,
      { expiryReconciliationBatchSize: 25, expiryReconciliationIntervalMs: 5_000 } as never,
      storage as never,
    );

    await (reconciler as unknown as { reconcileExpiredVisuals: () => Promise<void> }).reconcileExpiredVisuals();

    expect(storage.deleteObject).toHaveBeenCalledWith("canvas-visuals/visual_1.webp");
    expect(tx.canvasVisualCapability.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "visual_1", status: "ready" },
      data: { status: "expired", failureCode: "VISUAL_GRANT_REVOKED" },
    });
    expect(tx.canvasVisualCapability.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "visual_1",
        storageKey: "canvas-visuals/visual_1.webp",
        storageDeletedAt: null,
      },
      data: { storageDeletedAt: expect.any(Date) },
    });
    expect(rawSqlText(tx.$queryRaw.mock.calls[0]![0])).toContain("FOR UPDATE OF visual");
  });

  it("leaves a failed delete eligible and retries it on the next pass", async () => {
    const tx = transaction();
    const visual = {
      id: "visual_1",
      status: "expired",
      storageKey: "canvas-visuals/retry.webp",
      storageDeletedAt: null,
      lifecycleFailureCode: null,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      tx.$queryRaw
        .mockResolvedValueOnce([visual])
        .mockResolvedValueOnce([{ lockReceipt: "" }])
        .mockResolvedValueOnce([{
          id: visual.id,
          storageKey: visual.storageKey,
          storageDeletedAt: null,
        }])
        .mockResolvedValueOnce([{ held: false }]);
    }
    const storage = {
      deleteObject: vi.fn()
        .mockRejectedValueOnce(new Error("temporary storage outage"))
        .mockResolvedValueOnce(undefined),
    };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "visual_1" }]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const reconciler = new CanvasAgentExpiryReconciler(
      db as never,
      { expiryReconciliationBatchSize: 25, expiryReconciliationIntervalMs: 5_000 } as never,
      storage as never,
    );

    await (reconciler as unknown as { reconcileExpiredVisuals: () => Promise<void> }).reconcileExpiredVisuals();
    expect(tx.canvasVisualCapability.updateMany).not.toHaveBeenCalled();

    await (reconciler as unknown as { reconcileExpiredVisuals: () => Promise<void> }).reconcileExpiredVisuals();
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(tx.canvasVisualCapability.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { storageDeletedAt: expect.any(Date) },
    }));
  });

  it("retains an integrity-quarantined visual object for forensic release", async () => {
    const tx = transaction();
    tx.$queryRaw.mockResolvedValueOnce([{
      id: "visual_integrity",
      status: "failed",
      storageKey: "canvas-visuals/retained.webp",
      storageDeletedAt: null,
      failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
      integrityHeld: true,
      lifecycleFailureCode: null,
    }]);
    const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "visual_integrity" }]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const reconciler = new CanvasAgentExpiryReconciler(
      db as never,
      { expiryReconciliationBatchSize: 25, expiryReconciliationIntervalMs: 5_000 } as never,
      storage as never,
    );

    await (reconciler as unknown as { reconcileExpiredVisuals: () => Promise<void> })
      .reconcileExpiredVisuals();

    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(tx.canvasVisualCapability.updateMany).not.toHaveBeenCalled();
    const candidateQuery = db.$queryRaw.mock.calls[0]![0];
    expect(queryValues(candidateQuery)).toContain(READY_OBJECT_INTEGRITY_QUARANTINE_CODE);
  });

  it("allows normal visual cleanup only after the forensic hold is explicitly released", async () => {
    const tx = transaction();
    tx.$queryRaw
      .mockResolvedValueOnce([{
      id: "visual_released",
      status: "failed",
      storageKey: "canvas-visuals/released.webp",
      storageDeletedAt: null,
      failureCode: READY_OBJECT_INTEGRITY_QUARANTINE_CODE,
      integrityHeld: false,
      lifecycleFailureCode: null,
      }])
      .mockResolvedValueOnce([{ lockReceipt: "" }])
      .mockResolvedValueOnce([{
        id: "visual_released",
        storageKey: "canvas-visuals/released.webp",
        storageDeletedAt: null,
      }])
      .mockResolvedValueOnce([{ held: false }]);
    const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "visual_released" }]),
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const reconciler = new CanvasAgentExpiryReconciler(
      db as never,
      { expiryReconciliationBatchSize: 25, expiryReconciliationIntervalMs: 5_000 } as never,
      storage as never,
    );

    await (reconciler as unknown as { reconcileExpiredVisuals: () => Promise<void> })
      .reconcileExpiredVisuals();

    expect(storage.deleteObject).toHaveBeenCalledWith("canvas-visuals/released.webp");
    expect(tx.canvasVisualCapability.updateMany).toHaveBeenCalledWith({
      where: {
        id: "visual_released",
        storageKey: "canvas-visuals/released.webp",
        storageDeletedAt: null,
      },
      data: { storageDeletedAt: expect.any(Date) },
    });
  });
});

function harness(tx: ReturnType<typeof transaction>, intervalMs = 5_000) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const config = {
    expiryReconciliationBatchSize: 25,
    expiryReconciliationIntervalMs: intervalMs,
  };
  const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
  return {
    db,
    reconciler: new CanvasAgentExpiryReconciler(db as never, config as never, storage as never),
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
    canvasToolGrant: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    canvasVisualCapability: {
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
