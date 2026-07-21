import { hashRequest } from "../src/common/idempotency.js";
import { RunsService } from "../src/modules/runs/runs.service.js";

const now = new Date("2026-07-19T00:00:00.000Z");
const idempotencyKey = "run-cancel:key-1";
const request = {
  prompt: "Build it",
  modelId: "quality",
  workflow: "generate" as const,
  generationIntent: null,
  targetSurface: "app" as const,
  designStyle: { kind: "automatic" as const },
  sourceIds: [],
  artifactTargets: [],
  requestedArtifactKinds: [],
  canvasSnapshot: null,
};

function persistedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    requestId: "request_1",
    projectId: "project_1",
    threadId: "thread_1",
    retryOfRunId: null,
    createdById: "principal_1",
    knowledgeReleaseId: null,
    idempotencyKey: "run:create:key-1",
    requestHash: hashRequest(request),
    request,
    status: "running" as const,
    phase: "generating" as const,
    phaseLabel: "Generating",
    progress: 0.5,
    modelId: "quality",
    traceId: "trace_1",
    attempt: 1,
    eventSequence: 4,
    cancelRequestedAt: null,
    startedAt: now,
    finishedAt: null,
    errorCode: null,
    errorDetail: null,
    errorRetryable: null,
    cancellationReason: null,
    outputEntryId: "entry_1",
    createdAt: now,
    updatedAt: now,
    sourceSnapshots: [],
    ...overrides,
  };
}

function rawSqlText(value: unknown) {
  if (!value || typeof value !== "object") return String(value);
  const query = value as { sql?: unknown; text?: unknown; strings?: unknown };
  if (typeof query.sql === "string") return query.sql;
  if (typeof query.text === "string") return query.text;
  if (Array.isArray(query.strings)) return query.strings.join("");
  return String(value);
}

