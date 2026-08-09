import { createHash, randomUUID } from "node:crypto";
import {
  PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES,
  assertPrototypePatchPayloadSize,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { RunEventStore } from "../src/runs/run-event.store.js";
import { runtimeProviderCancellationUnconfirmedCode } from "../src/runs/runtime-cancellation-state.js";
import {
  createRuntimeFinalizationPayload,
  createRuntimeProviderProjection,
  createRuntimeProviderTextCheckpoint,
  projectIncompleteVisibleAssistantText,
  sha256Canonical,
} from "../src/runtime/runtime-assistant-text.js";
import {
  RuntimeAttemptService,
  type RuntimeExecutionClaim,
} from "../src/runtime/runtime-attempt.service.js";
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

describeWithPostgres("RuntimeAttempt PostgreSQL cleanup lock order", () => {
  it("serializes late attachment and cancellation claim without a Run-Attempt deadlock", async () => {
    const monitor = new PrismaClient({ datasourceUrl: databaseUrl! });
    const blocker = new PrismaClient({ datasourceUrl: databaseUrl! });
    const lateWriter = new PrismaClient({ datasourceUrl: databaseUrl! });
    const claimant = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(monitor, true);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const blockerApplicationName = `attempt-blocker-${suffix}`;
    const attachApplicationName = `attempt-attach-${suffix}`;
    const claimApplicationName = `attempt-claim-${suffix}`;
    const failedAt = new Date();
    const providerIdempotencyKey = `wbrt:${createHash("sha256")
      .update(fixture.runtimeAttemptId!)
      .digest("hex")}`;
    const blockerLocked = deferred<void>();
    const releaseBlocker = deferred<void>();
    const attachService = new RuntimeAttemptService(
      databaseWithApplicationName(lateWriter, attachApplicationName) as never,
      120_000,
    );
    const claimService = new RuntimeAttemptService(
      databaseWithApplicationName(claimant, claimApplicationName) as never,
      120_000,
    );
    let blockerTransaction: Promise<unknown> | null = null;
    let attachOperation:
      | ReturnType<RuntimeAttemptService["attachExternalRunForCleanup"]>
      | null = null;
    let claimOperation:
      | ReturnType<RuntimeAttemptService["claimProviderCancellation"]>
      | null = null;
    let cancellationClaim: RuntimeExecutionClaim | null = null;

    try {
      await monitor.run.update({
        where: { id: fixture.runId },
        data: {
          status: "failed",
          finishedAt: failedAt,
          errorCode: runtimeProviderCancellationUnconfirmedCode,
          errorDetail: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
          errorRetryable: true,
        },
      });
      await monitor.runtimeAttempt.update({
        where: { id: fixture.runtimeAttemptId! },
        data: {
          status: "failed",
          startedAt: failedAt,
          finishedAt: failedAt,
          errorCode: runtimeProviderCancellationUnconfirmedCode,
          errorDetail: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
          errorRetryable: true,
          submissionUnknownAt: failedAt,
          providerIdempotencyKey,
          providerCancellationOperationEpoch: 1,
          providerCancellationOperationStartedAt: failedAt,
          providerCancellationOperationDeadlineAt: new Date(failedAt.getTime() + 50),
        },
      });
      const operationState = await monitor.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
        select: { providerCancellationOperationDeadlineAt: true },
      });
      if (!operationState.providerCancellationOperationDeadlineAt) {
        throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      }
      await waitUntilAfterDatabaseTime(
        monitor,
        operationState.providerCancellationOperationDeadlineAt,
      );

      blockerTransaction = blocker.$transaction(async (tx) => {
        await setTransactionApplicationName(tx, blockerApplicationName);
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "runtime_attempts"
          WHERE "id" = ${fixture.runtimeAttemptId!}
          FOR UPDATE
        `);
        blockerLocked.resolve();
        await releaseBlocker.promise;
      }, { maxWait: 10_000, timeout: 30_000 });
      await blockerLocked.promise;

      attachOperation = attachService.attachExternalRunForCleanup(
        fixture.runtimeAttemptId!,
        1,
        fixture.externalRunId,
      );
      await waitForPostgresLockWait(monitor, attachApplicationName);

      claimOperation = claimService.claimProviderCancellation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        `runtime-cleanup:${suffix}`,
        120_000,
      );
      await waitForPostgresLockWait(monitor, claimApplicationName);

      releaseBlocker.resolve();
      await blockerTransaction;
      const [attachResult, claimResult] = await Promise.allSettled([
        attachOperation,
        claimOperation,
      ]);
      if (attachResult.status === "rejected") throw attachResult.reason;
      if (claimResult.status === "rejected") throw claimResult.reason;
      expect([attachResult.status, claimResult.status]).toEqual(["fulfilled", "fulfilled"]);
      if (claimResult.value.disposition !== "claimed") {
        throw new Error("RUNTIME_PROVIDER_CANCELLATION_CLAIM_MISSING");
      }
      cancellationClaim = claimResult.value.claim;

      expect(attachResult.value).toMatchObject({
        externalRunId: fixture.externalRunId,
        operationCurrent: false,
      });
      expect(cancellationClaim).toMatchObject({
        runId: fixture.runId,
        attemptId: fixture.runtimeAttemptId,
        ownerId: `runtime-cleanup:${suffix}`,
      });
      const claimedRows = await Promise.all([
        monitor.run.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { executionOwnerId: true, executionEpoch: true },
        }),
        monitor.runtimeAttempt.findUniqueOrThrow({
          where: { id: fixture.runtimeAttemptId! },
          select: {
            externalRunId: true,
            executionOwnerId: true,
            executionEpoch: true,
          },
        }),
      ]);
      expect(claimedRows).toEqual([
        {
          executionOwnerId: cancellationClaim.ownerId,
          executionEpoch: cancellationClaim.epoch,
        },
        {
          externalRunId: fixture.externalRunId,
          executionOwnerId: cancellationClaim.ownerId,
          executionEpoch: cancellationClaim.epoch,
        },
      ]);
      await expect(monitor.runtimeProviderCancellationResolution.count({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toBe(0);

      await claimService.releaseProviderCancellation(cancellationClaim);
      cancellationClaim = null;
      await expect(Promise.all([
        monitor.run.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: {
            executionOwnerId: true,
            executionHeartbeatAt: true,
            executionLeaseExpiresAt: true,
          },
        }),
        monitor.runtimeAttempt.findUniqueOrThrow({
          where: { id: fixture.runtimeAttemptId! },
          select: {
            executionOwnerId: true,
            executionHeartbeatAt: true,
            executionLeaseExpiresAt: true,
          },
        }),
      ])).resolves.toEqual([
        {
          executionOwnerId: null,
          executionHeartbeatAt: null,
          executionLeaseExpiresAt: null,
        },
        {
          executionOwnerId: null,
          executionHeartbeatAt: null,
          executionLeaseExpiresAt: null,
        },
      ]);
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled([
        ...(blockerTransaction ? [blockerTransaction] : []),
        ...(attachOperation ? [attachOperation] : []),
        ...(claimOperation ? [claimOperation] : []),
      ]);
      if (cancellationClaim) {
        await claimService.releaseProviderCancellation(cancellationClaim).catch(() => undefined);
      }
      await cleanupFixture(monitor, fixture);
      await Promise.all([
        monitor.$disconnect(),
        blocker.$disconnect(),
        lateWriter.$disconnect(),
        claimant.$disconnect(),
      ]);
    }
  }, 120_000);
});

describeWithPostgres("RuntimeAttempt PostgreSQL provider cancellation operations", () => {
  it.each(["attach", "finish", "settle"] as const)(
    "fences %s authority when the Attempt lock wait crosses the operation deadline",
    async (action) => {
      const monitor = new PrismaClient({ datasourceUrl: databaseUrl! });
      const blocker = new PrismaClient({ datasourceUrl: databaseUrl! });
      const worker = new PrismaClient({ datasourceUrl: databaseUrl! });
      const fixture = await seedAttemptFixture(monitor, true);
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const applicationName = `cancel-${action}-${suffix}`;
      const blockerLocked = deferred<void>();
      const releaseBlocker = deferred<void>();
      const setupService = new RuntimeAttemptService(monitor, 120_000);
      const service = new RuntimeAttemptService(
        databaseWithApplicationName(worker, applicationName) as never,
        120_000,
      );
      let blockerTransaction: Promise<unknown> | null = null;
      let pendingOperation: Promise<unknown> | null = null;

      try {
        await monitor.runtimeAttempt.update({
          where: { id: fixture.runtimeAttemptId! },
          data: { providerIdempotencyKey: providerIdempotencyKeyForAttempt(fixture.runtimeAttemptId!) },
        });
        await cancelActiveRun(monitor, fixture.runId);
        const operation = await setupService.startProviderCancellationOperation(
          fixture.runId,
          fixture.runtimeAttemptId!,
          2_000,
        );
        if (!operation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");

        blockerTransaction = blocker.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id"
            FROM "runtime_attempts"
            WHERE "id" = ${fixture.runtimeAttemptId!}
            FOR UPDATE
          `);
          blockerLocked.resolve();
          await releaseBlocker.promise;
        }, { maxWait: 10_000, timeout: 30_000 });
        await blockerLocked.promise;

        if (action === "attach") {
          pendingOperation = service.attachExternalRunForCleanup(
            fixture.runtimeAttemptId!,
            operation.epoch,
            fixture.externalRunId,
          );
        } else if (action === "finish") {
          pendingOperation = service.finishProviderCancellationOperation(operation);
        } else {
          pendingOperation = service.settleProviderCancellationOperation(operation, {
            outcome: "external_run_absent",
            externalRunId: null,
          });
        }
        await waitForPostgresLockWait(monitor, applicationName);
        await waitUntilAfterDatabaseTime(monitor, operation.deadlineAt);
        releaseBlocker.resolve();
        await blockerTransaction;

        const result = await pendingOperation;
        if (action === "attach") {
          expect(result).toEqual({
            externalRunId: fixture.externalRunId,
            operationCurrent: false,
          });
        } else if (action === "finish") {
          expect(result).toBe(false);
        } else {
          expect(result).toBe("fenced");
        }

        await expect(monitor.runtimeAttempt.findUniqueOrThrow({
          where: { id: fixture.runtimeAttemptId! },
          select: {
            externalRunId: true,
            providerCancellationOperationEpoch: true,
            providerCancellationOperationStartedAt: true,
            providerCancellationOperationDeadlineAt: true,
          },
        })).resolves.toMatchObject({
          externalRunId: action === "attach" ? fixture.externalRunId : null,
          providerCancellationOperationEpoch: operation.epoch,
          providerCancellationOperationStartedAt: expect.any(Date),
          providerCancellationOperationDeadlineAt: expect.any(Date),
        });
        await expect(monitor.runtimeProviderCancellationResolution.count({
          where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        })).resolves.toBe(0);
      } finally {
        releaseBlocker.resolve();
        await Promise.allSettled([
          ...(blockerTransaction ? [blockerTransaction] : []),
          ...(pendingOperation ? [pendingOperation] : []),
        ]);
        await cleanupFixture(monitor, fixture);
        await Promise.all([monitor.$disconnect(), blocker.$disconnect(), worker.$disconnect()]);
      }
    },
    120_000,
  );

  it("rejects takeover before the database deadline and advances exactly one epoch after it", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const service = new RuntimeAttemptService(db, 120_000);

    try {
      await cancelActiveRun(db, fixture.runId);
      const first = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        1_500,
      );
      if (!first) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");

      await expect(service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        1_500,
      )).resolves.toBeNull();
      await expect(db.$executeRaw(Prisma.sql`
        UPDATE "runtime_attempts"
        SET
          "provider_cancellation_operation_epoch" = ${first.epoch + 1},
          "provider_cancellation_operation_started_at" = clock_timestamp(),
          "provider_cancellation_operation_deadline_at" = clock_timestamp() + INTERVAL '1 second'
        WHERE "id" = ${fixture.runtimeAttemptId!}
      `)).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_OPERATION_TAKEOVER_INVALID/u);

      await waitUntilAfterDatabaseTime(db, first.deadlineAt);
      const second = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        2_000,
      );
      expect(second).toMatchObject({
        runId: fixture.runId,
        attemptId: fixture.runtimeAttemptId,
        epoch: first.epoch + 1,
      });
      expect(second!.deadlineAt.getTime()).toBeGreaterThan(first.deadlineAt.getTime());
      await expect(db.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
        select: { providerCancellationOperationEpoch: true },
      })).resolves.toEqual({ providerCancellationOperationEpoch: first.epoch + 1 });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("persists stale positive provider identity after finish without granting resolution authority", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const service = new RuntimeAttemptService(db, 120_000);

    try {
      await terminalizeProviderCancellationUnconfirmed(db, fixture);
      const claim = await claimProviderCancellation(service, fixture);
      const staleOperation = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        150,
        claim,
      );
      if (!staleOperation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      await waitUntilAfterDatabaseTime(db, staleOperation.deadlineAt);
      const currentOperation = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
        claim,
      );
      if (!currentOperation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      expect(currentOperation.epoch).toBe(staleOperation.epoch + 1);
      await expect(service.finishProviderCancellationOperation(currentOperation)).resolves.toBe(true);

      await expect(service.attachExternalRunForCleanup(
        fixture.runtimeAttemptId!,
        staleOperation.epoch,
        fixture.externalRunId,
      )).resolves.toEqual({
        externalRunId: fixture.externalRunId,
        operationCurrent: false,
      });
      await expect(service.settleProviderCancellationOperation(staleOperation, {
        outcome: "cancelled",
        externalRunId: fixture.externalRunId,
      })).resolves.toBe("fenced");
      await expect(db.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
      })).resolves.toMatchObject({
        externalRunId: fixture.externalRunId,
        providerCancellationOperationEpoch: currentOperation.epoch,
        providerCancellationOperationStartedAt: null,
        providerCancellationOperationDeadlineAt: null,
      });
      await expect(db.runtimeProviderCancellationResolution.count({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toBe(0);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rejects raw INSERT and UPDATE attempts to forge an active operation", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const forgedAttemptId = `forged_${randomUUID().replaceAll("-", "")}`;

    try {
      await expect(db.$executeRaw(Prisma.sql`
        INSERT INTO "runtime_attempts" (
          "id", "run_id", "runtime_binding_id", "attempt", "adapter", "external_thread_id",
          "provider_cancellation_operation_epoch",
          "provider_cancellation_operation_started_at",
          "provider_cancellation_operation_deadline_at"
        ) VALUES (
          ${forgedAttemptId}, ${fixture.runId}, ${fixture.binding.id}, 2,
          ${fixture.binding.adapter}, ${fixture.binding.externalThreadId},
          1, clock_timestamp(), clock_timestamp() + INTERVAL '30 seconds'
        )
      `)).rejects.toThrow(
        /RUNTIME_(?:ATTEMPT_MUST_START_PENDING|PROVIDER_CANCELLATION_OPERATION_MUST_START_EMPTY)/u,
      );
      await expect(db.$executeRaw(Prisma.sql`
        UPDATE "runtime_attempts"
        SET
          "provider_cancellation_operation_epoch" = 1,
          "provider_cancellation_operation_started_at" = clock_timestamp(),
          "provider_cancellation_operation_deadline_at" = clock_timestamp() + INTERVAL '30 seconds'
        WHERE "id" = ${fixture.runtimeAttemptId!}
      `)).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_OPERATION_SCOPE_INVALID/u);

      await expect(db.runtimeAttempt.findMany({
        where: { id: { in: [fixture.runtimeAttemptId!, forgedAttemptId] } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          providerCancellationOperationEpoch: true,
          providerCancellationOperationStartedAt: true,
          providerCancellationOperationDeadlineAt: true,
        },
      })).resolves.toEqual([{
        id: fixture.runtimeAttemptId!,
        providerCancellationOperationEpoch: 0,
        providerCancellationOperationStartedAt: null,
        providerCancellationOperationDeadlineAt: null,
      }]);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rejects resolutions outside the exact active operation scope", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const service = new RuntimeAttemptService(db, 120_000);

    try {
      await terminalizeProviderCancellationUnconfirmed(db, fixture);
      const claim = await claimProviderCancellation(service, fixture);
      const first = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
        claim,
      );
      if (!first) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      await service.attachExternalRunForCleanup(
        fixture.runtimeAttemptId!,
        first.epoch,
        fixture.externalRunId,
      );

      await expect(insertProviderCancellationResolution(db, fixture, {
        operationEpoch: first.epoch + 1,
      })).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_EPOCH_INVALID/u);
      await expect(insertProviderCancellationResolution(db, fixture, {
        runId: `wrong_${fixture.runId}`,
        operationEpoch: first.epoch,
      })).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_SCOPE_INVALID/u);
      await expect(insertProviderCancellationResolution(db, fixture, {
        operationEpoch: first.epoch,
        externalRunId: `wrong_${fixture.externalRunId}`,
      })).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_EXTERNAL_RUN_INVALID/u);

      await expect(service.finishProviderCancellationOperation(first)).resolves.toBe(true);
      await expect(insertProviderCancellationResolution(db, fixture, {
        operationEpoch: first.epoch,
      })).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_OPERATION_NOT_ACTIVE/u);

      const second = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        150,
        claim,
      );
      if (!second) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      await waitUntilAfterDatabaseTime(db, second.deadlineAt);
      await expect(insertProviderCancellationResolution(db, fixture, {
        operationEpoch: second.epoch,
      })).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_OPERATION_NOT_ACTIVE/u);
      await expect(db.runtimeProviderCancellationResolution.count({
        where: { runtimeAttemptId: fixture.runtimeAttemptId! },
      })).resolves.toBe(0);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("rolls back settlement after resolution insertion and freezes the epoch after commit", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const service = new RuntimeAttemptService(db, 120_000);
    const crashingService = new RuntimeAttemptService(
      databaseWithProviderCancellationResolutionCrash(db) as never,
      120_000,
    );

    try {
      await terminalizeProviderCancellationUnconfirmed(db, fixture);
      const claim = await claimProviderCancellation(service, fixture);
      const operation = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
        claim,
      );
      if (!operation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");

      await expect(crashingService.settleProviderCancellationOperation(operation, {
        outcome: "cancelled",
        externalRunId: fixture.externalRunId,
      })).rejects.toThrow("SIMULATED_CRASH_AFTER_CANCELLATION_RESOLUTION_INSERT");
      await expect(Promise.all([
        db.runtimeAttempt.findUniqueOrThrow({
          where: { id: fixture.runtimeAttemptId! },
          select: {
            externalRunId: true,
            providerCancellationOperationEpoch: true,
            providerCancellationOperationStartedAt: true,
            providerCancellationOperationDeadlineAt: true,
          },
        }),
        db.runtimeProviderCancellationResolution.count({
          where: { runtimeAttemptId: fixture.runtimeAttemptId! },
        }),
      ])).resolves.toEqual([
        {
          externalRunId: null,
          providerCancellationOperationEpoch: operation.epoch,
          providerCancellationOperationStartedAt: expect.any(Date),
          providerCancellationOperationDeadlineAt: expect.any(Date),
        },
        0,
      ]);

      await expect(service.settleProviderCancellationOperation(operation, {
        outcome: "cancelled",
        externalRunId: fixture.externalRunId,
      })).resolves.toBe("resolved");
      await expect(service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
        claim,
      )).resolves.toBeNull();
      await expect(db.$executeRaw(Prisma.sql`
        UPDATE "runtime_attempts"
        SET
          "provider_cancellation_operation_epoch" = ${operation.epoch + 1},
          "provider_cancellation_operation_started_at" = clock_timestamp(),
          "provider_cancellation_operation_deadline_at" = clock_timestamp() + INTERVAL '30 seconds'
        WHERE "id" = ${fixture.runtimeAttemptId!}
      `)).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_OPERATION_RESOLVED/u);
      await expect(db.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
        select: {
          providerCancellationOperationEpoch: true,
          providerCancellationOperationStartedAt: true,
          providerCancellationOperationDeadlineAt: true,
        },
      })).resolves.toEqual({
        providerCancellationOperationEpoch: operation.epoch,
        providerCancellationOperationStartedAt: null,
        providerCancellationOperationDeadlineAt: null,
      });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("observes a resolution committed while waiting for the cancellation scope locks", async () => {
    const settlerDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const claimantDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(settlerDb, true);
    const resolutionInserted = deferred<void>();
    const releaseSettlement = deferred<void>();
    const applicationName = `cancel-resolution-wait-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const setupService = new RuntimeAttemptService(settlerDb, 120_000);
    const settlingService = new RuntimeAttemptService(
      databaseWithProviderCancellationResolutionBarrier(
        settlerDb,
        resolutionInserted,
        releaseSettlement,
      ) as never,
      120_000,
    );
    const claimantService = new RuntimeAttemptService(
      databaseWithApplicationName(claimantDb, applicationName) as never,
      120_000,
    );
    let settlement: ReturnType<
      RuntimeAttemptService["settleProviderCancellationOperation"]
    > | null = null;
    let claim: ReturnType<RuntimeAttemptService["claimProviderCancellation"]> | null = null;

    try {
      await terminalizeProviderCancellationUnconfirmed(settlerDb, fixture);
      const cancellationClaim = await claimProviderCancellation(setupService, fixture);
      const operation = await setupService.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
        cancellationClaim,
      );
      if (!operation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");

      settlement = settlingService.settleProviderCancellationOperation(operation, {
        outcome: "cancelled",
        externalRunId: fixture.externalRunId,
      });
      await resolutionInserted.promise;
      claim = claimantService.claimProviderCancellation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        `runtime-cleanup:${randomUUID()}`,
        120_000,
      );
      await waitForPostgresLockWait(settlerDb, applicationName);

      releaseSettlement.resolve();
      await expect(settlement).resolves.toBe("resolved");
      await expect(claim).resolves.toEqual({ disposition: "resolved" });
    } finally {
      releaseSettlement.resolve();
      await Promise.allSettled([
        ...(settlement ? [settlement] : []),
        ...(claim ? [claim] : []),
      ]);
      await cleanupFixture(settlerDb, fixture);
      await Promise.all([settlerDb.$disconnect(), claimantDb.$disconnect()]);
    }
  }, 120_000);

  it("rejects nullable failure codes at operation and resolution boundaries", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const operationFixture = await seedAttemptFixture(db, true);
    const resolutionFixture = await seedAttemptFixture(db, true);
    const service = new RuntimeAttemptService(db, 120_000);

    try {
      const failedAt = new Date();
      await db.run.update({
        where: { id: operationFixture.runId },
        data: { status: "failed", finishedAt: failedAt, errorCode: null },
      });
      await db.runtimeAttempt.update({
        where: { id: operationFixture.runtimeAttemptId! },
        data: {
          status: "failed",
          startedAt: failedAt,
          finishedAt: failedAt,
          errorCode: null,
        },
      });
      await expect(db.$executeRaw(Prisma.sql`
        UPDATE "runtime_attempts"
        SET
          "provider_cancellation_operation_epoch" = 1,
          "provider_cancellation_operation_started_at" = clock_timestamp(),
          "provider_cancellation_operation_deadline_at" = clock_timestamp() + INTERVAL '30 seconds'
        WHERE "id" = ${operationFixture.runtimeAttemptId!}
      `)).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_OPERATION_SCOPE_INVALID/u);

      await db.runtimeAttempt.update({
        where: { id: resolutionFixture.runtimeAttemptId! },
        data: {
          providerIdempotencyKey: providerIdempotencyKeyForAttempt(
            resolutionFixture.runtimeAttemptId!,
          ),
        },
      });
      await cancelActiveRun(db, resolutionFixture.runId);
      const operation = await service.startProviderCancellationOperation(
        resolutionFixture.runId,
        resolutionFixture.runtimeAttemptId!,
        30_000,
      );
      if (!operation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      await service.attachExternalRunForCleanup(
        resolutionFixture.runtimeAttemptId!,
        operation.epoch,
        resolutionFixture.externalRunId,
      );
      await db.runtimeAttempt.update({
        where: { id: resolutionFixture.runtimeAttemptId! },
        data: {
          status: "failed",
          startedAt: failedAt,
          finishedAt: failedAt,
          errorCode: null,
        },
      });
      await db.run.update({
        where: { id: resolutionFixture.runId },
        data: { status: "failed", finishedAt: failedAt, errorCode: null },
      });
      await expect(db.$transaction(async (tx) => {
        await tx.runtimeProviderCancellationResolution.create({
          data: {
            runtimeAttemptId: resolutionFixture.runtimeAttemptId!,
            runId: resolutionFixture.runId,
            operationEpoch: operation.epoch,
            externalRunId: resolutionFixture.externalRunId,
            failureCode: "RUNTIME_EXECUTION_FAILED",
            outcome: "cancelled",
          },
        });
        await tx.runtimeAttempt.update({
          where: { id: resolutionFixture.runtimeAttemptId! },
          data: {
            providerCancellationOperationStartedAt: null,
            providerCancellationOperationDeadlineAt: null,
          },
        });
      })).rejects.toThrow(/RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_STATE_INVALID/u);

      await expect(Promise.all([
        db.runtimeAttempt.findUniqueOrThrow({
          where: { id: operationFixture.runtimeAttemptId! },
          select: { providerCancellationOperationEpoch: true },
        }),
        db.runtimeProviderCancellationResolution.count({
          where: { runtimeAttemptId: resolutionFixture.runtimeAttemptId! },
        }),
      ])).resolves.toEqual([
        { providerCancellationOperationEpoch: 0 },
        0,
      ]);
    } finally {
      await Promise.all([
        cleanupFixture(db, operationFixture),
        cleanupFixture(db, resolutionFixture),
      ]);
      await db.$disconnect();
    }
  }, 120_000);

  it("blocks operations on a running Run and fences ordinary claims after cancellation starts", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const service = new RuntimeAttemptService(db, 120_000);

    try {
      await expect(service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
      )).rejects.toThrow("RUNTIME_PROVIDER_CANCELLATION_OPERATION_SCOPE_FENCED");
      await expect(db.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
        select: { providerCancellationOperationEpoch: true },
      })).resolves.toEqual({ providerCancellationOperationEpoch: 0 });

      await cancelActiveRun(db, fixture.runId);
      const operation = await service.startProviderCancellationOperation(
        fixture.runId,
        fixture.runtimeAttemptId!,
        30_000,
      );
      if (!operation) throw new Error("RUNTIME_PROVIDER_CANCELLATION_OPERATION_MISSING");
      await expect(service.finishProviderCancellationOperation(operation)).resolves.toBe(true);
      await expect(service.claim(
        fixture.runId,
        fixture.runtimeAttemptId!,
        `ordinary-worker:${randomUUID()}`,
      )).rejects.toThrow("RUNTIME_EXECUTION_PROVIDER_CANCELLATION_FENCED");
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
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

describeWithPostgres("RuntimeAttempt PostgreSQL fault and concurrency fences", () => {
  it.each([
    ["before the pending insert", "before-pending-insert", "SIMULATED_CRASH_BEFORE_PENDING_INSERT"],
    ["after the processed transition", "after-processed", "SIMULATED_CRASH_AFTER_PROCESSED_TRANSITION"],
    ["after the projection CAS", "after-projection-cas", "SIMULATED_CRASH_AFTER_PROJECTION_CAS"],
  ] as const)("rolls back every event effect %s", async (_label, faultPoint, errorMessage) => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const faultedService = new RuntimeAttemptService(
      databaseWithEventTransactionFault(db, faultPoint) as never,
      120_000,
    );
    const input = externalEvent(fixture, `event-fault-${faultPoint}`);

    try {
      await expect(processWithActivityEffect(db, faultedService, claim, fixture, input))
        .rejects.toThrow(errorMessage);

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

  it("fences an expired owner after a new owner takes over at the next epoch", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const { service: firstService, claim: firstClaim } = await activateExternalRun(db, fixture);
    const takeoverService = new RuntimeAttemptService(db, 120_000);
    const expiredHeartbeatAt = new Date(Date.now() - 120_000);
    const expiredLeaseAt = new Date(Date.now() - 60_000);
    const input = externalEvent(fixture, "event-after-lease-takeover");

    try {
      await db.$transaction([
        db.run.update({
          where: { id: fixture.runId },
          data: {
            executionHeartbeatAt: expiredHeartbeatAt,
            executionLeaseExpiresAt: expiredLeaseAt,
          },
        }),
        db.runtimeAttempt.update({
          where: { id: fixture.runtimeAttemptId! },
          data: {
            executionHeartbeatAt: expiredHeartbeatAt,
            executionLeaseExpiresAt: expiredLeaseAt,
          },
        }),
      ]);

      const takeoverClaim = await takeoverService.claim(
        fixture.runId,
        fixture.runtimeAttemptId!,
        `runtime-takeover-pg:${randomUUID()}`,
      );
      expect(takeoverClaim).toMatchObject({
        runId: firstClaim.runId,
        attemptId: firstClaim.attemptId,
        epoch: firstClaim.epoch + 1,
      });
      expect(takeoverClaim.ownerId).not.toBe(firstClaim.ownerId);

      await expect(firstService.heartbeat(firstClaim)).rejects.toThrow("RUNTIME_EXECUTION_FENCED");
      await expect(processWithActivityEffect(db, firstService, firstClaim, fixture, input))
        .rejects.toThrow("RUNTIME_EXECUTION_FENCED");
      await expect(durableEventState(db, fixture)).resolves.toEqual(emptyDurableEventState());
      await expect(takeoverService.claim(
        fixture.runId,
        fixture.runtimeAttemptId!,
        `runtime-third-owner-pg:${randomUUID()}`,
      )).rejects.toThrow("RUNTIME_EXECUTION_CLAIM_BUSY");

      await expect(processWithActivityEffect(db, takeoverService, takeoverClaim, fixture, input))
        .resolves.toEqual({ created: true, sequence: 1 });
      await expect(durableEventState(db, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
      await expect(Promise.all([
        db.run.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { executionOwnerId: true, executionEpoch: true },
        }),
        db.runtimeAttempt.findUniqueOrThrow({
          where: { id: fixture.runtimeAttemptId! },
          select: { executionOwnerId: true, executionEpoch: true },
        }),
      ])).resolves.toEqual([
        { executionOwnerId: takeoverClaim.ownerId, executionEpoch: takeoverClaim.epoch },
        { executionOwnerId: takeoverClaim.ownerId, executionEpoch: takeoverClaim.epoch },
      ]);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("deduplicates the same event concurrently across two database connections", async () => {
    const firstDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const secondDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(firstDb, true);
    const { claim } = await activateExternalRun(firstDb, fixture);
    const firstLockAcquired = deferred<void>();
    const secondLockRequested = deferred<void>();
    const releaseFirstLock = deferred<void>();
    const firstService = new RuntimeAttemptService(
      databaseWithLockScopeBarrier(firstDb, {
        afterLockAcquired: firstLockAcquired,
        releaseLock: releaseFirstLock,
      }) as never,
      120_000,
    );
    const secondService = new RuntimeAttemptService(
      databaseWithLockScopeBarrier(secondDb, {
        beforeLockRequest: secondLockRequested,
      }) as never,
      120_000,
    );
    const input = externalEvent(fixture, "event-concurrent-same-identity");
    const firstEffects = vi.fn(async (tx: Prisma.TransactionClient) => {
      await appendActivityEffect(new RunEventStore(firstDb), tx, fixture, input.externalEventId);
    });
    const secondEffects = vi.fn(async (tx: Prisma.TransactionClient) => {
      await appendActivityEffect(new RunEventStore(secondDb), tx, fixture, input.externalEventId);
    });
    const firstOutcome = firstService.processExternalEvent(claim, input, firstEffects);
    let secondOutcome: Promise<{ created: boolean; sequence: number }> | undefined;

    try {
      await firstLockAcquired.promise;
      secondOutcome = secondService.processExternalEvent(claim, input, secondEffects);
      await secondLockRequested.promise;
      await expect(promiseStateAfter(secondOutcome, 100)).resolves.toBe("pending");

      releaseFirstLock.resolve();
      const results = await Promise.all([firstOutcome, secondOutcome]);

      expect(results.map((result) => result.sequence)).toEqual([1, 1]);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(firstEffects.mock.calls.length + secondEffects.mock.calls.length).toBe(1);
      await expect(durableEventState(firstDb, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, [input]));
    } finally {
      releaseFirstLock.resolve();
      await Promise.allSettled([
        firstOutcome,
        ...(secondOutcome ? [secondOutcome] : []),
      ]);
      await cleanupFixture(firstDb, fixture);
      await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
    }
  }, 120_000);

  it("serializes adjacent events into contiguous sequences across two database connections", async () => {
    const firstDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const secondDb = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(firstDb, true);
    const { claim } = await activateExternalRun(firstDb, fixture);
    const firstLockAcquired = deferred<void>();
    const secondLockRequested = deferred<void>();
    const releaseFirstLock = deferred<void>();
    const firstService = new RuntimeAttemptService(
      databaseWithLockScopeBarrier(firstDb, {
        afterLockAcquired: firstLockAcquired,
        releaseLock: releaseFirstLock,
      }) as never,
      120_000,
    );
    const secondService = new RuntimeAttemptService(
      databaseWithLockScopeBarrier(secondDb, {
        beforeLockRequest: secondLockRequested,
      }) as never,
      120_000,
    );
    const firstInput = externalEvent(fixture, "event-concurrent-adjacent-a");
    const secondInput = externalEvent(fixture, "event-concurrent-adjacent-b");
    const firstOutcome = processWithActivityEffect(
      firstDb,
      firstService,
      claim,
      fixture,
      firstInput,
    );
    let secondOutcome: Promise<{ created: boolean; sequence: number }> | undefined;

    try {
      await firstLockAcquired.promise;
      secondOutcome = processWithActivityEffect(
        secondDb,
        secondService,
        claim,
        fixture,
        secondInput,
      );
      await secondLockRequested.promise;
      await expect(promiseStateAfter(secondOutcome, 100)).resolves.toBe("pending");

      releaseFirstLock.resolve();
      const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome]);
      const applied = [
        { input: firstInput, result: firstResult },
        { input: secondInput, result: secondResult },
      ].sort((left, right) => left.result.sequence - right.result.sequence);

      expect(applied.map(({ result }) => result)).toEqual([
        { created: true, sequence: 1 },
        { created: true, sequence: 2 },
      ]);
      await expect(durableEventState(firstDb, fixture))
        .resolves.toEqual(expectedDurableEventState(fixture, applied.map(({ input }) => input)));
    } finally {
      releaseFirstLock.resolve();
      await Promise.allSettled([
        firstOutcome,
        ...(secondOutcome ? [secondOutcome] : []),
      ]);
      await cleanupFixture(firstDb, fixture);
      await Promise.all([firstDb.$disconnect(), secondDb.$disconnect()]);
    }
  }, 120_000);

  it("processes one current event at the typed patch payload budget without a historical payload scan", async () => {
    const queries: string[] = [];
    const db = new PrismaClient({
      datasourceUrl: databaseUrl!,
      log: [{ emit: "event", level: "query" }],
    });
    db.$on("query", (event) => queries.push(event.query));
    const fixture = await seedAttemptFixture(db, true);
    const { service, claim } = await activateExternalRun(db, fixture);
    const first = externalEvent(fixture, "event-before-large-payload");
    const payloadOverhead = Buffer.byteLength(JSON.stringify({ syntheticText: "" }), "utf8");
    const payload = {
      syntheticText: "x".repeat(PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES - payloadOverhead),
    };
    const current = {
      externalRunId: fixture.externalRunId,
      externalEventId: "event-typed-patch-payload-budget",
      event: "synthetic.patch-payload",
      payload,
    } as const;

    try {
      expect(assertPrototypePatchPayloadSize(payload)).toBe(PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES);
      await service.processExternalEvent(claim, first, async () => undefined);

      queries.length = 0;
      await expect(service.processExternalEvent(claim, current, async () => undefined))
        .resolves.toEqual({ created: true, sequence: 2 });
      const transactionQueries = [...queries];
      const inboxReads = transactionQueries.filter((query) => (
        query.trimStart().toUpperCase().startsWith("SELECT")
        && query.includes('"runtime_external_events"')
      ));
      expect(inboxReads).toHaveLength(1);
      expect(inboxReads[0]).toMatch(/"external_event_id"\s*=\s*\$\d+/iu);
      expect(inboxReads[0]).not.toMatch(/ORDER\s+BY|LIMIT\s+10001/iu);

      await expect(db.runtimeExternalEvent.findUniqueOrThrow({
        where: {
          runtimeAttemptId_externalEventId: {
            runtimeAttemptId: fixture.runtimeAttemptId!,
            externalEventId: current.externalEventId,
          },
        },
        select: { sequence: true, payload: true, payloadSha256: true, status: true },
      })).resolves.toEqual({
        sequence: 2,
        payload,
        payloadSha256: sha256Canonical(payload),
        status: "processed",
      });
      await expect(Promise.all([
        db.runtimeAttempt.findUniqueOrThrow({
          where: { id: fixture.runtimeAttemptId! },
          select: { externalEventSequence: true, lastExternalEventId: true },
        }),
        db.runtimeProviderState.findUniqueOrThrow({
          where: { runtimeAttemptId: fixture.runtimeAttemptId! },
          select: { lastAppliedSequence: true, lastExternalEventId: true },
        }),
      ])).resolves.toEqual([
        { externalEventSequence: 2, lastExternalEventId: current.externalEventId },
        { lastAppliedSequence: 2, lastExternalEventId: current.externalEventId },
      ]);
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);
});

describeWithPostgres("RuntimeProviderState PostgreSQL invariants", () => {
  it("keeps timestamps monotonic when the database wall clock moves backward", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);

    try {
      const { seeded, updated } = await db.$transaction(async (tx) => {
        await tx.runtimeProviderState.create({
          data: initialProviderState(fixture),
        });
        await tx.$executeRawUnsafe(
          'ALTER TABLE "runtime_provider_states" DISABLE TRIGGER "runtime_provider_state_guard"',
        );
        await tx.$executeRaw(Prisma.sql`
          WITH future_timestamp AS MATERIALIZED (
            SELECT clock_timestamp() + INTERVAL '1 hour' AS value
          )
          UPDATE "runtime_provider_states" AS state
          SET "built_at" = future_timestamp.value,
              "updated_at" = future_timestamp.value
          FROM future_timestamp
          WHERE state."runtime_attempt_id" = ${fixture.runtimeAttemptId!}
        `);
        const seeded = await tx.runtimeProviderState.findUniqueOrThrow({
          where: { runtimeAttemptId: fixture.runtimeAttemptId! },
          select: { builtAt: true, updatedAt: true },
        });
        await tx.$executeRawUnsafe(
          'ALTER TABLE "runtime_provider_states" ENABLE TRIGGER "runtime_provider_state_guard"',
        );
        const updated = await tx.runtimeProviderState.update({
          where: { runtimeAttemptId: fixture.runtimeAttemptId! },
          data: { projectionVersion: 2 },
          select: { builtAt: true, updatedAt: true },
        });
        return { seeded, updated };
      }, { maxWait: 10_000, timeout: 30_000 });

      expect(updated.builtAt).toEqual(seeded.builtAt);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(seeded.updatedAt.getTime());
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updated.builtAt.getTime());
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

  it("inherits only from the direct predecessor and blocks a missing predecessor projection", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const fixture = await seedAttemptFixture(db, true);
    const directPredecessorId = `${fixture.runtimeAttemptId}_direct`;
    const currentAttemptId = `${fixture.runtimeAttemptId}_current`;
    const firstProjection = createRuntimeProviderProjection({
      runtimeAttemptId: fixture.runtimeAttemptId!,
      runId: fixture.runId,
    });

    try {
      await db.$transaction(async (tx) => {
        await tx.run.update({
          where: { id: fixture.runId },
          data: { attempt: 3 },
        });
        await tx.runtimeAttempt.createMany({
          data: [
            {
              id: directPredecessorId,
              runId: fixture.runId,
              runtimeBindingId: fixture.binding.id,
              attempt: 2,
              adapter: fixture.binding.adapter,
              externalThreadId: fixture.binding.externalThreadId,
            },
            {
              id: currentAttemptId,
              runId: fixture.runId,
              runtimeBindingId: fixture.binding.id,
              attempt: 3,
              adapter: fixture.binding.adapter,
              externalThreadId: fixture.binding.externalThreadId,
            },
          ],
        });
        await tx.runtimeProviderState.create({ data: providerProjectionData(firstProjection) });
      });

      const service = new RuntimeAttemptService(db, 120_000);
      await expect(service.claim(
        fixture.runId,
        currentAttemptId,
        `runtime-predecessor-pg:${randomUUID()}`,
      )).rejects.toThrow("RUNTIME_PROVIDER_STATE_BACKFILL_REQUIRED");
      await expect(db.runtimeProviderState.findUnique({
        where: { runtimeAttemptId: currentAttemptId },
      })).resolves.toBeNull();

      const directProjection = createRuntimeProviderProjection({
        runtimeAttemptId: directPredecessorId,
        runId: fixture.runId,
        snapshot: {
          rawAssistantText: "wbkg1.",
          visibleAssistantText: "",
          redactionBuffer: "wbkg1.",
        },
      });
      await db.runtimeProviderState.create({ data: providerProjectionData(directProjection) });

      await expect(service.claim(
        fixture.runId,
        currentAttemptId,
        `runtime-predecessor-pg:${randomUUID()}`,
      )).resolves.toMatchObject({
        runId: fixture.runId,
        attemptId: currentAttemptId,
        epoch: 1,
      });
      await expect(db.runtimeProviderState.findUniqueOrThrow({
        where: { runtimeAttemptId: currentAttemptId },
        select: {
          lastAppliedSequence: true,
          rawAssistantText: true,
          visibleAssistantText: true,
          redactionBuffer: true,
        },
      })).resolves.toEqual({
        lastAppliedSequence: 0,
        rawAssistantText: "wbkg1.",
        visibleAssistantText: "",
        redactionBuffer: "wbkg1.",
      });
    } finally {
      await cleanupFixture(db, fixture);
      await db.$disconnect();
    }
  }, 120_000);

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
      const started = await db.runtimeAttempt.findUniqueOrThrow({
        where: { id: fixture.runtimeAttemptId! },
        select: { startedAt: true },
      });
      if (!started.startedAt) throw new Error("RUNTIME_ATTEMPT_STARTED_AT_MISSING");
      await db.runtimeAttempt.update({
        where: { id: fixture.runtimeAttemptId! },
        data: {
          status: "succeeded",
          finishedAt: started.startedAt,
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

function providerProjectionData(state: ReturnType<typeof createRuntimeProviderProjection>) {
  return {
    runtimeAttemptId: state.runtimeAttemptId,
    runId: state.runId,
    projectionVersion: state.projectionVersion,
    lastAppliedSequence: state.lastAppliedSequence,
    lastExternalEventId: state.lastExternalEventId,
    rawAssistantText: state.rawAssistantText,
    visibleAssistantText: state.visibleAssistantText,
    redactionBuffer: state.redactionBuffer,
    finalizationExternalEventId: state.finalizationExternalEventId,
    finalizationPayloadSha256: state.finalizationPayloadSha256,
    stateSha256: state.stateSha256,
  };
}

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
        metadata: {
          workbenchProjectId: fixture.projectId,
          workbenchThreadId: fixture.threadId,
          workbenchPrincipalId: fixture.principalId,
        },
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

async function terminalizeProviderCancellationUnconfirmed(
  db: PrismaClient,
  fixture: AttemptFixture,
) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  const failedAt = new Date();
  await db.run.update({
    where: { id: fixture.runId },
    data: {
      status: "failed",
      finishedAt: failedAt,
      errorCode: runtimeProviderCancellationUnconfirmedCode,
      errorDetail: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
      errorRetryable: true,
      executionOwnerId: null,
      executionHeartbeatAt: null,
      executionLeaseExpiresAt: null,
    },
  });
  await db.runtimeAttempt.update({
    where: { id: fixture.runtimeAttemptId },
    data: {
      status: "failed",
      startedAt: failedAt,
      finishedAt: failedAt,
      errorCode: runtimeProviderCancellationUnconfirmedCode,
      errorDetail: "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT",
      errorRetryable: true,
      submissionUnknownAt: failedAt,
      providerIdempotencyKey: providerIdempotencyKeyForAttempt(fixture.runtimeAttemptId),
      executionOwnerId: null,
      executionHeartbeatAt: null,
      executionLeaseExpiresAt: null,
    },
  });
}

async function claimProviderCancellation(
  service: RuntimeAttemptService,
  fixture: AttemptFixture,
): Promise<RuntimeExecutionClaim> {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  const result = await service.claimProviderCancellation(
    fixture.runId,
    fixture.runtimeAttemptId,
    `runtime-cleanup:${randomUUID()}`,
    120_000,
  );
  if (result.disposition !== "claimed") {
    throw new Error(`RUNTIME_PROVIDER_CANCELLATION_CLAIM_${result.disposition.toUpperCase()}`);
  }
  return result.claim;
}

function providerIdempotencyKeyForAttempt(attemptId: string) {
  return `wbrt:${createHash("sha256").update(attemptId).digest("hex")}`;
}

function insertProviderCancellationResolution(
  db: PrismaClient,
  fixture: AttemptFixture,
  input: {
    runId?: string;
    operationEpoch: number;
    externalRunId?: string;
  },
) {
  if (!fixture.runtimeAttemptId) throw new Error("RUNTIME_ATTEMPT_FIXTURE_MISSING");
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "runtime_provider_cancellation_resolutions" (
      "runtime_attempt_id", "run_id", "operation_epoch", "external_run_id",
      "failure_code", "outcome"
    ) VALUES (
      ${fixture.runtimeAttemptId}, ${input.runId ?? fixture.runId}, ${input.operationEpoch},
      ${input.externalRunId ?? fixture.externalRunId},
      'RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT', 'cancelled'
    )
  `);
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

function databaseWithProviderCancellationResolutionCrash(client: PrismaClient) {
  let injected = false;
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "runtimeProviderCancellationResolution") {
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                const value = Reflect.get(
                  delegateTarget,
                  delegateProperty,
                  delegateReceiver,
                ) as unknown;
                if (delegateProperty === "create") {
                  const create = (value as (...args: unknown[]) => Promise<unknown>)
                    .bind(delegateTarget);
                  return async (...args: unknown[]) => {
                    const result = await create(...args);
                    if (!injected) {
                      injected = true;
                      throw new Error("SIMULATED_CRASH_AFTER_CANCELLATION_RESOLUTION_INSERT");
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
      }) as Prisma.TransactionClient), { maxWait: 10_000, timeout: 30_000 }),
  };
}

