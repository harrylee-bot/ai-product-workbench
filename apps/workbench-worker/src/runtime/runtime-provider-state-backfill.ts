import { createHash } from "node:crypto";
import { jsonValueSchema } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  recordRuntimeProviderStateMetric,
  recordRuntimeTransactionMetric,
} from "@workbench/workbench-telemetry";
import {
  assertRuntimeProviderProjection,
  createRuntimeProviderProjection,
  reduceRuntimeProviderProjection,
  type RuntimeProviderProjection,
} from "./runtime-assistant-text.js";
import { knownRuntimeProviderStateErrorCode } from "./runtime-provider-state-error.js";

export const runtimeProviderStateBackfillOperatorVersion = 2;
export const runtimeProviderStateBackfillEventPageSize = 250;

const runtimeProviderStateBackfillAttemptPageSize = 250;

export type RuntimeProviderStateBackfillMode = "apply" | "dry-run" | "verify-only";

export type RuntimeProviderStateBackfillCheckpoint = {
  protocol: "workbench.runtime-provider-state-backfill-checkpoint.v1";
  operatorVersion: typeof runtimeProviderStateBackfillOperatorVersion;
  projectionVersion: 2;
  candidateSha: string;
  attemptIdSha256: string;
  eventCount: number;
  lastSequence: number;
  stateSha256: string;
  durationMs: number;
  status: "created" | "verified" | "would-create";
};

export class RuntimeProviderStateBackfill {
  private dryRunProjectionCache: {
    attempt: number;
    projection: RuntimeProviderProjection;
    runId: string;
  } | null = null;

  constructor(private readonly db: PrismaClient) {}

