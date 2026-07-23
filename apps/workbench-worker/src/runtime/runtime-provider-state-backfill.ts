import { createHash } from "node:crypto";
import { jsonValueSchema } from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import {
  assertRuntimeProviderProjection,
  createRuntimeProviderProjection,
  reduceRuntimeProviderProjection,
  type RuntimeProviderProjection,
} from "./runtime-assistant-text.js";

export const runtimeProviderStateBackfillOperatorVersion = 1;

type BackfillMode = "apply" | "dry-run" | "verify-only";

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
  constructor(private readonly db: PrismaClient) {}

  async processBatch(input: {
    candidateSha: string;
    mode: BackfillMode;
    batchSize: number;
    afterAttemptId?: string;
  }): Promise<{
    checkpoints: RuntimeProviderStateBackfillCheckpoint[];
    nextAfterAttemptId: string | null;
    coverage: Awaited<ReturnType<RuntimeProviderStateBackfill["coverage"]>>;
  }> {
    assertCandidateSha(input.candidateSha);
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1_000) {
      throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_BATCH_SIZE_INVALID");
    }
    const attempts = await this.db.runtimeAttempt.findMany({
      where: input.afterAttemptId ? { id: { gt: input.afterAttemptId } } : undefined,
      orderBy: { id: "asc" },
      take: input.batchSize,
      select: { id: true },
    });
    const checkpoints: RuntimeProviderStateBackfillCheckpoint[] = [];
    for (const attempt of attempts) {
      checkpoints.push(await this.processAttempt({
        attemptId: attempt.id,
        candidateSha: input.candidateSha,
        mode: input.mode,
      }));
    }
    return {
      checkpoints,
      nextAfterAttemptId: attempts.at(-1)?.id ?? null,
      coverage: await this.coverage(),
    };
  }

  async coverage() {
    const attempts = await this.db.runtimeAttempt.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        status: true,
        externalEventSequence: true,
        providerState: true,
      },
    });
    let built = 0;
    let missing = 0;
    let lagging = 0;
    let versionMismatch = 0;
    let hashMismatch = 0;
    let activeMissing = 0;
    let verified = 0;
    for (const attempt of attempts) {
      if (!attempt.providerState) {
        missing += 1;
        if (["pending", "submitting", "submission_unknown", "running", "cancelling"].includes(attempt.status)) {
          activeMissing += 1;
        }
        continue;
      }
      built += 1;
      const invalidVersion = attempt.providerState.projectionVersion !== 2;
      const isLagging = attempt.providerState.lastAppliedSequence !== attempt.externalEventSequence;
      let invalidHash = false;
      if (invalidVersion) versionMismatch += 1;
      if (isLagging) lagging += 1;
      try {
        providerProjectionFromRow(attempt.providerState);
      } catch {
        hashMismatch += 1;
        invalidHash = true;
      }
      if (!invalidVersion && !isLagging && !invalidHash) verified += 1;
    }
    return {
      totalAttempts: attempts.length,
      expectedProjections: attempts.length,
      built,
      verified,
      missing,
      conflicts: 0,
      lagging,
      versionMismatch,
      hashMismatch,
      activeMissing,
      rolloutBlocked: activeMissing > 0 || lagging > 0 || versionMismatch > 0 || hashMismatch > 0,
    };
  }

  private async processAttempt(input: {
    attemptId: string;
    candidateSha: string;
    mode: BackfillMode;
  }): Promise<RuntimeProviderStateBackfillCheckpoint> {
    const startedAt = performance.now();
    const result = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; runId: string; attempt: number }>>(Prisma.sql`
        SELECT attempt."id", attempt."run_id" AS "runId", attempt."attempt"
        FROM "runtime_attempts" AS attempt
        WHERE attempt."id" = ${input.attemptId}
        FOR UPDATE
      `);
      const target = locked[0];
      if (!target) throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_ATTEMPT_NOT_FOUND");
      const attempts = await tx.runtimeAttempt.findMany({
        where: { runId: target.runId, attempt: { lte: target.attempt } },
        orderBy: { attempt: "asc" },
        select: {
          id: true,
          runId: true,
          attempt: true,
          externalEventSequence: true,
          externalEvents: {
            orderBy: { sequence: "asc" },
            select: {
              externalEventId: true,
              sequence: true,
              event: true,
              payload: true,
              payloadSha256: true,
              status: true,
            },
          },
        },
      });
      let previous: RuntimeProviderProjection | null = null;
      let projection: RuntimeProviderProjection | null = null;
      let eventCount = 0;
      for (const attempt of attempts) {
        projection = createRuntimeProviderProjection({
          runtimeAttemptId: attempt.id,
          runId: attempt.runId,
          snapshot: previous
            ? {
                rawAssistantText: previous.rawAssistantText,
                visibleAssistantText: previous.visibleAssistantText,
                redactionBuffer: previous.redactionBuffer,
              }
            : undefined,
        });
        if (attempt.externalEvents.length !== attempt.externalEventSequence) {
          throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_EVENT_COUNT_CONFLICT");
        }
        for (const [index, event] of attempt.externalEvents.entries()) {
          if (event.status !== "processed") {
            throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_PENDING_EVENT");
          }
          if (event.sequence !== index + 1) {
            throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_SEQUENCE_GAP");
          }
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
          if (attempt.id === target.id) eventCount += 1;
        }
        previous = projection;
      }
      if (!projection || projection.runtimeAttemptId !== target.id) {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_REPLAY_INVALID");
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
        return { projection, eventCount, status: "verified" as const };
      }
      if (input.mode === "verify-only") {
        throw new Error("RUNTIME_PROVIDER_STATE_BACKFILL_MISSING");
      }
      if (input.mode === "dry-run") {
        return { projection, eventCount, status: "would-create" as const };
      }
      await tx.runtimeProviderState.create({ data: providerProjectionData(projection) });
      return { projection, eventCount, status: "created" as const };
    }, { maxWait: 10_000, timeout: 30_000 });
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
