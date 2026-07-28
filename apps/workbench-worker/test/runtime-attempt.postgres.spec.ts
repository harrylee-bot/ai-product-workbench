import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { RunEventStore } from "../src/runs/run-event.store.js";
import {
  createRuntimeFinalizationPayload,
  createRuntimeProviderTextCheckpoint,
  projectIncompleteVisibleAssistantText,
  sha256Canonical,
} from "../src/runtime/runtime-assistant-text.js";
import { RuntimeAttemptService } from "../src/runtime/runtime-attempt.service.js";
import {
  RuntimeProviderStateBackfill,
  runtimeProviderStateBackfillEventPageSize,
} from "../src/runtime/runtime-provider-state-backfill.js";

const databaseUrl = process.env.WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL;
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
  it("reproduces the legacy 7,686-event provider-state replay path", async () => {
    const queries: string[] = [];
    const db = new PrismaClient({
      datasourceUrl: databaseUrl!,
      log: [{ emit: "event", level: "query" }],
    });
    db.$on("query", (event) => queries.push(event.query));
    const fixture = await seedAttemptFixture(db, true);
    const { claim } = await activateExternalRun(db, fixture, 120_000);
    const incidentEventCount = 7_686;

    try {
      const expected = await seedRepresentativeProcessedEvents(db, fixture, incidentEventCount);

      const legacyService = new RuntimeAttemptService(db, 120_000, "legacy-read");
      queries.length = 0;
      const state = await legacyService.providerTextState(claim);

      expect(state).toMatchObject({
        protocol: "workbench.runtime-provider-text-state.v2",
        rawAssistantText: expected.visibleText,
        visibleAssistantText: expected.visibleText,
        durableVisibleAssistantText: expected.visibleText,
        committedFinalization: {
          externalEventId: expected.finalizationExternalEventId,
          payloadSha256: expected.finalizationPayloadSha256,
        },
      });
      expect("processedExternalEventIds" in state).toBe(false);
      expect(queries.some((query) => query.toLowerCase().includes("runtime_external_events"))).toBe(true);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it.each([7_686, 12_000])(
    "reads one projection without historical JSON after %i processed events",
    async (eventCount) => {
      const queries: string[] = [];
      const db = new PrismaClient({
        datasourceUrl: databaseUrl!,
        log: [{ emit: "event", level: "query" }],
      });
      db.$on("query", (event) => queries.push(event.query));
      const fixture = await seedAttemptFixture(db, true);
      const { claim } = await activateExternalRun(db, fixture, 120_000);
      const operator = new RuntimeProviderStateBackfill(db);

      try {
        const expected = await seedRepresentativeProcessedEvents(db, fixture, eventCount);
        await db.runtimeProviderState.delete({
          where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        });
        queries.length = 0;
        const backfillStartedAt = performance.now();
        const backfill = await operator.processBatch({
          candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
          mode: "apply",
          batchSize: 10,
        });
        const backfillDurationMs = performance.now() - backfillStartedAt;
        expect(backfill.checkpoints[0]).toMatchObject({
          eventCount,
          lastSequence: eventCount,
          status: "created",
        });
        const normalizedBackfillQueries = queries.map((query) => query.replace(/\s+/gu, " ").trim().toLowerCase());
        const transactionStart = normalizedBackfillQueries.indexOf("begin");
        const transactionFinish = normalizedBackfillQueries.indexOf("commit", transactionStart + 1);
        const inboxReadIndexes = normalizedBackfillQueries
          .map((query, index) => query.includes("runtime_external_events") ? index : -1)
          .filter((index) => index >= 0);
        expect(transactionStart).toBeGreaterThanOrEqual(0);
        expect(transactionFinish).toBeGreaterThan(transactionStart);
        expect(inboxReadIndexes).toHaveLength(Math.ceil(eventCount / runtimeProviderStateBackfillEventPageSize) + 1);
        expect(inboxReadIndexes.every((index) => index < transactionStart)).toBe(true);
        expect(normalizedBackfillQueries.slice(transactionStart, transactionFinish + 1))
          .not.toEqual(expect.arrayContaining([expect.stringContaining("runtime_external_events")]));
        expect(transactionFinish - transactionStart + 1).toBeLessThanOrEqual(8);
        const service = new RuntimeAttemptService(db, 120_000, "projection-required");
        const durations: number[] = [];
        queries.length = 0;
        for (let sample = 0; sample < 5; sample += 1) {
          const startedAt = performance.now();
          const state = await service.providerTextState(claim);
          durations.push(performance.now() - startedAt);
          expect(state).toMatchObject({
            protocol: "workbench.runtime-provider-text-state.v2",
            rawAssistantText: expected.visibleText,
            visibleAssistantText: expected.visibleText,
            durableVisibleAssistantText: expected.visibleText,
            committedFinalization: {
              externalEventId: expected.finalizationExternalEventId,
              payloadSha256: expected.finalizationPayloadSha256,
            },
          });
          expect("processedExternalEventIds" in state).toBe(false);
        }
        const normalizedQueries = queries.map((query) => query.toLowerCase());
        expect(normalizedQueries.some((query) => query.includes("runtime_external_events"))).toBe(false);
        expect(Math.max(...durations)).toBeLessThan(5_000);
        const sorted = [...durations].sort((left, right) => left - right);
        console.log(JSON.stringify({
          protocol: "workbench.runtime-provider-state-read-metrics.v1",
          eventCount,
          samples: durations.length,
          queryCount: queries.length,
          p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)]!.toFixed(2)),
          p95Ms: Number(sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2)),
          maxMs: Number(Math.max(...durations).toFixed(2)),
          backfillDurationMs: Number(backfillDurationMs.toFixed(2)),
          backfillInboxQueryCount: inboxReadIndexes.length,
          backfillTransactionQueryCount: transactionFinish - transactionStart + 1,
        }));
      } finally {
        await cleanupFixture(db, fixture);
        await db.$disconnect();
      }
    },
    120_000,
  );

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

