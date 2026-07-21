import { createHash } from "node:crypto";
import {
  RuntimeAttemptService,
  type RuntimeExecutionClaim,
} from "../src/runtime/runtime-attempt.service.js";

const binding = {
  id: "binding-1",
  adapter: "deerflow",
  externalThreadId: "thread-external-1",
};

const initialNow = new Date("2026-07-19T00:00:00.000Z");

type HarnessState = {
  databaseNow: Date;
  runStatus: string;
  runOwnerId: string | null;
  runEpoch: number;
  runLeaseExpiresAt: Date | null;
  attemptStatus: string;
  attemptOwnerId: string | null;
  attemptEpoch: number;
  attemptLeaseExpiresAt: Date | null;
  externalRunId: string | null;
  providerIdempotencyKey: string | null;
  submissionUnknownAt: Date | null;
  externalEventSequence: number;
  lastExternalEventId: string | null;
};

function rawSqlText(query: unknown): string {
  if (!query || typeof query !== "object") return String(query);
  const value = query as { sql?: unknown; text?: unknown; strings?: unknown };
  if (typeof value.sql === "string") return value.sql;
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.strings)) return value.strings.join("");
  return String(query);
}

function harness(overrides: Partial<HarnessState> = {}, leaseMs = 45_000) {
  const state: HarnessState = {
    databaseNow: initialNow,
    runStatus: "running",
    runOwnerId: null,
    runEpoch: 0,
    runLeaseExpiresAt: null,
    attemptStatus: "pending",
    attemptOwnerId: null,
    attemptEpoch: 0,
    attemptLeaseExpiresAt: null,
    externalRunId: null,
    providerIdempotencyKey: null,
    submissionUnknownAt: null,
    externalEventSequence: 0,
    lastExternalEventId: null,
    ...overrides,
  };
  const externalEvents = new Map<string, Record<string, unknown>>();

  const runMatches = (where: Record<string, unknown>) => (
    (where.id === undefined || where.id === "run-1")
    && (where.status === undefined
      || where.status === state.runStatus
      || (typeof where.status === "object"
        && Array.isArray((where.status as { in?: unknown }).in)
        && ((where.status as { in: string[] }).in).includes(state.runStatus)))
    && (where.executionOwnerId === undefined || where.executionOwnerId === state.runOwnerId)
    && (where.executionEpoch === undefined || where.executionEpoch === state.runEpoch)
  );
  const attemptMatches = (where: Record<string, unknown>) => (
    (where.id === undefined || where.id === "runtime-attempt-1")
    && (where.runId === undefined || where.runId === "run-1")
    && (where.status === undefined
      || where.status === state.attemptStatus
      || (typeof where.status === "object"
        && Array.isArray((where.status as { in?: unknown }).in)
        && ((where.status as { in: string[] }).in).includes(state.attemptStatus)))
    && (where.executionOwnerId === undefined || where.executionOwnerId === state.attemptOwnerId)
    && (where.executionEpoch === undefined || where.executionEpoch === state.attemptEpoch)
    && (where.providerIdempotencyKey === undefined
      || where.providerIdempotencyKey === state.providerIdempotencyKey)
    && (where.externalRunId === undefined || where.externalRunId === state.externalRunId)
    && (where.externalEventSequence === undefined
      || where.externalEventSequence === state.externalEventSequence)
  );
  const assignRun = (data: Record<string, unknown>) => {
    if ("status" in data) state.runStatus = data.status as string;
    if ("executionOwnerId" in data) state.runOwnerId = data.executionOwnerId as string | null;
    if ("executionEpoch" in data) state.runEpoch = data.executionEpoch as number;
    if ("executionLeaseExpiresAt" in data) {
      state.runLeaseExpiresAt = data.executionLeaseExpiresAt as Date | null;
    }
  };
  const assignAttempt = (data: Record<string, unknown>) => {
    if ("status" in data) state.attemptStatus = data.status as string;
    if ("executionOwnerId" in data) state.attemptOwnerId = data.executionOwnerId as string | null;
    if ("executionEpoch" in data) state.attemptEpoch = data.executionEpoch as number;
    if ("executionLeaseExpiresAt" in data) {
      state.attemptLeaseExpiresAt = data.executionLeaseExpiresAt as Date | null;
    }
    if ("externalRunId" in data) state.externalRunId = data.externalRunId as string | null;
    if ("providerIdempotencyKey" in data) {
      state.providerIdempotencyKey = data.providerIdempotencyKey as string | null;
    }
    if ("submissionUnknownAt" in data) {
      state.submissionUnknownAt = data.submissionUnknownAt as Date | null;
    }
    if ("externalEventSequence" in data) {
      state.externalEventSequence = data.externalEventSequence as number;
    }
    if ("lastExternalEventId" in data) {
      state.lastExternalEventId = data.lastExternalEventId as string | null;
    }
  };
  const attemptRow = () => ({
    id: "runtime-attempt-1",
    runId: "run-1",
    status: state.attemptStatus,
    externalRunId: state.externalRunId,
    providerIdempotencyKey: state.providerIdempotencyKey,
  });

  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => (
      rawSqlText(query).includes('JOIN "runtime_attempts"')
        ? [{ ...state }]
        : [{ status: state.runStatus }]
    )),
    run: {
      updateMany: vi.fn(async ({ where, data }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!runMatches(where)) return { count: 0 };
        assignRun(data);
        return { count: 1 };
      }),
    },
    runtimeAttempt: {
      findUnique: vi.fn(async () => attemptRow()),
      findUniqueOrThrow: vi.fn(async () => attemptRow()),
      updateMany: vi.fn(async ({ where, data }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!attemptMatches(where)) return { count: 0 };
        assignAttempt(data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        assignAttempt(data);
        return attemptRow();
      }),
    },
    runtimeExternalEvent: {
      findUnique: vi.fn(async ({ where }: {
        where: { runtimeAttemptId_externalEventId: { externalEventId: string } };
      }) => externalEvents.get(where.runtimeAttemptId_externalEventId.externalEventId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { status: "pending", ...data };
        externalEvents.set(String(data.externalEventId), row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: { externalEventId: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const row = externalEvents.get(where.externalEventId);
        if (!row || (where.status !== undefined && row.status !== where.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => {
      const stateSnapshot = { ...state };
      const eventSnapshot = new Map(
        [...externalEvents].map(([key, value]) => [key, { ...value }]),
      );
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(state, stateSnapshot);
        externalEvents.clear();
        for (const [key, value] of eventSnapshot) externalEvents.set(key, value);
        throw error;
      }
    }),
  };
  return {
    db,
    tx,
    state,
    externalEvents,
    service: new RuntimeAttemptService(db as never, leaseMs),
  };
}

const claimA: RuntimeExecutionClaim = {
  runId: "run-1",
  attemptId: "runtime-attempt-1",
  ownerId: "worker-a:test",
  epoch: 1,
};

describe("RuntimeAttemptService", () => {
  it("ensures one attempt per run and rejects a changed binding", async () => {
    let stored: Record<string, unknown> | null = null;
    const runtimeAttempt = {
      findUnique: vi.fn(async () => stored),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = {
          id: "runtime-attempt-1",
          externalRunId: null,
          status: "pending",
          ...data,
        };
        return stored;
      }),
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ status: "running" }]),
      runtimeAttempt,
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never);

    const created = await service.ensure("run-1", 1, binding);
    expect(await service.ensure("run-1", 1, binding)).toBe(created);
    expect(runtimeAttempt.create).toHaveBeenCalledTimes(1);
    await expect(service.ensure("run-1", 1, { ...binding, id: "binding-2" }))
      .rejects.toThrow("RUNTIME_ATTEMPT_BINDING_MISMATCH");
  });

  it.each(["queued", "waiting_input", "cancelling", "succeeded", "failed", "cancelled"])(
    "does not create an attempt while the run is %s",
    async (runStatus) => {
      const runtimeAttempt = { findUnique: vi.fn(), create: vi.fn() };
      const tx = { $queryRaw: vi.fn(async () => [{ status: runStatus }]), runtimeAttempt };
      const service = new RuntimeAttemptService({
        $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
      } as never);

      await expect(service.ensure("run-1", 1, binding))
        .rejects.toThrow("RUNTIME_ATTEMPT_RUN_NOT_ACTIVE");
      expect(runtimeAttempt.create).not.toHaveBeenCalled();
    },
  );

  it("allows only one worker to hold a live Run and Attempt claim", async () => {
    const { service, state } = harness({}, 10_000);

    await expect(service.claim("run-1", "runtime-attempt-1", "worker-a:test"))
      .resolves.toEqual(claimA);
    await expect(service.claim("run-1", "runtime-attempt-1", "worker-b:test"))
      .rejects.toThrow("RUNTIME_EXECUTION_CLAIM_BUSY");
    expect(state).toMatchObject({
      runOwnerId: "worker-a:test",
      attemptOwnerId: "worker-a:test",
      runEpoch: 1,
      attemptEpoch: 1,
      runLeaseExpiresAt: new Date("2026-07-19T00:00:10.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:00:10.000Z"),
    });
  });

  it("heartbeats from database time and extends both leases", async () => {
    const { service, state } = harness({}, 10_000);
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");
    state.databaseNow = new Date("2026-07-19T00:00:04.000Z");

    await service.heartbeat(claim);

    expect(state.runLeaseExpiresAt).toEqual(new Date("2026-07-19T00:00:14.000Z"));
    expect(state.attemptLeaseExpiresAt).toEqual(new Date("2026-07-19T00:00:14.000Z"));
  });

  it("takes over an expired claim and fences the old epoch", async () => {
    const expired = new Date("2026-07-18T23:59:59.000Z");
    const { service, state } = harness({
      runOwnerId: "worker-a:test",
      attemptOwnerId: "worker-a:test",
      runEpoch: 4,
      attemptEpoch: 4,
      runLeaseExpiresAt: expired,
      attemptLeaseExpiresAt: expired,
      attemptStatus: "running",
    });
    const oldClaim = { ...claimA, epoch: 4 };

    const takeover = await service.claim("run-1", "runtime-attempt-1", "worker-b:test");

    expect(takeover).toEqual({ ...claimA, ownerId: "worker-b:test", epoch: 5 });
    await expect(service.heartbeat(oldClaim)).rejects.toThrow("RUNTIME_EXECUTION_FENCED");
    expect(state.runOwnerId).toBe("worker-b:test");
    expect(state.runEpoch).toBe(5);
  });

  it("persists one stable provider idempotency key before submission", async () => {
    const { service, state } = harness();
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");
    const expected = `wbrt:${createHash("sha256").update("runtime-attempt-1").digest("hex")}`;

    await expect(service.submissionContext(claim)).resolves.toEqual({
      mode: "submit",
      providerIdempotencyKey: expected,
    });
    await expect(service.submissionContext(claim)).resolves.toMatchObject({
      providerIdempotencyKey: expected,
    });
    await service.authorizeSubmission(claim);

    expect(state.providerIdempotencyKey).toBe(expected);
    expect(state.attemptStatus).toBe("submitting");
  });

  it("requires reconciliation after a worker dies with a durable submitting intent", async () => {
    const { service, state } = harness({}, 10_000);
    const firstClaim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");
    await service.submissionContext(firstClaim);
    await service.authorizeSubmission(firstClaim);

    state.databaseNow = new Date("2026-07-19T00:00:11.000Z");
    const recoveryClaim = await service.claim("run-1", "runtime-attempt-1", "worker-b:test");

    await expect(service.submissionContext(recoveryClaim)).resolves.toMatchObject({
      mode: "reconcile",
    });
    await expect(service.authorizeSubmission(recoveryClaim))
      .rejects.toThrow("RUNTIME_SUBMISSION_RECONCILIATION_REQUIRED");
    expect(state.attemptStatus).toBe("submitting");

    await service.markSubmissionUnknown(recoveryClaim, "provider lookup returned no matching Run");
    expect(state).toMatchObject({
      attemptStatus: "submission_unknown",
      submissionUnknownAt: state.databaseNow,
      runOwnerId: null,
      attemptOwnerId: null,
    });
  });

  it("marks an ambiguous submission once and releases both leases", async () => {
    const { service, state } = harness();
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");
    await service.submissionContext(claim);
    await service.authorizeSubmission(claim);

    await service.markSubmissionUnknown(claim, "connection closed after request body");

    expect(state.attemptStatus).toBe("submission_unknown");
    expect(state.submissionUnknownAt).toEqual(initialNow);
    expect(state.runOwnerId).toBeNull();
    expect(state.attemptOwnerId).toBeNull();
  });

  it("attaches an external Run idempotently and rejects replacement", async () => {
    const { service, state } = harness();
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");
    await service.submissionContext(claim);
    await service.authorizeSubmission(claim);

    await service.attachExternalRun(claim, "external-run-1");
    await service.attachExternalRun(claim, "external-run-1");

    expect(state).toMatchObject({ externalRunId: "external-run-1", attemptStatus: "running" });
    await expect(service.submissionContext(claim)).resolves.toEqual({
      mode: "join",
      providerIdempotencyKey: state.providerIdempotencyKey,
      externalRunId: "external-run-1",
      lastExternalEventId: null,
    });
    await expect(service.authorizeSubmission(claim))
      .rejects.toThrow("RUNTIME_SUBMISSION_EXTERNAL_RUN_ALREADY_ATTACHED");
    await expect(service.attachExternalRun(claim, "external-run-2"))
      .rejects.toThrow("RUNTIME_EXTERNAL_RUN_ID_CONFLICT");
  });

  it("releases a resolved reconciliation claim without reverting its attached Run", async () => {
    const { service, state } = harness({
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");

    await service.markSubmissionUnknown(claim, "attach commit response was lost");

    expect(state).toMatchObject({
      attemptStatus: "running",
      externalRunId: "external-run-1",
      runOwnerId: null,
      attemptOwnerId: null,
    });
  });

  it("deduplicates an exact external event replay with effects and cursor in one transaction", async () => {
    const { service, state, externalEvents } = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });
    const effects = vi.fn(async () => undefined);
    const input = {
      externalRunId: "external-run-1",
      externalEventId: "event-1",
      event: "values",
      payload: { value: "hello" },
    } as const;

    await expect(service.processExternalEvent(claimA, input, effects))
      .resolves.toEqual({ created: true, sequence: 1 });
    await expect(service.processExternalEvent(claimA, input, effects))
      .resolves.toEqual({ created: false, sequence: 1 });

    expect(effects).toHaveBeenCalledTimes(1);
    expect(state.lastExternalEventId).toBe("event-1");
    expect(externalEvents.get("event-1")).toMatchObject({ status: "processed", sequence: 1 });
  });

  it("rejects reuse of an external event id with another payload", async () => {
    const { service } = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });
    const original = {
      externalRunId: "external-run-1",
      externalEventId: "event-1",
      event: "values",
      payload: { value: "hello" },
    } as const;
    await service.processExternalEvent(claimA, original, async () => undefined);

    await expect(service.processExternalEvent(
      claimA,
      { ...original, payload: { value: "changed" } },
      async () => undefined,
    )).rejects.toThrow("RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT");
  });

  it("rolls back inbox, effects, and cursor when an effect fails", async () => {
    const { service, state, externalEvents, tx } = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });

    await expect(service.processExternalEvent(claimA, {
      externalRunId: "external-run-1",
      externalEventId: "event-failed",
      event: "messages",
      payload: { delta: "partial" },
    }, async () => {
      throw new Error("effect failed");
    })).rejects.toThrow("effect failed");

    expect(externalEvents.size).toBe(0);
    expect(state.externalEventSequence).toBe(0);
    expect(state.lastExternalEventId).toBeNull();
    expect(tx.runtimeExternalEvent.updateMany).not.toHaveBeenCalled();
  });

  it("records a retryable error without terminalizing and releases the claim", async () => {
    const { service, state } = harness();
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");

    await service.recordRetryableError(claim, {
      code: "RUNTIME_EXECUTION_RETRYABLE",
      detail: "socket closed",
    });

    expect(state.attemptStatus).toBe("pending");
    expect(state.runOwnerId).toBeNull();
    expect(state.attemptOwnerId).toBeNull();
  });

  it("moves an active attempt into cancelling under the Run lock", async () => {
    const { service, state } = harness({ runStatus: "cancelling", attemptStatus: "running" });

    await service.beginCancellation("run-1", "runtime-attempt-1");

    expect(state.attemptStatus).toBe("cancelling");
  });
});
