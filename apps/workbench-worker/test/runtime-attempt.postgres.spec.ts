import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { RunEventStore } from "../src/runs/run-event.store.js";
import { RuntimeAttemptService } from "../src/runtime/runtime-attempt.service.js";

const databaseUrl =
  process.env.WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL
  ?? process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("RuntimeAttempt PostgreSQL cancellation fences", () => {
  it("does not create an attempt when cancellation commits before the Run lock", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(worker, false);
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const service = new RuntimeAttemptService(
      databaseWithRunLockFence(worker, lockRequested, releaseLock) as never,
    );
    const outcome = service.ensure(fixture.runId, 1, fixture.binding).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );

    try {
      await lockRequested.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseLock.resolve();

      const result = await outcome;
      expect(result.error).toMatchObject({ message: "RUNTIME_ATTEMPT_RUN_NOT_ACTIVE" });
      expect(result.value).toBeNull();
      await expect(worker.runtimeAttempt.count({ where: { runId: fixture.runId } })).resolves.toBe(0);
    } finally {
      releaseLock.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("does not authorize submission when cancellation commits before the Run lock", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const canceller = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(worker, true);
    const lockRequested = deferred<void>();
    const releaseLock = deferred<void>();
    const claimService = new RuntimeAttemptService(worker, 120_000);
    const claim = await claimService.claim(
      fixture.runId,
      fixture.runtimeAttemptId!,
      `runtime-attempt-pg:${randomUUID()}`,
    );
    await claimService.submissionContext(claim);
    const service = new RuntimeAttemptService(
      databaseWithRunLockFence(worker, lockRequested, releaseLock) as never,
    );
    const outcome = service.authorizeSubmission(claim).then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );

    try {
      await lockRequested.promise;
      await cancelActiveRun(canceller, fixture.runId);
      releaseLock.resolve();

      const result = await outcome;
      expect(result.error).toMatchObject({ message: "RUNTIME_SUBMISSION_NOT_AUTHORIZED" });
      await expect(worker.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        status: "pending",
        startedAt: null,
        externalRunId: null,
      });
    } finally {
      releaseLock.resolve();
      await outcome;
      await cleanupFixture(worker, fixture);
      await Promise.all([worker.$disconnect(), canceller.$disconnect()]);
    }
  }, 120_000);

  it("creates and authorizes one attempt while the Run remains running", async () => {
    const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(worker, false);
    const service = new RuntimeAttemptService(worker);

    try {
      const created = await service.ensure(fixture.runId, 1, fixture.binding);
      const replayed = await service.ensure(fixture.runId, 1, fixture.binding);
      expect(replayed.id).toBe(created.id);

      const claim = await service.claim(
        fixture.runId,
        created.id,
        `runtime-attempt-pg:${randomUUID()}`,
      );
      await service.submissionContext(claim);
      await service.authorizeSubmission(claim);

      await expect(worker.runtimeAttempt.findUniqueOrThrow({
        where: { id: created.id },
      })).resolves.toMatchObject({
        status: "submitting",
        startedAt: expect.any(Date),
        externalRunId: null,
      });
      await expect(worker.runtimeAttempt.count({ where: { runId: fixture.runId } })).resolves.toBe(1);
    } finally {
      await cleanupFixture(worker, fixture);
      await worker.$disconnect();
    }
  }, 120_000);
});

