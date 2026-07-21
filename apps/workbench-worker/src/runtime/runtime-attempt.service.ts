import { createHash } from "node:crypto";
import { canonicalJson, jsonValueSchema, type JsonValue } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { lockRunStatus } from "../runs/run-state-lock.js";
import {
  rebuildRuntimeProviderTextState,
  runtimeProviderTextReplayEventLimit,
  type RuntimeProviderTextEvent,
} from "./runtime-assistant-text.js";
import {
  runtimeExternalFinalizationEvent,
  type RuntimeSubmissionState,
} from "./runtime.port.js";

type RuntimeBindingRecord = {
  id: string;
  adapter: string;
  externalThreadId: string;
};

type ClaimScopeRow = {
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

export type RuntimeExecutionClaim = {
  runId: string;
  attemptId: string;
  ownerId: string;
  epoch: number;
};

export type RuntimeExternalEventInput = {
  externalRunId: string;
  externalEventId: string;
  event: string;
  payload: JsonValue;
};

export class RuntimeExecutionClaimBusyError extends Error {
  constructor() {
    super("RUNTIME_EXECUTION_CLAIM_BUSY");
  }
}

export class RuntimeExecutionFencedError extends Error {
  constructor(message = "RUNTIME_EXECUTION_FENCED") {
    super(message);
  }
}

export class RuntimeExecutionCancelledError extends RuntimeExecutionFencedError {
  constructor() {
    super("RUNTIME_EXECUTION_CANCELLED");
  }
}

export class RuntimeAttemptService {
  constructor(
    private readonly db: PrismaClient,
    private readonly leaseMs = 45_000,
  ) {}

  async ensure(runId: string, attempt: number, binding: RuntimeBindingRecord) {
    return this.db.$transaction(async (tx) => {
      if (await lockRunStatus(tx, runId) !== "running") {
        throw new Error("RUNTIME_ATTEMPT_RUN_NOT_ACTIVE");
      }
      const existing = await tx.runtimeAttempt.findUnique({
        where: { runId_attempt: { runId, attempt } },
      });
      if (existing) return assertAttemptBinding(existing, binding);
      return tx.runtimeAttempt.create({
        data: {
          runId,
          attempt,
          runtimeBindingId: binding.id,
          adapter: binding.adapter,
          externalThreadId: binding.externalThreadId,
        },
      });
    });
  }

  async claim(runId: string, attemptId: string, ownerId: string): Promise<RuntimeExecutionClaim> {
    assertOwnerId(ownerId);
    return this.db.$transaction(async (tx) => {
      const scope = await this.lockScope(tx, runId, attemptId);
      if (scope.runStatus !== "running" || !executionAttemptStatuses.has(scope.attemptStatus)) {
        throw new RuntimeExecutionFencedError();
      }
      if (
        activeLease(scope.runOwnerId, scope.runLeaseExpiresAt, scope.databaseNow)
        || activeLease(scope.attemptOwnerId, scope.attemptLeaseExpiresAt, scope.databaseNow)
      ) {
        throw new RuntimeExecutionClaimBusyError();
      }
      const epoch = Math.max(scope.runEpoch, scope.attemptEpoch) + 1;
      const leaseExpiresAt = new Date(scope.databaseNow.getTime() + this.leaseMs);
      const runClaimed = await tx.run.updateMany({
        where: { id: runId, status: "running", executionEpoch: scope.runEpoch },
        data: {
          executionOwnerId: ownerId,
          executionEpoch: epoch,
          executionHeartbeatAt: scope.databaseNow,
          executionLeaseExpiresAt: leaseExpiresAt,
        },
      });
      const attemptClaimed = await tx.runtimeAttempt.updateMany({
        where: { id: attemptId, runId, executionEpoch: scope.attemptEpoch },
        data: {
          executionOwnerId: ownerId,
          executionEpoch: epoch,
          executionHeartbeatAt: scope.databaseNow,
          executionLeaseExpiresAt: leaseExpiresAt,
        },
      });
      if (runClaimed.count !== 1 || attemptClaimed.count !== 1) {
        throw new RuntimeExecutionClaimBusyError();
      }
      return { runId, attemptId, ownerId, epoch };
    });
  }

  async heartbeat(claim: RuntimeExecutionClaim): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const scope = await this.assertClaimTx(tx, claim);
      const leaseExpiresAt = new Date(scope.databaseNow.getTime() + this.leaseMs);
      const runUpdated = await tx.run.updateMany({
        where: claimRunWhere(claim),
        data: {
          executionHeartbeatAt: scope.databaseNow,
          executionLeaseExpiresAt: leaseExpiresAt,
        },
      });
      const attemptUpdated = await tx.runtimeAttempt.updateMany({
        where: claimAttemptWhere(claim),
        data: {
          executionHeartbeatAt: scope.databaseNow,
          executionLeaseExpiresAt: leaseExpiresAt,
        },
      });
      if (runUpdated.count !== 1 || attemptUpdated.count !== 1) {
        throw new RuntimeExecutionFencedError();
      }
    });
  }

  async submissionContext(claim: RuntimeExecutionClaim): Promise<RuntimeSubmissionState> {
    return this.db.$transaction(async (tx) => {
      let scope = await this.assertClaimTx(tx, claim);
      const key = scope.providerIdempotencyKey ?? providerIdempotencyKey(claim.attemptId);
      if (scope.providerIdempotencyKey === null) {
        const updated = await tx.runtimeAttempt.updateMany({
          where: { ...claimAttemptWhere(claim), providerIdempotencyKey: null },
          data: { providerIdempotencyKey: key },
        });
        if (updated.count !== 1) throw new RuntimeExecutionFencedError();
        scope = { ...scope, providerIdempotencyKey: key };
      }
      if (scope.externalRunId) {
        if (scope.attemptStatus !== "running") {
          throw new Error("RUNTIME_SUBMISSION_JOIN_STATE_INVALID");
        }
        return {
          mode: "join",
          providerIdempotencyKey: key,
          externalRunId: scope.externalRunId,
          lastExternalEventId: scope.lastExternalEventId,
        };
      }
      if (scope.attemptStatus === "pending") {
        return { mode: "submit", providerIdempotencyKey: key };
      }
      if (scope.attemptStatus === "submitting" || scope.attemptStatus === "submission_unknown") {
        return { mode: "reconcile", providerIdempotencyKey: key };
      }
      throw new Error("RUNTIME_SUBMISSION_STATE_INVALID");
    });
  }

  async providerTextState(claim: RuntimeExecutionClaim) {
    return this.db.$transaction(async (tx) => {
      await this.assertClaimTx(tx, claim);
      const rows = await tx.$queryRaw<Array<RuntimeProviderTextEvent & { payload: Prisma.JsonValue }>>(
        Prisma.sql`
          SELECT
            event."runtime_attempt_id" AS "runtimeAttemptId",
            attempt."attempt" AS "attempt",
            event."external_event_id" AS "externalEventId",
            event."sequence" AS "sequence",
            event."event" AS "event",
            event."payload" AS "payload",
            event."payload_sha256" AS "payloadSha256"
          FROM "runtime_external_events" AS event
          JOIN "runtime_attempts" AS attempt ON attempt."id" = event."runtime_attempt_id"
          WHERE event."run_id" = ${claim.runId}
            AND event."status" = 'processed'
          ORDER BY attempt."attempt" DESC, event."sequence" DESC
          LIMIT ${runtimeProviderTextReplayEventLimit + 1}
        `,
      );
      const truncated = rows.length > runtimeProviderTextReplayEventLimit;
      const events = rows
        .slice(0, runtimeProviderTextReplayEventLimit)
        .reverse()
        .map((row) => ({ ...row, payload: jsonValueSchema.parse(row.payload) }));
      const draft = await tx.runDraft.findUnique({
        where: { runId: claim.runId },
        select: { content: true },
      });
      return rebuildRuntimeProviderTextState({
        currentRuntimeAttemptId: claim.attemptId,
        durableVisibleAssistantText: runtimeDraftText(draft?.content),
        events,
        truncated,
      });
    });
  }

  async authorizeSubmission(claim: RuntimeExecutionClaim): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        const scope = await this.assertClaimTx(tx, claim);
        if (scope.externalRunId) {
          throw new Error("RUNTIME_SUBMISSION_EXTERNAL_RUN_ALREADY_ATTACHED");
        }
        if (scope.attemptStatus === "submitting" || scope.attemptStatus === "submission_unknown") {
          throw new Error("RUNTIME_SUBMISSION_RECONCILIATION_REQUIRED");
        }
        if (scope.attemptStatus !== "pending" || !scope.providerIdempotencyKey) {
          throw new Error("RUNTIME_SUBMISSION_STATE_INVALID");
        }
        const updated = await tx.runtimeAttempt.updateMany({
          where: {
            ...claimAttemptWhere(claim),
            status: "pending",
            externalRunId: null,
            providerIdempotencyKey: scope.providerIdempotencyKey,
          },
          data: {
            status: "submitting",
            startedAt: scope.databaseNow,
            errorCode: null,
            errorDetail: null,
            errorRetryable: null,
          },
        });
        if (updated.count !== 1) throw new RuntimeExecutionFencedError();
      });
    } catch (error) {
      if (error instanceof RuntimeExecutionCancelledError) {
        throw new Error("RUNTIME_SUBMISSION_NOT_AUTHORIZED");
      }
      throw error;
    }
  }

  async markSubmissionUnknown(claim: RuntimeExecutionClaim, detail: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const scope = await this.assertClaimTx(tx, claim);
      if (scope.externalRunId) {
        if (scope.attemptStatus !== "running") {
          throw new Error("RUNTIME_SUBMISSION_UNKNOWN_EXTERNAL_RUN_STATE_INVALID");
        }
        const attemptUpdated = await tx.runtimeAttempt.updateMany({
          where: claimAttemptWhere(claim),
          data: releasedLease(),
        });
        const runUpdated = await tx.run.updateMany({
          where: claimRunWhere(claim),
          data: releasedLease(),
        });
        if (attemptUpdated.count !== 1 || runUpdated.count !== 1) {
          throw new RuntimeExecutionFencedError();
        }
        return;
      }
      if (scope.attemptStatus !== "submitting" && scope.attemptStatus !== "submission_unknown") {
        throw new Error("RUNTIME_SUBMISSION_UNKNOWN_STATE_INVALID");
      }
      const attemptUpdated = await tx.runtimeAttempt.updateMany({
        where: claimAttemptWhere(claim),
        data: {
          status: "submission_unknown",
          submissionUnknownAt: scope.submissionUnknownAt ?? scope.databaseNow,
          errorCode: "RUNTIME_SUBMISSION_UNKNOWN",
          errorDetail: detail,
          errorRetryable: false,
          ...releasedLease(),
        },
      });
      const runUpdated = await tx.run.updateMany({
        where: claimRunWhere(claim),
        data: {
          errorCode: "RUNTIME_SUBMISSION_UNKNOWN",
          errorDetail: detail,
          errorRetryable: false,
          ...releasedLease(),
        },
      });
      if (attemptUpdated.count !== 1 || runUpdated.count !== 1) {
        throw new RuntimeExecutionFencedError();
      }
    });
  }

  async attachExternalRun(
    claim: RuntimeExecutionClaim,
    externalRunId: string,
  ) {
    assertExternalRunId(externalRunId);
    return this.db.$transaction(async (tx) => {
      const scope = await this.assertClaimTx(tx, claim);
      if (scope.externalRunId) {
        if (scope.externalRunId !== externalRunId) throw new Error("RUNTIME_EXTERNAL_RUN_ID_CONFLICT");
        return tx.runtimeAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } });
      }
      if (!new Set(["submitting", "submission_unknown", "cancelling"]).has(scope.attemptStatus)) {
        throw new Error("RUNTIME_EXTERNAL_RUN_ATTACH_STATE_INVALID");
      }
      const updated = await tx.runtimeAttempt.updateMany({
        where: claimAttemptWhere(claim),
        data: {
          externalRunId,
          status: scope.attemptStatus === "cancelling" ? "cancelling" : "running",
          errorCode: null,
          errorDetail: null,
          errorRetryable: null,
        },
      });
      if (updated.count !== 1) throw new RuntimeExecutionFencedError();
      return tx.runtimeAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } });
    });
  }

  async attachExternalRunForCancellation(attemptId: string, externalRunId: string) {
    assertExternalRunId(externalRunId);
    return this.db.$transaction(async (tx) => {
      const attempt = await tx.runtimeAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (attempt.externalRunId) {
        if (attempt.externalRunId !== externalRunId) throw new Error("RUNTIME_EXTERNAL_RUN_ID_CONFLICT");
        return attempt;
      }
      if (attempt.status !== "cancelling") {
        throw new Error("RUNTIME_EXTERNAL_RUN_ATTACH_STATE_INVALID");
      }
      return tx.runtimeAttempt.update({
        where: { id: attemptId },
        data: { externalRunId },
      });
    });
  }

  async processExternalEvent(
    claim: RuntimeExecutionClaim,
    input: RuntimeExternalEventInput,
    applyEffects: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{ created: boolean; sequence: number }> {
    if (input.event === runtimeExternalFinalizationEvent) {
      throw new Error("RUNTIME_EXTERNAL_EVENT_TYPE_RESERVED");
    }
    return this.processInboxEvent(claim, input, applyEffects, true);
  }

  async processExternalFinalization(
    claim: RuntimeExecutionClaim,
    input: RuntimeExternalEventInput,
    applyEffects: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<{ created: boolean; sequence: number }> {
    if (input.event !== runtimeExternalFinalizationEvent) {
      throw new Error("RUNTIME_EXTERNAL_FINALIZATION_TYPE_INVALID");
    }
    return this.processInboxEvent(claim, input, applyEffects, false);
  }

  private async processInboxEvent(
    claim: RuntimeExecutionClaim,
    input: RuntimeExternalEventInput,
    applyEffects: (tx: Prisma.TransactionClient) => Promise<void>,
    checkpointProviderCursor: boolean,
  ): Promise<{ created: boolean; sequence: number }> {
    assertExternalRunId(input.externalRunId);
    assertExternalEvent(input);
    const payload = jsonValueSchema.parse(input.payload);
    const payloadSha256 = sha256Canonical(payload);
    return this.db.$transaction(async (tx) => {
      const scope = await this.assertClaimTx(tx, claim);
      if (scope.externalRunId !== input.externalRunId || scope.attemptStatus !== "running") {
        throw new RuntimeExecutionFencedError();
      }
      const existing = await tx.runtimeExternalEvent.findUnique({
        where: {
          runtimeAttemptId_externalEventId: {
            runtimeAttemptId: claim.attemptId,
            externalEventId: input.externalEventId,
          },
        },
      });
      if (existing) {
        assertExternalEventReplay(existing, claim, input, payloadSha256);
        if (existing.status === "processed") {
          return { created: false, sequence: existing.sequence };
        }
      }

      const sequence = existing?.sequence ?? scope.externalEventSequence + 1;
      if (!existing) {
        const sequenced = await tx.runtimeAttempt.updateMany({
          where: {
            ...claimAttemptWhere(claim),
            externalEventSequence: scope.externalEventSequence,
          },
          data: { externalEventSequence: sequence },
        });
        if (sequenced.count !== 1) throw new RuntimeExecutionFencedError();
        await tx.runtimeExternalEvent.create({
          data: {
            runtimeAttemptId: claim.attemptId,
            runId: claim.runId,
            externalRunId: input.externalRunId,
            externalEventId: input.externalEventId,
            sequence,
            event: input.event,
            payload: payload === null ? Prisma.JsonNull : payload as Prisma.InputJsonValue,
            payloadSha256,
          },
        });
      }

      await applyEffects(tx);
      const processed = await tx.runtimeExternalEvent.updateMany({
        where: {
          runtimeAttemptId: claim.attemptId,
          externalEventId: input.externalEventId,
          status: "pending",
        },
        data: { status: "processed", processedAt: scope.databaseNow },
      });
      const checkpointed = checkpointProviderCursor
        ? await tx.runtimeAttempt.updateMany({
            where: claimAttemptWhere(claim),
            data: { lastExternalEventId: input.externalEventId },
          })
        : { count: 1 };
      if (processed.count !== 1 || checkpointed.count !== 1) {
        throw new RuntimeExecutionFencedError();
      }
      return { created: true, sequence };
    });
  }

  async release(claim: RuntimeExecutionClaim): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const runUpdated = await tx.run.updateMany({
        where: claimRunWhere(claim),
        data: releasedLease(),
      });
      const attemptUpdated = await tx.runtimeAttempt.updateMany({
        where: claimAttemptWhere(claim),
        data: releasedLease(),
      });
      if (runUpdated.count !== 1 || attemptUpdated.count !== 1) {
        throw new RuntimeExecutionFencedError();
      }
    });
  }

  async assertClaimTx(
    tx: Prisma.TransactionClient,
    claim: RuntimeExecutionClaim,
  ): Promise<ClaimScopeRow> {
    const scope = await this.lockScope(tx, claim.runId, claim.attemptId);
    if (
      scope.runOwnerId !== claim.ownerId
      || scope.runEpoch !== claim.epoch
      || scope.attemptOwnerId !== claim.ownerId
      || scope.attemptEpoch !== claim.epoch
    ) {
      throw new RuntimeExecutionFencedError();
    }
    if (scope.runStatus === "cancelling" || scope.runStatus === "cancelled") {
      throw new RuntimeExecutionCancelledError();
    }
    if (
      scope.runStatus !== "running"
      || !scope.runLeaseExpiresAt
      || scope.runLeaseExpiresAt.getTime() <= scope.databaseNow.getTime()
      || !scope.attemptLeaseExpiresAt
      || scope.attemptLeaseExpiresAt.getTime() <= scope.databaseNow.getTime()
    ) {
      throw new RuntimeExecutionFencedError();
    }
    return scope;
  }

  async beginCancellation(runId: string, attemptId: string) {
    return this.db.$transaction(async (tx) => {
      const runStatus = await lockRunStatus(tx, runId);
      if (runStatus !== "cancelling" && runStatus !== "cancelled") {
        throw new Error("RUNTIME_CANCEL_STATE_INVALID");
      }
      const attempt = await tx.runtimeAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (attempt.runId !== runId) throw new Error("RUNTIME_CANCEL_ATTEMPT_SCOPE_INVALID");
      if (attempt.status === "submitting" || attempt.status === "running") {
        return tx.runtimeAttempt.update({
          where: { id: attemptId },
          data: { status: "cancelling" },
        });
      }
      return attempt;
    });
  }

  async recordRetryableError(
    claim: RuntimeExecutionClaim,
    error: { code: string; detail: string },
  ) {
    return this.db.$transaction(async (tx) => {
      await this.assertClaimTx(tx, claim);
      const attemptUpdated = await tx.runtimeAttempt.updateMany({
        where: {
          ...claimAttemptWhere(claim),
          status: { in: ["pending", "submitting", "running"] },
        },
        data: {
          errorCode: error.code,
          errorDetail: error.detail,
          errorRetryable: true,
          ...releasedLease(),
        },
      });
      const runUpdated = await tx.run.updateMany({
        where: claimRunWhere(claim),
        data: releasedLease(),
      });
      if (attemptUpdated.count !== 1 || runUpdated.count !== 1) {
        throw new RuntimeExecutionFencedError();
      }
    });
  }

  private async lockScope(
    tx: Prisma.TransactionClient,
    runId: string,
    attemptId: string,
  ): Promise<ClaimScopeRow> {
    const rows = await tx.$queryRaw<ClaimScopeRow[]>(Prisma.sql`
      SELECT
        CURRENT_TIMESTAMP AS "databaseNow",
        run."status"::TEXT AS "runStatus",
        run."execution_owner_id" AS "runOwnerId",
        run."execution_epoch" AS "runEpoch",
        run."execution_lease_expires_at" AS "runLeaseExpiresAt",
        attempt."status"::TEXT AS "attemptStatus",
        attempt."execution_owner_id" AS "attemptOwnerId",
        attempt."execution_epoch" AS "attemptEpoch",
        attempt."execution_lease_expires_at" AS "attemptLeaseExpiresAt",
        attempt."external_run_id" AS "externalRunId",
        attempt."provider_idempotency_key" AS "providerIdempotencyKey",
        attempt."submission_unknown_at" AS "submissionUnknownAt",
        attempt."external_event_sequence" AS "externalEventSequence",
        attempt."last_external_event_id" AS "lastExternalEventId"
      FROM "runs" AS run
      JOIN "runtime_attempts" AS attempt ON attempt."run_id" = run."id"
      WHERE run."id" = ${runId}
        AND attempt."id" = ${attemptId}
      FOR UPDATE OF run, attempt
    `);
    if (!rows[0]) throw new RuntimeExecutionFencedError();
    return rows[0];
  }
}

