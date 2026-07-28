import { createHash } from "node:crypto";
import { canonicalJson, jsonValueSchema, type JsonValue } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  recordRuntimeLivenessMetric,
  recordRuntimeProviderStateMetric,
  recordRuntimeTransactionMetric,
} from "@workbench/workbench-telemetry";
import { lockRunStatus } from "../runs/run-state-lock.js";
import {
  rebuildRuntimeProviderTextState,
  assertRuntimeProviderProjection,
  createRuntimeProviderProjection,
  reduceRuntimeProviderProjection,
  runtimeProviderTextStateFromProjection,
  runtimeProviderTextStateFromLegacy,
  runtimeProviderTextReplayEventLimit,
  type RuntimeProviderProjection,
  type RuntimeProviderTextEvent,
} from "./runtime-assistant-text.js";
import {
  runtimeExternalFinalizationEvent,
  type RuntimeSubmissionState,
} from "./runtime.port.js";
import { knownRuntimeProviderStateErrorCode } from "./runtime-provider-state-error.js";

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
  attempt: number;
};

const runtimeExecutionTransactionOptions = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

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

export type RuntimeProviderStateMode = "legacy-read" | "shadow-verify" | "projection-required";

export type RuntimeProviderStateShadowFinding = {
  protocol: "workbench.runtime-provider-state-shadow-finding.v1";
  code: "RUNTIME_PROVIDER_STATE_SHADOW_MISMATCH" | "RUNTIME_PROVIDER_STATE_SHADOW_VERIFY_FAILED";
  runIdSha256: string;
  attemptIdSha256: string;
};