function createHarness(options: {
  status?: "running" | "cancelling" | "cancelled";
  transactionReplay?: ReturnType<typeof receipt> | null;
} = {}) {
  let run = persistedRun({
    status: options.status ?? "running",
    cancelRequestedAt: options.status === "cancelling" || options.status === "cancelled" ? now : null,
    finishedAt: options.status === "cancelled" ? now : null,
    cancellationReason: options.status === "cancelled" ? "Cancelled by user" : null,
  });
  let durableReceipt: ReturnType<typeof receipt> | null = null;
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => rawSqlText(query).includes("pg_advisory_xact_lock")
      ? [{ receiptLock: "" }]
      : [{ id: "project_1", revision: 0 }]),
    projectMember: {
      findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
    },
    runCancellationReceipt: {
      findUnique: vi.fn().mockImplementation(async () => options.transactionReplay ?? durableReceipt),
      create: vi.fn().mockImplementation(async ({ data }: { data: ReturnType<typeof receipt> }) => {
        durableReceipt = { id: "cancel_receipt_1", createdAt: now, ...data };
        return durableReceipt;
      }),
    },
    run: {
      updateMany: vi.fn().mockImplementation(async () => {
        if (!(["queued", "running", "waiting_input"] as string[]).includes(run.status)) {
          return { count: 0 };
        }
        run = { ...run, status: "cancelling", cancelRequestedAt: now };
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => run),
    },
    runtimeAttempt: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const events = {
    append: vi.fn().mockImplementation(async () => {
      run = { ...run, eventSequence: run.eventSequence + 1 };
      return {};
    }),
  };
  const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
  const db = {
    runCancellationReceipt: {
      findUnique: vi.fn().mockImplementation(async () => durableReceipt),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const access = {
    findRun: vi.fn().mockImplementation(async (_principalId: string, runId: string) => (
      runId === run.id ? run : { ...run, id: runId }
    )),
  };
  return {
    access,
    db,
    events,
    queue,
    tx,
    service: new RunsService(
      db as never,
      access as never,
      events as never,
      queue as never,
      {} as never,
      {} as never,
    ),
    getReceipt: () => durableReceipt,
    setReceipt: (value: ReturnType<typeof receipt>) => { durableReceipt = value; },
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  const response = {
    id: "run_1",
    requestId: "request_1",
    projectId: "project_1",
    threadId: "thread_1",
    retryOfRunId: null,
    status: "cancelling" as const,
    modelId: "quality",
    workflow: "generate" as const,
    generationIntent: null,
    targetSurface: "app" as const,
    designStyle: { kind: "automatic" as const },
    artifactTargets: [],
    requestedArtifactKinds: [],
    sources: [],
    knowledgeReleaseId: null,
    phase: "generating" as const,
    phaseLabel: "Generating",
    progress: 0.5,
    attempt: 1,
    lastEventSequence: 5,
    cancelRequestedAt: now.toISOString(),
    failure: null,
    cancellationReason: null,
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    finishedAt: null,
  };
  return {
    id: "cancel_receipt_1",
    runId: "run_1",
    principalId: "principal_1",
    idempotencyKey,
    requestHash: hashRequest({ protocol: "workbench.run-cancellation.v1", runId: "run_1" }),
    response,
    responseHash: hashRequest(response),
    createdAt: now,
    ...overrides,
  };
}

describe("Run cancellation durable idempotency", () => {
  it("commits the exact first response and replays it after mutable Run state advances", async () => {
    const harness = createHarness();

    const first = await harness.service.cancel("principal_1", "run_1", idempotencyKey);
    expect(first).toMatchObject({ id: "run_1", status: "cancelling", lastEventSequence: 5 });
    expect(harness.tx.runCancellationReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run_1",
        principalId: "principal_1",
        idempotencyKey,
        requestHash: hashRequest({ protocol: "workbench.run-cancellation.v1", runId: "run_1" }),
        response: first,
        responseHash: hashRequest(first),
      }),
    });
    expect(harness.events.append).toHaveBeenCalledTimes(1);
    expect(harness.queue.sendInTransaction).toHaveBeenCalledTimes(1);
    expect(rawSqlText(harness.tx.$queryRaw.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock");

    const replayed = await harness.service.cancel("principal_1", "run_1", idempotencyKey);
    expect(replayed).toEqual(first);
    expect(harness.db.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.events.append).toHaveBeenCalledTimes(1);
    expect(harness.queue.sendInTransaction).toHaveBeenCalledTimes(1);
  });

  it("records an already-cancelled command without creating another event or queue job", async () => {
    const harness = createHarness({ status: "cancelled" });

    await expect(harness.service.cancel("principal_1", "run_1", idempotencyKey))
      .resolves.toMatchObject({ status: "cancelled" });
    expect(harness.events.append).not.toHaveBeenCalled();
    expect(harness.queue.sendInTransaction).not.toHaveBeenCalled();
    expect(harness.getReceipt()).toMatchObject({ runId: "run_1", principalId: "principal_1" });
  });

  it("rejects reuse of the same caller key for another Run", async () => {
    const harness = createHarness();
    await harness.service.cancel("principal_1", "run_1", idempotencyKey);

    await expect(harness.service.cancel("principal_1", "run_2", idempotencyKey))
      .rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
      });
    expect(harness.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the immutable response no longer matches its canonical hash", async () => {
    const harness = createHarness();
    harness.setReceipt(receipt({ responseHash: "f".repeat(64) }));

    await expect(harness.service.cancel("principal_1", "run_1", idempotencyKey))
      .rejects.toThrow("RUN_CANCELLATION_RECEIPT_HASH_INVALID");
    expect(harness.db.$transaction).not.toHaveBeenCalled();
  });

  it("resolves a concurrent winner under the receipt identity lock before changing Run state", async () => {
    const winner = receipt();
    const harness = createHarness({ transactionReplay: winner });

    await expect(harness.service.cancel("principal_1", "run_1", idempotencyKey))
      .resolves.toEqual(winner.response);
    expect(harness.tx.run.updateMany).not.toHaveBeenCalled();
    expect(harness.tx.runCancellationReceipt.create).not.toHaveBeenCalled();
  });
});