describeWithPostgres("RuntimeAttempt PostgreSQL external event crash replay", () => {
  it("commits a slow external event atomically beyond Prisma's default transaction timeout", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture, 45_000);
    const input = externalEvent(fixture, "event-slow-atomic-commit");
    const events = new RunEventStore(db);

    try {
      await expect(service.processExternalEvent(claim, input, async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT 1 AS "delayed" FROM pg_sleep(6)`);
        await appendActivityEffect(events, tx, fixture, input.externalEventId);
      })).resolves.toEqual({ created: true, sequence: 1 });

      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("lets a heartbeat wait for a slow external event transaction", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture, 45_000);
    const input = externalEvent(fixture, "event-slow-heartbeat-contention");
    const eventLocked = deferred<void>();
    const events = new RunEventStore(db);

    try {
      const event = service.processExternalEvent(claim, input, async (tx) => {
        eventLocked.resolve();
        await tx.$queryRaw(Prisma.sql`SELECT 1 AS "delayed" FROM pg_sleep(6)`);
        await appendActivityEffect(events, tx, fixture, input.externalEventId);
      });
      await eventLocked.promise;

      await expect(Promise.all([event, service.heartbeat(claim)]))
        .resolves.toEqual([{ created: true, sequence: 1 }, undefined]);
      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
    } finally {
      eventLocked.resolve();
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rolls back an inbox reservation when the worker crashes before the internal append", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const input = externalEvent(fixture, "event-before-append");

    try {
      await expect(service.processExternalEvent(claim, input, async () => {
        throw new Error("SIMULATED_CRASH_BEFORE_INTERNAL_APPEND");
      })).rejects.toThrow("SIMULATED_CRASH_BEFORE_INTERNAL_APPEND");

      await expect(durableEventState(db, fixture)).resolves.toEqual(emptyDurableEventState());
      await expect(processWithActivityEffect(db, service, claim, fixture, input))
        .resolves.toEqual({ created: true, sequence: 1 });
      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rolls back the internal append when the worker crashes before the cursor checkpoint", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const input = externalEvent(fixture, "event-after-append");
    const events = new RunEventStore(db);

    try {
      await expect(service.processExternalEvent(claim, input, async (tx) => {
        await appendActivityEffect(events, tx, fixture, input.externalEventId);
        throw new Error("SIMULATED_CRASH_AFTER_INTERNAL_APPEND");
      })).rejects.toThrow("SIMULATED_CRASH_AFTER_INTERNAL_APPEND");

      await expect(durableEventState(db, fixture)).resolves.toEqual(emptyDurableEventState());
      await expect(processWithActivityEffect(db, service, claim, fixture, input))
        .resolves.toEqual({ created: true, sequence: 1 });
      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rolls back inbox, internal append, and cursor when the worker crashes after the cursor SQL", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const crashingService = new RuntimeAttemptService(
      databaseWithCursorCheckpointCrash(db) as never,
      120_000,
    );
    const input = externalEvent(fixture, "event-after-cursor");

    try {
      await expect(processWithActivityEffect(db, crashingService, claim, fixture, input))
        .rejects.toThrow("SIMULATED_CRASH_AFTER_CURSOR_CHECKPOINT");

      await expect(durableEventState(db, fixture)).resolves.toEqual(emptyDurableEventState());
      await expect(processWithActivityEffect(db, service, claim, fixture, input))
        .resolves.toEqual({ created: true, sequence: 1 });
      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("replays a lost commit response without duplicating effects or advancing either sequence twice", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const lossyService = new RuntimeAttemptService(databaseWithCommitResponseLoss(db) as never, 120_000);
    const first = externalEvent(fixture, "event-commit-response-lost");
    const second = externalEvent(fixture, "event-after-recovery");

    try {
      await expect(processWithActivityEffect(db, lossyService, claim, fixture, first))
        .rejects.toThrow("SIMULATED_EXTERNAL_EVENT_COMMIT_RESPONSE_LOSS");
      const committed = await durableEventState(db, fixture);
      expect(committed).toEqual(expectedDurableEventState(fixture, [first]));

      const replayEffects = vi.fn(async (tx: Prisma.TransactionClient) => {
        await appendActivityEffect(new RunEventStore(db), tx, fixture, first.externalEventId);
      });
      await expect(service.processExternalEvent(claim, first, replayEffects))
        .resolves.toEqual({ created: false, sequence: 1 });
      expect(replayEffects).not.toHaveBeenCalled();
      await expect(durableEventState(db, fixture)).resolves.toEqual(committed);

      await expect(service.processExternalEvent(
        claim,
        { ...first, payload: { delta: "conflicting replay" } },
        async () => undefined,
      )).rejects.toThrow("RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT");
      await expect(durableEventState(db, fixture)).resolves.toEqual(committed);

      await expect(processWithActivityEffect(db, service, claim, fixture, second))
        .resolves.toEqual({ created: true, sequence: 2 });
      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [first, second]));
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);
});

type AttemptFixture = {
  principalId: string;
  workspaceId: string;
  projectId: string;
  threadId: string;
  runId: string;
  runtimeAttemptId: string | null;
  externalRunId: string;
  binding: {
    id: string;
    adapter: string;
    externalThreadId: string;
  };
};

async function seedAttemptFixture(db: PrismaClient, withAttempt: boolean): Promise<AttemptFixture> {
  const suffix = randomUUID().replaceAll("-", "");
  const fixture: AttemptFixture = {
    principalId: `principal_${suffix}`,
    workspaceId: `workspace_${suffix}`,
    projectId: `project_${suffix}`,
    threadId: `thread_${suffix}`,
    runId: `run_${suffix}`,
    runtimeAttemptId: withAttempt ? `attempt_${suffix}` : null,
    externalRunId: `external_run_${suffix}`,
    binding: {
      id: `binding_${suffix}`,
      adapter: "deerflow",
      externalThreadId: `external_thread_${suffix}`,
    },
  };
  await db.$transaction(async (tx) => {
    await tx.principal.create({
      data: {
        id: fixture.principalId,
        issuer: `attempt-race-${suffix}`,
        subject: fixture.principalId,
      },
    });
    await tx.workspace.create({
      data: {
        id: fixture.workspaceId,
        slug: `attempt-race-${suffix}`,
        name: "Runtime attempt race",
        createdById: fixture.principalId,
      },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: fixture.workspaceId,
        principalId: fixture.principalId,
        role: "owner",
      },
    });
    await tx.project.create({
      data: {
        id: fixture.projectId,
        workspaceId: fixture.workspaceId,
        createdById: fixture.principalId,
        title: "Runtime attempt race",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: fixture.projectId,
        workspaceId: fixture.workspaceId,
        principalId: fixture.principalId,
        role: "owner",
      },
    });
    await tx.thread.create({
      data: {
        id: fixture.threadId,
        projectId: fixture.projectId,
        createdById: fixture.principalId,
        title: "Runtime attempt race",
      },
    });
    await tx.runtimeBinding.create({
      data: {
        id: fixture.binding.id,
        threadId: fixture.threadId,
        adapter: fixture.binding.adapter,
        externalThreadId: fixture.binding.externalThreadId,
        metadata: { workbenchThreadId: fixture.threadId },
      },
    });
    await tx.run.create({
      data: {
        id: fixture.runId,
        projectId: fixture.projectId,
        threadId: fixture.threadId,
        createdById: fixture.principalId,
        idempotencyKey: `attempt-race-${suffix}`,
        requestHash: "b".repeat(64),
        requestId: `request_${suffix}`,
        request: {
          prompt: "Build it",
          modelId: "quality",
          workflow: "generate",
          targetSurface: "app",
          designStyle: { kind: "automatic" },
          sourceIds: [],
          artifactTargets: [],
          requestedArtifactKinds: [],
        },
        modelId: "quality",
        traceId: `trace_${suffix}`,
        status: "running",
        attempt: 1,
        startedAt: new Date(),
      },
    });
    if (fixture.runtimeAttemptId) {
      await tx.runtimeAttempt.create({
        data: {
          id: fixture.runtimeAttemptId,
          runId: fixture.runId,
          runtimeBindingId: fixture.binding.id,
          attempt: 1,
          adapter: fixture.binding.adapter,
          externalThreadId: fixture.binding.externalThreadId,
        },
      });
    }
  });
  return fixture;
}

async function activateExternalRun(
  db: PrismaClient,
  fixture: AttemptFixture,
  leaseMs = 120_000,
) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  const service = new RuntimeAttemptService(db, leaseMs);
  const claim = await service.claim(
    fixture.runId,
    fixture.runtimeAttemptId,
    `runtime-event-pg:${randomUUID()}`,
  );
  await service.submissionContext(claim);
  await service.authorizeSubmission(claim);
  await service.attachExternalRun(claim, fixture.externalRunId);
  return { service, claim };
}

function externalEvent(fixture: AttemptFixture, externalEventId: string) {
  return {
    externalRunId: fixture.externalRunId,
    externalEventId,
    event: "messages",
    payload: { delta: `delta:${externalEventId}` },
  } as const;
}

async function processWithActivityEffect(
  db: PrismaClient,
  service: RuntimeAttemptService,
  claim: Awaited<ReturnType<RuntimeAttemptService["claim"]>>,
  fixture: AttemptFixture,
  input: ReturnType<typeof externalEvent>,
) {
  const events = new RunEventStore(db);
  return service.processExternalEvent(claim, input, async (tx) => {
    await appendActivityEffect(events, tx, fixture, input.externalEventId);
  });
}

async function appendActivityEffect(
  events: RunEventStore,
  tx: Prisma.TransactionClient,
  fixture: AttemptFixture,
  externalEventId: string,
) {
  await events.appendOnce(
    tx,
    fixture.runId,
    "activity.changed",
    activityPayload(externalEventId),
    activitySourceId(externalEventId),
  );
}

function activityPayload(externalEventId: string) {
  return {
    activityId: `external-${externalEventId}`,
    status: "running" as const,
    label: `External event ${externalEventId}`,
    detail: null,
  };
}

function activitySourceId(externalEventId: string) {
  return `runtime-external:${externalEventId}`;
}

async function durableEventState(db: PrismaClient, fixture: AttemptFixture) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  const [attempt, run, inbox, events] = await Promise.all([
    db.runtimeAttempt.findUniqueOrThrow({
      where: { id: fixture.runtimeAttemptId },
      select: { lastExternalEventId: true, externalEventSequence: true },
    }),
    db.run.findUniqueOrThrow({
      where: { id: fixture.runId },
      select: { eventSequence: true },
    }),
    db.runtimeExternalEvent.findMany({
      where: { runtimeAttemptId: fixture.runtimeAttemptId },
      orderBy: { sequence: "asc" },
      select: {
        externalEventId: true,
        sequence: true,
        event: true,
        payload: true,
        status: true,
      },
    }),
    db.runEvent.findMany({
      where: { runId: fixture.runId },
      orderBy: { sequence: "asc" },
      select: { sequence: true, type: true, sourceId: true, payload: true },
    }),
  ]);
  return {
    attempt,
    runEventSequence: run.eventSequence,
    inbox,
    events,
  };
}

function emptyDurableEventState() {
  return {
    attempt: { lastExternalEventId: null, externalEventSequence: 0 },
    runEventSequence: 0,
    inbox: [],
    events: [],
  };
}

function expectedDurableEventState(
  fixture: AttemptFixture,
  inputs: ReturnType<typeof externalEvent>[],
) {
  return {
    attempt: {
      lastExternalEventId: inputs.at(-1)?.externalEventId ?? null,
      externalEventSequence: inputs.length,
    },
    runEventSequence: inputs.length,
    inbox: inputs.map((input, index) => ({
      externalEventId: input.externalEventId,
      sequence: index + 1,
      event: input.event,
      payload: input.payload,
      status: "processed",
    })),
    events: inputs.map((input, index) => ({
      sequence: index + 1,
      type: "activity.changed",
      sourceId: activitySourceId(input.externalEventId),
      payload: activityPayload(input.externalEventId),
    })),
  };
}

function databaseWithCursorCheckpointCrash(client: PrismaClient) {
  let injected = false;
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "runtimeAttempt") {
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                const value = Reflect.get(delegateTarget, delegateProperty, delegateReceiver) as unknown;
                if (delegateProperty === "updateMany") {
                  const updateMany = (value as (...args: unknown[]) => Promise<unknown>).bind(delegateTarget);
                  return async (args: { data?: Record<string, unknown> }) => {
                    const result = await updateMany(args);
                    if (
                      !injected
                      && args.data
                      && Object.hasOwn(args.data, "lastExternalEventId")
                    ) {
                      injected = true;
                      throw new Error("SIMULATED_CRASH_AFTER_CURSOR_CHECKPOINT");
                    }
                    return result;
                  };
                }
                return typeof value === "function" ? value.bind(delegateTarget) : value;
              },
            });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Prisma.TransactionClient), { timeout: 30_000 }),
  };
}

function databaseWithCommitResponseLoss(client: PrismaClient) {
  let injected = false;
  return {
    $transaction: async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) => {
      const result = await client.$transaction(callback, { timeout: 30_000 });
      if (!injected) {
        injected = true;
        throw new Error("SIMULATED_EXTERNAL_EVENT_COMMIT_RESPONSE_LOSS");
      }
      return result;
    },
  };
}

function databaseWithRunLockFence(
  client: PrismaClient,
  lockRequested: Deferred<void>,
  releaseLock: Deferred<void>,
) {
  let stopped = false;
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "$queryRaw") {
            const queryRaw = target.$queryRaw.bind(target) as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (!stopped) {
                stopped = true;
                lockRequested.resolve();
                await releaseLock.promise;
              }
              return queryRaw(...args);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Prisma.TransactionClient), { timeout: 30_000 }),
  };
}

async function cancelActiveRun(db: PrismaClient, runId: string) {
  const cancelled = await db.run.updateMany({
    where: { id: runId, status: "running" },
    data: { status: "cancelling", cancelRequestedAt: new Date() },
  });
  expect(cancelled.count).toBe(1);
}

async function cleanupFixture(db: PrismaClient, fixture: AttemptFixture) {
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.principal.deleteMany({ where: { id: fixture.principalId } });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