describeWithPostgres("RuntimeProviderState PostgreSQL invariants", () => {
  it("accepts a scoped initial projection and rejects invalid shape and scope", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);

    try {
      await expect(db.runtimeProviderState.create({
        data: initialProviderState(fixture),
      })).resolves.toMatchObject({
        runtimeAttemptId: fixture.runtimeAttemptId,
        runId: fixture.runId,
        projectionVersion: 2,
        lastAppliedSequence: 0,
      });
      await expect(db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: { runId: `other_${fixture.runId}` },
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_(IDENTITY_IMMUTABLE|SCOPE_INVALID)/u);
      await expect(db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: { projectionVersion: 0 },
      })).rejects.toThrow();
      await expect(db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: { stateSha256: "not-a-hash" },
      })).rejects.toThrow();
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("binds cursors and finalization hashes and prevents gaps or terminal advancement", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const first = externalEvent(fixture, "projection-event-1");
    const second = externalEvent(fixture, "projection-event-2");
    const third = externalEvent(fixture, "projection-event-3");

    try {
      await service.processExternalEvent(claim, first, async () => undefined);
      await seedProcessedExternalEvents(db, fixture, [second, third], 2);
      await expect(db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: {
          lastAppliedSequence: 3,
          lastExternalEventId: third.externalEventId,
          stateSha256: "b".repeat(64),
        },
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID/u);

      await db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: {
          lastAppliedSequence: 2,
          lastExternalEventId: second.externalEventId,
          stateSha256: "b".repeat(64),
        },
      });
      await db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: {
          lastAppliedSequence: 3,
          lastExternalEventId: third.externalEventId,
          stateSha256: "c".repeat(64),
        },
      });
      await db.runtimeAttempt.update({
        where: { id: fixture.runtimeAttemptId! },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          executionOwnerId: null,
          executionHeartbeatAt: null,
          executionLeaseExpiresAt: null,
        },
      });
      await expect(db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: { projectionVersion: 3, stateSha256: "d".repeat(64) },
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT/u);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("requires a processed finalization event with the exact payload hash", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
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
    const finalizationId = "projection-finalization-1";

    try {
      await service.processExternalFinalization(claim, {
        externalRunId: fixture.externalRunId,
        externalEventId: finalizationId,
        event: "workbench.runtime.finalization.v2",
        payload,
      }, async () => undefined);
      await expect(db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: { finalizationPayloadSha256: "f".repeat(64) },
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID/u);
      await expect(db.runtimeProviderState.findUniqueOrThrow({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        finalizationExternalEventId: finalizationId,
        finalizationPayloadSha256: sha256Canonical(payload),
      });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);
});

