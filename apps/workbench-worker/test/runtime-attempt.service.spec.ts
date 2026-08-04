import { createHash } from "node:crypto";
import {
  createRuntimeFinalizationPayload,
  createRuntimeProviderProjection,
  createRuntimeProviderTextCheckpoint,
  projectIncompleteVisibleAssistantText,
  reduceRuntimeProviderProjection,
  sha256Canonical,
} from "../src/runtime/runtime-assistant-text.js";
import {
  RuntimeAttemptService,
  type RuntimeExecutionClaim,
  type RuntimeProviderCancellationClaimResult,
} from "../src/runtime/runtime-attempt.service.js";
import { runtimeProviderCancellationUnconfirmedCode } from "../src/runs/runtime-cancellation-state.js";
import { runtimeExternalFinalizationEvent } from "../src/runtime/runtime.port.js";

const binding = {
  id: "binding-1",
  adapter: "deerflow",
  externalThreadId: "thread-external-1",
};

const initialNow = new Date("2026-07-19T00:00:00.000Z");

type HarnessState = {
  databaseNow: Date;
  runStatus: string;
  runErrorCode: string | null;
  runErrorDetail: string | null;
  runOwnerId: string | null;
  runEpoch: number;
  runLeaseExpiresAt: Date | null;
  attemptStatus: string;
  attemptErrorCode: string | null;
  attemptOwnerId: string | null;
  attemptEpoch: number;
  attemptLeaseExpiresAt: Date | null;
  providerCancellationOperationEpoch: number;
  providerCancellationOperationStartedAt: Date | null;
  providerCancellationOperationDeadlineAt: Date | null;
  providerCancellationResolutionId: string | null;
  externalRunId: string | null;
  providerIdempotencyKey: string | null;
  submissionUnknownAt: Date | null;
  externalEventSequence: number;
  lastExternalEventId: string | null;
  attempt: number;
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
    runErrorCode: null,
    runErrorDetail: null,
    runOwnerId: null,
    runEpoch: 0,
    runLeaseExpiresAt: null,
    attemptStatus: "pending",
    attemptErrorCode: null,
    attemptOwnerId: null,
    attemptEpoch: 0,
    attemptLeaseExpiresAt: null,
    providerCancellationOperationEpoch: 0,
    providerCancellationOperationStartedAt: null,
    providerCancellationOperationDeadlineAt: null,
    providerCancellationResolutionId: null,
    externalRunId: null,
    providerIdempotencyKey: null,
    submissionUnknownAt: null,
    externalEventSequence: 0,
    lastExternalEventId: null,
    attempt: 1,
    ...overrides,
  };
  const externalEvents = new Map<string, Record<string, unknown>>();
  let providerCancellationResolution: Record<string, unknown> | null = null;
  let providerProjection = createRuntimeProviderProjection({
    runtimeAttemptId: "runtime-attempt-1",
    runId: "run-1",
  });

  const runMatches = (where: Record<string, unknown>) => (
    (where.id === undefined || where.id === "run-1")
    && (where.status === undefined
      || where.status === state.runStatus
      || (typeof where.status === "object"
        && Array.isArray((where.status as { in?: unknown }).in)
        && ((where.status as { in: string[] }).in).includes(state.runStatus)))
    && (where.executionOwnerId === undefined || where.executionOwnerId === state.runOwnerId)
    && (where.executionEpoch === undefined || where.executionEpoch === state.runEpoch)
    && (where.errorCode === undefined || where.errorCode === state.runErrorCode)
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
    && (where.providerCancellationOperationEpoch === undefined
      || where.providerCancellationOperationEpoch === state.providerCancellationOperationEpoch
      || (typeof where.providerCancellationOperationEpoch === "object"
        && typeof (where.providerCancellationOperationEpoch as { gte?: unknown }).gte === "number"
        && state.providerCancellationOperationEpoch
          >= (where.providerCancellationOperationEpoch as { gte: number }).gte))
    && (where.providerCancellationOperationStartedAt === undefined
      || where.providerCancellationOperationStartedAt === state.providerCancellationOperationStartedAt
      || (typeof where.providerCancellationOperationStartedAt === "object"
        && (where.providerCancellationOperationStartedAt as { not?: unknown }).not === null
        && state.providerCancellationOperationStartedAt !== null))
    && (where.providerCancellationOperationDeadlineAt === undefined
      || where.providerCancellationOperationDeadlineAt === state.providerCancellationOperationDeadlineAt
      || (typeof where.providerCancellationOperationDeadlineAt === "object"
        && (where.providerCancellationOperationDeadlineAt as { gt?: unknown }).gt instanceof Date
        && state.providerCancellationOperationDeadlineAt !== null
        && state.providerCancellationOperationDeadlineAt
          > (where.providerCancellationOperationDeadlineAt as { gt: Date }).gt))
    && (where.errorCode === undefined || where.errorCode === state.attemptErrorCode)
    && (where.providerCancellationResolution === undefined
      || (typeof where.providerCancellationResolution === "object"
        && (where.providerCancellationResolution as { is?: unknown }).is === null
        && state.providerCancellationResolutionId === null))
    && (where.providerIdempotencyKey === undefined
      || where.providerIdempotencyKey === state.providerIdempotencyKey)
    && (where.externalRunId === undefined || where.externalRunId === state.externalRunId)
    && (where.externalEventSequence === undefined
      || where.externalEventSequence === state.externalEventSequence)
  );
  const assignRun = (data: Record<string, unknown>) => {
    if ("status" in data) state.runStatus = data.status as string;
    if ("errorCode" in data) state.runErrorCode = data.errorCode as string | null;
    if ("executionOwnerId" in data) state.runOwnerId = data.executionOwnerId as string | null;
    if ("executionEpoch" in data) state.runEpoch = data.executionEpoch as number;
    if ("executionLeaseExpiresAt" in data) {
      state.runLeaseExpiresAt = data.executionLeaseExpiresAt as Date | null;
    }
  };
  const assignAttempt = (data: Record<string, unknown>) => {
    if ("status" in data) state.attemptStatus = data.status as string;
    if ("errorCode" in data) state.attemptErrorCode = data.errorCode as string | null;
    if ("executionOwnerId" in data) state.attemptOwnerId = data.executionOwnerId as string | null;
    if ("executionEpoch" in data) state.attemptEpoch = data.executionEpoch as number;
    if ("executionLeaseExpiresAt" in data) {
      state.attemptLeaseExpiresAt = data.executionLeaseExpiresAt as Date | null;
    }
    if ("providerCancellationOperationEpoch" in data) {
      state.providerCancellationOperationEpoch = data.providerCancellationOperationEpoch as number;
    }
    if ("providerCancellationOperationStartedAt" in data) {
      state.providerCancellationOperationStartedAt = data.providerCancellationOperationStartedAt as Date | null;
    }
    if ("providerCancellationOperationDeadlineAt" in data) {
      state.providerCancellationOperationDeadlineAt = data.providerCancellationOperationDeadlineAt as Date | null;
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
    errorCode: state.attemptErrorCode,
    externalRunId: state.externalRunId,
    providerIdempotencyKey: state.providerIdempotencyKey,
    providerCancellationOperationEpoch: state.providerCancellationOperationEpoch,
    providerCancellationOperationStartedAt: state.providerCancellationOperationStartedAt,
    providerCancellationOperationDeadlineAt: state.providerCancellationOperationDeadlineAt,
    providerCancellationResolution: providerCancellationResolution === null
      ? null
      : { ...providerCancellationResolution },
  });

  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = rawSqlText(query);
      if (sql.includes('FROM "runtime_attempts" AS attempt')) return [{ ...state }];
      if (sql.includes('clock_timestamp() AS "databaseNow"')) {
        return [{
          databaseNow: state.databaseNow,
          providerCancellationResolutionId: state.providerCancellationResolutionId,
        }];
      }
      return [{ status: state.runStatus }];
    }),
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
      findFirst: vi.fn(async () => null),
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
    runtimeProviderState: {
      findUnique: vi.fn(async () => providerProjection),
      create: vi.fn(async ({ data }: { data: typeof providerProjection }) => {
        providerProjection = { ...data };
        return providerProjection;
      }),
      updateMany: vi.fn(async ({ where, data }: {
        where: Record<string, unknown>;
        data: Partial<typeof providerProjection>;
      }) => {
        if (
          where.runtimeAttemptId !== providerProjection.runtimeAttemptId
          || where.runId !== providerProjection.runId
          || where.projectionVersion !== providerProjection.projectionVersion
          || where.lastAppliedSequence !== providerProjection.lastAppliedSequence
          || where.stateSha256 !== providerProjection.stateSha256
        ) {
          return { count: 0 };
        }
        providerProjection = { ...providerProjection, ...data };
        return { count: 1 };
      }),
    },
    runDraft: {
      findUnique: vi.fn(async () => null),
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
    runtimeProviderCancellationResolution: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        providerCancellationResolution = { ...data };
        state.providerCancellationResolutionId = String(data.runtimeAttemptId);
        return providerCancellationResolution;
      }),
    },
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => {
      const stateSnapshot = { ...state };
      const eventSnapshot = new Map(
        [...externalEvents].map(([key, value]) => [key, { ...value }]),
      );
      const projectionSnapshot = { ...providerProjection };
      const providerCancellationResolutionSnapshot = providerCancellationResolution === null
        ? null
        : { ...providerCancellationResolution };
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(state, stateSnapshot);
        externalEvents.clear();
        for (const [key, value] of eventSnapshot) externalEvents.set(key, value);
        providerProjection = projectionSnapshot;
        providerCancellationResolution = providerCancellationResolutionSnapshot;
        throw error;
      }
    }),
  };
  return {
    db,
    tx,
    state,
    externalEvents,
    providerCancellationResolution: () => providerCancellationResolution,
    providerProjection: () => providerProjection,
    service: new RuntimeAttemptService(db as never, leaseMs),
  };
}

