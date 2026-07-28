import { createHash, randomUUID } from "node:crypto";
import {
  approvalOptionsSchema,
  approvalResponseSchema,
  artifactDraftScreenSchema,
  artifactKindSchema,
  canvasAgentToolResultSchema,
  boardNodeDataSchema,
  boardNodeProtocol,
  boardPointSchema,
  boardSizeSchema,
  canonicalJson as canonicalizeJson,
  designPresetDefinitionFromRuntimeSnapshot,
  jsonValueSchema,
  prdDocumentSchema,
  projectPrototypeSourceScreens,
  prototypePatchCheckpointScreenSchema,
  prototypeDocumentSchema,
  prototypeSourceProjectionSchema,
  runtimeMaterializedDesignStyleSnapshotSchema,
  runtimePresetDesignStyleSnapshotSchema,
  runtimeDesignStyleSnapshotSchema,
  runtimeResumeDecisionSchema,
  runSourceBlobLimit,
  startRunRequestSchema,
  type RuntimeDesignStyleSnapshot,
  type RuntimeMaterializedDesignStyleSnapshot,
  type BoardNode,
  type RuntimeInputRequired,
  type RuntimeArtifactDraft,
  type RuntimeProgressEvent,
  type RunGenerationStage,
  type PrototypeAsset,
  type RuntimeResult,
  type RuntimeResumeDecision,
  type StartRunRequest,
} from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { recordRuntimeLivenessMetric } from "@workbench/workbench-telemetry";
import type {
  RuntimeArtifactTarget,
  RuntimeArtifactTargetAsset,
  RuntimeSource,
  RuntimeContentLocator,
  RuntimeDesignAsset,
  RuntimePort,
  RuntimeExternalEventPart,
  RuntimeSubmissionState,
} from "../runtime/runtime.port.js";
import {
  RuntimeSubmissionUnknownError,
  runtimeExternalFinalizationEvent,
} from "../runtime/runtime.port.js";
import {
  RuntimeLivenessError,
  RuntimeWallClockBudget,
  raceWithAbort,
} from "../runtime/runtime-liveness.js";
import {
  RuntimeAttemptService,
  RuntimeExecutionClaimBusyError,
  RuntimeExecutionCancelledError,
  RuntimeExecutionFencedError,
  type RuntimeExecutionClaim,
  type RuntimeProviderStateMode,
  type RuntimeProviderStateShadowFinding,
} from "../runtime/runtime-attempt.service.js";
import { RuntimeBindingService } from "../runtime/runtime-binding.service.js";
import type { KnowledgeToolGrantIssuer } from "../runtime/knowledge-tool-grant.service.js";
import type { CanvasToolGrantIssuer } from "../runtime/canvas-tool-grant.service.js";
import { parseRuntimeFinalizationPayload } from "../runtime/runtime-assistant-text.js";
import { knownRuntimeProviderStateErrorCode } from "../runtime/runtime-provider-state-error.js";
import { withBoardRevisionOwner } from "./board-revision-owner.js";
import {
  assertExactCanvasQuickEditTarget,
  classifyCanvasPublicationIntents,
  planCanvasDirectIntentsOverRuntimeResult,
  type CanvasDirectIntentRuntimePlan,
  type CanvasPublicationIntents,
} from "./canvas-staged-intents.js";
import { RunEventStore } from "./run-event.store.js";
import { lockRunStatus } from "./run-state-lock.js";
import {
  isPrototypeDraft,
  PrototypePatchService,
  type PrototypeCheckpointScreenState,
} from "./prototype-patch.service.js";

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const runPreparationInclude = {
  thread: { include: { project: true } },
  draft: true,
  sourceSnapshots: {
    orderBy: { position: "asc" },
    include: {
      source: {
        include: {
          blobs: {
            orderBy: { position: "asc" },
            include: {
              blob: true,
              fileAsset: {
                include: {
                  currentExtraction: {
                    include: {
                      outputs: {
                        orderBy: [{ kind: "asc" }, { position: "asc" }],
                        include: { blob: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.RunInclude;

type PreparedSourceSnapshot = Prisma.RunSourceSnapshotGetPayload<{
  include: typeof runPreparationInclude.sourceSnapshots.include;
}>;
type PreparedSourceExtraction = NonNullable<
  PreparedSourceSnapshot["source"]["blobs"][number]["fileAsset"]
>["currentExtraction"];

type PreparedDesignAsset = Prisma.ArtifactVersionAssetGetPayload<{
  include: { blob: true };
}>;

type PreparedArtifactTarget = Prisma.ArtifactVersionGetPayload<{
  include: {
    artifact: { select: { kind: true } };
    contentBlob: true;
    assets: {
      include: { blob: true };
      orderBy: { assetId: "asc" };
    };
  };
}>;

type CanvasPublicationContext = {
  agentSessionId: string;
  boardId: string;
  boardRevision: number;
  canvasStateRevision: number;
  intents: CanvasPublicationIntents;
};

type PublishedArtifactVersion = {
  artifactId: string;
  artifactVersionId: string;
  version: number;
};

type RuntimePersistenceContext = {
  entryId: string;
  sources: RuntimeSource[];
  designAssets: RuntimeDesignAsset[];
  artifactTargets: RuntimeArtifactTarget[];
};

export class RunProcessor {
  private readonly active = new Map<string, AbortController>();
  private cancellationPollTimer: NodeJS.Timeout | null = null;
  private cancellationPollInFlight = false;
  private readonly events: RunEventStore;
  private readonly bindings: RuntimeBindingService;
  private readonly attempts: RuntimeAttemptService;
  private readonly prototypePatches: PrototypePatchService;
  private readonly executionOwnerPrefix: string;
  private readonly executionHeartbeatMs: number;
  private readonly executionMaximumWallClockMs: number;
  private readonly executionDeadlineCancelMs: number;
  private readonly cancellationPollIntervalMs: number;
  private readonly cancellationQueryBatchSize: number;

  constructor(
    private readonly db: PrismaClient,
    private readonly runtime: RuntimePort,
    private readonly knowledgeToolGrants: KnowledgeToolGrantIssuer,
    private readonly canvasToolGrants: CanvasToolGrantIssuer = NO_CANVAS_TOOL_GRANTS,
    prototypePatches?: PrototypePatchService,
    private readonly cancellationRecoveryWindowMs = 11 * 60 * 1_000,
    execution: {
      ownerPrefix?: string;
      leaseMs?: number;
      heartbeatMs?: number;
      maximumWallClockMs?: number;
      deadlineCancelMs?: number;
      cancellationPollIntervalMs?: number;
      cancellationQueryBatchSize?: number;
      providerStateMode?: RuntimeProviderStateMode;
      providerStateShadowReporter?: (finding: RuntimeProviderStateShadowFinding) => void;
    } = {},
  ) {
    this.events = new RunEventStore(db);
    this.bindings = new RuntimeBindingService(db, runtime);
    const leaseMs = execution.leaseMs ?? 45_000;
    this.attempts = new RuntimeAttemptService(
      db,
      leaseMs,
      execution.providerStateMode ?? "projection-required",
      execution.providerStateShadowReporter,
    );
    this.prototypePatches = prototypePatches ?? new PrototypePatchService(db);
    this.executionOwnerPrefix = execution.ownerPrefix ?? "runtime-worker";
    this.executionHeartbeatMs = execution.heartbeatMs ?? 15_000;
    this.executionMaximumWallClockMs = execution.maximumWallClockMs ?? 30 * 60_000;
    this.executionDeadlineCancelMs = execution.deadlineCancelMs ?? 30_000;
    this.cancellationPollIntervalMs = execution.cancellationPollIntervalMs ?? 1_000;
    this.cancellationQueryBatchSize = execution.cancellationQueryBatchSize ?? 100;
    if (!Number.isSafeInteger(this.cancellationPollIntervalMs)
      || this.cancellationPollIntervalMs < 250
      || this.cancellationPollIntervalMs > 10_000) {
      throw new Error("RUNTIME_CANCELLATION_POLL_INTERVAL_INVALID");
    }
    if (!Number.isSafeInteger(this.cancellationQueryBatchSize)
      || this.cancellationQueryBatchSize < 1
      || this.cancellationQueryBatchSize > 1_000) {
      throw new Error("RUNTIME_CANCELLATION_QUERY_BATCH_SIZE_INVALID");
    }
    if (this.executionHeartbeatMs >= leaseMs) {
      throw new Error("RUNTIME_EXECUTION_HEARTBEAT_INTERVAL_INVALID");
    }
    if (!Number.isSafeInteger(this.executionMaximumWallClockMs)
      || this.executionMaximumWallClockMs < 1) {
      throw new Error("RUNTIME_EXECUTION_MAX_WALL_CLOCK_INVALID");
    }
    if (!Number.isSafeInteger(this.executionDeadlineCancelMs)
      || this.executionDeadlineCancelMs < 1
      || this.executionDeadlineCancelMs >= this.executionMaximumWallClockMs) {
      throw new Error("RUNTIME_EXECUTION_DEADLINE_CANCEL_INVALID");
    }
  }

  async execute(
    runId: string,
    approvalIds: string[] = [],
    jobSignal?: AbortSignal,
    retry = { retryCount: 0, retryLimit: 0 },
  ) {
    const handlerStartedAtMs = Date.now();
    let prepared: Awaited<ReturnType<RunProcessor["prepare"]>>;
    try {
      prepared = await this.prepare(runId, approvalIds);
    } catch (error) {
      const run = await this.db.run.findUnique({ where: { id: runId }, select: { status: true } });
      if (run?.status === "cancelling" || run?.status === "cancelled") {
        return { runId, cancellationPending: run.status !== "cancelled" };
      }
      if (error instanceof RunTransitionRejectedError) return { runId, skipped: true };
      const retryable = isRetryableRuntimeError(error);
      if (!retryable || retry.retryCount >= retry.retryLimit) {
        await this.failRun(runId, null, error, retryable);
      }
      throw error;
    }
    if (!prepared) return { runId, skipped: true };

    const wallClock = new RuntimeWallClockBudget(
      this.executionMaximumWallClockMs,
      handlerStartedAtMs,
    );
    const controller = new AbortController();
    this.active.set(runId, controller);
    this.startCancellationPoller();
    const signal = AbortSignal.any([
      ...(jobSignal ? [jobSignal] : []),
      controller.signal,
      wallClock.signal,
    ]);

    let fullText = prepared.previousAssistantText;
    let runtimeAttemptId: string | null = null;
    let claim: RuntimeExecutionClaim | null = null;
    let submission: RuntimeSubmissionState | null = null;
    let externalThreadId: string | null = null;
    let externalRunId: string | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let wallClockOutcome: "ok" | "error" | "cancelled" | null = null;

    try {
      const binding = await this.bindings.ensure(prepared.thread.id, {
        workbenchProjectId: prepared.project.id,
        workbenchThreadId: prepared.thread.id,
        workbenchPrincipalId: prepared.run.createdById,
      }, signal);
      externalThreadId = binding.externalThreadId;
      const runtimeAttempt = await this.attempts.ensure(runId, prepared.run.attempt, binding);
      runtimeAttemptId = runtimeAttempt.id;
      wallClock.rebase(
        runtimeAttempt.startedAt instanceof Date
          ? runtimeAttempt.startedAt.getTime()
          : handlerStartedAtMs,
      );
      if (wallClock.signal.aborted) throw wallClock.signal.reason;
      claim = await this.attempts.claim(
        runId,
        runtimeAttempt.id,
        `${this.executionOwnerPrefix}:${randomUUID()}`,
      );
      heartbeatTimer = this.startExecutionHeartbeat(claim, controller);
      submission = await this.attempts.submissionContext(claim);
      externalRunId = submission.mode === "join" ? submission.externalRunId : null;
      const providerTextState = await this.attempts.providerTextState(claim);
      fullText = providerTextState.durableVisibleAssistantText;
      const knowledgeTool = submission.mode === "submit"
        ? await this.knowledgeToolGrants.issue({
            runId,
            runtimeAttemptId: runtimeAttempt.id,
            principalId: prepared.run.createdById,
            projectId: prepared.project.id,
            releaseId: prepared.run.knowledgeReleaseId,
          })
        : null;
      const canvasTool = submission.mode === "submit"
        ? await this.canvasToolGrants.issue({
            runId,
            runtimeAttemptId: runtimeAttempt.id,
            attempt: prepared.run.attempt,
            principalId: prepared.run.createdById,
            projectId: prepared.project.id,
            threadId: prepared.thread.id,
            modelId: prepared.request.modelId,
            workflow: prepared.request.workflow,
            artifactTargets: prepared.request.artifactTargets,
            snapshot: prepared.request.canvasSnapshot ?? null,
          })
        : null;
      const outcome = await raceWithAbort(this.runtime.execute({
        runId,
        runtimeAttemptId: runtimeAttempt.id,
        attempt: prepared.run.attempt,
        projectId: prepared.project.id,
        threadId: prepared.thread.id,
        principalId: prepared.run.createdById,
        externalThreadId: binding.externalThreadId,
        request: prepared.request,
        artifactTargets: prepared.artifactTargets,
        prototypePatchBaselines: prepared.prototypePatchBaselines,
        sources: prepared.sources,
        designAssets: prepared.designAssets,
        knowledgeTool,
        canvasTool,
        designStyleSnapshot: prepared.designStyleSnapshot,
        resume: prepared.resume,
        providerTextState,
        submission,
      }, {
        onSubmissionStarted: () => this.attempts.authorizeSubmission(claim!),
        onExternalRunCreated: async (candidateExternalRunId) => {
          await this.attempts.attachExternalRun(claim!, candidateExternalRunId);
          externalRunId = candidateExternalRunId;
        },
        isExternalEventProcessed: (part) => (
          this.attempts.externalEventProcessed(claim!, part)
        ),
        onExternalEvent: async (part, effects) => {
          let nextFullText = fullText;
          await this.attempts.processExternalEvent(claim!, part, async (tx) => {
            nextFullText = await this.persistRuntimeEffectsTx(
              tx,
              claim!,
              prepared,
              nextFullText,
              effects,
            );
          });
          fullText = nextFullText;
        },
        onExternalFinalization: async (part, effects) => {
          if (part.event !== runtimeExternalFinalizationEvent) {
            throw new Error("RUNTIME_EXTERNAL_FINALIZATION_TYPE_INVALID");
          }
          if (effects.some((effect) => effect.type === "text.delta")) {
            throw new Error("RUNTIME_EXTERNAL_FINALIZATION_TEXT_DELTA_FORBIDDEN");
          }
          const finalization = parseRuntimeFinalizationPayload(part.payload);
          if (canonicalizeJson(finalization.effects) !== canonicalizeJson(effects)) {
            throw new Error("RUNTIME_EXTERNAL_FINALIZATION_EFFECTS_CONFLICT");
          }
          let nextFullText = fullText;
          await this.attempts.processExternalFinalization(claim!, part, async (tx) => {
            nextFullText = await this.persistRuntimeEffectsTx(
              tx,
              claim!,
              prepared,
              nextFullText,
              effects,
            );
            const terminalText = finalization.visibleFinalEffect.text;
            const terminalDelta = terminalVisibleTextDelta(nextFullText, terminalText);
            if (terminalDelta) {
              await this.persistDeltaTx(
                tx,
                claim!.runId,
                prepared.entryId,
                terminalText,
                terminalDelta,
              );
            }
            nextFullText = terminalText;
            await this.terminalizeRunningActivitiesTx(tx, claim!);
          });
          fullText = nextFullText;
        },
      }, signal), signal);

      if (outcome.protocol === "workbench.runtime.input-required.v1") {
        await this.waitForInput(claim, outcome);
        wallClockOutcome = "ok";
        return { runId, approvalCount: outcome.approvals.length, waitingInput: true };
      }
      if (outcome.artifacts.some((artifact) => artifact.kind === "prd")) {
        await this.persistProgress(claim, {
          type: "phase",
          phase: "validating",
          label: "正在校验需求说明书",
          progress: null,
        });
        validateRuntimeArtifactOperations(prepared.request, outcome);
        await this.persistProgress(claim, {
          type: "phase",
          phase: "publishing",
          label: "正在发布需求说明书",
          progress: null,
        });
      }
      await this.publishResult(
        claim,
        prepared.entryId,
        fullText,
        outcome,
      );
      wallClockOutcome = "ok";
      return { runId, artifactCount: outcome.artifacts.length };
    } catch (caught) {
      const error = wallClock.signal.aborted
        ? wallClock.signal.reason
        : caught;
      const status = await this.db.run.findUnique({ where: { id: runId }, select: { status: true } });
      if (status?.status === "cancelling" || status?.status === "cancelled" || error instanceof RuntimeCancelledError) {
        wallClockOutcome = "cancelled";
        return { runId, cancellationPending: status?.status !== "cancelled" };
      }
      if (error instanceof RunTransitionRejectedError) return { runId, skipped: true };
      if (error instanceof RuntimeExecutionClaimBusyError || error instanceof RuntimeExecutionFencedError) {
        return { runId, skipped: true };
      }
      if (error instanceof RuntimeSubmissionUnknownError && claim) {
        await this.attempts.markSubmissionUnknown(claim, publicErrorMessage(error.cause ?? error));
        wallClockOutcome = "error";
        return { runId, submissionUnknown: true };
      }
      if (
        error instanceof RuntimeLivenessError
        && error.code === "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED"
        && claim
        && runtimeAttemptId
      ) {
        await this.cancelDeadlineExceededProvider({
          claim,
          runtimeAttemptId,
          principalId: prepared.run.createdById,
          externalThreadId,
          externalRunId,
        });
      }
      const retryable = isRetryableRuntimeError(error);
      if (retryable && retry.retryCount < retry.retryLimit) {
        if (claim) {
          await this.attempts.recordRetryableError(claim, {
            code: runtimeExecutionErrorCode(error, "RUNTIME_EXECUTION_RETRYABLE"),
            detail: publicErrorMessage(error),
          });
        }
      } else {
        await this.failRun(runId, runtimeAttemptId, error, retryable, claim);
      }
      if (!(error instanceof RuntimeLivenessError && error.code === "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED")) {
        wallClockOutcome = "error";
      }
      throw error;
    } finally {
      if (wallClockOutcome) {
        recordRuntimeLivenessMetric({
          operation: "wall-clock",
          outcome: wallClockOutcome,
          durationMs: Math.max(0, Date.now() - handlerStartedAtMs),
          ...(wallClockOutcome === "error" ? { errorCode: "RUNTIME_EXECUTION_FAILED" } : {}),
        });
      }
      wallClock.stop();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.active.delete(runId);
      this.stopCancellationPollerIfIdle();
    }
  }

  private async cancelDeadlineExceededProvider(input: {
    claim: RuntimeExecutionClaim;
    runtimeAttemptId: string;
    principalId: string;
    externalThreadId: string | null;
    externalRunId: string | null;
  }): Promise<void> {
    if (!input.externalThreadId) return;
    const startedAt = performance.now();
    const cleanupSignal = AbortSignal.timeout(this.executionDeadlineCancelMs);
    try {
      await raceWithAbort(this.runtime.cancel({
        runId: input.claim.runId,
        runtimeAttemptId: input.runtimeAttemptId,
        principalId: input.principalId,
        externalThreadId: input.externalThreadId,
        externalRunId: input.externalRunId,
      }, async (candidateExternalRunId) => {
        await this.attempts.attachExternalRun(input.claim, candidateExternalRunId);
      }, cleanupSignal), cleanupSignal);
      recordRuntimeLivenessMetric({
        operation: "cancel",
        outcome: "cancelled",
        durationMs: performance.now() - startedAt,
      });
    } catch {
      recordRuntimeLivenessMetric({
        operation: "cancel",
        outcome: cleanupSignal.aborted ? "timeout" : "error",
        durationMs: performance.now() - startedAt,
        errorCode: cleanupSignal.aborted
          ? "RUNTIME_PROVIDER_CANCEL_TIMEOUT"
          : "RUNTIME_PROVIDER_CANCEL_FAILED",
      });
      // The local deadline remains authoritative. The claim-fenced terminal
      // transition below prevents late provider callbacks from mutating state.
    }
  }

  async cancel(
    runId: string,
    jobSignal?: AbortSignal,
    retry = { retryCount: 0, retryLimit: 0 },
  ) {
    this.active.get(runId)?.abort(new RuntimeCancelledError());
    const run = await this.db.run.findUnique({
      where: { id: runId },
      select: {
        status: true,
        createdById: true,
        runtimeAttempts: { orderBy: { attempt: "desc" }, take: 1 },
      },
    });
    if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
    if (terminalStatuses.has(run.status)) return { runId, cancelled: run.status === "cancelled" };
    if (run.status !== "cancelling") throw new Error("RUNTIME_CANCEL_STATE_INVALID");

    const initialAttempt = run.runtimeAttempts[0];
    if (!initialAttempt) {
      await this.finalizeCancellation(runId, "Cancelled before runtime submission");
      return { runId, cancelled: true };
    }
    const attempt = await this.attempts.beginCancellation(runId, initialAttempt.id);
    if (!attempt.externalRunId && attempt.status === "pending") {
      await this.finalizeCancellation(runId, "Cancelled before runtime submission", attempt.id);
      return { runId, cancelled: true };
    }
    if (["succeeded", "failed", "cancelled", "waiting_input"].includes(attempt.status)) {
      await this.finalizeCancellation(runId, "Cancelled by user", attempt.id);
      return { runId, cancelled: true };
    }

    const result = await this.runtime.cancel({
      runId,
      runtimeAttemptId: attempt.id,
      principalId: run.createdById,
      externalThreadId: attempt.externalThreadId,
      externalRunId: attempt.externalRunId,
    }, async (externalRunId) => {
      await this.attempts.attachExternalRunForCancellation(attempt.id, externalRunId);
    }, jobSignal);
    if (!result.found) {
      const submissionAgeMs = attempt.startedAt
        ? Date.now() - attempt.startedAt.getTime()
        : 0;
      if (submissionAgeMs < this.cancellationRecoveryWindowMs) {
        throw new Error("RUNTIME_EXTERNAL_RUN_UNRESOLVED");
      }
      await this.finalizeCancellation(
        runId,
        "Cancelled after external Run creation window elapsed",
        attempt.id,
      );
      return { runId, cancelled: true, externalRunAbsent: true };
    }
    await this.finalizeCancellation(runId, "Cancelled by user", attempt.id);
    return { runId, cancelled: true };
  }

  private async prepare(runId: string, approvalIds: string[]) {
    return this.db.$transaction(async (tx) => {
      if (!(await lockRunForPreparation(tx, runId))) {
        throw new Error(`RUN_NOT_FOUND:${runId}`);
      }
      let run = await tx.run.findUnique({
        where: { id: runId },
        include: runPreparationInclude,
      });
      if (!run) throw new Error(`RUN_NOT_FOUND:${runId}`);
      if (terminalStatuses.has(run.status)) return null;
      if (run.status === "cancelling") return null;
      const recovering = run.status === "running";
      if (!recovering && run.status !== "queued") return null;
      if (recovering && run.attempt < 1) throw new Error("RUNTIME_ATTEMPT_INVALID");
      const request = startRunRequestSchema.parse(run.request);
      const artifactTargets = await loadRuntimeArtifactTargets(
        tx,
        run.projectId,
        request,
      );
      const designStyleSnapshot = persistedDesignStyleSnapshot(run, request);
      const designAssets = await loadRuntimeDesignAssets(tx, designStyleSnapshot);

      let resume: RuntimeResumeDecision[] | null = null;
      if (approvalIds.length > 0) {
        const resumableAttempt = recovering ? run.attempt - 1 : run.attempt;
        const approvals = await tx.runApproval.findMany({
          where: { id: { in: approvalIds }, runId },
        });
        const byId = new Map(approvals.map((approval) => [approval.id, approval]));
        if (approvals.length !== new Set(approvalIds).size) throw new Error("RUNTIME_RESUME_APPROVAL_MISSING");
        resume = approvalIds.map((approvalId) => {
          const approval = byId.get(approvalId);
          if (!approval || approval.status === "pending" || approval.status === "expired") {
            throw new Error("RUNTIME_RESUME_APPROVAL_NOT_DECIDED");
          }
          if (approval.attempt !== resumableAttempt) throw new Error("RUNTIME_RESUME_APPROVAL_STALE");
          const response = approvalResponseSchema.parse(approval.response);
          if (!response) throw new Error("RUNTIME_RESUME_APPROVAL_RESPONSE_MISSING");
          return runtimeResumeDecisionSchema.parse({
            key: approval.key,
            decision: response.decision,
            ...(response.value === undefined ? {} : { value: response.value }),
          });
        });
      }

      if (recovering) {
        if (!run.outputEntryId) throw new Error("RUNTIME_OUTPUT_ENTRY_MISSING");
        await this.prototypePatches.activateRunTx(tx, runId);
        const prototypePatchBaselines = await this.prototypePatches.loadRunBaselinesTx(tx, runId);
        return {
          run,
          thread: run.thread,
          project: run.thread.project,
          entryId: run.outputEntryId,
          request,
          artifactTargets,
          prototypePatchBaselines,
          designStyleSnapshot,
          designAssets,
          sources: mapRuntimeSources(run.sourceSnapshots),
          resume,
          previousAssistantText: draftText(run.draft?.content),
        };
      }

      let entryId = run.outputEntryId;
      let createdOutputEntry = false;
      if (!entryId) {
        const thread = await tx.thread.update({
          where: { id: run.threadId },
          data: { entrySequence: { increment: 1 }, revision: { increment: 1 } },
        });
        const entry = await tx.threadEntry.create({
          data: {
            threadId: run.threadId,
            sequence: thread.entrySequence,
            role: "assistant",
            kind: "message",
            producedByRunId: run.id,
            content: { protocol: "workbench.entry.v1", type: "assistant.message", text: "" },
          },
        });
        entryId = entry.id;
        createdOutputEntry = true;
      }

      const started = await tx.run.updateMany({
        where: { id: runId, status: "queued" },
        data: {
          status: "running",
          phase: "understanding",
          phaseLabel: "正在理解需求",
          progress: null,
          attempt: { increment: 1 },
          startedAt: run.startedAt ?? new Date(),
          outputEntryId: entryId,
        },
      });
      await assertRunTransition(tx, runId, started);
      run = await tx.run.findUniqueOrThrow({
        where: { id: runId },
        include: runPreparationInclude,
      });
      await this.prototypePatches.activateRunTx(tx, runId);
      const prototypePatchBaselines = await this.prototypePatches.loadRunBaselinesTx(tx, runId);
      await this.events.append(tx, runId, "run.started", { attempt: run.attempt });
      await this.events.appendOnce(
        tx,
        runId,
        "run.generation.stage.changed",
        { attempt: run.attempt, stage: "thinking" },
        `system:run-generation-stage:${run.attempt}:thinking`,
      );
      if (createdOutputEntry) await this.events.append(tx, runId, "message.started", { entryId });
      await this.events.append(tx, runId, "run.phase.changed", {
        phase: "understanding",
        label: "正在理解需求",
        progress: null,
      });
      return {
        run,
        thread: run.thread,
        project: run.thread.project,
        entryId,
        request,
        artifactTargets,
        prototypePatchBaselines,
        designStyleSnapshot,
        designAssets,
        sources: mapRuntimeSources(run.sourceSnapshots),
        resume,
        previousAssistantText: draftText(run.draft?.content),
      };
    });
  }

  private async persistRuntimeEffectsTx(
    tx: Prisma.TransactionClient,
    claim: RuntimeExecutionClaim,
    context: RuntimePersistenceContext,
    initialFullText: string,
    effects: RuntimeProgressEvent[],
  ) {
    let fullText = initialFullText;
    for (const event of effects) {
      if (event.type === "text.delta") {
        fullText += event.delta;
        await this.persistDeltaTx(tx, claim.runId, context.entryId, fullText, event.delta);
        continue;
      }
      if (event.type === "artifact.draft") {
        await this.persistArtifactDraftTx(
          tx,
          claim.runId,
          claim.attemptId,
          event,
          context.sources,
          context.designAssets,
          context.artifactTargets,
        );
        continue;
      }
      if (event.type === "artifact.prototype.patch") {
        await this.prototypePatches.persistPatchTx(tx, claim.runId, claim.attemptId, event);
        continue;
      }
      await this.persistProgressTx(tx, claim.runId, event);
    }
    return fullText;
  }

  private async terminalizeRunningActivitiesTx(
    tx: Prisma.TransactionClient,
    claim: RuntimeExecutionClaim,
  ) {
    const activities = await tx.$queryRaw<Array<{
      activityId: string | null;
      label: string | null;
      detail: string | null;
    }>>(Prisma.sql`
      SELECT
        latest."payload"->>'activityId' AS "activityId",
        latest."payload"->>'label' AS "label",
        latest."payload"->>'detail' AS "detail"
      FROM (
        SELECT DISTINCT ON (event."payload"->>'activityId') event."payload", event."sequence"
        FROM "run_events" AS event
        WHERE event."run_id" = ${claim.runId}
          AND event."type" = 'activity.changed'
        ORDER BY event."payload"->>'activityId', event."sequence" DESC
      ) AS latest
      WHERE latest."payload"->>'status' = 'running'
      ORDER BY latest."payload"->>'activityId'
    `);
    for (const activity of activities) {
      if (!activity.activityId || !activity.label) {
        throw new Error("RUNTIME_ACTIVITY_EVENT_INVALID");
      }
      await this.events.appendOnce(
        tx,
        claim.runId,
        "activity.changed",
        {
          activityId: activity.activityId,
          status: "succeeded",
          label: activity.label,
          detail: activity.detail,
        },
        runtimeFinalizationActivitySourceId(claim.attemptId, activity.activityId),
      );
    }
  }

  private async waitForInput(claim: RuntimeExecutionClaim, input: RuntimeInputRequired) {
    const { runId, attemptId: runtimeAttemptId } = claim;
    await this.db.$transaction(async (tx) => {
      await this.assertActiveClaimTx(tx, claim);
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (run.status !== "running") throw new RuntimeCancelledError();
      const runtimeAttempt = await tx.runtimeAttempt.findUniqueOrThrow({ where: { id: runtimeAttemptId } });
      if (runtimeAttempt.runId !== runId || runtimeAttempt.status !== "running") {
        throw new Error("RUNTIME_ATTEMPT_WAIT_STATE_INVALID");
      }
      const waiting = await tx.run.updateMany({
        where: {
          id: runId,
          status: "running",
          executionOwnerId: claim.ownerId,
          executionEpoch: claim.epoch,
        },
        data: { status: "waiting_input", ...releasedExecutionLease() },
      });
      await assertRunTransition(tx, runId, waiting);
      await this.prototypePatches.pauseRunTx(tx, runId);
      const attemptWaiting = await tx.runtimeAttempt.updateMany({
        where: {
          id: runtimeAttemptId,
          runId,
          status: "running",
          executionOwnerId: claim.ownerId,
          executionEpoch: claim.epoch,
        },
        data: {
          status: "waiting_input",
          finishedAt: new Date(),
          ...releasedExecutionLease(),
        },
      });
      if (attemptWaiting.count !== 1) throw new Error("RUNTIME_ATTEMPT_WAIT_STATE_INVALID");
      await this.cancelCanvasSessionsTx(tx, runId, new Date(), runtimeAttemptId);

      for (const request of input.approvals) {
        let approval = await tx.runApproval.findUnique({
          where: {
            runId_key_attempt: {
              runId,
              key: request.key,
              attempt: run.attempt,
            },
          },
        });
        if (!approval) {
          approval = await tx.runApproval.create({
            data: {
              runId,
              key: request.key,
              kind: request.kind,
              prompt: request.prompt,
              options: request.options as Prisma.InputJsonArray,
              attempt: run.attempt,
            },
          });
          const options = approvalOptionsSchema.parse(approval.options);
          await this.events.append(tx, runId, "run.input.required", {
            approvalId: approval.id,
            kind: approval.kind,
            prompt: approval.prompt,
            options,
            attempt: approval.attempt,
          });
        }
      }
    });
  }

  private async persistProgress(
    claim: RuntimeExecutionClaim,
    event: Exclude<
      RuntimeProgressEvent,
      { type: "text.delta" } | { type: "artifact.draft" } | { type: "artifact.prototype.patch" }
    >,
  ) {
    await this.db.$transaction(async (tx) => {
      await this.assertActiveClaimTx(tx, claim);
      await this.persistProgressTx(tx, claim.runId, event);
    });
  }

  private async persistProgressTx(
    tx: Prisma.TransactionClient,
    runId: string,
    event: Exclude<
      RuntimeProgressEvent,
      { type: "text.delta" } | { type: "artifact.draft" } | { type: "artifact.prototype.patch" }
    >,
  ) {
    if (event.type === "phase") {
        await tx.run.update({
          where: { id: runId },
          data: {
            phase: event.phase,
            phaseLabel: event.label,
            progress: event.progress,
          },
        });
        await this.events.append(tx, runId, "run.phase.changed", {
          phase: event.phase,
          label: event.label,
          progress: event.progress,
        });
      return;
    }
    if (event.type === "generation.stage") {
      await this.persistGenerationStage(tx, runId, event);
      return;
    }
    await this.events.append(tx, runId, "activity.changed", {
        activityId: event.activityId,
        status: event.status,
        label: event.label,
        detail: event.detail,
    });
  }

  private async persistGenerationStage(
    tx: Prisma.TransactionClient,
    runId: string,
    event: Extract<RuntimeProgressEvent, { type: "generation.stage" }>,
  ) {
    const run = await tx.run.findUniqueOrThrow({
      where: { id: runId },
      select: { attempt: true, phase: true, phaseLabel: true },
    });
    const payload = { attempt: run.attempt, stage: event.stage };
    const replayed = await tx.runEvent.findFirst({
      where: { runId, sourceId: event.sourceEventId },
      select: { type: true, payload: true },
    });
    if (replayed) {
      if (
        replayed.type !== "run.generation.stage.changed"
        || canonicalJson(replayed.payload) !== canonicalJson(payload)
      ) {
        throw new Error("RUN_EVENT_SOURCE_CONFLICT");
      }
      return;
    }
    const latestEvents = await tx.runEvent.findMany({
      where: { runId, type: "run.generation.stage.changed" },
      orderBy: { sequence: "desc" },
      take: 32,
      select: { payload: true },
    });
    const currentStage = currentGenerationStage(latestEvents, run.attempt);
    if (currentStage) {
      const currentRank = generationStageRank(currentStage);
      const nextRank = generationStageRank(event.stage);
      if (nextRank < currentRank) throw new Error("RUNTIME_GENERATION_STAGE_REGRESSION");
      if (nextRank === currentRank) throw new Error("RUNTIME_GENERATION_STAGE_DUPLICATE");
      assertGenerationStageTransition(currentStage, event.stage);
    } else if (generationStageRank(event.stage) <= generationStageRank("generating-ui")) {
      throw new Error("RUNTIME_GENERATION_STAGE_TRANSITION_INVALID");
    }

    const presentation = generationStagePresentation(event.stage);
    await tx.run.update({
      where: { id: runId },
      data: {
        phase: presentation.phase,
        phaseLabel: presentation.label,
        progress: null,
      },
    });
    await this.events.appendOnce(
      tx,
      runId,
      "run.generation.stage.changed",
      payload,
      event.sourceEventId,
    );
    if (run.phase !== presentation.phase || run.phaseLabel !== presentation.label) {
      await this.events.append(tx, runId, "run.phase.changed", {
        phase: presentation.phase,
        label: presentation.label,
        progress: null,
      });
    }
  }

  private async persistDelta(
    claim: RuntimeExecutionClaim,
    entryId: string,
    fullText: string,
    delta: string,
  ) {
    await this.db.$transaction(async (tx) => {
      await this.assertActiveClaimTx(tx, claim);
      await this.persistDeltaTx(tx, claim.runId, entryId, fullText, delta);
    });
  }

  private async persistDeltaTx(
    tx: Prisma.TransactionClient,
    runId: string,
    entryId: string,
    fullText: string,
    delta: string,
  ) {
    await tx.runDraft.upsert({
      where: { runId },
        create: {
          runId,
          content: { entryId, text: fullText },
        },
        update: {
          version: { increment: 1 },
          content: { entryId, text: fullText },
        },
    });
    await this.events.append(tx, runId, "message.delta", { entryId, delta });
  }

  private async persistArtifactDraft(
    claim: RuntimeExecutionClaim,
    event: Extract<RuntimeProgressEvent, { type: "artifact.draft" }>,
    sources: RuntimeSource[],
    designAssets: RuntimeDesignAsset[],
    artifactTargets: RuntimeArtifactTarget[] = [],
  ) {
    await this.db.$transaction(async (tx) => {
      await this.assertActiveClaimTx(tx, claim);
      await this.persistArtifactDraftTx(
        tx,
        claim.runId,
        claim.attemptId,
        event,
        sources,
        designAssets,
        artifactTargets,
      );
    });
  }

  private async persistArtifactDraftTx(
    tx: Prisma.TransactionClient,
    runId: string,
    runtimeAttemptId: string,
    event: Extract<RuntimeProgressEvent, { type: "artifact.draft" }>,
    sources: RuntimeSource[],
    designAssets: RuntimeDesignAsset[],
    artifactTargets: RuntimeArtifactTarget[] = [],
  ) {
      const run = await tx.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
          id: true,
          projectId: true,
          attempt: true,
          request: true,
          knowledgeReleaseId: true,
        },
      });
      const runtimeAttempt = await tx.runtimeAttempt.findUniqueOrThrow({
        where: { id: runtimeAttemptId },
        select: { id: true, runId: true, attempt: true, status: true },
      });
      if (
        runtimeAttempt.runId !== runId
        || runtimeAttempt.attempt !== run.attempt
        || runtimeAttempt.status !== "running"
      ) {
        throw new Error("RUNTIME_ARTIFACT_DRAFT_ATTEMPT_INVALID");
      }
      const request = startRunRequestSchema.parse(run.request);
      const checksum = sha256Canonical(event.draft.content);
      const replayed = await tx.runEvent.findFirst({
        where: { runId, sourceId: event.sourceEventId },
        select: { type: true, payload: true },
      });
      if (replayed) {
        assertMatchingRuntimeArtifactDraftReplay(replayed, run.attempt, event, checksum);
        return;
      }

      validateRuntimeArtifactDraftOperation(request, event.draft);
      if (event.draft.kind === "prd" || event.draft.kind === "prototype") {
        await assertArtifactDraftStageReady(tx, runId, run.attempt, event.draft.kind);
      }
      const target = event.draft.operation.kind === "revise"
        ? await lockRuntimeArtifactDraftTarget(tx, run, event.draft)
        : null;
      const assetPins = prototypeAssetPins(
        event.draft,
        sources,
        designAssets,
        target?.baseAssets,
        request.workflow === "generate"
          ? artifactTargets.flatMap((artifactTarget) => artifactTarget.assets)
          : [],
      );
      let version = await tx.artifactVersion.findUnique({
        where: {
          createdByRunId_runtimeDraftIndex: {
            createdByRunId: runId,
            runtimeDraftIndex: event.artifactIndex,
          },
        },
        include: {
          artifact: {
            select: { id: true, kind: true, title: true, currentVersionId: true },
          },
        },
      });
      if (version) {
        assertRuntimeArtifactDraftIdentity(version, run, event, target);
        version = await tx.artifactVersion.update({
          where: { id: version.id },
          data: {
            content: event.draft.content as Prisma.InputJsonValue,
            checksum,
            citations: event.draft.citations as Prisma.InputJsonArray,
          },
          include: {
            artifact: {
              select: { id: true, kind: true, title: true, currentVersionId: true },
            },
          },
        });
        await tx.artifactVersionAsset.deleteMany({
          where: { artifactVersionId: version.id },
        });
      } else {
        const artifact = target?.artifact ?? await tx.artifact.create({
          data: {
            projectId: run.projectId,
            kind: event.draft.kind,
            title: event.draft.title,
          },
        });
        version = await tx.artifactVersion.create({
          data: {
            artifactId: artifact.id,
            projectId: run.projectId,
            version: target?.version ?? 1,
            schemaVersion: event.draft.schemaVersion,
            status: "staging",
            content: event.draft.content as Prisma.InputJsonValue,
            checksum,
            citations: event.draft.citations as Prisma.InputJsonArray,
            createdByRunId: runId,
            runtimeDraftSourceId: event.sourceEventId,
            runtimeDraftIndex: event.artifactIndex,
            runtimeDraftTitle: event.draft.title,
            knowledgeReleaseId: run.knowledgeReleaseId ?? target?.knowledgeReleaseId ?? null,
          },
          include: {
            artifact: {
              select: { id: true, kind: true, title: true, currentVersionId: true },
            },
          },
        });
      }
      if (assetPins.length > 0) {
        await tx.artifactVersionAsset.createMany({
          data: assetPins.map((pin) => ({
            artifactVersionId: version.id,
            artifactId: version.artifact.id,
            projectId: run.projectId,
            assetId: pin.assetId,
            kind: pin.kind,
            blobId: pin.blobId,
            mediaType: pin.mediaType,
            byteSize: BigInt(pin.byteSize),
            sha256: pin.sha256,
            metadata: pin.metadata as Prisma.InputJsonValue,
          })),
        });
      }
      const checkpointScreens = isPrototypeDraft(event.draft)
        ? await this.prototypePatches.synchronizeCheckpointTx(tx, {
            runId,
            artifactVersionId: version.id,
            artifactId: version.artifact.id,
            projectId: run.projectId,
            document: event.draft.content,
            checkpointScreens: event.checkpointScreens,
          })
        : (() => {
            if (event.checkpointScreens.length > 0) {
              throw new Error("RUNTIME_ARTIFACT_DRAFT_CHECKPOINT_SCREENS_INVALID");
            }
            return [];
          })();
    await this.events.appendOnce(
        tx,
        runId,
        "artifact.draft.created",
        runtimeArtifactDraftEventPayload(
          run.attempt,
          event,
          version.artifact.id,
          version.id,
          checksum,
          checkpointScreens,
        ),
        event.sourceEventId,
    );
  }

  private async publishResult(
    claim: RuntimeExecutionClaim,
    entryId: string,
    streamedText: string,
    result: RuntimeResult,
  ) {
    const { runId, attemptId: runtimeAttemptId } = claim;
    await this.db.$transaction(async (tx) => {
      await this.assertActiveClaimTx(tx, claim);
      const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
      if (run.status !== "running") throw new RuntimeExecutionFencedError();
      const request = startRunRequestSchema.parse(run.request);
      const runtimeAttempt = await tx.runtimeAttempt.findUniqueOrThrow({ where: { id: runtimeAttemptId } });
      if (runtimeAttempt.runId !== runId || runtimeAttempt.status !== "running") {
        throw new Error("RUNTIME_ATTEMPT_PUBLISH_STATE_INVALID");
      }
      const canvasPublication = await this.assertCanvasSessionPublishable(
        tx,
        runId,
        runtimeAttemptId,
      );
      if (canvasPublication?.intents.mode === "quick_edit") {
        assertExactCanvasQuickEditTarget(request, canvasPublication.intents.target);
      }
      validateRuntimeArtifactOperations(request, result);
      const directPlan = canvasPublication?.intents.mode === "direct"
        ? planCanvasDirectIntentsOverRuntimeResult(
            request,
            result,
            canvasPublication.intents.intents,
          )
        : null;
      if (directPlan) {
        await this.synchronizeStagedCanvasIntentDraft(tx, run, directPlan);
      }
      const effectiveResult = directPlan?.effectiveResult ?? result;

      const finalText = result.message || streamedText;
      await tx.threadEntry.update({
        where: { id: entryId },
        data: { content: { protocol: "workbench.entry.v1", type: "assistant.message", text: finalText } },
      });
      await tx.runDraft.deleteMany({ where: { runId } });

      const board = await tx.board.findUniqueOrThrow({ where: { projectId: run.projectId } });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "boards" WHERE "id" = ${board.id} FOR UPDATE`);
      const existingNodes = await tx.boardNode.findMany({
        where: { boardId: board.id },
        select: { position: true, size: true },
      });
      const rootOrder = await tx.boardNode.aggregate({
        where: { boardId: board.id, parentNodeKey: null },
        _max: { sortOrder: true },
      });
      const artifactEvents: PublishedArtifactVersion[] = [];
      let nextNodeX = nextAvailableBoardNodeX(existingNodes);
      let nextNodeOrder = (rootOrder._max.sortOrder ?? -1) + 1;
      for (const [artifactIndex, draft] of effectiveResult.artifacts.entries()) {
        if (draft.operation.kind === "revise") {
          let version: { id: string; artifactId: string; version: number };
          if (directPlan && directPlan.artifactIndex === artifactIndex && canvasPublication) {
            version = await this.promoteCanvasDirectIntentRevision(
              tx,
              run,
              board,
              canvasPublication,
              directPlan,
              draft,
              artifactIndex,
            );
          } else if (canvasPublication?.intents.mode === "quick_edit") {
            version = await this.promoteCanvasQuickEditRevision(
              tx,
              run,
              board,
              { ...canvasPublication, intents: canvasPublication.intents },
              draft,
              artifactIndex,
            );
          } else {
            version = await this.promoteStagedArtifactRevision(
              tx,
              run,
              board.id,
              draft,
              artifactIndex,
            );
          }
          artifactEvents.push({
            artifactId: version.artifactId,
            artifactVersionId: version.id,
            version: version.version,
          });
          continue;
        }
        const checksum = sha256Canonical(draft.content);
        const version = await tx.artifactVersion.findFirst({
          where: {
            createdByRunId: runId,
            runtimeDraftIndex: artifactIndex,
            status: "staging",
          },
          include: { artifact: true },
        });
        if (!version) throw new Error("RUNTIME_ARTIFACT_DRAFT_MISSING");
        assertStagedRuntimeArtifactDraft(
          version,
          draft,
          artifactIndex,
          checksum,
          "RUNTIME_FINAL_ARTIFACT_DIVERGED",
        );
        const artifact = version.artifact;
        if (artifact.currentVersionId !== null || version.version !== 1) {
          throw new Error("RUNTIME_ARTIFACT_DRAFT_CREATE_STATE_INVALID");
        }
        await lockAndAssertStagedPrototypeAssets(
          tx,
          version.id,
          draft,
          "RUNTIME_ARTIFACT_CREATE_ASSET_INVALID",
        );
        if (isPrototypeDraft(draft)) {
          await this.prototypePatches.finalizeVersionTx(
            tx,
            version.id,
            draft.content,
            new Date(),
          );
        }
        await tx.artifactVersion.update({
          where: { id: version.id },
          data: { status: "ready" },
        });
        await tx.artifact.update({
          where: { id: artifact.id },
          data: { title: draft.title, currentVersionId: version.id },
        });
        for (const placement of boardPlacementsForArtifact(draft)) {
          await tx.boardNode.create({
            data: {
              boardId: board.id,
              projectId: run.projectId,
              nodeKey: `artifact:${artifact.id}:${placement.key}`,
              sortOrder: nextNodeOrder,
              kind: "artifact",
              position: { x: nextNodeX, y: 0 },
              size: placement.size,
              artifactId: artifact.id,
              artifactVersionId: version.id,
              data: placement.data,
            },
          });
          nextNodeOrder += 1;
          nextNodeX += placement.size.width + 80;
        }
        artifactEvents.push({
          artifactId: artifact.id,
          artifactVersionId: version.id,
          version: version.version,
        });
      }
      let canvasPublicationBoardRevision: number | undefined;
      if (canvasPublication?.intents.mode === "direct") {
        canvasPublicationBoardRevision = canvasPublication.boardRevision + 1;
      } else if (canvasPublication?.intents.mode === "quick_edit") {
        canvasPublicationBoardRevision = await this.linkQuickEditPublication(
          tx,
          board.id,
          { ...canvasPublication, intents: canvasPublication.intents },
          artifactEvents,
        );
      }
      const finishedAt = new Date();
      const completed = await tx.run.updateMany({
        where: {
          id: runId,
          status: "running",
          executionOwnerId: claim.ownerId,
          executionEpoch: claim.epoch,
        },
        data: {
          status: "succeeded",
          progress: 1,
          finishedAt,
          errorCode: null,
          errorDetail: null,
          errorRetryable: null,
          ...releasedExecutionLease(),
        },
      });
      await assertRunTransition(tx, runId, completed);
      const completedAttempt = await tx.runtimeAttempt.updateMany({
        where: {
          id: runtimeAttemptId,
          runId,
          status: "running",
          executionOwnerId: claim.ownerId,
          executionEpoch: claim.epoch,
        },
        data: {
          status: "succeeded",
          finishedAt,
          errorCode: null,
          errorDetail: null,
          errorRetryable: null,
          ...releasedExecutionLease(),
        },
      });
      if (completedAttempt.count !== 1) throw new Error("RUNTIME_ATTEMPT_PUBLISH_STATE_INVALID");
      if (canvasPublication) {
        await this.completeCanvasSessionTx(
          tx,
          canvasPublication.agentSessionId,
          finishedAt,
          canvasPublicationBoardRevision,
        );
      }
      for (const payload of artifactEvents) {
        await this.events.append(tx, runId, "artifact.version.created", payload);
      }
      if (
        effectiveResult.artifacts.some((artifact) => artifact.kind === "prototype")
        || canvasPublication?.intents.mode === "direct"
      ) {
        await this.events.appendOnce(
          tx,
          runId,
          "run.generation.stage.changed",
          { attempt: run.attempt, stage: "screen-stable" },
          `system:run-generation-stage:${run.attempt}:screen-stable`,
        );
      }
      await this.events.append(tx, runId, "message.completed", { entryId });
      await this.events.append(tx, runId, "run.completed", { artifactCount: artifactEvents.length });
    });
  }

  private async linkQuickEditPublication(
    tx: Prisma.TransactionClient,
    boardId: string,
    publication: CanvasPublicationContext & {
      intents: Extract<CanvasPublicationIntents, { mode: "quick_edit" }>;
    },
    artifactEvents: readonly PublishedArtifactVersion[],
  ) {
    const target = publication.intents.target;
    const published = artifactEvents.filter((event) => event.artifactId === target.artifactId);
    if (artifactEvents.length !== 1 || published.length !== 1) {
      throw new Error("CANVAS_QUICK_EDIT_PUBLICATION_TARGET_INVALID");
    }
    const board = await tx.board.findUniqueOrThrow({
      where: { id: boardId },
      select: { revision: true },
    });
    // A quick edit is authorized against one exact board snapshot. Applying it
    // to a newer revision would silently overwrite concurrent user changes.
    if (board.revision !== publication.boardRevision + 1) {
      throw new Error("CANVAS_QUICK_EDIT_BOARD_REVISION_INVALID");
    }
    const linked = await tx.canvasToolInvocation.updateMany({
      where: {
        agentSessionId: publication.agentSessionId,
        id: { in: publication.intents.invocationIds },
        status: "succeeded",
        satisfiesRunTarget: true,
        targetArtifactId: target.artifactId,
        targetArtifactVersionId: target.artifactVersionId,
        targetScreenId: target.screenId,
      },
      data: {
        resultArtifactVersionId: published[0]!.artifactVersionId,
        boardRevisionAfter: board.revision,
        canvasStateRevisionAfter: publication.canvasStateRevision,
      },
    });
    if (linked.count !== publication.intents.invocationIds.length) {
      throw new Error("CANVAS_QUICK_EDIT_PUBLICATION_CONFLICT");
    }
    return board.revision;
  }

  private async promoteCanvasQuickEditRevision(
    tx: Prisma.TransactionClient,
    run: { id: string; projectId: string; knowledgeReleaseId: string | null },
    board: { id: string; projectId: string; revision: number },
    publication: CanvasPublicationContext & {
      intents: Extract<CanvasPublicationIntents, { mode: "quick_edit" }>;
    },
    draft: RuntimeArtifactDraft,
    artifactIndex: number,
  ) {
    if (
      board.id !== publication.boardId
      || board.projectId !== run.projectId
      || board.revision !== publication.boardRevision
    ) {
      throw new Error("CANVAS_QUICK_EDIT_BOARD_REVISION_INVALID");
    }
    const resultBoardRevision = publication.boardRevision + 1;
    const claimed = await tx.board.updateMany({
      where: {
        id: board.id,
        projectId: run.projectId,
        revision: publication.boardRevision,
      },
      data: { revision: resultBoardRevision },
    });
    if (claimed.count !== 1) throw new Error("CANVAS_QUICK_EDIT_BOARD_REVISION_INVALID");

    return withBoardRevisionOwner(tx, board.id, resultBoardRevision, () => (
      this.promoteStagedArtifactRevision(
        tx,
        run,
        board.id,
        draft,
        artifactIndex,
      )
    ));
  }

  private async synchronizeStagedCanvasIntentDraft(
    tx: Prisma.TransactionClient,
    run: { id: string; attempt: number },
    plan: CanvasDirectIntentRuntimePlan,
  ) {
    const staged = await tx.artifactVersion.findFirst({
      where: {
        createdByRunId: run.id,
        runtimeDraftIndex: plan.artifactIndex,
        status: "staging",
      },
      include: { artifact: true },
    });
    if (!staged) throw new Error("RUNTIME_ARTIFACT_DRAFT_MISSING");
    const originalChecksum = sha256Canonical(plan.originalDraft.content);
    assertStagedRuntimeArtifactDraft(
      staged,
      plan.originalDraft,
      plan.artifactIndex,
      originalChecksum,
    );
    const synchronized = await tx.artifactVersion.updateMany({
      where: {
        id: staged.id,
        status: "staging",
        checksum: originalChecksum,
      },
      data: {
        content: plan.effectiveDraft.content as Prisma.InputJsonValue,
        checksum: sha256Canonical(plan.effectiveDraft.content),
        citations: plan.effectiveDraft.citations as Prisma.InputJsonArray,
        runtimeDraftTitle: plan.effectiveDraft.title,
      },
    });
    if (synchronized.count !== 1) {
      throw new Error("CANVAS_DIRECT_INTENT_STAGING_CONFLICT");
    }
    if (!isPrototypeDraft(plan.effectiveDraft)) {
      throw new Error("CANVAS_DIRECT_INTENT_RUNTIME_REVISION_INVALID");
    }
    const checkpointScreens = await this.prototypePatches.synchronizeCheckpointTx(tx, {
      runId: run.id,
      artifactVersionId: staged.id,
      artifactId: staged.artifactId,
      projectId: staged.projectId,
      document: plan.effectiveDraft.content,
      mode: "trusted_final",
    });
    await this.events.appendOnce(
      tx,
      run.id,
      "artifact.draft.created",
      {
        attempt: run.attempt,
        artifactIndex: plan.artifactIndex,
        artifactId: staged.artifactId,
        artifactVersionId: staged.id,
        kind: "prototype",
        checksum: sha256Canonical(plan.effectiveDraft.content),
        draftChecksum: sha256Canonical(plan.effectiveDraft),
        screens: checkpointScreens,
      },
      `system:canvas-direct-intent-checkpoint:${run.attempt}:${plan.artifactIndex}`,
    );
  }

  private async promoteCanvasDirectIntentRevision(
    tx: Prisma.TransactionClient,
    run: { id: string; projectId: string; knowledgeReleaseId: string | null },
    board: { id: string; projectId: string; revision: number },
    publication: CanvasPublicationContext,
    plan: CanvasDirectIntentRuntimePlan,
    draft: RuntimeArtifactDraft,
    artifactIndex: number,
  ) {
    if (
      board.id !== publication.boardId
      || board.projectId !== run.projectId
      || board.revision !== publication.boardRevision
    ) {
      throw new Error("CANVAS_DIRECT_INTENT_BOARD_REVISION_CONFLICT");
    }
    const resultBoardRevision = board.revision + 1;
    const updatedBoard = await tx.board.updateMany({
      where: { id: board.id, revision: board.revision },
      data: { revision: resultBoardRevision },
    });
    if (updatedBoard.count !== 1) {
      throw new Error("CANVAS_DIRECT_INTENT_BOARD_REVISION_CONFLICT");
    }

    const ready = await withBoardRevisionOwner(tx, board.id, resultBoardRevision, async () => {
      const promoted = await this.promoteStagedArtifactRevision(
        tx,
        run,
        board.id,
        draft,
        artifactIndex,
        plan.originalDraft,
      );
      await this.createCanvasDuplicateBoardNodes(
        tx,
        run.projectId,
        board.id,
        promoted.id,
        plan,
      );
      return promoted;
    });

    const intents = plan.intents;
    const target = intents[0]!.target;
    const published = await tx.canvasToolInvocation.updateMany({
      where: {
        agentSessionId: publication.agentSessionId,
        id: { in: intents.map((intent) => intent.id) },
        status: "succeeded",
        satisfiesRunTarget: true,
        targetArtifactId: target.artifactId,
        targetArtifactVersionId: target.artifactVersionId,
        targetScreenId: target.screenId,
      },
      data: {
        resultArtifactVersionId: ready.id,
        boardRevisionAfter: resultBoardRevision,
        canvasStateRevisionAfter: publication.canvasStateRevision,
      },
    });
    if (published.count !== intents.length) {
      throw new Error("CANVAS_DIRECT_INTENT_PUBLICATION_CONFLICT");
    }
    return ready;
  }

  private async createCanvasDuplicateBoardNodes(
    tx: Prisma.TransactionClient,
    projectId: string,
    boardId: string,
    artifactVersionId: string,
    plan: CanvasDirectIntentRuntimePlan,
  ) {
    if (plan.duplicateEffects.length === 0) return;
    const reference = plan.intents[0]?.target;
    if (!reference) throw new Error("CANVAS_DIRECT_INTENT_EDIT_TARGET_INVALID");
    const targetNode = await tx.boardNode.findUnique({
      where: {
        boardId_nodeKey: {
          boardId,
          nodeKey: reference.boardNodeId,
        },
      },
    });
    const targetData = targetNode ? boardNodeDataSchema.safeParse(targetNode.data) : null;
    if (
      !targetNode
      || targetNode.projectId !== projectId
      || targetNode.artifactId !== reference.artifactId
      || targetNode.artifactVersionId !== artifactVersionId
      || !targetData?.success
      || targetData.data.nodeType !== "artifact"
      || targetData.data.screenId !== reference.screenId
    ) {
      throw new Error("CANVAS_DIRECT_INTENT_BOARD_TARGET_INVALID");
    }
    const position = boardPointSchema.parse(targetNode.position);
    const siblingOrder = await tx.boardNode.aggregate({
      where: { boardId, parentNodeKey: targetNode.parentNodeKey },
      _max: { sortOrder: true },
    });
    let nextSortOrder = (siblingOrder._max.sortOrder ?? -1) + 1;
    for (const [index, effect] of plan.duplicateEffects.entries()) {
      await tx.boardNode.create({
        data: {
          boardId,
          projectId,
          nodeKey: effect.nodeKey,
          parentNodeKey: targetNode.parentNodeKey,
          sortOrder: nextSortOrder,
          kind: "artifact",
          position: {
            x: position.x + (index + 1) * 40,
            y: position.y + (index + 1) * 40,
          },
          ...(targetNode.size === null ? {} : { size: targetNode.size }),
          artifactId: reference.artifactId,
          artifactVersionId,
          data: {
            ...targetData.data,
            title: effect.screen.name,
            screenId: effect.screen.id,
            route: effect.screen.route,
          } as Prisma.InputJsonValue,
        },
      });
      nextSortOrder += 1;
    }
  }

  private async promoteStagedArtifactRevision(
    tx: Prisma.TransactionClient,
    run: { id: string; projectId: string; knowledgeReleaseId: string | null },
    boardId: string,
    draft: RuntimeArtifactDraft,
    artifactIndex: number,
    validationDraft: RuntimeArtifactDraft = draft,
  ) {
    if (draft.operation.kind !== "revise") {
      throw new Error("RUNTIME_ARTIFACT_REVISION_OPERATION_INVALID");
    }
    const target = draft.operation.target;
    const locked = await tx.$queryRaw<Array<{
      id: string;
      kind: string;
      currentVersionId: string | null;
    }>>(Prisma.sql`
      SELECT
        "id",
        "kind"::TEXT AS "kind",
        "current_version_id" AS "currentVersionId"
      FROM "artifacts"
      WHERE "id" = ${target.artifactId}
        AND "project_id" = ${run.projectId}
      FOR UPDATE
    `);
    const artifact = locked[0];
    if (
      !artifact
      || artifact.kind !== draft.kind
      || artifact.currentVersionId !== target.artifactVersionId
    ) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_BASE_CONFLICT");
    }
    const base = await tx.artifactVersion.findUnique({
      where: {
        id_artifactId: {
          id: target.artifactVersionId,
          artifactId: target.artifactId,
        },
      },
    });
    if (
      !base
      || base.projectId !== run.projectId
      || base.status !== "ready"
      || base.content === null
      || base.contentBlobId !== null
      || base.schemaVersion !== draft.schemaVersion
    ) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_BASE_INVALID");
    }
    assertRuntimeArtifactRevisionContent(
      artifact.kind,
      base.content,
      validationDraft,
      target.screenIds,
    );

    const staged = await tx.artifactVersion.findFirst({
      where: {
        artifactId: target.artifactId,
        createdByRunId: run.id,
        runtimeDraftIndex: artifactIndex,
        status: "staging",
      },
      include: { artifact: true },
    });
    if (!staged) throw new Error("RUNTIME_ARTIFACT_DRAFT_MISSING");
    assertStagedRuntimeArtifactDraft(
      staged,
      draft,
      artifactIndex,
      sha256Canonical(draft.content),
      "RUNTIME_FINAL_ARTIFACT_DIVERGED",
    );
    if (staged.version <= base.version) {
      throw new Error("RUNTIME_ARTIFACT_DRAFT_REVISION_STATE_INVALID");
    }
    await lockAndAssertStagedPrototypeAssets(
      tx,
      staged.id,
      draft,
      "RUNTIME_ARTIFACT_REVISION_ASSET_INVALID",
    );

    if (isPrototypeDraft(draft)) {
      await this.prototypePatches.finalizeVersionTx(
        tx,
        staged.id,
        draft.content,
        new Date(),
      );
    }
    const ready = await tx.artifactVersion.update({
      where: { id: staged.id },
      data: { status: "ready" },
      select: { id: true, artifactId: true, version: true },
    });
    await tx.artifact.update({
      where: { id: target.artifactId },
      data: {
        title: draft.title,
        currentVersionId: ready.id,
        revision: { increment: 1 },
      },
    });

    const placements = boardPlacementsForArtifact(draft);
    const placementsByScreen = new Map(
      placements.flatMap((placement) => (
        placement.data.screenId ? [[placement.data.screenId, placement] as const] : []
      )),
    );
    const pinnedNodes = await tx.boardNode.findMany({
      where: {
        boardId,
        artifactId: target.artifactId,
        artifactVersionId: target.artifactVersionId,
      },
      select: { id: true, data: true },
    });
    for (const node of pinnedNodes) {
      const nodeData = asRecord(node.data);
      const screenId = typeof nodeData?.screenId === "string" ? nodeData.screenId : null;
      const placement = screenId ? placementsByScreen.get(screenId) : placements[0];
      if (!placement) throw new Error("RUNTIME_ARTIFACT_REVISION_BOARD_TARGET_INVALID");
      await tx.boardNode.update({
        where: { id: node.id },
        data: {
          artifactVersionId: ready.id,
          size: placement.size,
          data: placement.data,
        },
      });
    }
    return ready;
  }

  private async cleanupRunStagingArtifacts(
    tx: Prisma.TransactionClient,
    runId: string,
  ) {
    const stagingWhere = {
      createdByRunId: runId,
      status: "staging",
      runtimeDraftSourceId: { not: null },
      runtimeDraftIndex: { not: null },
      runtimeDraftTitle: { not: null },
    } satisfies Prisma.ArtifactVersionWhereInput;
    const stagedVersions = await tx.artifactVersion.findMany({
      where: stagingWhere,
      select: {
        id: true,
        artifactId: true,
        artifact: { select: { currentVersionId: true } },
      },
    });
    if (stagedVersions.length === 0) return;

    const temporaryArtifactIds = [...new Set(stagedVersions.flatMap((version) => (
      version.artifact.currentVersionId === null ? [version.artifactId] : []
    )))];
    const deletedVersions = await tx.artifactVersion.deleteMany({
      where: {
        ...stagingWhere,
        id: { in: stagedVersions.map((version) => version.id) },
      },
    });
    if (deletedVersions.count !== stagedVersions.length) {
      throw new Error("RUNTIME_ARTIFACT_STAGING_CLEANUP_CONFLICT");
    }
    if (temporaryArtifactIds.length === 0) return;
    const deletedArtifacts = await tx.artifact.deleteMany({
      where: {
        id: { in: temporaryArtifactIds },
        currentVersionId: null,
        versions: { none: {} },
        boardNodes: { none: {} },
        designSystemImports: { none: {} },
        designSystemCreations: { none: {} },
        versionEditReceipts: { none: {} },
        creationReceipt: null,
      },
    });
    if (deletedArtifacts.count !== temporaryArtifactIds.length) {
      throw new Error("RUNTIME_ARTIFACT_OWNER_CLEANUP_CONFLICT");
    }
  }

  private async assertCanvasSessionPublishable(
    tx: Prisma.TransactionClient,
    runId: string,
    runtimeAttemptId: string,
  ): Promise<CanvasPublicationContext | null> {
    const existing = await tx.canvasAgentSession.findUnique({
      where: { runtimeAttemptId },
      select: { id: true },
    });
    if (!existing) return null;

    // Canvas tool execution takes this same row lock before creating an
    // invocation. Holding it through publication closes the final-result race.
    const locked = await tx.$queryRaw<Array<{
      id: string;
      status: string;
      boardId: string;
      boardRevision: number;
      canvasStateRevision: number;
    }>>(Prisma.sql`
      SELECT
        "id",
        "status"::TEXT AS "status",
        "board_id" AS "boardId",
        "board_revision" AS "boardRevision",
        "canvas_state_revision" AS "canvasStateRevision"
      FROM "canvas_agent_sessions"
      WHERE "id" = ${existing.id}
        AND "runtime_attempt_id" = ${runtimeAttemptId}
        AND "run_id" = ${runId}
      FOR UPDATE
    `);
    const session = locked[0];
    if (!session || session.status !== "active") {
      throw new Error("CANVAS_AGENT_SESSION_PUBLISH_STATE_INVALID");
    }

    const pendingInvocation = await tx.canvasToolInvocation.findFirst({
      where: {
        agentSessionId: session.id,
        status: { in: ["in_flight", "waiting_client", "waiting_approval"] },
      },
      select: { id: true },
    });
    if (pendingInvocation) throw new Error("CANVAS_TOOL_INVOCATION_PENDING");

    const mutationInvocations = await tx.canvasToolInvocation.findMany({
      where: {
        agentSessionId: session.id,
        toolName: { in: ["quick_edit", "rename_screen", "duplicate_screen"] },
        status: "succeeded",
      },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      select: {
        id: true,
        sequence: true,
        toolCallId: true,
        toolName: true,
        requestHash: true,
        request: true,
        satisfiesRunTarget: true,
        targetBoardNodeId: true,
        targetArtifactId: true,
        targetArtifactVersionId: true,
        targetScreenId: true,
      },
    });
    return {
      agentSessionId: session.id,
      boardId: session.boardId,
      boardRevision: session.boardRevision,
      canvasStateRevision: session.canvasStateRevision,
      intents: classifyCanvasPublicationIntents(mutationInvocations),
    };
  }

  private async completeCanvasSessionTx(
    tx: Prisma.TransactionClient,
    agentSessionId: string,
    completedAt: Date,
    boardRevision?: number,
  ) {
    const completed = await tx.canvasAgentSession.updateMany({
      where: { id: agentSessionId, status: "active" },
      data: {
        status: "completed",
        activeMutationToolCallId: null,
        ...(boardRevision === undefined ? {} : { boardRevision }),
      },
    });
    if (completed.count !== 1) throw new Error("CANVAS_AGENT_SESSION_PUBLISH_STATE_INVALID");
    await tx.canvasToolGrant.updateMany({
      where: { agentSessionId, revokedAt: null },
      data: { revokedAt: completedAt },
    });
    await tx.canvasClientCommand.updateMany({
      where: { agentSessionId, status: "pending" },
      data: { status: "cancelled" },
    });
  }

  private async cancelCanvasSessionsTx(
    tx: Prisma.TransactionClient,
    runId: string,
    cancelledAt: Date,
    runtimeAttemptId?: string,
  ) {
    const sessions = await tx.canvasAgentSession.findMany({
      where: {
        runId,
        status: "active",
        ...(runtimeAttemptId ? { runtimeAttemptId } : {}),
      },
      select: { id: true },
    });
    if (sessions.length === 0) return;
    const agentSessionIds = sessions.map((session) => session.id);

    // Session first closes the reservation gate. Any reservation already
    // holding the session lock settles before this update, so the following
    // non-terminal invocation query is complete and stable.
    await tx.canvasAgentSession.updateMany({
      where: { id: { in: agentSessionIds }, status: "active" },
      data: { status: "cancelled", activeMutationToolCallId: null },
    });
    const pendingInvocations = await tx.canvasToolInvocation.findMany({
      where: {
        agentSessionId: { in: agentSessionIds },
        status: { in: ["in_flight", "waiting_client", "waiting_approval"] },
      },
      select: {
        id: true,
        agentSessionId: true,
        toolCallId: true,
        toolName: true,
        status: true,
        boardRevisionBefore: true,
        boardRevisionAfter: true,
        canvasStateRevisionBefore: true,
        canvasStateRevisionAfter: true,
        canvasStateSha256Before: true,
      },
    });
    for (const invocation of pendingInvocations) {
      const boardRevision = invocation.boardRevisionAfter ?? invocation.boardRevisionBefore;
      const canvasStateRevision = invocation.canvasStateRevisionAfter
        ?? invocation.canvasStateRevisionBefore;
      const response = canvasAgentToolResultSchema.parse({
        protocol: "workbench.canvas-agent-tool.v1",
        agentSessionId: invocation.agentSessionId,
        toolCallId: invocation.toolCallId,
        toolName: invocation.toolName,
        status: "cancelled",
        boardRevision,
        canvasStateRevision,
        responseSha256: sha256Canonical(null),
        data: null,
        failure: null,
        approvalId: null,
        clientCommandId: null,
      });
      const cancelled = await tx.canvasToolInvocation.updateMany({
        where: {
          id: invocation.id,
          status: invocation.status,
        },
        data: {
          status: "cancelled",
          response: response as unknown as Prisma.InputJsonValue,
          boardRevisionAfter: boardRevision,
          canvasStateRevisionAfter: canvasStateRevision,
          canvasStateSha256After: invocation.canvasStateSha256Before,
          completedAt: cancelledAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (cancelled.count !== 1) {
        throw new Error("CANVAS_TOOL_INVOCATION_CANCELLATION_CONFLICT");
      }
    }
    await tx.canvasToolGrant.updateMany({
      where: { agentSessionId: { in: agentSessionIds }, revokedAt: null },
      data: { revokedAt: cancelledAt },
    });
    await tx.canvasClientCommand.updateMany({
      where: { agentSessionId: { in: agentSessionIds }, status: "pending" },
      data: { status: "cancelled" },
    });
  }

  private async failRun(
    runId: string,
    runtimeAttemptId: string | null,
    error: unknown,
    retryable: boolean,
    claim: RuntimeExecutionClaim | null = null,
  ) {
    const message = publicErrorMessage(error);
    const code = runtimeExecutionErrorCode(error);
    await this.db.$transaction(async (tx) => {
      if (claim) {
        try {
          await this.attempts.assertClaimTx(tx, claim);
        } catch (claimError) {
          if (claimError instanceof RuntimeExecutionFencedError) return;
          throw claimError;
        }
      }
      const updated = await tx.run.updateMany({
        where: claim
          ? {
              id: runId,
              status: "running",
              executionOwnerId: claim.ownerId,
              executionEpoch: claim.epoch,
            }
          : { id: runId, status: { in: ["queued", "running"] } },
        data: {
          status: "failed",
          finishedAt: new Date(),
          errorCode: code,
          errorDetail: message,
          errorRetryable: retryable,
          ...releasedExecutionLease(),
        },
      });
      if (updated.count !== 1) return;
      const failedAt = new Date();
      if (runtimeAttemptId) {
        const attempt = await tx.runtimeAttempt.findUnique({ where: { id: runtimeAttemptId } });
        if (attempt && !["waiting_input", "succeeded", "failed", "cancelled"].includes(attempt.status)) {
          const attemptFailed = await tx.runtimeAttempt.updateMany({
            where: claim
              ? {
                  id: runtimeAttemptId,
                  runId,
                  executionOwnerId: claim.ownerId,
                  executionEpoch: claim.epoch,
                }
              : { id: runtimeAttemptId },
            data: {
              status: "failed",
              startedAt: attempt.startedAt ?? failedAt,
              finishedAt: failedAt,
              errorCode: code,
              errorDetail: message,
              errorRetryable: retryable,
              ...releasedExecutionLease(),
            },
          });
          if (attemptFailed.count !== 1) throw new RuntimeExecutionFencedError();
        }
      }
      await this.cancelCanvasSessionsTx(tx, runId, failedAt);
      await tx.runDraft.deleteMany({ where: { runId } });
      await this.prototypePatches.discardRunTx(tx, runId, failedAt);
      await this.cleanupRunStagingArtifacts(tx, runId);
      await this.events.append(tx, runId, "run.failed", {
        code,
        message,
        retryable,
      });
    });
  }

  private async finalizeCancellation(runId: string, reason: string, runtimeAttemptId?: string) {
    await this.db.$transaction((tx) => this.finalizeCancellationTx(tx, runId, reason, runtimeAttemptId));
  }

  private async finalizeCancellationTx(
    tx: Prisma.TransactionClient,
    runId: string,
    reason: string,
    runtimeAttemptId?: string,
  ) {
    const updated = await tx.run.updateMany({
      where: { id: runId, status: "cancelling" },
      data: { status: "cancelled", cancellationReason: reason, finishedAt: new Date() },
    });
    if (updated.count !== 1) return;
    const cancelledAt = new Date();
    if (runtimeAttemptId) {
      const attempt = await tx.runtimeAttempt.findUnique({ where: { id: runtimeAttemptId } });
      if (attempt && !["succeeded", "failed", "cancelled"].includes(attempt.status)) {
        await tx.runtimeAttempt.update({
          where: { id: runtimeAttemptId },
          data: {
            status: "cancelled",
            startedAt: attempt.startedAt ?? cancelledAt,
            finishedAt: cancelledAt,
          },
        });
      }
    }
    await this.cancelCanvasSessionsTx(tx, runId, cancelledAt);
    await this.prototypePatches.discardRunTx(tx, runId, cancelledAt);
    await this.cleanupRunStagingArtifacts(tx, runId);
    await tx.runDraft.deleteMany({ where: { runId } });
    await this.events.append(tx, runId, "run.cancelled", { reason });
  }

  private startCancellationPoller() {
    if (this.cancellationPollTimer) return;
    this.cancellationPollTimer = setInterval(() => {
      void this.pollActiveRunsForCancellation();
    }, this.cancellationPollIntervalMs);
    this.cancellationPollTimer.unref();
  }

  private startExecutionHeartbeat(
    claim: RuntimeExecutionClaim,
    controller: AbortController,
  ) {
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      void this.attempts.heartbeat(claim).catch((error) => {
        controller.abort(
          error instanceof RuntimeExecutionCancelledError
            ? new RuntimeCancelledError()
            : error instanceof RuntimeExecutionFencedError
            ? error
            : new RuntimeExecutionFencedError(),
        );
      }).finally(() => {
        inFlight = false;
      });
    }, this.executionHeartbeatMs);
    timer.unref();
    return timer;
  }

  private async assertActiveClaimTx(
    tx: Prisma.TransactionClient,
    claim: RuntimeExecutionClaim,
  ) {
    try {
      return await this.attempts.assertClaimTx(tx, claim);
    } catch (error) {
      if (error instanceof RuntimeExecutionCancelledError) throw new RuntimeCancelledError();
      throw error;
    }
  }

  private stopCancellationPollerIfIdle() {
    if (this.active.size > 0 || !this.cancellationPollTimer) return;
    clearInterval(this.cancellationPollTimer);
    this.cancellationPollTimer = null;
  }

  private async pollActiveRunsForCancellation() {
    if (this.cancellationPollInFlight || this.active.size === 0) return;
    this.cancellationPollInFlight = true;
    try {
      const runIds = [...this.active.keys()];
      for (let offset = 0; offset < runIds.length; offset += this.cancellationQueryBatchSize) {
        const batch = runIds.slice(offset, offset + this.cancellationQueryBatchSize);
        const cancelled = await this.db.run.findMany({
          where: {
            id: { in: batch },
            status: { in: ["cancelling", "cancelled"] },
          },
          select: { id: true },
        });
        for (const run of cancelled) {
          this.active.get(run.id)?.abort(new RuntimeCancelledError());
        }
      }
    } catch {
      // The durable cancellation reconciler remains authoritative. A failed
      // poll must not terminate an active Run or create an overlapping query.
    } finally {
      this.cancellationPollInFlight = false;
      this.stopCancellationPollerIfIdle();
    }
  }
}

const NO_CANVAS_TOOL_GRANTS: CanvasToolGrantIssuer = {
  issue: async () => null,
};

export function boardPlacementsForArtifact(
  draft: RuntimeResult["artifacts"][number],
): Array<{
  key: string;
  size: { width: number; height: number };
  data: Extract<BoardNode["data"], { nodeType: "artifact" }>;
}> {
  if (draft.kind === "prototype") {
    const prototype = prototypeDocumentSchema.parse(draft.content);
    return prototype.screens.map((screen) => ({
      key: `screen:${screen.id}`,
      size: { width: screen.viewport.width, height: screen.viewport.height },
      data: {
        protocol: boardNodeProtocol,
        nodeType: "artifact",
        title: screen.name,
        artifactKind: draft.kind,
        screenId: screen.id,
        route: screen.route,
      },
    }));
  }

  return [{
    key: "root",
    size: draft.kind === "prd"
      ? { width: 500, height: 500 }
      : { width: 800, height: 600 },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: draft.title,
      artifactKind: draft.kind,
    },
  }];
}

function nextAvailableBoardNodeX(
  nodes: Array<{ position: Prisma.JsonValue; size: Prisma.JsonValue | null }>,
) {
  return nodes.reduce((right, node) => {
    const position = boardPointSchema.parse(node.position);
    const width = node.size === null ? 0 : boardSizeSchema.parse(node.size).width;
    return Math.max(right, position.x + width + 80);
  }, 0);
}

export function validateRuntimeArtifactOperations(
  request: StartRunRequest,
  result: RuntimeResult,
) {
  const requestedKinds = new Set(request.requestedArtifactKinds);
  const unrequestedKinds = [...new Set(
    result.artifacts
      .map((draft) => draft.kind)
      .filter((kind) => !requestedKinds.has(kind)),
  )];
  if (unrequestedKinds.length > 0) {
    throw new Error(`RUNTIME_ARTIFACTS_UNREQUESTED:${unrequestedKinds.join(",")}`);
  }
  const revisions = result.artifacts.filter((draft) => draft.operation.kind === "revise");
  if (request.workflow !== "edit") {
    if (revisions.length > 0) throw new Error("RUNTIME_ARTIFACT_REVISION_NOT_ALLOWED");
    return;
  }
  if (revisions.length !== result.artifacts.length) {
    throw new Error("RUNTIME_ARTIFACT_EDIT_MUST_REVISE");
  }
  const requestedByVersion = new Map(
    request.artifactTargets.map((target) => [target.artifactVersionId, target]),
  );
  if (revisions.length !== requestedByVersion.size) {
    throw new Error("RUNTIME_ARTIFACT_REVISION_TARGETS_INCOMPLETE");
  }
  for (const draft of revisions) {
    const operation = draft.operation;
    if (operation.kind !== "revise") continue;
    const requested = requestedByVersion.get(operation.target.artifactVersionId);
    if (!requested || canonicalJson(requested) !== canonicalJson(operation.target)) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_TARGET_INVALID");
    }
  }
}

function validateRuntimeArtifactDraftOperation(
  request: StartRunRequest,
  draft: RuntimeArtifactDraft,
) {
  if (!request.requestedArtifactKinds.includes(draft.kind)) {
    throw new Error("RUNTIME_ARTIFACT_KIND_NOT_REQUESTED");
  }
  if (request.workflow !== "edit") {
    if (draft.operation.kind !== "create") {
      throw new Error("RUNTIME_ARTIFACT_REVISION_NOT_ALLOWED");
    }
    return;
  }
  if (draft.operation.kind !== "revise") {
    throw new Error("RUNTIME_ARTIFACT_EDIT_MUST_REVISE");
  }
  const target = draft.operation.target;
  const requested = request.artifactTargets.find(
    (candidate) => candidate.artifactVersionId === target.artifactVersionId,
  );
  if (!requested || canonicalJson(requested) !== canonicalJson(target)) {
    throw new Error("RUNTIME_ARTIFACT_REVISION_TARGET_INVALID");
  }
}

async function lockRuntimeArtifactDraftTarget(
  tx: Prisma.TransactionClient,
  run: { id: string; projectId: string; knowledgeReleaseId: string | null },
  draft: RuntimeArtifactDraft,
) {
  if (draft.operation.kind !== "revise") {
    throw new Error("RUNTIME_ARTIFACT_REVISION_OPERATION_INVALID");
  }
  const target = draft.operation.target;
  const locked = await tx.$queryRaw<Array<{
    id: string;
    kind: string;
    title: string;
    currentVersionId: string | null;
  }>>(Prisma.sql`
    SELECT
      "id",
      "kind"::TEXT AS "kind",
      "title",
      "current_version_id" AS "currentVersionId"
    FROM "artifacts"
    WHERE "id" = ${target.artifactId}
      AND "project_id" = ${run.projectId}
    FOR UPDATE
  `);
  const artifact = locked[0];
  if (
    !artifact
    || artifact.kind !== draft.kind
    || artifact.currentVersionId !== target.artifactVersionId
  ) {
    throw new Error("RUNTIME_ARTIFACT_REVISION_BASE_CONFLICT");
  }
  const base = await tx.artifactVersion.findUnique({
    where: {
      id_artifactId: {
        id: target.artifactVersionId,
        artifactId: target.artifactId,
      },
    },
    include: { assets: { include: { blob: true }, orderBy: { assetId: "asc" } } },
  });
  if (
    !base
    || base.projectId !== run.projectId
    || base.status !== "ready"
    || base.content === null
    || base.contentBlobId !== null
    || base.schemaVersion !== draft.schemaVersion
  ) {
    throw new Error("RUNTIME_ARTIFACT_REVISION_BASE_INVALID");
  }
  assertRuntimeArtifactRevisionContent(artifact.kind, base.content, draft, target.screenIds);
  for (const asset of base.assets) {
    if (
      asset.blob.status !== "ready"
      || asset.blob.deletedAt !== null
      || asset.blobId !== asset.blob.id
      || asset.mediaType !== asset.blob.mediaType
      || asset.byteSize !== asset.blob.byteSize
      || asset.sha256 !== asset.blob.sha256
    ) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_ASSET_INVALID");
    }
  }
  const latest = await tx.artifactVersion.findFirst({
    where: { artifactId: target.artifactId },
    select: { version: true },
    orderBy: { version: "desc" },
  });
  return {
    artifact: { id: artifact.id, title: artifact.title },
    baseAssets: base.assets,
    knowledgeReleaseId: base.knowledgeReleaseId,
    version: (latest?.version ?? base.version) + 1,
  };
}

function assertMatchingRuntimeArtifactDraftReplay(
  replayed: { type: string; payload: Prisma.JsonValue },
  attempt: number,
  event: Extract<RuntimeProgressEvent, { type: "artifact.draft" }>,
  checksum: string,
) {
  const payload = asRecord(replayed.payload);
  const artifactId = typeof payload?.artifactId === "string" ? payload.artifactId : null;
  const artifactVersionId = typeof payload?.artifactVersionId === "string"
    ? payload.artifactVersionId
    : null;
  if (!artifactId || !artifactVersionId || replayed.type !== "artifact.draft.created") {
    throw new Error("RUNTIME_ARTIFACT_DRAFT_SOURCE_CONFLICT");
  }
  const screens = artifactDraftScreenSchema.array().safeParse(payload?.screens);
  if (!screens.success) throw new Error("RUNTIME_ARTIFACT_DRAFT_SOURCE_CONFLICT");
  const checkpointScreens = prototypePatchCheckpointScreenSchema.array().safeParse(
    event.checkpointScreens,
  );
  if (
    !checkpointScreens.success
    || canonicalJson(checkpointScreens.data) !== canonicalJson(screens.data.map((screen) => ({
      screenId: screen.id,
      revision: screen.revision,
      checksum: screen.checksum,
    })))
  ) {
    throw new Error("RUNTIME_ARTIFACT_DRAFT_SOURCE_CONFLICT");
  }
  const expected = runtimeArtifactDraftEventPayload(
    attempt,
    event,
    artifactId,
    artifactVersionId,
    checksum,
    screens.data,
  );
  if (canonicalJson(replayed.payload) !== canonicalJson(expected)) {
    throw new Error("RUNTIME_ARTIFACT_DRAFT_SOURCE_CONFLICT");
  }
}

function assertRuntimeArtifactDraftIdentity(
  version: {
    projectId: string;
    status: string;
    contentBlobId: string | null;
    runtimeDraftSourceId: string | null;
    runtimeDraftIndex: number | null;
    runtimeDraftTitle: string | null;
    schemaVersion: number;
    knowledgeReleaseId: string | null;
    artifact: { id: string; kind: string; title: string; currentVersionId: string | null };
  },
  run: { projectId: string; knowledgeReleaseId: string | null },
  event: Extract<RuntimeProgressEvent, { type: "artifact.draft" }>,
  target: {
    artifact: { id: string; title: string };
    knowledgeReleaseId: string | null;
  } | null,
) {
  const expectedKnowledgeReleaseId = run.knowledgeReleaseId ?? target?.knowledgeReleaseId ?? null;
  const operationMatches = event.draft.operation.kind === "create"
    ? target === null
      && version.artifact.currentVersionId === null
      && version.artifact.title === event.draft.title
    : target !== null
      && version.artifact.id === event.draft.operation.target.artifactId
      && version.artifact.currentVersionId === event.draft.operation.target.artifactVersionId;
  if (
    version.projectId !== run.projectId
    || version.status !== "staging"
    || version.contentBlobId !== null
    || version.runtimeDraftSourceId === null
    || version.runtimeDraftIndex !== event.artifactIndex
    || version.runtimeDraftTitle !== event.draft.title
    || version.schemaVersion !== event.draft.schemaVersion
    || version.knowledgeReleaseId !== expectedKnowledgeReleaseId
    || version.artifact.kind !== event.draft.kind
    || !operationMatches
  ) {
    throw new Error("RUNTIME_ARTIFACT_DRAFT_IDENTITY_CONFLICT");
  }
}

async function assertArtifactDraftStageReady(
  tx: Prisma.TransactionClient,
  runId: string,
  attempt: number,
  kind: "prd" | "prototype",
) {
  const latestEvents = await tx.runEvent.findMany({
    where: { runId, type: "run.generation.stage.changed" },
    orderBy: { sequence: "desc" },
    take: 32,
    select: { payload: true },
  });
  const currentStage = currentGenerationStage(latestEvents, attempt);
  const ready = kind === "prd"
    ? currentStage === "validating-prd"
    : currentStage !== undefined
      && (prototypeGenerationStageSequence as readonly RunGenerationStage[]).includes(currentStage)
      && generationStageRank(currentStage) >= generationStageRank("generating-ui");
  if (!ready) {
    throw new Error("RUNTIME_ARTIFACT_DRAFT_STAGE_TOO_EARLY");
  }
}

function assertStagedRuntimeArtifactDraft(
  version: {
    runtimeDraftIndex: number | null;
    runtimeDraftTitle: string | null;
    schemaVersion: number;
    checksum: string;
    citations: Prisma.JsonValue;
    content: Prisma.JsonValue | null;
    artifact: { kind: string };
  },
  draft: RuntimeArtifactDraft,
  artifactIndex: number,
  checksum: string,
  failureCode = "RUNTIME_ARTIFACT_DRAFT_CONTENT_CONFLICT",
) {
  if (
    version.runtimeDraftIndex !== artifactIndex
    || version.runtimeDraftTitle !== draft.title
    || version.artifact.kind !== draft.kind
    || version.schemaVersion !== draft.schemaVersion
    || version.checksum !== checksum
    || version.content === null
    || sha256Canonical(version.content) !== checksum
    || canonicalJson(version.citations) !== canonicalJson(draft.citations)
  ) {
    throw new Error(failureCode);
  }
}

function runtimeArtifactDraftEventPayload(
  attempt: number,
  event: Extract<RuntimeProgressEvent, { type: "artifact.draft" }>,
  artifactId: string,
  artifactVersionId: string,
  checksum: string,
  screens: readonly PrototypeCheckpointScreenState[],
) {
  return {
    attempt,
    artifactIndex: event.artifactIndex,
    artifactId,
    artifactVersionId,
    kind: event.draft.kind,
    checksum,
    draftChecksum: sha256Canonical(event.draft),
    screens: event.draft.kind === "prototype" ? screens : [],
  };
}

async function lockRunForPreparation(tx: Prisma.TransactionClient, runId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "runs" WHERE "id" = ${runId} FOR UPDATE
  `);
  return rows.length === 1;
}

function assertRuntimeArtifactRevisionContent(
  artifactKind: string,
  baseContent: unknown,
  draft: RuntimeResult["artifacts"][number],
  selectedScreenIds: readonly string[],
) {
  if (artifactKind === "prd" && draft.kind === "prd") {
    const base = prdDocumentSchema.parse(baseContent);
    const next = prdDocumentSchema.parse(draft.content);
    if (selectedScreenIds.length > 0) throw new Error("RUNTIME_ARTIFACT_REVISION_SCREEN_INVALID");
    if (next.documentId !== base.documentId || next.revision.number <= base.revision.number) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_CONTINUITY_INVALID");
    }
    if (canonicalJson(next.citations) !== canonicalJson(base.citations)) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_CITATIONS_INVALID");
    }
    return;
  }
  if (artifactKind === "prototype" && draft.kind === "prototype") {
    const base = prototypeDocumentSchema.parse(baseContent);
    const next = prototypeDocumentSchema.parse(draft.content);
    if (next.documentId !== base.documentId || next.revision <= base.revision) {
      throw new Error("RUNTIME_ARTIFACT_REVISION_CONTINUITY_INVALID");
    }
    if (selectedScreenIds.length > 0) {
      assertPrototypeScreenRevisionScope(base, next, selectedScreenIds);
    }
    return;
  }
  throw new Error("RUNTIME_ARTIFACT_REVISION_KIND_INVALID");
}

function assertPrototypeScreenRevisionScope(
  base: ReturnType<typeof prototypeDocumentSchema.parse>,
  next: ReturnType<typeof prototypeDocumentSchema.parse>,
  selectedScreenIds: readonly string[],
) {
  const selected = new Set(selectedScreenIds);
  const baseScreenIds = base.screens.map((screen) => screen.id).sort();
  const nextScreenIds = next.screens.map((screen) => screen.id).sort();
  if (
    canonicalJson(baseScreenIds) !== canonicalJson(nextScreenIds)
    || selectedScreenIds.some((screenId) => !baseScreenIds.includes(screenId))
  ) {
    throw new Error("RUNTIME_ARTIFACT_REVISION_SCREEN_SET_INVALID");
  }
  const baseUnselectedNodeIds = new Set(
    base.nodes.filter((node) => !selected.has(node.screenId)).map((node) => node.id),
  );
  const nextUnselectedNodeIds = new Set(
    next.nodes.filter((node) => !selected.has(node.screenId)).map((node) => node.id),
  );
  const projection = (
    document: ReturnType<typeof prototypeDocumentSchema.parse>,
    unselectedNodeIds: ReadonlySet<string>,
  ) => ({
    screens: document.screens.filter((screen) => !selected.has(screen.id)),
    nodes: document.nodes.filter((node) => !selected.has(node.screenId)),
    states: document.states.filter((state) => !selected.has(state.screenId)),
    actions: document.actions.filter((action) => unselectedNodeIds.has(action.nodeId)),
    bindings: document.bindings.filter((binding) => unselectedNodeIds.has(binding.nodeId)),
    motions: document.motions.filter((motion) => unselectedNodeIds.has(motion.nodeId)),
    tokens: document.tokens,
    assets: document.assets,
    variables: document.variables,
  });
  if (
    canonicalJson(projection(base, baseUnselectedNodeIds))
    !== canonicalJson(projection(next, nextUnselectedNodeIds))
  ) {
    throw new Error("RUNTIME_ARTIFACT_REVISION_SCOPE_VIOLATION");
  }
}

async function loadRuntimeArtifactTargets(
  tx: Prisma.TransactionClient,
  projectId: string,
  request: StartRunRequest,
): Promise<RuntimeArtifactTarget[]> {
  const targets = request.artifactTargets;
  if (targets.length === 0) return [];
  const rows = await tx.artifactVersion.findMany({
    where: {
      projectId,
      id: { in: targets.map((target) => target.artifactVersionId) },
    },
    include: {
      artifact: { select: { kind: true } },
      contentBlob: true,
      assets: {
        include: { blob: true },
        orderBy: { assetId: "asc" },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== targets.length) throw new Error("RUNTIME_ARTIFACT_TARGET_MISSING");
  return targets.map((target) => mapRuntimeArtifactTarget(
    projectId,
    target,
    byId.get(target.artifactVersionId),
    request.workflow === "generate" ? "generate-source" : "complete",
  ));
}

export function mapRuntimeArtifactTarget(
  projectId: string,
  target: StartRunRequest["artifactTargets"][number],
  row: PreparedArtifactTarget | undefined,
  contentScope: "complete" | "generate-source" = "complete",
): RuntimeArtifactTarget {
  if (
    !row
    || row.projectId !== projectId
    || row.artifactId !== target.artifactId
    || row.status !== "ready"
  ) {
    throw new Error("RUNTIME_ARTIFACT_TARGET_INVALID");
  }
  const kind = artifactKindSchema.parse(row.artifact.kind);
  if ((row.content === null) === (row.contentBlob === null)) {
    throw new Error("RUNTIME_ARTIFACT_TARGET_CONTENT_INVALID");
  }

  let content: RuntimeArtifactTarget["content"] | null = null;
  let assets: RuntimeArtifactTarget["assets"] = [];
  if (row.content !== null) {
    const value = jsonValueSchema.parse(row.content);
    if (sha256Canonical(value) !== row.checksum) {
      throw new Error("RUNTIME_ARTIFACT_TARGET_CHECKSUM_INVALID");
    }
    if (kind === "prd") prdDocumentSchema.parse(value);
    if (kind === "prototype") {
      const document = prototypeDocumentSchema.parse(value);
      const screenIds = new Set(document.screens.map((screen) => screen.id));
      if (target.screenIds.some((screenId) => !screenIds.has(screenId))) {
        throw new Error("RUNTIME_ARTIFACT_TARGET_SCREEN_INVALID");
      }
      const allAssets = mapRuntimeArtifactTargetAssets(projectId, target, row, document);
      if (contentScope === "generate-source") {
        const payload = projectPrototypeSourceScreens(
          document,
          target.screenIds,
          row.checksum,
        );
        const projection = prototypeSourceProjectionSchema.parse({
          ...payload,
          projectionChecksum: sha256Canonical(payload),
        });
        const projectedAssetIds = new Set(projection.assets.map((asset) => asset.id));
        assets = allAssets.filter((asset) => projectedAssetIds.has(asset.assetId));
        content = { mode: "inline", value: projection };
      } else {
        assets = allAssets;
        content = { mode: "inline", value };
      }
    } else if (target.screenIds.length > 0) {
      throw new Error("RUNTIME_ARTIFACT_TARGET_SCREEN_INVALID");
    } else if (row.assets.length > 0) {
      throw new Error("RUNTIME_ARTIFACT_TARGET_ASSET_PIN_MISMATCH");
    }
    if (kind !== "prototype") content = { mode: "inline", value };
  } else {
    const blob = row.contentBlob!;
    if (
      target.screenIds.length > 0
      || blob.status !== "ready"
      || blob.deletedAt !== null
      || blob.sha256 !== row.checksum
    ) {
      throw new Error("RUNTIME_ARTIFACT_TARGET_BLOB_INVALID");
    }
    content = {
      mode: "blob",
      blobId: blob.id,
      locator: contentLocator(blob),
    };
    if (row.assets.length > 0) {
      throw new Error("RUNTIME_ARTIFACT_TARGET_ASSET_PIN_MISMATCH");
    }
  }
  if (content === null) throw new Error("RUNTIME_ARTIFACT_TARGET_CONTENT_INVALID");
  return {
    artifactId: target.artifactId,
    artifactVersionId: target.artifactVersionId,
    screenIds: [...target.screenIds],
    kind,
    schemaVersion: row.schemaVersion,
    checksum: row.checksum,
    content,
    assets,
  };
}

function mapRuntimeArtifactTargetAssets(
  projectId: string,
  target: StartRunRequest["artifactTargets"][number],
  row: PreparedArtifactTarget,
  document: ReturnType<typeof prototypeDocumentSchema.parse>,
): RuntimeArtifactTargetAsset[] {
  const binaryAssets = document.assets.filter(
    (asset): asset is BinaryPrototypeAsset => asset.kind === "image" || asset.kind === "font",
  );
  const byAssetId = new Map(row.assets.map((asset) => [asset.assetId, asset]));
  if (byAssetId.size !== row.assets.length || row.assets.length !== binaryAssets.length) {
    throw new Error("RUNTIME_ARTIFACT_TARGET_ASSET_PIN_MISMATCH");
  }

  return binaryAssets.map((asset) => {
    const pin = byAssetId.get(asset.id);
    const blob = pin?.blob;
    if (
      !pin
      || !blob
      || pin.artifactVersionId !== target.artifactVersionId
      || pin.artifactId !== target.artifactId
      || pin.projectId !== projectId
      || pin.assetId !== asset.id
      || pin.kind !== asset.kind
      || pin.blobId !== asset.blobId
      || pin.mediaType !== asset.mediaType
      || pin.byteSize !== BigInt(asset.byteSize)
      || pin.sha256 !== asset.sha256
      || canonicalJson(pin.metadata) !== canonicalJson(asset)
      || blob.id !== asset.blobId
      || blob.status !== "ready"
      || blob.deletedAt !== null
      || blob.mediaType !== asset.mediaType
      || blob.byteSize !== BigInt(asset.byteSize)
      || blob.sha256 !== asset.sha256
    ) {
      throw new Error(`RUNTIME_ARTIFACT_TARGET_ASSET_SOURCE_INVALID:${asset.id}`);
    }

    return {
      artifactVersionId: target.artifactVersionId,
      assetId: asset.id,
      kind: asset.kind,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      metadata: asset,
      content: contentLocator(blob),
    };
  });
}

async function loadRuntimeDesignAssets(
  tx: Prisma.TransactionClient,
  snapshot: RuntimeMaterializedDesignStyleSnapshot | null,
) {
  if (!snapshot || snapshot.protocol === "workbench.runtime.design-preset.v1") return [];
  if (snapshot.assets.length === 0) return [];
  const rows = await tx.artifactVersionAsset.findMany({
    where: {
      artifactVersionId: snapshot.source.artifactVersionId,
      artifactId: snapshot.source.artifactId,
      projectId: snapshot.source.projectId,
    },
    include: { blob: true },
    orderBy: { assetId: "asc" },
  });
  return mapRuntimeDesignAssets(snapshot, rows);
}

export function mapRuntimeDesignAssets(
  snapshot: RuntimeDesignStyleSnapshot,
  rows: readonly PreparedDesignAsset[],
): RuntimeDesignAsset[] {
  const byAssetId = new Map(rows.map((row) => [row.assetId, row]));
  if (byAssetId.size !== rows.length || rows.length !== snapshot.assets.length) {
    throw new Error("RUNTIME_DESIGN_STYLE_ASSET_PIN_MISMATCH");
  }

  return snapshot.assets.map((asset) => {
    const row = byAssetId.get(asset.id);
    const blob = row?.blob;
    if (
      !row
      || !blob
      || row.artifactVersionId !== snapshot.source.artifactVersionId
      || row.artifactId !== snapshot.source.artifactId
      || row.projectId !== snapshot.source.projectId
      || asset.artifactVersionId !== snapshot.source.artifactVersionId
      || row.kind !== asset.kind
      || row.blobId !== asset.blobId
      || row.mediaType !== asset.mediaType
      || row.byteSize !== BigInt(asset.byteSize)
      || row.sha256 !== asset.sha256
      || blob.id !== asset.blobId
      || blob.status !== "ready"
      || blob.deletedAt !== null
      || blob.mediaType !== asset.mediaType
      || blob.byteSize !== BigInt(asset.byteSize)
      || blob.sha256 !== asset.sha256
    ) {
      throw new Error(`RUNTIME_DESIGN_STYLE_ASSET_SOURCE_INVALID:${asset.id}`);
    }

    return {
      assetId: asset.id,
      name: asset.name,
      kind: asset.kind,
      artifactVersionId: asset.artifactVersionId,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      content: {
        storageKey: blob.storageKey,
        mediaType: blob.mediaType,
        byteSize: asset.byteSize,
        sha256: blob.sha256,
      },
    };
  });
}

export function mapRuntimeSources(sources: PreparedSourceSnapshot[]): RuntimeSource[] {
  if (sources.length > runSourceBlobLimit) throw new Error("RUNTIME_SOURCE_COUNT_INVALID");
  const runtimeSources: RuntimeSource[] = [];
  for (const [sourceIndex, sourceSnapshot] of sources.entries()) {
    if (sourceSnapshot.position !== sourceIndex) throw new Error("RUNTIME_SOURCE_ORDER_INVALID");
    if (
      sourceSnapshot.sourceId !== sourceSnapshot.source.id
      || sourceSnapshot.projectId !== sourceSnapshot.source.projectId
      || sourceSnapshot.kind !== sourceSnapshot.source.kind
      || sourceSnapshot.checksum !== sourceSnapshot.source.checksum
    ) throw new Error("RUNTIME_SOURCE_SNAPSHOT_INVALID");

    for (const [blobIndex, entry] of sourceSnapshot.source.blobs.entries()) {
      if (entry.position !== blobIndex) throw new Error("RUNTIME_SOURCE_BLOB_ORDER_INVALID");
      const byteSize = safeBlobByteSize(entry.byteSize);
      if (
        entry.blob.status !== "ready"
        || entry.blob.deletedAt !== null
        || entry.blob.sha256 !== entry.sha256
        || entry.blob.mediaType !== entry.mediaType
        || safeBlobByteSize(entry.blob.byteSize) !== byteSize
      ) throw new Error("RUNTIME_SOURCE_BLOB_INVALID");
      runtimeSources.push({
        position: runtimeSources.length,
        sourceId: sourceSnapshot.sourceId,
        sourceKind: sourceSnapshot.kind,
        blobId: entry.blob.id,
        originalName: entry.path ?? sourceSnapshot.label,
        mediaType: entry.mediaType,
        byteSize,
        sha256: entry.sha256,
        original: contentLocator(entry.blob),
        extraction: preferredExtraction(entry.fileAsset?.currentExtraction ?? null),
      });
    }
  }
  if (runtimeSources.length > runSourceBlobLimit) throw new Error("RUNTIME_SOURCE_BLOB_COUNT_INVALID");
  return runtimeSources;
}

type LockedStagedPrototypeAsset = {
  artifactVersionId: string;
  assetId: string;
  kind: string;
  blobId: string;
  mediaType: string;
  byteSize: bigint;
  sha256: string;
  metadata: Prisma.JsonValue;
  lockedBlobId: string;
  blobStatus: string;
  blobDeletedAt: Date | null;
  blobMediaType: string;
  blobByteSize: bigint;
  blobSha256: string;
};

async function lockAndAssertStagedPrototypeAssets(
  tx: Prisma.TransactionClient,
  artifactVersionId: string,
  draft: RuntimeArtifactDraft,
  errorCode: string,
): Promise<void> {
  const assets = await tx.$queryRaw<LockedStagedPrototypeAsset[]>(Prisma.sql`
    SELECT
      pin."artifact_version_id" AS "artifactVersionId",
      pin."asset_id" AS "assetId",
      pin."kind" AS "kind",
      pin."blob_id" AS "blobId",
      pin."media_type" AS "mediaType",
      pin."byte_size" AS "byteSize",
      pin."sha256" AS "sha256",
      pin."metadata" AS "metadata",
      blob."id" AS "lockedBlobId",
      blob."status"::TEXT AS "blobStatus",
      blob."deleted_at" AS "blobDeletedAt",
      blob."media_type" AS "blobMediaType",
      blob."byte_size" AS "blobByteSize",
      blob."sha256" AS "blobSha256"
    FROM "artifact_version_assets" pin
    JOIN "blobs" blob ON blob."id" = pin."blob_id"
    WHERE pin."artifact_version_id" = ${artifactVersionId}
    ORDER BY pin."asset_id"
    FOR SHARE OF pin, blob
  `);
  try {
    const expected = prototypeAssetPins(draft, [], [], assets);
    if (
      assets.length !== expected.length
      || new Set(assets.map((asset) => asset.assetId)).size !== assets.length
      || assets.some((asset) => (
        asset.artifactVersionId !== artifactVersionId
        || asset.blobId !== asset.lockedBlobId
        || asset.blobStatus !== "ready"
        || asset.blobDeletedAt !== null
        || asset.mediaType !== asset.blobMediaType
        || asset.byteSize !== asset.blobByteSize
        || asset.sha256 !== asset.blobSha256
      ))
    ) {
      throw new Error(errorCode);
    }
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode, { cause: error });
  }
}

type BinaryPrototypeAsset = Extract<PrototypeAsset, { kind: "image" | "font" }>;

export function prototypeAssetPins(
  draft: RuntimeResult["artifacts"][number],
  sources: readonly RuntimeSource[],
  designAssets: readonly RuntimeDesignAsset[] = [],
  existingAssets: readonly {
    kind: string;
    blobId: string;
    mediaType: string;
    byteSize: bigint;
    sha256: string;
    metadata: unknown;
  }[] = [],
  sourceAssets: readonly RuntimeArtifactTargetAsset[] = [],
): Array<{
  assetId: string;
  kind: BinaryPrototypeAsset["kind"];
  blobId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  metadata: BinaryPrototypeAsset;
}> {
  if (draft.kind !== "prototype") return [];
  const allowedSources = new Map(
    sources.map((source) => [source.blobId, source]),
  );
  const allowedDesignAssets = new Map(
    designAssets.map((source) => [`${source.kind}:${source.blobId}`, source]),
  );
  const allowedExistingAssets = new Map(
    existingAssets.map((source) => [`${source.kind}:${source.blobId}`, source]),
  );
  const allowedSourceAssets = new Map<string, RuntimeArtifactTargetAsset[]>();
  for (const source of sourceAssets) {
    const key = `${source.kind}:${source.blobId}`;
    allowedSourceAssets.set(key, [...(allowedSourceAssets.get(key) ?? []), source]);
  }
  return draft.content.assets.flatMap((asset) => {
    if (asset.kind === "icon") return [];
    const source = allowedSources.get(asset.blobId)
      ?? allowedDesignAssets.get(`${asset.kind}:${asset.blobId}`);
    const existing = allowedExistingAssets.get(`${asset.kind}:${asset.blobId}`);
    const authorizedSource = (allowedSourceAssets.get(`${asset.kind}:${asset.blobId}`) ?? [])
      .some((candidate) => matchesRuntimeSourceAsset(asset, candidate));
    if (
      (
        !source
        || source.mediaType !== asset.mediaType
        || source.byteSize !== asset.byteSize
        || source.sha256 !== asset.sha256
      )
      && (
        !existing
        || existing.mediaType !== asset.mediaType
        || existing.byteSize !== BigInt(asset.byteSize)
        || existing.sha256 !== asset.sha256
        || canonicalJson(existing.metadata) !== canonicalJson(asset)
      )
      && !authorizedSource
    ) {
      throw new Error(`RUNTIME_PROTOTYPE_ASSET_UNAUTHORIZED:${asset.id}`);
    }
    return [{
      assetId: asset.id,
      kind: asset.kind,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      metadata: asset,
    }];
  });
}

function matchesRuntimeSourceAsset(
  asset: BinaryPrototypeAsset,
  source: RuntimeArtifactTargetAsset,
) {
  if (
    source.kind !== asset.kind
    || source.blobId !== asset.blobId
    || source.mediaType !== asset.mediaType
    || source.byteSize !== asset.byteSize
    || source.sha256 !== asset.sha256
    || source.metadata.kind !== asset.kind
    || source.assetId !== source.metadata.id
    || source.blobId !== source.metadata.blobId
    || source.mediaType !== source.metadata.mediaType
    || source.byteSize !== source.metadata.byteSize
    || source.sha256 !== source.metadata.sha256
  ) {
    return false;
  }
  if (asset.kind === "image" && source.metadata.kind === "image") {
    return source.metadata.width === asset.width && source.metadata.height === asset.height;
  }
  if (asset.kind === "font" && source.metadata.kind === "font") {
    return source.metadata.family === asset.family
      && source.metadata.weight === asset.weight
      && source.metadata.style === asset.style;
  }
  return false;
}

function preferredExtraction(
  extraction: PreparedSourceExtraction,
): RuntimeSource["extraction"] {
  if (!extraction) return null;
  if (extraction.status !== "ready") throw new Error("RUNTIME_SOURCE_EXTRACTION_INVALID");
  const output = (
    extraction.outputs.find((candidate) => candidate.kind === "text")
    ?? extraction.outputs.find((candidate) => candidate.kind === "markdown")
    ?? extraction.outputs.find((candidate) => candidate.kind === "structured")
    ?? extraction.outputs[0]
  );
  if (!output || output.blob.status !== "ready") {
    throw new Error("RUNTIME_SOURCE_EXTRACTION_OUTPUT_INVALID");
  }
  return {
    kind: output.kind,
    position: output.position,
    content: contentLocator(output.blob),
  };
}

function contentLocator(blob: {
  storageKey: string;
  mediaType: string;
  byteSize: bigint;
  sha256: string;
}): RuntimeContentLocator {
  return {
    storageKey: blob.storageKey,
    mediaType: blob.mediaType,
    byteSize: safeBlobByteSize(blob.byteSize),
    sha256: blob.sha256,
  };
}

function safeBlobByteSize(value: bigint) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0 || BigInt(size) !== value) {
    throw new Error("RUNTIME_SOURCE_SIZE_INVALID");
  }
  return size;
}

export class RuntimeCancelledError extends Error {
  constructor() {
    super("RUNTIME_CANCELLED");
  }
}

function releasedExecutionLease() {
  return {
    executionOwnerId: null,
    executionHeartbeatAt: null,
    executionLeaseExpiresAt: null,
  };
}

class RunTransitionRejectedError extends Error {
  constructor(status: string | null) {
    super(`RUN_TRANSITION_REJECTED:${status ?? "missing"}`);
  }
}

async function assertRunTransition(
  tx: Prisma.TransactionClient,
  runId: string,
  transition: { count: number },
) {
  if (transition.count === 1) return;
  const current = await tx.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (current?.status === "cancelling" || current?.status === "cancelled") {
    throw new RuntimeCancelledError();
  }
  throw new RunTransitionRejectedError(current?.status ?? null);
}

export function canonicalJson(value: unknown): string {
  try {
    return canonicalizeJson(value);
  } catch {
    throw new Error("ARTIFACT_CONTENT_NOT_JSON");
  }
}

export function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function runtimeFinalizationActivitySourceId(attemptId: string, activityId: string) {
  return `system:runtime-finalization-activity:${createHash("sha256")
    .update(attemptId)
    .update("\0")
    .update(activityId)
    .digest("hex")}`;
}

const generationStagePresentations = {
  "thinking": { rank: 0, phase: "understanding", label: "正在理解需求" },
  "collecting-prd-context": { rank: 1, phase: "retrieving_knowledge", label: "正在整理项目资料" },
  "structuring-prd": { rank: 2, phase: "planning", label: "正在规划文档结构" },
  "drafting-prd": { rank: 3, phase: "generating", label: "正在编写需求说明书" },
  "validating-prd": { rank: 4, phase: "validating", label: "正在检查需求说明书" },
  "design-system": { rank: 1, phase: "planning", label: "正在生成设计系统" },
  "mapping-components": { rank: 2, phase: "planning", label: "正在映射组件" },
  "creating-flows": { rank: 3, phase: "planning", label: "正在创建用户流程" },
  "generating-ui": { rank: 4, phase: "generating", label: "正在生成界面" },
  "screen-streaming": { rank: 5, phase: "generating", label: "正在流式生成界面" },
  "summarizing": { rank: 6, phase: "validating", label: "正在总结设计" },
  "screen-stable": { rank: 7, phase: "publishing", label: "正在稳定画板" },
} as const satisfies Record<RunGenerationStage, {
  rank: number;
  phase: Extract<RuntimeProgressEvent, { type: "phase" }>["phase"];
  label: string;
}>;

const prototypeGenerationStageSequence = [
  "thinking",
  "design-system",
  "mapping-components",
  "creating-flows",
  "generating-ui",
  "screen-streaming",
  "summarizing",
  "screen-stable",
] as const satisfies readonly RunGenerationStage[];

const prdGenerationStageSequence = [
  "thinking",
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
] as const satisfies readonly RunGenerationStage[];

function assertGenerationStageTransition(
  current: RunGenerationStage,
  next: RunGenerationStage,
) {
  const sequences: readonly (readonly RunGenerationStage[])[] = [
    prototypeGenerationStageSequence,
    prdGenerationStageSequence,
  ];
  const sequence = current === "thinking"
    ? sequences.find((candidate) => candidate[1] === next)
    : sequences.find((candidate) => candidate.includes(current));
  const currentIndex = sequence?.indexOf(current) ?? -1;
  if (!sequence || currentIndex < 0 || sequence[currentIndex + 1] !== next) {
    throw new Error("RUNTIME_GENERATION_STAGE_TRANSITION_INVALID");
  }
}

function generationStageRank(stage: RunGenerationStage) {
  const presentation = generationStagePresentations[stage];
  if (!presentation) throw new Error("RUNTIME_GENERATION_STAGE_INVALID");
  return presentation.rank;
}

function currentGenerationStage(
  events: ReadonlyArray<{ payload: unknown }>,
  attempt: number,
): RunGenerationStage | undefined {
  return events.flatMap((candidate) => {
    const payload = asRecord(candidate.payload);
    return payload?.attempt === attempt && typeof payload.stage === "string"
      ? [payload.stage as RunGenerationStage]
      : [];
  })[0];
}

function generationStagePresentation(stage: RunGenerationStage) {
  const presentation = generationStagePresentations[stage];
  if (!presentation) throw new Error("RUNTIME_GENERATION_STAGE_INVALID");
  return presentation;
}

export function publicErrorMessage(error: unknown) {
  const providerStateCode = knownRuntimeProviderStateErrorCode(error);
  if (providerStateCode) return providerStateCode;
  const value = error instanceof Error ? error.message : "Runtime execution failed";
  return value.replace(/https?:\/\/[^\s]+/g, "[runtime endpoint]").slice(0, 1_000);
}

export function isRetryableRuntimeError(error: unknown) {
  if (error instanceof RuntimeLivenessError) return error.retryable;
  if (knownRuntimeProviderStateErrorCode(error)) return false;
  if (!(error instanceof Error)) return true;
  if (error.name === "ZodError") return false;
  return ![
    "ARTIFACT_CONTENT_NOT_JSON",
    "DEERFLOW_RUN_ERROR:",
    "DEERFLOW_STREAM_END_INVALID",
    "DEERFLOW_STREAM_MODE_INVALID:",
    "DEERFLOW_STREAM_MODE_MISSING",
    "DEERFLOW_THREAD_BINDING_INVALID",
    "DEERFLOW_UPLOAD_HANDLE_INVALID",
    "KNOWLEDGE_TOOL_NOT_CONFIGURED",
    "RUNTIME_APPROVAL_",
    "RUNTIME_ARTIFACT_",
    "RUNTIME_ARTIFACTS_MISSING:",
    "RUNTIME_SOURCE_COUNT_INVALID",
    "RUNTIME_SOURCE_DIGEST_INVALID",
    "RUNTIME_SOURCE_EXTRACTION_INVALID",
    "RUNTIME_SOURCE_EXTRACTION_OUTPUT_INVALID",
    "RUNTIME_SOURCE_FILE_NAME_INVALID",
    "RUNTIME_SOURCE_MEDIA_TYPE_INVALID",
    "RUNTIME_SOURCE_ORDER_INVALID",
    "RUNTIME_SOURCE_SIZE_INVALID",
    "RUNTIME_SOURCE_SOURCE_INVALID",
    "RUNTIME_CANVAS_GRANT_LEAK",
    "RUNTIME_CANVAS_TOOL_",
    "RUNTIME_DESIGN_STYLE_",
    "RUNTIME_EXTERNAL_EVENT_ID_INVALID",
    "RUNTIME_EXTERNAL_EVENT_IDENTITY_CONFLICT",
    "RUNTIME_EXTERNAL_RUN_DUPLICATED",
    "RUNTIME_EXTERNAL_RUN_ID_CONFLICT",
    "RUNTIME_EXTERNAL_RUN_ID_INVALID",
    "RUNTIME_GENERATION_STAGE_",
    "RUNTIME_INTERRUPT_NOT_RESUMABLE",
    "RUNTIME_KNOWLEDGE_GRANT_LEAK",
    "RUNTIME_OUTPUT_ENTRY_MISSING",
    "RUNTIME_RESUME_",
    "RUNTIME_RESULT_SUBMISSION_",
    "RUNTIME_TOOL_",
    "RUN_EVENT_SOURCE_",
  ].some((prefix) => error.message.startsWith(prefix));
}

export function runtimeExecutionErrorCode(
  error: unknown,
  fallback = "RUNTIME_EXECUTION_FAILED",
): string {
  if (error instanceof RuntimeLivenessError) return error.code;
  const providerStateCode = knownRuntimeProviderStateErrorCode(error);
  if (providerStateCode) return providerStateCode;
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function persistedDesignStyleSnapshot(
  run: {
    projectId: string;
    designStyleSnapshot: unknown;
    designStyleSnapshotSha256: string | null;
  },
  request: StartRunRequest,
) {
  if (request.designStyle.kind === "automatic") {
    if (run.designStyleSnapshot != null || run.designStyleSnapshotSha256 != null) {
      throw new Error("RUNTIME_DESIGN_STYLE_SNAPSHOT_UNEXPECTED");
    }
    return null;
  }
  if (run.designStyleSnapshot == null || run.designStyleSnapshotSha256 == null) {
    throw new Error("RUNTIME_DESIGN_STYLE_SNAPSHOT_MISSING");
  }
  const materialized = runtimeMaterializedDesignStyleSnapshotSchema.safeParse(run.designStyleSnapshot);
  if (!materialized.success || sha256Canonical(materialized.data) !== run.designStyleSnapshotSha256) {
    throw new Error("RUNTIME_DESIGN_STYLE_SNAPSHOT_INVALID");
  }

  if (request.designStyle.kind === "artifact") {
    const artifact = runtimeDesignStyleSnapshotSchema.safeParse(materialized.data);
    if (
      !artifact.success
      || artifact.data.source.projectId !== run.projectId
      || artifact.data.source.artifactVersionId !== request.designStyle.artifactVersionId
    ) {
      throw new Error("RUNTIME_DESIGN_STYLE_SNAPSHOT_INVALID");
    }
    return artifact.data;
  }

  const preset = runtimePresetDesignStyleSnapshotSchema.safeParse(materialized.data);
  if (
    !preset.success
    || preset.data.source.presetId !== request.designStyle.presetId
    || preset.data.source.version !== request.designStyle.version
    || preset.data.source.checksum !== request.designStyle.checksum
    || sha256Canonical(designPresetDefinitionFromRuntimeSnapshot(preset.data)) !== preset.data.source.checksum
  ) {
    throw new Error("RUNTIME_DESIGN_STYLE_SNAPSHOT_INVALID");
  }
  return preset.data;
}

function draftText(value: unknown) {
  const text = asRecord(value)?.text;
  return typeof text === "string" ? text : "";
}

function terminalVisibleTextDelta(previous: string, terminal: string) {
  if (terminal === previous) return "";
  if (terminal.startsWith(previous)) return terminal.slice(previous.length);
  throw new Error("RUNTIME_EXTERNAL_FINALIZATION_TEXT_CONFLICT");
}