describeWithPostgres("RuntimeProviderState PostgreSQL backfill", () => {
  it("supports dry-run, apply, resume verification, and hash-conflict failure", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const inputs = [
      externalEvent(fixture, "backfill-event-1"),
      externalEvent(fixture, "backfill-event-2"),
    ];
    const operator = new RuntimeProviderStateBackfill(db);
    const candidateSha = "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6";

    try {
      for (const input of inputs) {
        await service.processExternalEvent(claim, input, async () => undefined);
      }
      await db.runtimeProviderState.delete({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      });

      const dryRun = await operator.processBatch({
        candidateSha,
        mode: "dry-run",
        batchSize: 10,
      });
      expect(dryRun.checkpoints).toHaveLength(1);
      expect(dryRun.checkpoints[0]).toMatchObject({
        status: "would-create",
        eventCount: 2,
        lastSequence: 2,
      });
      expect(dryRun.coverage).toMatchObject({
        built: 0,
        missing: 1,
        activeMissing: 1,
        rolloutBlocked: true,
      });

      const applied = await operator.processBatch({
        candidateSha,
        mode: "apply",
        batchSize: 10,
      });
      expect(applied.checkpoints[0]).toMatchObject({
        status: "created",
        eventCount: 2,
        lastSequence: 2,
      });
      expect(applied.coverage).toMatchObject({
        built: 1,
        verified: 1,
        missing: 0,
        lagging: 0,
        hashMismatch: 0,
        rolloutBlocked: false,
      });

      const verified = await operator.processBatch({
        candidateSha,
        mode: "verify-only",
        batchSize: 10,
      });
      expect(verified.checkpoints[0]?.status).toBe("verified");

      await db.runtimeProviderState.update({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        data: { stateSha256: "f".repeat(64) },
      });
      await expect(operator.processBatch({
        candidateSha,
        mode: "verify-only",
        batchSize: 10,
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_HASH_MISMATCH/u);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rebuilds terminal finalization and carries only its text snapshot into a later attempt", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
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
    const secondAttemptId = `attempt_${randomUUID().replaceAll("-", "")}`;
    const operator = new RuntimeProviderStateBackfill(db);

    try {
      await service.processExternalFinalization(claim, {
        externalRunId: fixture.externalRunId,
        externalEventId: "backfill-terminal-finalization",
        event: "workbench.runtime.finalization.v2",
        payload,
      }, async () => undefined);
      await db.runtimeProviderState.delete({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      });
      await db.runtimeAttempt.create({
        data: {
          id: secondAttemptId,
          runId: fixture.runId,
          runtimeBindingId: fixture.binding.id,
          attempt: 2,
          adapter: fixture.binding.adapter,
          externalThreadId: fixture.binding.externalThreadId,
        },
      });

      const applied = await operator.processBatch({
        candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
        mode: "apply",
        batchSize: 10,
      });

      expect(applied.checkpoints).toHaveLength(2);
      await expect(db.runtimeProviderState.findUniqueOrThrow({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        lastAppliedSequence: 1,
        finalizationExternalEventId: "backfill-terminal-finalization",
        finalizationPayloadSha256: sha256Canonical(payload),
      });
      await expect(db.runtimeProviderState.findUniqueOrThrow({
        where: { runtimeAttemptId: secondAttemptId },
      })).resolves.toMatchObject({
        lastAppliedSequence: 0,
        finalizationExternalEventId: null,
        finalizationPayloadSha256: null,
        rawAssistantText: "",
        visibleAssistantText: "",
      });
      expect(applied.coverage).toMatchObject({
        totalAttempts: 2,
        verified: 2,
        rolloutBlocked: false,
      });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rejects an attempt whose historical inbox still contains a pending event", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    await activateExternalRun(db, fixture);
    const input = externalEvent(fixture, "backfill-pending-event");
    const operator = new RuntimeProviderStateBackfill(db);

    try {
      await db.runtimeAttempt.update({
        where: { id: fixture.runtimeAttemptId! },
        data: { externalEventSequence: 1 },
      });
      await db.runtimeExternalEvent.create({
        data: {
          runtimeAttemptId: fixture.runtimeAttemptId!,
          runId: fixture.runId,
          externalRunId: fixture.externalRunId,
          externalEventId: input.externalEventId,
          sequence: 1,
          event: input.event,
          payload: input.payload,
          payloadSha256: sha256Canonical(input.payload),
        },
      });
      await db.runtimeProviderState.delete({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      });

      await expect(operator.processBatch({
        candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
        mode: "apply",
        batchSize: 10,
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_BACKFILL_PENDING_EVENT/u);
      await expect(db.runtimeProviderState.count({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toBe(0);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rejects a historical sequence gap without creating a projection", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    await activateExternalRun(db, fixture);
    const operator = new RuntimeProviderStateBackfill(db);
    let guardDisabled = false;

    try {
      await db.runtimeAttempt.update({
        where: { id: fixture.runtimeAttemptId! },
        data: { externalEventSequence: 2 },
      });
      await db.runtimeProviderState.delete({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      });
      await db.$executeRawUnsafe(
        'ALTER TABLE "runtime_external_events" DISABLE TRIGGER "runtime_external_event_guard"',
      );
      guardDisabled = true;
      const payload = { synthetic: true };
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "runtime_external_events" (
          "id", "runtime_attempt_id", "run_id", "external_run_id",
          "external_event_id", "sequence", "event", "payload", "payload_sha256",
          "status", "processed_at"
        ) VALUES
          (${`gap_1_${fixture.runtimeAttemptId!}`}, ${fixture.runtimeAttemptId!}, ${fixture.runId},
           ${fixture.externalRunId}, 'gap-event-1', 1, 'synthetic.noop',
           ${JSON.stringify(payload)}::JSONB, ${sha256Canonical(payload)}, 'processed', CURRENT_TIMESTAMP),
          (${`gap_3_${fixture.runtimeAttemptId!}`}, ${fixture.runtimeAttemptId!}, ${fixture.runId},
           ${fixture.externalRunId}, 'gap-event-3', 3, 'synthetic.noop',
           ${JSON.stringify(payload)}::JSONB, ${sha256Canonical(payload)}, 'processed', CURRENT_TIMESTAMP)
      `);
      await db.$executeRawUnsafe(
        'ALTER TABLE "runtime_external_events" ENABLE TRIGGER "runtime_external_event_guard"',
      );
      guardDisabled = false;

      await expect(operator.processBatch({
        candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
        mode: "apply",
        batchSize: 10,
      })).rejects.toThrow(/RUNTIME_PROVIDER_STATE_BACKFILL_SEQUENCE_GAP/u);
      await expect(db.runtimeProviderState.count({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toBe(0);
    } finally {
      if (guardDisabled) {
        await db.$executeRawUnsafe(
          'ALTER TABLE "runtime_external_events" ENABLE TRIGGER "runtime_external_event_guard"',
        );
      }
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

function initialProviderState(fixture: AttemptFixture) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  return {
    runtimeAttemptId: fixture.runtimeAttemptId,
    runId: fixture.runId,
    projectionVersion: 2,
    lastAppliedSequence: 0,
    lastExternalEventId: null,
    rawAssistantText: "",
    visibleAssistantText: "",
    redactionBuffer: "",
    finalizationExternalEventId: null,
    finalizationPayloadSha256: null,
    stateSha256: "a".repeat(64),
  };
}

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

async function seedProcessedExternalEvents(
  db: PrismaClient,
  fixture: AttemptFixture,
  inputs: ReturnType<typeof externalEvent>[],
  firstSequence: number,
) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  const finalSequence = firstSequence + inputs.length - 1;
  await db.runtimeAttempt.update({
    where: { id: fixture.runtimeAttemptId },
    data: { externalEventSequence: finalSequence },
  });
  for (const [offset, input] of inputs.entries()) {
    await db.runtimeExternalEvent.create({
      data: {
        runtimeAttemptId: fixture.runtimeAttemptId,
        runId: fixture.runId,
        externalRunId: fixture.externalRunId,
        externalEventId: input.externalEventId,
        sequence: firstSequence + offset,
        event: input.event,
        payload: input.payload,
        payloadSha256: sha256Canonical(input.payload),
      },
    });
    await db.runtimeExternalEvent.update({
      where: {
        runtimeAttemptId_externalEventId: {
          runtimeAttemptId: fixture.runtimeAttemptId,
          externalEventId: input.externalEventId,
        },
      },
      data: { status: "processed", processedAt: new Date() },
    });
  }
}

async function seedRepresentativeProcessedEvents(
  db: PrismaClient,
  fixture: AttemptFixture,
  eventCount: number,
) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  if (eventCount < 6) throw new Error("RUNTIME_ATTEMPT_REPRESENTATIVE_EVENT_COUNT_INVALID");
  const noopPayload = { synthetic: true };
  const deltaPayload = { type: "ai", content: "alpha " };
  const cumulativePayload = {
    messages: [{ type: "ai", content: "alpha beta" }],
  };
  const tuplePayload = [{ type: "ai", content: " gamma" }, { synthetic: true }];
  const visibleText = "alpha beta gamma";
  const finalization = createRuntimeFinalizationPayload({
    messagesSha256: "a".repeat(64),
    outcomeSha256: "b".repeat(64),
    effects: [{
      type: "phase",
      phase: "validating",
      label: "Synthetic validation",
      progress: 1,
    }],
    visibleAssistantText: visibleText,
    providerTextCheckpoint: createRuntimeProviderTextCheckpoint(
      projectIncompleteVisibleAssistantText(visibleText),
      visibleText,
    ),
  });
  await db.runtimeAttempt.update({
    where: { id: fixture.runtimeAttemptId },
    data: {
      externalEventSequence: eventCount,
      lastExternalEventId: `synthetic-${eventCount}`,
    },
  });
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "runtime_external_events" (
      "id", "runtime_attempt_id", "run_id", "external_run_id",
      "external_event_id", "sequence", "event", "payload", "payload_sha256"
    )
    SELECT
      ${`projection_${fixture.runtimeAttemptId}_`} || series::TEXT,
      ${fixture.runtimeAttemptId},
      ${fixture.runId},
      ${fixture.externalRunId},
      'synthetic-' || series::TEXT,
      series,
      CASE
        WHEN series = 1 THEN 'messages'
        WHEN series = 3 THEN 'values'
        WHEN series = 4 THEN 'messages-tuple'
        WHEN series = ${eventCount} THEN 'workbench.runtime.finalization.v2'
        ELSE 'synthetic.noop'
      END,
      CASE
        WHEN series = 1 THEN ${JSON.stringify(deltaPayload)}::JSONB
        WHEN series = 3 THEN ${JSON.stringify(cumulativePayload)}::JSONB
        WHEN series = 4 THEN ${JSON.stringify(tuplePayload)}::JSONB
        WHEN series = ${eventCount} THEN ${JSON.stringify(finalization)}::JSONB
        ELSE ${JSON.stringify(noopPayload)}::JSONB
      END,
      CASE
        WHEN series = 1 THEN ${sha256Canonical(deltaPayload)}
        WHEN series = 3 THEN ${sha256Canonical(cumulativePayload)}
        WHEN series = 4 THEN ${sha256Canonical(tuplePayload)}
        WHEN series = ${eventCount} THEN ${sha256Canonical(finalization)}
        ELSE ${sha256Canonical(noopPayload)}
      END
    FROM generate_series(1, ${eventCount}) AS series
  `);
  await db.$executeRaw(Prisma.sql`
    UPDATE "runtime_external_events"
    SET "status" = 'processed', "processed_at" = CURRENT_TIMESTAMP
    WHERE "runtime_attempt_id" = ${fixture.runtimeAttemptId}
  `);
  await db.runDraft.upsert({
    where: { runId: fixture.runId },
    create: {
      runId: fixture.runId,
      content: { entryId: "synthetic-entry", text: visibleText },
    },
    update: {
      version: { increment: 1 },
      content: { entryId: "synthetic-entry", text: visibleText },
    },
  });
  return {
    visibleText,
    finalizationExternalEventId: `synthetic-${eventCount}`,
    finalizationPayloadSha256: sha256Canonical(finalization),
  };
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
  const [attempt, run, providerState, inbox, events] = await Promise.all([
    db.runtimeAttempt.findUniqueOrThrow({
      where: { id: fixture.runtimeAttemptId },
      select: { lastExternalEventId: true, externalEventSequence: true },
    }),
    db.run.findUniqueOrThrow({
      where: { id: fixture.runId },
      select: { eventSequence: true },
    }),
    db.runtimeProviderState.findUniqueOrThrow({
      where: { runtimeAttemptId: fixture.runtimeAttemptId },
      select: {
        lastAppliedSequence: true,
        lastExternalEventId: true,
        finalizationExternalEventId: true,
      },
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
    providerState,
    runEventSequence: run.eventSequence,
    inbox,
    events,
  };
}

function emptyDurableEventState() {
  return {
    attempt: { lastExternalEventId: null, externalEventSequence: 0 },
    providerState: {
      lastAppliedSequence: 0,
      lastExternalEventId: null,
      finalizationExternalEventId: null,
    },
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
    providerState: {
      lastAppliedSequence: inputs.length,
      lastExternalEventId: inputs.at(-1)?.externalEventId ?? null,
      finalizationExternalEventId: null,
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