  async processPage(input: {
    candidateSha: string;
    mode: RuntimeProviderStateBackfillMode;
    batchSize: number;
    afterAttemptId?: string;
  }): Promise<{
    checkpoints: RuntimeProviderStateBackfillCheckpoint[];
    nextAfterAttemptId: string | null;
    hasMore: boolean;
  }> {
    assertCandidateSha(input.candidateSha);
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1_000) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_BATCH_SIZE_INVALID");
    }
    const cursor = input.afterAttemptId
      ? await this.db.runtimeAttempt.findUnique({
          where: { id: input.afterAttemptId },
          select: { id: true, runId: true, attempt: true },
        })
      : null;
    if (input.afterAttemptId && !cursor) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_CURSOR_NOT_FOUND");
    }
    const candidates = await this.db.runtimeAttempt.findMany({
      where: cursor ? {
        OR: [
          { runId: { gt: cursor.runId } },
          { runId: cursor.runId, attempt: { gt: cursor.attempt } },
          { runId: cursor.runId, attempt: cursor.attempt, id: { gt: cursor.id } },
        ],
      } : undefined,
      orderBy: [{ runId: "asc" }, { attempt: "asc" }, { id: "asc" }],
      take: input.batchSize + 1,
      select: { id: true },
    });
    const attempts = candidates.slice(0, input.batchSize);
    const checkpoints: RuntimeProviderStateBackfillCheckpoint[] = [];
    for (const attempt of attempts) {
      const startedAt = performance.now();
      try {
        const checkpoint = await this.processAttempt({
          attemptId: attempt.id,
          candidateSha: input.candidateSha,
          mode: input.mode,
        });
        checkpoints.push(checkpoint);
        recordRuntimeProviderStateMetric({
          operation: "backfill",
          outcome: "ok",
          durationMs: performance.now() - startedAt,
          rowsApplied: checkpoint.status === "created" ? 1 : 0,
        });
      } catch (error) {
        recordRuntimeProviderStateMetric({
          operation: "backfill",
          outcome: "error",
          durationMs: performance.now() - startedAt,
          rowsApplied: 0,
          errorCode: backfillMetricErrorCode(error),
        });
        throw error;
      }
    }
    return {
      checkpoints,
      nextAfterAttemptId: attempts.at(-1)?.id ?? null,
      hasMore: candidates.length > input.batchSize,
    };
  }

  async processBatch(input: {
    candidateSha: string;
    mode: RuntimeProviderStateBackfillMode;
    batchSize: number;
    afterAttemptId?: string;
  }) {
    const page = await this.processPage(input);
    return {
      ...page,
      coverage: await this.coverage(),
    };
  }

  async coverage() {
    let built = 0;
    let missing = 0;
    let lagging = 0;
    let versionMismatch = 0;
    let hashMismatch = 0;
    let activeMissing = 0;
    let terminalMissing = 0;
    let conflicts = 0;
    let verified = 0;
    let totalAttempts = 0;
    let afterAttemptId: string | undefined;
    while (true) {
      const attempts = await this.db.runtimeAttempt.findMany({
        where: afterAttemptId ? { id: { gt: afterAttemptId } } : undefined,
        orderBy: { id: "asc" },
        take: runtimeProviderStateBackfillAttemptPageSize,
        select: {
          id: true,
          runId: true,
          status: true,
          externalEventSequence: true,
          providerState: true,
        },
      });
      if (attempts.length === 0) break;
      totalAttempts += attempts.length;
      for (const attempt of attempts) {
        if (!attempt.providerState) {
          missing += 1;
          if ([
            "pending",
            "submitting",
            "submission_unknown",
            "running",
            "waiting_input",
            "cancelling",
          ].includes(attempt.status)) {
            activeMissing += 1;
          }
          if (["succeeded", "failed", "cancelled"].includes(attempt.status)) {
            terminalMissing += 1;
          }
          continue;
        }
        built += 1;
        const invalidVersion = attempt.providerState.projectionVersion !== 2;
        const isLagging = attempt.providerState.lastAppliedSequence !== attempt.externalEventSequence;
        let invalidHash = false;
        let invalidScope = false;
        if (invalidVersion) versionMismatch += 1;
        if (isLagging) lagging += 1;
        if (!invalidVersion) {
          try {
            const projection = providerProjectionFromRow(attempt.providerState);
            invalidScope = projection.runtimeAttemptId !== attempt.id || projection.runId !== attempt.runId;
          } catch {
            hashMismatch += 1;
            invalidHash = true;
          }
        }
        if (invalidScope) conflicts += 1;
        if (!invalidVersion && !isLagging && !invalidHash && !invalidScope) verified += 1;
      }
      const nextAfterAttemptId = attempts.at(-1)?.id;
      if (!nextAfterAttemptId || nextAfterAttemptId === afterAttemptId) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_COVERAGE_CURSOR_STALLED");
      }
      afterAttemptId = nextAfterAttemptId;
      if (attempts.length < runtimeProviderStateBackfillAttemptPageSize) break;
    }
    return {
      totalAttempts,
      expectedProjections: totalAttempts,
      built,
      verified,
      missing,
      conflicts,
      lagging,
      versionMismatch,
      hashMismatch,
      activeMissing,
      terminalMissing,
      rolloutBlocked: missing > 0
        || conflicts > 0
        || lagging > 0
        || versionMismatch > 0
        || hashMismatch > 0,
    };
  }

  private async processAttempt(input: {
    attemptId: string;
    candidateSha: string;
    mode: RuntimeProviderStateBackfillMode;
  }): Promise<RuntimeProviderStateBackfillCheckpoint> {
    const startedAt = performance.now();
    const targetSnapshot = await this.db.runtimeAttempt.findUnique({
      where: { id: input.attemptId },
      select: {
        id: true,
        runId: true,
        attempt: true,
        externalEventSequence: true,
        status: true,
      },
    });
    if (!targetSnapshot) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_NOT_FOUND");
    const previous = await this.previousProjection(targetSnapshot, input.mode);
    const projection = await this.replayAttempt(targetSnapshot, previous?.projection ?? null);
    const result = await this.backfillTransaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{
        id: string;
        runId: string;
        attempt: number;
        externalEventSequence: number;
        status: string;
      }>>(Prisma.sql`
        SELECT
          attempt."id",
          attempt."run_id" AS "runId",
          attempt."attempt",
          attempt."external_event_sequence" AS "externalEventSequence",
          attempt."status"::text AS "status"
        FROM "runtime_attempts" AS attempt
        WHERE attempt."id" = ${input.attemptId}
        FOR UPDATE
      `);
      const target = locked[0];
      if (!target) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_NOT_FOUND");
      if (
        target.runId !== targetSnapshot.runId
        || target.attempt !== targetSnapshot.attempt
        || target.externalEventSequence !== targetSnapshot.externalEventSequence
        || target.status !== targetSnapshot.status
      ) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_SNAPSHOT_CONFLICT");
      }
      if (previous) {
        const storedPrevious = await tx.runtimeAttempt.findUnique({
          where: { id: previous.attemptId },
          select: {
            externalEventSequence: true,
            providerState: true,
          },
        });
        if (
          !storedPrevious
          || storedPrevious.externalEventSequence !== previous.externalEventSequence
          || (
            previous.persistedStateSha256
            && storedPrevious.providerState?.stateSha256 !== previous.persistedStateSha256
          )
          || (!storedPrevious.providerState && input.mode !== "dry-run")
        ) {
          throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_PREDECESSOR_CHANGED");
        }
      }
      const [existing, latestAttempt, draft] = await Promise.all([
        tx.runtimeProviderState.findUnique({ where: { runtimeAttemptId: target.id } }),
        tx.runtimeAttempt.findFirst({
          where: { runId: target.runId },
          orderBy: { attempt: "desc" },
          select: { id: true },
        }),
        tx.runDraft.findUnique({
          where: { runId: target.runId },
          select: { content: true },
        }),
      ]);
      if (
        latestAttempt?.id === target.id
        && draft
        && runtimeDraftText(draft.content) !== projection.visibleAssistantText
      ) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_DRAFT_CONFLICT");
      }
      if (existing) {
        const stored = providerProjectionFromRow(existing);
        if (
          stored.projectionVersion !== projection.projectionVersion
          || stored.lastAppliedSequence !== projection.lastAppliedSequence
          || stored.stateSha256 !== projection.stateSha256
        ) {
          throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_CONFLICT");
        }
        return {
          projection,
          eventCount: targetSnapshot.externalEventSequence,
          status: "verified" as const,
        };
      }
      if (input.mode === "verify-only") {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_MISSING");
      }
      if (input.mode === "dry-run") {
        return {
          projection,
          eventCount: targetSnapshot.externalEventSequence,
          status: "would-create" as const,
        };
      }
      await tx.runtimeProviderState.create({ data: providerProjectionData(projection) });
      return {
        projection,
        eventCount: targetSnapshot.externalEventSequence,
        status: "created" as const,
      };
    });
    if (input.mode === "dry-run") {
      this.dryRunProjectionCache = {
        attempt: targetSnapshot.attempt,
        projection,
        runId: targetSnapshot.runId,
      };
    }
    return {
      protocol: "workbench.runtime-provider-state-backfill-checkpoint.v1",
      operatorVersion: runtimeProviderStateBackfillOperatorVersion,
      projectionVersion: 2,
      candidateSha: input.candidateSha,
      attemptIdSha256: createHash("sha256").update(input.attemptId).digest("hex"),
      eventCount: result.eventCount,
      lastSequence: result.projection.lastAppliedSequence,
      stateSha256: result.projection.stateSha256,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      status: result.status,
    };
  }

  private async previousProjection(
    target: {
      id: string;
      runId: string;
      attempt: number;
      externalEventSequence: number;
      status: string;
    },
    mode: RuntimeProviderStateBackfillMode,
  ): Promise<{
    attemptId: string;
    externalEventSequence: number;
    persistedStateSha256: string | null;
    projection: RuntimeProviderProjection;
  } | null> {
    if (
      mode === "dry-run"
      && this.dryRunProjectionCache?.runId === target.runId
      && this.dryRunProjectionCache.attempt === target.attempt - 1
    ) {
      return {
        attemptId: this.dryRunProjectionCache.projection.runtimeAttemptId,
        externalEventSequence: this.dryRunProjectionCache.projection.lastAppliedSequence,
        persistedStateSha256: null,
        projection: this.dryRunProjectionCache.projection,
      };
    }
    const previous = await this.db.runtimeAttempt.findFirst({
      where: { runId: target.runId, attempt: { lt: target.attempt } },
      orderBy: { attempt: "desc" },
      select: {
        id: true,
        runId: true,
        attempt: true,
        externalEventSequence: true,
        providerState: true,
      },
    });
    if (!previous) {
      if (target.attempt !== 1) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_GAP");
      }
      return null;
    }
    if (previous.attempt !== target.attempt - 1) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_GAP");
    }
    if (!previous.providerState) {
      if (mode !== "dry-run") {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_PREDECESSOR_MISSING");
      }
      const projection = await this.replayDryRunHistory(previous);
      return {
        attemptId: previous.id,
        externalEventSequence: previous.externalEventSequence,
        persistedStateSha256: null,
        projection,
      };
    }
    const projection = providerProjectionFromRow(previous.providerState);
    if (
      projection.runtimeAttemptId !== previous.id
      || projection.runId !== previous.runId
      || projection.lastAppliedSequence !== previous.externalEventSequence
    ) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_PREDECESSOR_CONFLICT");
    }
    return {
      attemptId: previous.id,
      externalEventSequence: previous.externalEventSequence,
      persistedStateSha256: projection.stateSha256,
      projection,
    };
  }

  private async replayDryRunHistory(target: {
    id: string;
    runId: string;
    attempt: number;
    externalEventSequence: number;
  }) {
    let projection: RuntimeProviderProjection | null = null;
    let afterAttempt = 0;
    while (afterAttempt < target.attempt) {
      const attempts = await this.db.runtimeAttempt.findMany({
        where: {
          runId: target.runId,
          attempt: { gt: afterAttempt, lte: target.attempt },
        },
        orderBy: { attempt: "asc" },
        take: runtimeProviderStateBackfillAttemptPageSize,
        select: {
          id: true,
          runId: true,
          attempt: true,
          externalEventSequence: true,
        },
      });
      if (attempts.length === 0) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_GAP");
      }
      for (const attempt of attempts) {
        if (attempt.attempt !== afterAttempt + 1) {
          throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_GAP");
        }
        projection = await this.replayAttempt(attempt, projection);
        afterAttempt = attempt.attempt;
      }
    }
    if (!projection || projection.runtimeAttemptId !== target.id) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_REPLAY_INVALID");
    }
    return projection;
  }

  private async replayAttempt(
    attempt: {
      id: string;
      runId: string;
      attempt: number;
      externalEventSequence: number;
    },
    previous: RuntimeProviderProjection | null,
  ) {
    let projection = createRuntimeProviderProjection({
      runtimeAttemptId: attempt.id,
      runId: attempt.runId,
      snapshot: previous ? {
        rawAssistantText: previous.rawAssistantText,
        visibleAssistantText: previous.visibleAssistantText,
        redactionBuffer: previous.redactionBuffer,
      } : undefined,
    });
    while (projection.lastAppliedSequence < attempt.externalEventSequence) {
      const events = await this.db.runtimeExternalEvent.findMany({
        where: {
          runtimeAttemptId: attempt.id,
          sequence: { gt: projection.lastAppliedSequence },
        },
        orderBy: { sequence: "asc" },
        take: runtimeProviderStateBackfillEventPageSize,
        select: {
          externalEventId: true,
          sequence: true,
          event: true,
          payload: true,
          payloadSha256: true,
          status: true,
        },
      });
      if (events.length === 0) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_EVENT_COUNT_CONFLICT");
      }
      for (const event of events) {
        if (event.status !== "processed") {
          throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_PENDING_EVENT");
        }
        if (
          event.sequence !== projection.lastAppliedSequence + 1
          || event.sequence > attempt.externalEventSequence
        ) {
          throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_SEQUENCE_GAP");
        }
        try {
          projection = reduceRuntimeProviderProjection(projection, {
            runtimeAttemptId: attempt.id,
            runId: attempt.runId,
            attempt: attempt.attempt,
            externalEventId: event.externalEventId,
            sequence: event.sequence,
            event: event.event,
            payload: jsonValueSchema.parse(event.payload),
            payloadSha256: event.payloadSha256,
          }).state;
        } catch (error) {
          if (error instanceof Error && error.message === "RUNTIME_PROVIDER_TEXT_EVENT_INTEGRITY_ERROR") {
            throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_PAYLOAD_HASH_MISMATCH");
          }
          if (error instanceof Error && error.message === "RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION") {
            throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_MULTIPLE_FINALIZATION");
          }
          throw error;
        }
      }
    }
    const unexpected = await this.db.runtimeExternalEvent.findFirst({
      where: {
        runtimeAttemptId: attempt.id,
        sequence: { gt: attempt.externalEventSequence },
      },
      select: { id: true },
    });
    if (unexpected) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_EVENT_COUNT_CONFLICT");
    return projection;
  }

  private async backfillTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    let transactionStartedAt: number | null = null;
    try {
      const result = await this.db.$transaction(async (tx) => {
        transactionStartedAt = performance.now();
        return callback(tx);
      }, { maxWait: 10_000, timeout: 5_000 });
      const finishedAt = performance.now();
      const durationMs = Math.max(0, finishedAt - startedAt);
      recordRuntimeTransactionMetric({
        operation: "provider-state-backfill",
        outcome: "ok",
        waitMs: Math.min(durationMs, Math.max(0, (transactionStartedAt ?? finishedAt) - startedAt)),
        durationMs,
      });
      return result;
    } catch (error) {
      const finishedAt = performance.now();
      const durationMs = Math.max(0, finishedAt - startedAt);
      const errorCode = transactionMetricErrorCode(error);
      recordRuntimeTransactionMetric({
        operation: "provider-state-backfill",
        outcome: errorCode === "P2028"
          ? "timeout"
          : errorCode.endsWith("_CONFLICT")
            ? "conflict"
            : "error",
        waitMs: Math.min(durationMs, Math.max(0, (transactionStartedAt ?? finishedAt) - startedAt)),
        durationMs,
        errorCode,
      });
      throw error;
    }
  }
}

function backfillMetricErrorCode(error: unknown) {
  const providerStateCode = knownRuntimeProviderStateErrorCode(error);
  if (providerStateCode) return providerStateCode;
  const message = error instanceof Error ? error.message : "";
  return /^RUNTIME_PROVIDER_STATE_BACKFILL_[A-Z0-9_]{1,48}$/u.test(message)
    ? message
    : "RUNTIME_PROVIDER_STATE_BACKFILL_FAILED";
}

function transactionMetricErrorCode(error: unknown) {
  const providerStateCode = knownRuntimeProviderStateErrorCode(error);
  if (providerStateCode) return providerStateCode;
  const prismaCode = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  return /^P\d{4}$/u.test(prismaCode) ? prismaCode : backfillMetricErrorCode(error);
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

function runtimeDraftText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_DRAFT_INVALID");
  }
  const text = (value as Record<string, unknown>).text;
  if (typeof text !== "string") throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_DRAFT_INVALID");
  return text;
}

function assertCandidateSha(value: string) {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_CANDIDATE_INVALID");
  }
}