function databaseWithProviderCancellationResolutionBarrier(
  client: PrismaClient,
  resolutionInserted: Deferred<void>,
  releaseSettlement: Deferred<void>,
) {
  let intercepted = false;
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "runtimeProviderCancellationResolution") {
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                const value = Reflect.get(
                  delegateTarget,
                  delegateProperty,
                  delegateReceiver,
                ) as unknown;
                if (delegateProperty === "create") {
                  const create = (value as (...args: unknown[]) => Promise<unknown>)
                    .bind(delegateTarget);
                  return async (...args: unknown[]) => {
                    const result = await create(...args);
                    if (!intercepted) {
                      intercepted = true;
                      resolutionInserted.resolve();
                      await releaseSettlement.promise;
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
      }) as Prisma.TransactionClient), { maxWait: 10_000, timeout: 30_000 }),
  };
}

type EventTransactionFaultPoint =
  | "before-pending-insert"
  | "after-processed"
  | "after-projection-cas";

function databaseWithEventTransactionFault(
  client: PrismaClient,
  faultPoint: EventTransactionFaultPoint,
) {
  let injected = false;
  const fail = (message: string) => {
    injected = true;
    throw new Error(message);
  };
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "runtimeExternalEvent") {
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                const value = Reflect.get(delegateTarget, delegateProperty, delegateReceiver) as unknown;
                if (delegateProperty === "create") {
                  const create = (value as (...args: unknown[]) => Promise<unknown>).bind(delegateTarget);
                  return async (...args: unknown[]) => {
                    if (!injected && faultPoint === "before-pending-insert") {
                      fail("SIMULATED_CRASH_BEFORE_PENDING_INSERT");
                    }
                    return create(...args);
                  };
                }
                if (delegateProperty === "updateMany") {
                  const updateMany = (value as (...args: unknown[]) => Promise<unknown>).bind(delegateTarget);
                  return async (...args: unknown[]) => {
                    const result = await updateMany(...args);
                    if (!injected && faultPoint === "after-processed") {
                      fail("SIMULATED_CRASH_AFTER_PROCESSED_TRANSITION");
                    }
                    return result;
                  };
                }
                return typeof value === "function" ? value.bind(delegateTarget) : value;
              },
            });
          }
          if (property === "runtimeProviderState") {
            const delegate = Reflect.get(target, property, receiver) as object;
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                const value = Reflect.get(delegateTarget, delegateProperty, delegateReceiver) as unknown;
                if (delegateProperty === "updateMany") {
                  const updateMany = (value as (...args: unknown[]) => Promise<unknown>).bind(delegateTarget);
                  return async (...args: unknown[]) => {
                    const result = await updateMany(...args);
                    if (!injected && faultPoint === "after-projection-cas") {
                      fail("SIMULATED_CRASH_AFTER_PROJECTION_CAS");
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

function databaseWithLockScopeBarrier(
  client: PrismaClient,
  barrier: {
    beforeLockRequest?: Deferred<void>;
    afterLockAcquired?: Deferred<void>;
    releaseLock?: Deferred<void>;
  },
) {
  let lockScopeIntercepted = false;
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === "$queryRaw") {
            const queryRaw = target.$queryRaw.bind(target) as (...args: unknown[]) => Promise<unknown>;
            return async (...args: unknown[]) => {
              if (lockScopeIntercepted) return queryRaw(...args);
              lockScopeIntercepted = true;
              barrier.beforeLockRequest?.resolve();
              const result = await queryRaw(...args);
              barrier.afterLockAcquired?.resolve();
              if (barrier.releaseLock) await barrier.releaseLock.promise;
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Prisma.TransactionClient), { timeout: 30_000 }),
  };
}

function databaseWithApplicationName(client: PrismaClient, applicationName: string) {
  return {
    $transaction: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
      client.$transaction(async (tx) => {
        await setTransactionApplicationName(tx, applicationName);
        return callback(tx);
      }, { maxWait: 10_000, timeout: 30_000 }),
  };
}

async function setTransactionApplicationName(
  tx: Prisma.TransactionClient,
  applicationName: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT set_config('application_name', ${applicationName}, true)
  `);
}

async function waitForPostgresLockWait(
  db: PrismaClient,
  applicationName: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{ waitEventType: string | null }>>(Prisma.sql`
      SELECT "wait_event_type" AS "waitEventType"
      FROM "pg_stat_activity"
      WHERE "datname" = current_database()
        AND "application_name" = ${applicationName}
        AND "state" = 'active'
      ORDER BY "backend_start" DESC
      LIMIT 1
    `);
    if (rows[0]?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`POSTGRES_LOCK_WAIT_TIMEOUT:${applicationName}`);
}

async function waitUntilAfterDatabaseTime(
  db: PrismaClient,
  deadlineAt: Date,
  paddingMs = 75,
) {
  const target = deadlineAt.getTime() + paddingMs;
  while (true) {
    const rows = await db.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
      SELECT clock_timestamp() AS "databaseNow"
    `);
    const databaseNow = rows[0]?.databaseNow;
    if (!databaseNow) throw new Error("POSTGRES_DATABASE_TIME_MISSING");
    const remainingMs = target - databaseNow.getTime();
    if (remainingMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(remainingMs, 250)));
  }
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

function promiseStateAfter<T>(promise: Promise<T>, durationMs: number) {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), durationMs);
    }),
  ]);
}