function providerCancellationHarness(overrides: Partial<HarnessState> = {}) {
  return harness({
    runStatus: "failed",
    runErrorCode: runtimeProviderCancellationUnconfirmedCode,
    attemptStatus: "failed",
    attemptErrorCode: runtimeProviderCancellationUnconfirmedCode,
    ...overrides,
  });
}

function claimedCancellation(result: RuntimeProviderCancellationClaimResult): RuntimeExecutionClaim {
  if (result.disposition !== "claimed") {
    throw new Error(`expected claimed cancellation, got ${result.disposition}`);
  }
  return result.claim;
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

  it("attaches a late external Run id without reopening a failed cancellation attempt", async () => {
    const row = {
      id: "runtime-attempt-1",
      runId: "run-1",
      status: "failed",
      errorCode: runtimeProviderCancellationUnconfirmedCode,
      externalRunId: null as string | null,
      providerCancellationResolution: null,
    };
    const runtimeAttempt = {
      findUnique: vi.fn(async () => ({ runId: row.runId })),
      findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ data }: { data: { externalRunId: string } }) => {
        row.externalRunId = data.externalRunId;
        return { count: 1 };
      }),
    };
    const tx = {
      $queryRaw: vi.fn(async (query: unknown) => (
        rawSqlText(query).includes('clock_timestamp() AS "databaseNow"')
          ? [{ databaseNow: initialNow, providerCancellationResolutionId: null }]
          : [{
              runStatus: "failed",
              runErrorCode: runtimeProviderCancellationUnconfirmedCode,
              externalRunId: row.externalRunId,
              attemptStatus: row.status,
              attemptErrorCode: row.errorCode,
              providerCancellationOperationEpoch: 1,
              providerCancellationOperationStartedAt: initialNow,
              providerCancellationOperationDeadlineAt: new Date(initialNow.getTime() + 60_000),
            }]
      )),
      runtimeAttempt,
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never);

    await expect(service.attachExternalRunForCleanup(
      row.id,
      1,
      "external-run-late",
    )).resolves.toEqual({
      externalRunId: "external-run-late",
      operationCurrent: true,
    });
    expect(runtimeAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: row.id,
        externalRunId: null,
        providerCancellationOperationEpoch: { gte: 1 },
        providerCancellationResolution: { is: null },
        OR: [
          {
            status: {
              in: ["pending", "submitting", "submission_unknown", "running", "cancelling"],
            },
          },
          {
            status: "failed",
            errorCode: runtimeProviderCancellationUnconfirmedCode,
          },
        ],
      },
      data: { externalRunId: "external-run-late" },
    });
    expect(runtimeAttempt.findUnique).toHaveBeenCalledWith({
      where: { id: row.id },
      select: { runId: true },
    });
    const lockSql = rawSqlText(tx.$queryRaw.mock.calls[0]![0]);
    expect(lockSql).toContain('FROM "runs" AS run');
    expect(lockSql).toContain("FOR UPDATE OF run");
    expect(lockSql).toContain('FROM "runtime_attempts" AS attempt');
    expect(lockSql).toContain("FOR UPDATE OF attempt");
    expect(lockSql.indexOf("FOR UPDATE OF run")).toBeLessThan(
      lockSql.indexOf("FOR UPDATE OF attempt"),
    );
    expect(rawSqlText(tx.$queryRaw.mock.calls[1]![0])).toContain(
      'clock_timestamp() AS "databaseNow"',
    );
    expect(runtimeAttempt.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[0]!,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[1]!,
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      runtimeAttempt.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(row).toMatchObject({
      status: "failed",
      errorCode: runtimeProviderCancellationUnconfirmedCode,
    });
  });

  it("attaches cleanup evidence while an execution attempt is still active", async () => {
    const row = {
      id: "runtime-attempt-active",
      runId: "run-1",
      status: "submitting",
      errorCode: null,
      externalRunId: null as string | null,
      providerCancellationResolution: null,
    };
    const runtimeAttempt = {
      findUnique: vi.fn(async () => ({ runId: row.runId })),
      findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ data }: { data: { externalRunId: string } }) => {
        row.externalRunId = data.externalRunId;
        return { count: 1 };
      }),
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: { runtimeAttempt: typeof runtimeAttempt }) => unknown) => (
        callback({
          $queryRaw: vi.fn(async () => [{
            databaseNow: initialNow,
            runStatus: "cancelling",
            runErrorCode: null,
            externalRunId: row.externalRunId,
            attemptStatus: row.status,
            attemptErrorCode: row.errorCode,
            providerCancellationOperationEpoch: 1,
            providerCancellationOperationStartedAt: initialNow,
            providerCancellationOperationDeadlineAt: new Date(initialNow.getTime() + 60_000),
            providerCancellationResolutionId: null,
          }]),
          runtimeAttempt,
        } as never)
      )),
    } as never);

    await expect(service.attachExternalRunForCleanup(row.id, 1, "external-run-active"))
      .resolves.toEqual({
        externalRunId: "external-run-active",
        operationCurrent: true,
      });
    expect(runtimeAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: row.id,
        externalRunId: null,
      }),
    }));
  });

  it("rejects a conflicting external Run id recovered by a concurrent canceller", async () => {
    const unresolved = {
      id: "runtime-attempt-1",
      runId: "run-1",
      status: "failed",
      errorCode: runtimeProviderCancellationUnconfirmedCode,
      externalRunId: null,
      providerCancellationResolution: null,
    };
    const runtimeAttempt = {
      findUnique: vi.fn(async () => ({ runId: unresolved.runId })),
      findUniqueOrThrow: vi.fn(async () => ({
        ...unresolved,
        externalRunId: "external-run-winner",
      })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{
        runStatus: "failed",
        runErrorCode: runtimeProviderCancellationUnconfirmedCode,
        externalRunId: null,
        attemptStatus: unresolved.status,
        attemptErrorCode: unresolved.errorCode,
        providerCancellationOperationEpoch: 1,
        providerCancellationOperationStartedAt: initialNow,
        providerCancellationOperationDeadlineAt: new Date(initialNow.getTime() + 60_000),
        providerCancellationResolutionId: null,
      }]),
      runtimeAttempt,
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never);

    await expect(service.attachExternalRunForCleanup(
      unresolved.id,
      1,
      "external-run-loser",
    )).rejects.toThrow("RUNTIME_EXTERNAL_RUN_ID_CONFLICT");
  });

  it("rejects a late external Run id after the cleanup resolution is durable", async () => {
    const row = {
      id: "runtime-attempt-settled",
      runId: "run-1",
      status: "failed",
      errorCode: runtimeProviderCancellationUnconfirmedCode,
      externalRunId: null,
      providerCancellationResolution: {
        runtimeAttemptId: "runtime-attempt-settled",
        outcome: "external_run_absent",
      },
    };
    const runtimeAttempt = {
      findUnique: vi.fn(async () => ({ runId: row.runId })),
      findUniqueOrThrow: vi.fn(async () => row),
      updateMany: vi.fn(),
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{
        runStatus: "failed",
        runErrorCode: runtimeProviderCancellationUnconfirmedCode,
        externalRunId: row.externalRunId,
        attemptStatus: row.status,
        attemptErrorCode: row.errorCode,
        providerCancellationOperationEpoch: 1,
        providerCancellationOperationStartedAt: initialNow,
        providerCancellationOperationDeadlineAt: new Date(initialNow.getTime() + 60_000),
        providerCancellationResolutionId: row.id,
      }]),
      runtimeAttempt,
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never);

    await expect(service.attachExternalRunForCleanup(row.id, 1, "external-run-too-late"))
      .rejects.toThrow("RUNTIME_EXTERNAL_RUN_ATTACH_STATE_INVALID");
    expect(runtimeAttempt.updateMany).not.toHaveBeenCalled();
    expect(runtimeAttempt.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("preserves not-found semantics when an attempt disappears before the scope lock", async () => {
    const runtimeAttempt = {
      findUnique: vi.fn(async () => ({ runId: "run-1" })),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    };
    const tx = {
      $queryRaw: vi.fn(async () => []),
      runtimeAttempt,
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never);

    await expect(service.attachExternalRunForCleanup(
      "runtime-attempt-deleted",
      1,
      "external-run-late",
    )).rejects.toThrow("RUNTIME_ATTEMPT_NOT_FOUND");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(runtimeAttempt.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(runtimeAttempt.updateMany).not.toHaveBeenCalled();
  });

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

  it.each([
    {
      label: "active operation",
      state: {
        providerCancellationOperationEpoch: 1,
        providerCancellationOperationStartedAt: initialNow,
        providerCancellationOperationDeadlineAt: new Date("2026-07-19T00:00:30.000Z"),
      },
    },
    {
      label: "expired operation",
      state: {
        providerCancellationOperationEpoch: 1,
        providerCancellationOperationStartedAt: new Date("2026-07-18T23:59:00.000Z"),
        providerCancellationOperationDeadlineAt: new Date("2026-07-18T23:59:30.000Z"),
      },
    },
    {
      label: "finished operation epoch",
      state: {
        providerCancellationOperationEpoch: 1,
        providerCancellationOperationStartedAt: null,
        providerCancellationOperationDeadlineAt: null,
      },
    },
    {
      label: "durable resolution",
      state: { providerCancellationResolutionId: "runtime-attempt-1" },
    },
  ])("fences an ordinary execution claim after $label", async ({ state }) => {
    const context = harness(state);

    await expect(context.service.claim("run-1", "runtime-attempt-1", "worker-a:test"))
      .rejects.toThrow("RUNTIME_EXECUTION_PROVIDER_CANCELLATION_FENCED");
    expect(context.tx.run.updateMany).not.toHaveBeenCalled();
    expect(context.tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("claims an unresolved provider cancellation with the requested lease", async () => {
    const { service, state } = providerCancellationHarness({
      runEpoch: 3,
      attemptEpoch: 5,
    });

    await expect(service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    )).resolves.toEqual({
      disposition: "claimed",
      claim: {
        runId: "run-1",
        attemptId: "runtime-attempt-1",
        ownerId: "cleanup-a:test",
        epoch: 6,
      },
    });
    expect(state).toMatchObject({
      runOwnerId: "cleanup-a:test",
      runEpoch: 6,
      runLeaseExpiresAt: new Date("2026-07-19T00:00:12.000Z"),
      attemptOwnerId: "cleanup-a:test",
      attemptEpoch: 6,
      attemptLeaseExpiresAt: new Date("2026-07-19T00:00:12.000Z"),
    });
  });

  it("does not claim a provider cancellation that already has a resolution", async () => {
    const { service, state, tx } = providerCancellationHarness({
      providerCancellationResolutionId: "runtime-attempt-1",
    });

    await expect(service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    )).resolves.toEqual({ disposition: "resolved" });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
    expect(state.runOwnerId).toBeNull();
    expect(state.attemptOwnerId).toBeNull();
  });

  it("keeps a timed-out cancellation generation active until its hard deadline", async () => {
    const context = providerCancellationHarness();
    const firstClaim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const firstOperation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      firstClaim,
    );
    expect(firstOperation).toEqual({
      runId: "run-1",
      attemptId: "runtime-attempt-1",
      epoch: 1,
      externalRunId: null,
      deadlineAt: new Date("2026-07-19T00:00:30.000Z"),
      monotonicDeadlineAtMs: expect.any(Number),
    });
    await context.service.releaseProviderCancellation(firstClaim);

    await expect(context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-b:test",
      12_000,
    )).resolves.toEqual({ disposition: "busy" });
    expect(context.state).toMatchObject({
      providerCancellationOperationEpoch: 1,
      providerCancellationOperationStartedAt: initialNow,
      providerCancellationOperationDeadlineAt: new Date("2026-07-19T00:00:30.000Z"),
      providerCancellationResolutionId: null,
    });
  });

  it("takes over only after the hard deadline while preserving stale positive evidence", async () => {
    const context = providerCancellationHarness();
    const firstClaim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const firstOperation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      firstClaim,
    );
    await context.service.releaseProviderCancellation(firstClaim);
    context.state.databaseNow = new Date("2026-07-19T00:00:30.001Z");

    const secondClaim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-b:test",
      12_000,
    ));
    const secondOperation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      secondClaim,
    );
    expect(secondOperation?.epoch).toBe(2);
    await expect(context.service.attachExternalRunForCleanup(
      "runtime-attempt-1",
      firstOperation!.epoch,
      "external-run-stale",
    )).resolves.toEqual({
      externalRunId: "external-run-stale",
      operationCurrent: false,
    });
    await expect(context.service.finishProviderCancellationOperation(firstOperation!))
      .resolves.toBe(false);
    await expect(context.service.finishProviderCancellationOperation(secondOperation!))
      .resolves.toBe(true);
    await expect(context.service.finishProviderCancellationOperation(secondOperation!))
      .resolves.toBe(false);
    expect(context.state).toMatchObject({
      externalRunId: "external-run-stale",
      providerCancellationOperationEpoch: 2,
      providerCancellationOperationStartedAt: null,
      providerCancellationOperationDeadlineAt: null,
    });
  });

  it("does not let a finished operation resolve a newer generation", async () => {
    const context = providerCancellationHarness({ externalRunId: "external-run-1" });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const firstOperation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );
    await context.service.finishProviderCancellationOperation(firstOperation!);
    const secondOperation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );

    await expect(context.service.settleProviderCancellationOperation(firstOperation!, {
      outcome: "external_run_absent",
      externalRunId: "external-run-1",
    })).resolves.toBe("fenced");
    expect(secondOperation?.epoch).toBe(2);
    expect(context.providerCancellationResolution()).toBeNull();
  });

  it("atomically settles a late provider result after the cleanup claim is released", async () => {
    const context = providerCancellationHarness({
      runErrorDetail: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
    });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const operation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );
    await context.service.releaseProviderCancellation(claim);

    await expect(context.service.settleProviderCancellationOperation(operation!, {
      outcome: "cancelled",
      externalRunId: "external-run-late",
    })).resolves.toBe("resolved");

    expect(context.state).toMatchObject({
      externalRunId: "external-run-late",
      providerCancellationOperationEpoch: 1,
      providerCancellationOperationStartedAt: null,
      providerCancellationOperationDeadlineAt: null,
      providerCancellationResolutionId: "runtime-attempt-1",
      runOwnerId: null,
      attemptOwnerId: null,
    });
    expect(context.providerCancellationResolution()).toEqual({
      runtimeAttemptId: "runtime-attempt-1",
      runId: "run-1",
      operationEpoch: 1,
      externalRunId: "external-run-late",
      failureCode: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
      outcome: "cancelled",
    });
  });

  it("finishes unknown-id absence without ever writing a resolution", async () => {
    const context = providerCancellationHarness({
      runErrorDetail: "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT",
    });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const operation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );

    await expect(context.service.settleProviderCancellationOperation(operation!, {
      outcome: "external_run_absent",
      externalRunId: null,
    })).resolves.toBe("unconfirmed");

    expect(context.state).toMatchObject({
      externalRunId: null,
      providerCancellationOperationStartedAt: null,
      providerCancellationOperationDeadlineAt: null,
      providerCancellationResolutionId: null,
      runOwnerId: "cleanup-a:test",
      attemptOwnerId: "cleanup-a:test",
    });
    expect(context.providerCancellationResolution()).toBeNull();
  });

  it("clears the operation but leaves absence unconfirmed after a late Run id attach", async () => {
    const context = providerCancellationHarness();
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const operation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );
    context.state.externalRunId = "external-run-late";

    await expect(context.service.settleProviderCancellationOperation(operation!, {
      outcome: "external_run_absent",
      externalRunId: null,
    })).resolves.toBe("unconfirmed");

    expect(context.state).toMatchObject({
      externalRunId: "external-run-late",
      providerCancellationOperationStartedAt: null,
      providerCancellationOperationDeadlineAt: null,
      providerCancellationResolutionId: null,
      runOwnerId: "cleanup-a:test",
      attemptOwnerId: "cleanup-a:test",
    });
    expect(context.providerCancellationResolution()).toBeNull();
  });

  it("starts a fenced cancellation operation for a cancelling Run without an execution claim", async () => {
    const context = harness({ runStatus: "cancelling", attemptStatus: "cancelling" });

    await expect(context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
    )).resolves.toEqual({
      runId: "run-1",
      attemptId: "runtime-attempt-1",
      epoch: 1,
      externalRunId: null,
      deadlineAt: new Date("2026-07-19T00:00:30.000Z"),
      monotonicDeadlineAtMs: expect.any(Number),
    });
  });

  it("returns the database-authoritative external Run id in an operation token", async () => {
    const context = providerCancellationHarness({ externalRunId: "external-run-authoritative" });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));

    await expect(context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    )).resolves.toMatchObject({
      externalRunId: "external-run-authoritative",
      deadlineAt: new Date("2026-07-19T00:00:30.000Z"),
    });
  });

  it("rejects starting a provider cancellation operation while the Run is running", async () => {
    const context = harness({
      runOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptOwnerId: claimA.ownerId,
      attemptEpoch: claimA.epoch,
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
    });

    await expect(context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claimA,
    )).rejects.toThrow("RUNTIME_PROVIDER_CANCELLATION_OPERATION_SCOPE_FENCED");
  });

  it("reports a provider cancellation claim as busy while either durable lease is active", async () => {
    const { service, tx } = providerCancellationHarness({
      runOwnerId: "cleanup-existing:test",
      runLeaseExpiresAt: new Date("2026-07-19T00:00:01.000Z"),
    });

    await expect(service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    )).resolves.toEqual({ disposition: "busy" });
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a provider cancellation claim outside the unresolved failure state", async () => {
    const { service, tx } = providerCancellationHarness({
      attemptErrorCode: "RUNTIME_EXECUTION_FAILED",
    });

    await expect(service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    )).rejects.toThrow("RUNTIME_PROVIDER_CANCELLATION_CLAIM_FENCED");
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.runtimeAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("persists a provider cancellation resolution and releases its lease", async () => {
    const context = providerCancellationHarness({ externalRunId: "external-run-1" });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));

    const operation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );
    await context.service.settleProviderCancellationOperation(operation!, {
      outcome: "cancelled",
      externalRunId: "external-run-1",
    });

    expect(context.providerCancellationResolution()).toEqual({
      runtimeAttemptId: "runtime-attempt-1",
      runId: "run-1",
      operationEpoch: 1,
      externalRunId: "external-run-1",
      failureCode: "RUNTIME_EXECUTION_FAILED",
      outcome: "cancelled",
    });
    expect(context.state).toMatchObject({
      providerCancellationResolutionId: "runtime-attempt-1",
      runOwnerId: null,
      runLeaseExpiresAt: null,
      attemptOwnerId: null,
      attemptLeaseExpiresAt: null,
    });
  });

  it("fences finish and settlement after the operation hard deadline", async () => {
    const context = providerCancellationHarness({ externalRunId: "external-run-1" });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    const operation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );
    context.state.databaseNow = new Date("2026-07-19T00:00:30.001Z");

    await expect(context.service.finishProviderCancellationOperation(operation!))
      .resolves.toBe(false);
    await expect(context.service.settleProviderCancellationOperation(operation!, {
      outcome: "external_run_absent",
      externalRunId: "external-run-1",
    })).resolves.toBe("fenced");
    expect(context.tx.runtimeProviderCancellationResolution.create).not.toHaveBeenCalled();
    expect(context.providerCancellationResolution()).toBeNull();
    expect(context.state).toMatchObject({
      providerCancellationOperationEpoch: 1,
      providerCancellationOperationStartedAt: initialNow,
      providerCancellationOperationDeadlineAt: new Date("2026-07-19T00:00:30.000Z"),
    });
  });

  it("rejects a settlement for a conflicting external Run id", async () => {
    const context = providerCancellationHarness({ externalRunId: "external-run-1" });
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));

    const operation = await context.service.startProviderCancellationOperation(
      "run-1",
      "runtime-attempt-1",
      30_000,
      claim,
    );
    await expect(context.service.settleProviderCancellationOperation(operation!, {
      outcome: "already_terminal",
      externalRunId: "external-run-conflict",
    })).resolves.toBe("external_run_conflict");

    expect(context.tx.runtimeProviderCancellationResolution.create).not.toHaveBeenCalled();
    expect(context.providerCancellationResolution()).toBeNull();
    expect(context.state).toMatchObject({
      providerCancellationResolutionId: null,
      providerCancellationOperationStartedAt: initialNow,
      runOwnerId: "cleanup-a:test",
      attemptOwnerId: "cleanup-a:test",
    });
  });

  it("releases an unresolved provider cancellation claim", async () => {
    const context = providerCancellationHarness();
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));

    await expect(context.service.releaseProviderCancellation(claim)).resolves.toBeUndefined();
    expect(context.state).toMatchObject({
      runOwnerId: null,
      runLeaseExpiresAt: null,
      attemptOwnerId: null,
      attemptLeaseExpiresAt: null,
      providerCancellationResolutionId: null,
    });
  });

  it("fences and rolls back a provider cancellation release lost to a concurrent update", async () => {
    const context = providerCancellationHarness();
    const claim = claimedCancellation(await context.service.claimProviderCancellation(
      "run-1",
      "runtime-attempt-1",
      "cleanup-a:test",
      12_000,
    ));
    context.tx.runtimeAttempt.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(context.service.releaseProviderCancellation(claim))
      .rejects.toThrow("RUNTIME_PROVIDER_CANCELLATION_RELEASE_FENCED");
    expect(context.state).toMatchObject({
      runOwnerId: "cleanup-a:test",
      runLeaseExpiresAt: new Date("2026-07-19T00:00:12.000Z"),
      attemptOwnerId: "cleanup-a:test",
      attemptLeaseExpiresAt: new Date("2026-07-19T00:00:12.000Z"),
    });
  });

  it("requires and inherits only the direct predecessor projection", async () => {
    let predecessorProviderState: ReturnType<typeof createRuntimeProviderProjection> | null = null;
    const runtimeAttempt = {
      findUnique: vi.fn(async () => ({
        id: "runtime-attempt-2",
        runId: "run-1",
        attempt: 2,
        externalEventSequence: 0,
        providerState: predecessorProviderState,
      })),
      updateMany: vi.fn(),
    };
    const runtimeProviderState = {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{
        databaseNow: initialNow,
        runStatus: "running",
        runOwnerId: null,
        runEpoch: 0,
        runLeaseExpiresAt: null,
        attemptStatus: "pending",
        attemptOwnerId: null,
        attemptEpoch: 0,
        attemptLeaseExpiresAt: null,
        providerCancellationOperationEpoch: 0,
        providerCancellationOperationStartedAt: null,
        providerCancellationOperationDeadlineAt: null,
        providerCancellationResolutionId: null,
        externalRunId: null,
        providerIdempotencyKey: null,
        submissionUnknownAt: null,
        externalEventSequence: 0,
        lastExternalEventId: null,
        attempt: 3,
      }]),
      runtimeAttempt,
      runtimeProviderState,
      runDraft: { findUnique: vi.fn(async () => null) },
      run: { updateMany: vi.fn() },
    };
    const service = new RuntimeAttemptService({
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    } as never);

    await expect(service.claim("run-1", "runtime-attempt-3", "worker-a:test"))
      .rejects.toThrow("RUNTIME_PROVIDER_STATE_BACKFILL_REQUIRED");

    expect(runtimeAttempt.findUnique).toHaveBeenCalledWith({
      where: { runId_attempt: { runId: "run-1", attempt: 2 } },
      select: {
        id: true,
        runId: true,
        attempt: true,
        externalEventSequence: true,
        providerState: true,
      },
    });
    expect(runtimeProviderState.create).not.toHaveBeenCalled();
    expect(runtimeAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.run.updateMany).not.toHaveBeenCalled();

    predecessorProviderState = createRuntimeProviderProjection({
      runtimeAttemptId: "runtime-attempt-2",
      runId: "run-1",
      snapshot: {
        rawAssistantText: "wbkg1.",
        visibleAssistantText: "",
        redactionBuffer: "wbkg1.",
      },
    });
    runtimeAttempt.updateMany.mockResolvedValue({ count: 1 });
    tx.run.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.claim("run-1", "runtime-attempt-3", "worker-a:test"))
      .resolves.toEqual({
        runId: "run-1",
        attemptId: "runtime-attempt-3",
        ownerId: "worker-a:test",
        epoch: 1,
      });
    expect(runtimeProviderState.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runtimeAttemptId: "runtime-attempt-3",
        runId: "run-1",
        lastAppliedSequence: 0,
        rawAssistantText: "wbkg1.",
        visibleAssistantText: "",
        redactionBuffer: "wbkg1.",
      }),
    });
  });

  it("heartbeats from database time and extends both leases", async () => {
    const { db, service, state } = harness({}, 10_000);
    const claim = await service.claim("run-1", "runtime-attempt-1", "worker-a:test");
    state.databaseNow = new Date("2026-07-19T00:00:04.000Z");

    await service.heartbeat(claim);

    expect(state.runLeaseExpiresAt).toEqual(new Date("2026-07-19T00:00:14.000Z"));
    expect(state.attemptLeaseExpiresAt).toEqual(new Date("2026-07-19T00:00:14.000Z"));
    expect(db.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      { maxWait: 10_000, timeout: 30_000 },
    );
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

    await service.markSubmissionUnknown(recoveryClaim);
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

    await service.markSubmissionUnknown(claim);

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

    await service.markSubmissionUnknown(claim);

    expect(state).toMatchObject({
      attemptStatus: "running",
      externalRunId: "external-run-1",
      runOwnerId: null,
      attemptOwnerId: null,
    });
  });

  it("deduplicates an exact external event replay with effects and cursor in one transaction", async () => {
    const { db, service, state, externalEvents } = harness({
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
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    for (const call of db.$transaction.mock.calls) {
      expect(call).toEqual([
        expect.any(Function),
        { maxWait: 10_000, timeout: 30_000 },
      ]);
    }
  });

  it("reads only the verified projection and draft in projection-required mode", async () => {
    const { db, service, tx } = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });

    await expect(service.providerTextState(claimA)).resolves.toEqual({
      protocol: "workbench.runtime-provider-text-state.v2",
      rawAssistantText: "",
      visibleAssistantText: "",
      durableVisibleAssistantText: "",
      redactionBuffer: "",
      committedFinalization: null,
    });
    expect(tx.$queryRaw.mock.calls.every(([query]) => (
      !rawSqlText(query).includes("runtime_external_events")
    ))).toBe(true);
    expect(db.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      { maxWait: 10_000, timeout: 30_000 },
    );
  });

  it("requires a non-silent reporter in shadow-verify mode", () => {
    expect(() => new RuntimeAttemptService(
      {} as never,
      45_000,
      "shadow-verify",
    )).toThrow("RUNTIME_PROVIDER_STATE_SHADOW_REPORTER_REQUIRED");
  });

  it("returns the projection before transaction-free historical shadow replay completes", async () => {
    const context = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });
    let finishReplay!: (rows: []) => void;
    const replay = new Promise<[]>((resolve) => {
      finishReplay = resolve;
    });
    context.db.$queryRaw.mockReturnValueOnce(replay);
    const reporter = vi.fn();
    const service = new RuntimeAttemptService(
      context.db as never,
      45_000,
      "shadow-verify",
      reporter,
    );

    await expect(service.providerTextState(claimA)).resolves.toMatchObject({
      protocol: "workbench.runtime-provider-text-state.v2",
      rawAssistantText: "",
      visibleAssistantText: "",
    });
    expect(context.db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(reporter).not.toHaveBeenCalled();
    expect(context.db.$transaction).toHaveBeenCalledTimes(1);

    finishReplay([]);
    await vi.waitFor(() => expect(context.db.$queryRaw).toHaveResolved());
    expect(reporter).not.toHaveBeenCalled();
    expect(context.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("reports only hashed scope when transaction-free shadow replay finds a mismatch", async () => {
    const context = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
      externalEventSequence: 1,
    });
    const noopPayload = { synthetic: true };
    Object.assign(context.providerProjection(), reduceRuntimeProviderProjection(
      context.providerProjection(),
      {
        runtimeAttemptId: claimA.attemptId,
        runId: claimA.runId,
        attempt: 1,
        externalEventId: "event-1",
        sequence: 1,
        event: "synthetic.noop",
        payload: noopPayload,
        payloadSha256: sha256Canonical(noopPayload),
      },
    ).state);
    const divergentPayload = { type: "ai", content: "wbkg1." };
    context.db.$queryRaw.mockResolvedValueOnce([{
      runtimeAttemptId: claimA.attemptId,
      attempt: 1,
      externalEventId: "event-1",
      sequence: 1,
      event: "messages",
      payload: divergentPayload,
      payloadSha256: sha256Canonical(divergentPayload),
    }]);
    const reporter = vi.fn();
    const service = new RuntimeAttemptService(
      context.db as never,
      45_000,
      "shadow-verify",
      reporter,
    );

    await service.providerTextState(claimA);
    await vi.waitFor(() => expect(reporter).toHaveBeenCalledTimes(1));

    const finding = reporter.mock.calls[0]![0];
    expect(finding).toMatchObject({
      protocol: "workbench.runtime-provider-state-shadow-finding.v1",
      code: "RUNTIME_PROVIDER_STATE_SHADOW_MISMATCH",
      runIdSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      attemptIdSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(finding)).not.toContain(claimA.runId);
    expect(JSON.stringify(finding)).not.toContain(claimA.attemptId);
    expect(context.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "missing projection",
      prepare: ({ tx }: ReturnType<typeof harness>) => {
        tx.runtimeProviderState.findUnique.mockResolvedValueOnce(null);
      },
      error: "RUNTIME_PROVIDER_STATE_MISSING",
    },
    {
      name: "unknown projection version",
      prepare: ({ providerProjection }: ReturnType<typeof harness>) => {
        providerProjection().projectionVersion = 3 as 2;
      },
      error: "RUNTIME_PROVIDER_STATE_VERSION_INVALID",
    },
    {
      name: "projection hash mismatch",
      prepare: ({ providerProjection }: ReturnType<typeof harness>) => {
        providerProjection().stateSha256 = "b".repeat(64);
      },
      error: "RUNTIME_PROVIDER_STATE_HASH_MISMATCH",
    },
    {
      name: "projection sequence gap",
      state: { externalEventSequence: 1 },
      prepare: () => undefined,
      error: "RUNTIME_PROVIDER_STATE_SEQUENCE_GAP",
    },
    {
      name: "durable draft conflict",
      prepare: ({ tx }: ReturnType<typeof harness>) => {
        tx.runDraft.findUnique.mockResolvedValueOnce({ content: { text: "different" } });
      },
      error: "RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT",
    },
  ])("fails closed on $name", async ({ state: stateOverride = {}, prepare, error }) => {
    const context = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
      ...stateOverride,
    });
    prepare(context);

    await expect(context.service.providerTextState(claimA)).rejects.toThrow(error);
  });

  it("attaches only a bounded numeric lag to projection sequence errors", async () => {
    const context = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
      externalEventSequence: 3,
    });

    const error = await context.service.providerTextState(claimA).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      message: "RUNTIME_PROVIDER_STATE_SEQUENCE_GAP",
      projectionLag: 3,
    });
    expect(JSON.stringify(error)).toBe("{}");
  });

  it("checks replay identity without selecting or loading payload JSON", async () => {
    const { service, tx } = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });
    const input = {
      externalRunId: "external-run-1",
      externalEventId: "event-replay-check",
      event: "synthetic.noop",
      payload: { synthetic: true },
    } as const;
    await service.processExternalEvent(claimA, input, async () => undefined);

    await expect(service.externalEventProcessed(claimA, input)).resolves.toBe(true);
    await expect(service.externalEventProcessed(claimA, {
      ...input,
      payload: { synthetic: false },
    })).rejects.toThrow("RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT");
    await expect(service.externalEventProcessed(claimA, {
      ...input,
      externalEventId: "event-new",
    })).resolves.toBe(false);
    expect(tx.runtimeExternalEvent.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({
      select: {
        runId: true,
        externalRunId: true,
        event: true,
        payloadSha256: true,
        status: true,
      },
    }));
  });

  it("uses the bounded inbox transaction budget for external finalization", async () => {
    const { db, service } = harness({
      runOwnerId: claimA.ownerId,
      attemptOwnerId: claimA.ownerId,
      runEpoch: claimA.epoch,
      attemptEpoch: claimA.epoch,
      runLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptLeaseExpiresAt: new Date("2026-07-19T00:01:00.000Z"),
      attemptStatus: "running",
      externalRunId: "external-run-1",
    });

    const checkpoint = createRuntimeProviderTextCheckpoint(
      projectIncompleteVisibleAssistantText(""),
      "",
    );
    const payload = createRuntimeFinalizationPayload({
      messagesSha256: "a".repeat(64),
      outcomeSha256: "b".repeat(64),
      effects: [],
      visibleAssistantText: "",
      providerTextCheckpoint: checkpoint,
    });
    await service.processExternalFinalization(claimA, {
      externalRunId: "external-run-1",
      externalEventId: "finalization-1",
      event: runtimeExternalFinalizationEvent,
      payload,
    }, async () => undefined);

    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { maxWait: 10_000, timeout: 30_000 },
    );
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