const executionAttemptStatuses = new Set(["pending", "submitting", "submission_unknown", "running"]);

function activeLease(ownerId: string | null, expiresAt: Date | null, now: Date) {
  return ownerId !== null && expiresAt !== null && expiresAt.getTime() > now.getTime();
}

function claimRunWhere(claim: RuntimeExecutionClaim) {
  return {
    id: claim.runId,
    status: "running" as const,
    executionOwnerId: claim.ownerId,
    executionEpoch: claim.epoch,
  };
}

function claimAttemptWhere(claim: RuntimeExecutionClaim) {
  return {
    id: claim.attemptId,
    runId: claim.runId,
    executionOwnerId: claim.ownerId,
    executionEpoch: claim.epoch,
  };
}

function releasedLease() {
  return {
    executionOwnerId: null,
    executionHeartbeatAt: null,
    executionLeaseExpiresAt: null,
  };
}

function providerIdempotencyKey(attemptId: string) {
  return `wbrt:${createHash("sha256").update(attemptId).digest("hex")}`;
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function runtimeDraftText(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNTIME_PROVIDER_TEXT_DRAFT_INVALID");
  }
  const text = (value as Record<string, unknown>).text;
  if (typeof text !== "string") throw new Error("RUNTIME_PROVIDER_TEXT_DRAFT_INVALID");
  return text;
}