type RuntimeProviderProjectionRead = {
  state: ReturnType<typeof runtimeProviderTextStateFromProjection>;
  attempt: number;
  lastAppliedSequence: number;
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
    private readonly providerStateMode: RuntimeProviderStateMode = "projection-required",
    private readonly onShadowMismatch?: (finding: RuntimeProviderStateShadowFinding) => void,
  ) {
    if (providerStateMode === "shadow-verify" && !onShadowMismatch) {
      throw new Error("RUNTIME_PROVIDER_STATE_SHADOW_REPORTER_REQUIRED");
    }
  }

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
    const result = await this.db.$transaction(async (tx) => {
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
      await this.ensureProviderProjectionTx(tx, {
        runId,
        attemptId,
        attempt: scope.attempt,
        externalEventSequence: scope.externalEventSequence,
      });
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
      const tookOverExpiredLease = (
        (scope.runOwnerId !== null && scope.runLeaseExpiresAt !== null && scope.runLeaseExpiresAt <= scope.databaseNow)
        || (scope.attemptOwnerId !== null && scope.attemptLeaseExpiresAt !== null && scope.attemptLeaseExpiresAt <= scope.databaseNow)
      );
      return {
        claim: { runId, attemptId, ownerId, epoch },
        tookOverExpiredLease,
      };
    });
    if (result.tookOverExpiredLease) {
      recordRuntimeLivenessMetric({ operation: "lease-takeover", outcome: "recovered" });
    }
    return result.claim;
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
    }, runtimeExecutionTransactionOptions);
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
    const startedAt = performance.now();
    try {
      if (this.providerStateMode === "legacy-read") {
        const state = runtimeProviderTextStateFromLegacy(await this.providerTextStateLegacy(claim));
        recordRuntimeProviderStateMetric({
          operation: "read",
          outcome: "ok",
          durationMs: performance.now() - startedAt,
        });
        return state;
      }
      const projected = await this.readProviderTextStateProjection(claim);
      recordRuntimeProviderStateMetric({
        operation: "read",
        outcome: "ok",
        durationMs: performance.now() - startedAt,
        projectionLag: 0,
      });
      if (this.providerStateMode === "shadow-verify") {
        const shadowStartedAt = performance.now();
        void this.verifyProjectionShadow(claim, projected).then(() => {
          recordRuntimeProviderStateMetric({
            operation: "shadow-verify",
            outcome: "ok",
            durationMs: performance.now() - shadowStartedAt,
            projectionLag: 0,
          });
        }).catch((error: unknown) => {
          const code = error instanceof Error && error.message === "RUNTIME_PROVIDER_STATE_SHADOW_MISMATCH"
            ? "RUNTIME_PROVIDER_STATE_SHADOW_MISMATCH"
            : "RUNTIME_PROVIDER_STATE_SHADOW_VERIFY_FAILED";
          recordRuntimeProviderStateMetric({
            operation: "shadow-verify",
            outcome: "error",
            durationMs: performance.now() - shadowStartedAt,
            errorCode: code,
          });
          this.onShadowMismatch!({
            protocol: "workbench.runtime-provider-state-shadow-finding.v1",
            code,
            runIdSha256: opaqueIdSha256(claim.runId),
            attemptIdSha256: opaqueIdSha256(claim.attemptId),
          });
        });
      }
      return projected.state;
    } catch (error) {
      recordRuntimeProviderStateMetric({
        operation: "read",
        outcome: providerStateMetricOutcome(error),
        durationMs: performance.now() - startedAt,
        errorCode: providerStateMetricErrorCode(error),
        ...(providerStateMetricProjectionLag(error) === undefined
          ? {}
          : { projectionLag: providerStateMetricProjectionLag(error) }),
      });
      throw error;
    }
  }

  private async readProviderTextStateProjection(
    claim: RuntimeExecutionClaim,
  ): Promise<RuntimeProviderProjectionRead> {
    return this.providerStateTransaction("provider-state-read", async (tx) => {
      const scope = await this.assertClaimTx(tx, claim);
      const [projectionRow, draft] = await Promise.all([
        tx.runtimeProviderState.findUnique({
          where: { runtimeAttemptId: claim.attemptId },
        }),
        tx.runDraft.findUnique({
          where: { runId: claim.runId },
          select: { content: true },
        }),
      ]);
      if (!projectionRow) throw new Error("RUNTIME_PROVIDER_STATE_MISSING");
      const projection = providerProjectionFromRow(projectionRow);
      if (projection.runId !== claim.runId) {
        throw new Error("RUNTIME_PROVIDER_STATE_IDENTITY_INVALID");
      }
      if (projection.lastAppliedSequence !== scope.externalEventSequence) {
        throw providerStateSequenceGap(
          scope.externalEventSequence,
          projection.lastAppliedSequence,
        );
      }
      return {
        state: runtimeProviderTextStateFromProjection(
          projection,
          runtimeDraftText(draft?.content),
        ),
        attempt: scope.attempt,
        lastAppliedSequence: projection.lastAppliedSequence,
      };
    });
  }

  private async providerTextStateLegacy(claim: RuntimeExecutionClaim) {
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

  private async verifyProjectionShadow(
    claim: RuntimeExecutionClaim,
    projected: RuntimeProviderProjectionRead,
  ) {
    const rows = await this.db.$queryRaw<Array<RuntimeProviderTextEvent & { payload: Prisma.JsonValue }>>(
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
          AND (
            attempt."attempt" < ${projected.attempt}
            OR (
              attempt."id" = ${claim.attemptId}
              AND event."sequence" <= ${projected.lastAppliedSequence}
            )
          )
        ORDER BY attempt."attempt" DESC, event."sequence" DESC
        LIMIT ${runtimeProviderTextReplayEventLimit + 1}
      `,
    );
    const truncated = rows.length > runtimeProviderTextReplayEventLimit;
    const events = rows
      .slice(0, runtimeProviderTextReplayEventLimit)
      .reverse()
      .map((row) => ({ ...row, payload: jsonValueSchema.parse(row.payload) }));
    const legacy = rebuildRuntimeProviderTextState({
      currentRuntimeAttemptId: claim.attemptId,
      durableVisibleAssistantText: projected.state.durableVisibleAssistantText,
      events,
      truncated,
    });
    const normalizedLegacy = runtimeProviderTextStateFromLegacy(legacy);
    if (
      projected.state.rawAssistantText !== normalizedLegacy.rawAssistantText
      || projected.state.visibleAssistantText !== normalizedLegacy.visibleAssistantText
      || projected.state.redactionBuffer !== normalizedLegacy.redactionBuffer
      || projected.state.durableVisibleAssistantText !== normalizedLegacy.durableVisibleAssistantText
      || projected.state.committedFinalization?.externalEventId
        !== normalizedLegacy.committedFinalization?.externalEventId
      || projected.state.committedFinalization?.payloadSha256
        !== normalizedLegacy.committedFinalization?.payloadSha256
    ) {
      throw new Error("RUNTIME_PROVIDER_STATE_SHADOW_MISMATCH");
    }
  }

  async externalEventProcessed(
    claim: RuntimeExecutionClaim,
    input: RuntimeExternalEventInput,
  ): Promise<boolean> {
    assertExternalRunId(input.externalRunId);
    assertExternalEvent(input);
    const payloadSha256 = sha256Canonical(jsonValueSchema.parse(input.payload));
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
        select: {
          runId: true,
          externalRunId: true,
          event: true,
          payloadSha256: true,
          status: true,
        },
      });
      if (!existing) return false;
      assertExternalEventReplay(existing, claim, input, payloadSha256);
      return existing.status === "processed";
    }, runtimeExecutionTransactionOptions);
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
    const startedAt = performance.now();
    assertExternalRunId(input.externalRunId);
    assertExternalEvent(input);
    const payload = jsonValueSchema.parse(input.payload);
    const payloadSha256 = sha256Canonical(payload);
    try {
      const result = await this.providerStateTransaction("provider-state-update", async (tx) => {
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

      const projectionRow = await tx.runtimeProviderState.findUnique({
        where: { runtimeAttemptId: claim.attemptId },
      });
      if (!projectionRow) throw new Error("RUNTIME_PROVIDER_STATE_MISSING");
      const projection = providerProjectionFromRow(projectionRow);
      if (projection.lastAppliedSequence !== sequence - 1) {
        throw providerStateSequenceGap(sequence - 1, projection.lastAppliedSequence);
      }
      const nextProjection = reduceRuntimeProviderProjection(projection, {
        runtimeAttemptId: claim.attemptId,
        runId: claim.runId,
        attempt: scope.attempt,
        externalEventId: input.externalEventId,
        sequence,
        event: input.event,
        payload,
        payloadSha256,
      }).state;

      await applyEffects(tx);
      const draft = await tx.runDraft.findUnique({
        where: { runId: claim.runId },
        select: { content: true },
      });
      if (runtimeDraftText(draft?.content) !== nextProjection.visibleAssistantText) {
        throw new Error("RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT");
      }
      const processed = await tx.runtimeExternalEvent.updateMany({
        where: {
          runtimeAttemptId: claim.attemptId,
          externalEventId: input.externalEventId,
          status: "pending",
        },
        data: { status: "processed", processedAt: scope.databaseNow },
      });
      if (processed.count !== 1) throw new RuntimeExecutionFencedError();
      const projected = await tx.runtimeProviderState.updateMany({
        where: {
          runtimeAttemptId: claim.attemptId,
          runId: claim.runId,
          projectionVersion: projection.projectionVersion,
          lastAppliedSequence: projection.lastAppliedSequence,
          stateSha256: projection.stateSha256,
        },
        data: providerProjectionData(nextProjection),
      });
      const checkpointed = checkpointProviderCursor
        ? await tx.runtimeAttempt.updateMany({
            where: claimAttemptWhere(claim),
            data: { lastExternalEventId: input.externalEventId },
          })
        : { count: 1 };
      if (projected.count !== 1) throw new Error("RUNTIME_PROVIDER_STATE_CAS_CONFLICT");
      if (checkpointed.count !== 1) {
        throw new RuntimeExecutionFencedError();
      }
      return { created: true, sequence };
      });
      recordRuntimeProviderStateMetric({
        operation: "update",
        outcome: result.created ? "ok" : "replay",
        durationMs: performance.now() - startedAt,
        rowsApplied: result.created ? 1 : 0,
        eventsApplied: result.created ? 1 : 0,
        projectionLag: 0,
      });
      return result;
    } catch (error) {
      recordRuntimeProviderStateMetric({
        operation: "update",
        outcome: providerStateMetricOutcome(error),
        durationMs: performance.now() - startedAt,
        rowsApplied: 0,
        eventsApplied: 0,
        errorCode: providerStateMetricErrorCode(error),
        ...(providerStateMetricProjectionLag(error) === undefined
          ? {}
          : { projectionLag: providerStateMetricProjectionLag(error) }),
      });
      throw error;
    }
  }

  private async providerStateTransaction<T>(
    operation: "provider-state-read" | "provider-state-update",
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    let transactionStartedAt: number | null = null;
    try {
      const result = await this.db.$transaction(async (tx) => {
        transactionStartedAt = performance.now();
        return callback(tx);
      }, runtimeExecutionTransactionOptions);
      const finishedAt = performance.now();
      recordRuntimeTransactionMetric({
        operation,
        outcome: "ok",
        waitMs: Math.max(0, (transactionStartedAt ?? finishedAt) - startedAt),
        durationMs: Math.max(0, finishedAt - startedAt),
      });
      return result;
    } catch (error) {
      const finishedAt = performance.now();
      const errorCode = providerStateMetricErrorCode(error);
      recordRuntimeTransactionMetric({
        operation,
        outcome: errorCode === "P2028"
          ? "timeout"
          : providerStateMetricOutcome(error) === "conflict"
            ? "conflict"
            : "error",
        waitMs: Math.max(0, (transactionStartedAt ?? finishedAt) - startedAt),
        durationMs: Math.max(0, finishedAt - startedAt),
        errorCode,
      });
      throw error;
    }
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

  private async ensureProviderProjectionTx(
    tx: Prisma.TransactionClient,
    scope: {
      runId: string;
      attemptId: string;
      attempt: number;
      externalEventSequence: number;
    },
  ): Promise<void> {
    const existing = await tx.runtimeProviderState.findUnique({
      where: { runtimeAttemptId: scope.attemptId },
    });
    if (existing) {
      const projection = providerProjectionFromRow(existing);
      if (
        projection.runId !== scope.runId
        || projection.lastAppliedSequence > scope.externalEventSequence
      ) {
        throw new Error("RUNTIME_PROVIDER_STATE_SCOPE_INVALID");
      }
      return;
    }
    if (scope.externalEventSequence !== 0) {
      throw new Error("RUNTIME_PROVIDER_STATE_MISSING");
    }

    const [previous, draft] = await Promise.all([
      tx.runtimeAttempt.findFirst({
        where: {
          runId: scope.runId,
          attempt: { lt: scope.attempt },
          providerState: { isNot: null },
        },
        orderBy: { attempt: "desc" },
        select: { providerState: true },
      }),
      tx.runDraft.findUnique({
        where: { runId: scope.runId },
        select: { content: true },
      }),
    ]);
    const previousProjection = previous?.providerState
      ? providerProjectionFromRow(previous.providerState)
      : null;
    const durableText = runtimeDraftText(draft?.content);
    if (!previousProjection && durableText !== "") {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_REQUIRED");
    }
    if (previousProjection && previousProjection.visibleAssistantText !== durableText) {
      throw new Error("RUNTIME_PROVIDER_STATE_DRAFT_CONFLICT");
    }
    const projection = createRuntimeProviderProjection({
      runtimeAttemptId: scope.attemptId,
      runId: scope.runId,
      snapshot: previousProjection
        ? {
            rawAssistantText: previousProjection.rawAssistantText,
            visibleAssistantText: previousProjection.visibleAssistantText,
            redactionBuffer: previousProjection.redactionBuffer,
          }
        : undefined,
    });
    await tx.runtimeProviderState.create({
      data: providerProjectionData(projection),
    });
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
        , attempt."attempt" AS "attempt"
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

function providerProjectionFromRow(row: {
  runtimeAttemptId: string;
  runId: string;
  projectionVersion: number;
  lastAppliedSequence: number;
  lastExternalEventId: string | null;
  rawAssistantText: string;
  visibleAssistantText: string;
  redactionBuffer: string;
  finalizationExternalEventId: string | null;
  finalizationPayloadSha256: string | null;
  stateSha256: string;
}): RuntimeProviderProjection {
  return assertRuntimeProviderProjection({
    protocol: "workbench.runtime-provider-state.v2",
    runtimeAttemptId: row.runtimeAttemptId,
    runId: row.runId,
    projectionVersion: row.projectionVersion as 2,
    lastAppliedSequence: row.lastAppliedSequence,
    lastExternalEventId: row.lastExternalEventId,
    rawAssistantText: row.rawAssistantText,
    visibleAssistantText: row.visibleAssistantText,
    redactionBuffer: row.redactionBuffer,
    finalizationExternalEventId: row.finalizationExternalEventId,
    finalizationPayloadSha256: row.finalizationPayloadSha256,
    stateSha256: row.stateSha256,
  });
}

function providerProjectionData(state: RuntimeProviderProjection) {
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

const executionAttemptStatuses = new Set(["pending", "submitting", "submission_unknown", "running"]);

function providerStateMetricOutcome(error: unknown): "error" | "conflict" | "missing" {
  const code = providerStateMetricErrorCode(error);
  if (code === "RUNTIME_PROVIDER_STATE_MISSING") return "missing";
  if (code.endsWith("_CONFLICT") || code === "RUNTIME_PROVIDER_STATE_SEQUENCE_GAP") return "conflict";
  return "error";
}

function providerStateMetricErrorCode(error: unknown) {
  const providerStateCode = knownRuntimeProviderStateErrorCode(error);
  if (providerStateCode) return providerStateCode;
  const prismaCode = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  if (/^P\d{4}$/u.test(prismaCode)) return prismaCode;
  const message = error instanceof Error ? error.message : "";
  return /^RUNTIME_[A-Z0-9_]{1,56}$/u.test(message) ? message : "RUNTIME_PROVIDER_STATE_OPERATION_FAILED";
}

function providerStateSequenceGap(expectedSequence: number, actualSequence: number) {
  const error = new Error("RUNTIME_PROVIDER_STATE_SEQUENCE_GAP") as Error & {
    projectionLag?: number;
  };
  const projectionLag = expectedSequence - actualSequence;
  if (Number.isSafeInteger(projectionLag) && projectionLag >= 0) {
    Object.defineProperty(error, "projectionLag", {
      configurable: false,
      enumerable: false,
      value: projectionLag,
      writable: false,
    });
  }
  return error;
}

function providerStateMetricProjectionLag(error: unknown) {
  if (!error || typeof error !== "object" || !("projectionLag" in error)) return undefined;
  const projectionLag = (error as { projectionLag?: unknown }).projectionLag;
  return Number.isSafeInteger(projectionLag) && (projectionLag as number) >= 0
    ? projectionLag as number
    : undefined;
}

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

function opaqueIdSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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