function assertOwnerId(ownerId: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(ownerId)) throw new Error("RUNTIME_EXECUTION_OWNER_ID_INVALID");
}

function assertExternalRunId(externalRunId: string) {
  if (!externalRunId.trim() || externalRunId.length > 512) {
    throw new Error("RUNTIME_EXTERNAL_RUN_ID_INVALID");
  }
}

function assertExternalEvent(input: RuntimeExternalEventInput) {
  if (!input.externalEventId || input.externalEventId.length > 1_024) {
    throw new Error("RUNTIME_EXTERNAL_EVENT_ID_INVALID");
  }
  if (!input.event || input.event.length > 128) throw new Error("RUNTIME_EXTERNAL_EVENT_TYPE_INVALID");
}

function assertExternalEventReplay(
  existing: {
    runId: string;
    externalRunId: string;
    event: string;
    payloadSha256: string;
  },
  claim: RuntimeExecutionClaim,
  input: RuntimeExternalEventInput,
  payloadSha256: string,
) {
  if (
    existing.runId !== claim.runId
    || existing.externalRunId !== input.externalRunId
    || existing.event !== input.event
    || existing.payloadSha256 !== payloadSha256
  ) {
    throw new Error("RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT");
  }
}

function assertAttemptBinding<T extends RuntimeBindingRecord & { runtimeBindingId: string }>(
  attempt: T,
  binding: RuntimeBindingRecord,
) {
  if (
    attempt.runtimeBindingId !== binding.id
    || attempt.adapter !== binding.adapter
    || attempt.externalThreadId !== binding.externalThreadId
  ) {
    throw new Error("RUNTIME_ATTEMPT_BINDING_MISMATCH");
  }
  return attempt;
}
