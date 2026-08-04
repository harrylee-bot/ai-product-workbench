import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Transform } from "node:stream";
import {
  approvalOptionSchema,
  approvalOptionsSchema,
  applyPrototypePatch,
  canvasAgentToolNames,
  canvasAgentToolResultSchema,
  canonicalPrototypeScreenProjection,
  canonicalJson,
  PROTOTYPE_PATCH_MAX_REVISION,
  jsonValueSchema,
  knowledgeToolReferenceSchema,
  projectPrototypeScreen,
  prototypeDocumentSchema,
  runtimeArtifactDraftSchema,
  runtimeInputRequiredSchema,
  runtimePrototypePatchInputSchema,
  runtimeResultSchema,
  type ApprovalOption,
  type JsonValue,
  type PrototypeDocument,
  type PrototypePatchCheckpointScreen,
  type RuntimeArtifactDraft,
  type RuntimeInputRequired,
  type RuntimeOutcome,
  type RuntimeProgressEvent,
  type RuntimePrototypePatchInput,
  type RuntimeResult,
  type RuntimeResumeDecision,
} from "@workbench/workbench-contracts";
import type { VerifiedReadyObjectBody } from "@workbench/workbench-content-security";
import { Client, type Run, type StreamMode } from "@langchain/langgraph-sdk";
import { tracedFetch } from "@workbench/workbench-telemetry";
import FormData from "form-data";
import { v5 as uuidV5 } from "uuid";
import { z } from "zod";
import type { WorkerConfig } from "../config.js";
import type { RuntimeReadyBlobReader } from "../storage/runtime-ready-blob-reader.port.js";
import {
  assistantTextDelta,
  CapabilityRedactionFilter as KnowledgeGrantRedactionFilter,
  createRuntimeFinalizationPayload,
  createRuntimeProviderTextCheckpoint,
  extractAssistantTextFrame,
  projectCompleteVisibleAssistantText,
} from "./runtime-assistant-text.js";
import type {
  RuntimeSource,
  RuntimeCancellation,
  RuntimeCancellationResult,
  RuntimeContentLocator,
  RuntimeDesignAsset,
  RuntimeExecution,
  RuntimeExecutionObserver,
  RuntimePort,
  RuntimePrototypePatchBaseline,
  RuntimeThreadMetadata,
} from "./runtime.port.js";
import {
  RuntimeSubmissionUnknownError,
  runtimeExternalFinalizationEvent,
} from "./runtime.port.js";
import {
  RuntimeProviderLivenessBudget,
  raceWithAbort,
} from "./runtime-liveness.js";
import { runtimePrdResultGuidance } from "./runtime-prd-guidance.js";
import { assertPrdReferenceReadEvidence } from "./runtime-prd-reference-evidence.js";

export {
  assistantTextDelta,
  CapabilityRedactionFilter as KnowledgeGrantRedactionFilter,
} from "./runtime-assistant-text.js";

const MAX_GATEWAY_RESPONSE_SIZE = 65_536;
const ARTIFACT_DRAFT_PUBLISH_TOOL = "workbench_artifact_draft_publish";
const GENERATION_STAGE_TOOL = "workbench_generation_stage_update";
const PROTOTYPE_PATCH_PUBLISH_TOOL = "workbench_prototype_patch_publish";
const RUNTIME_RESULT_SUBMIT_TOOL = "workbench_runtime_result_submit";
const GENERATION_STAGE_PROTOCOL = "workbench.runtime.generation-stage.v1";
const ARTIFACT_DRAFT_PROTOCOL = "workbench.runtime.artifact-draft.v1";
const PROTOTYPE_PATCH_PUBLICATION_PROTOCOL = "workbench.runtime.prototype-patch-publication.v1";
const VALIDATED_RUNTIME_RESULT_PROTOCOL = "workbench.runtime.validated-result.v1";
const PRD_GENERATION_STAGE_SEQUENCE = [
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
] as const;
const RUN_PAGE_SIZE = 100;
const MAX_RUN_RECOVERY_PAGES = 100;
const KNOWLEDGE_GRANT_TOKEN = /wbkg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/u;
const CANVAS_GRANT_TOKEN = /wbct1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/u;
const TERMINAL_EXTERNAL_RUN_STATUSES = new Set<Run["status"]>(["error", "success", "timeout", "interrupted"]);
const STREAM_MODES = new Set<StreamMode>([
  "values",
  "messages",
  "updates",
  "events",
  "debug",
  "tasks",
  "checkpoints",
  "custom",
  "messages-tuple",
  "tools",
]);

type DeerFlowContentHandle = {
  virtualPath: string;
  markdownVirtualPath: string | null;
};

type DeerFlowSourceHandle = {
  position: number;
  sourceId: string;
  sourceKind: RuntimeSource["sourceKind"];
  blobId: string;
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  original: DeerFlowContentHandle;
  extraction: {
    kind: string;
    position: number;
    mediaType: string;
    byteSize: number;
    sha256: string;
    handle: DeerFlowContentHandle;
  } | null;
};

type DeerFlowDesignAssetHandle = {
  assetId: string;
  handle: DeerFlowContentHandle;
};

type DeerFlowArtifactTargetContentHandle = {
  kind: "content";
  artifactVersionId: string;
  handle: DeerFlowContentHandle;
};

type DeerFlowArtifactTargetAssetHandle = {
  kind: "asset";
  artifactVersionId: string;
  assetId: string;
  handle: DeerFlowContentHandle;
};

type DeerFlowArtifactTargetHandle =
  | DeerFlowArtifactTargetContentHandle
  | DeerFlowArtifactTargetAssetHandle;

function artifactTargetAssetHandleKey(artifactVersionId: string, assetId: string) {
  return JSON.stringify([artifactVersionId, assetId]);
}

const gatewayUploadResponseSchema = z.object({
  files: z.array(z.object({
    virtual_path: z.string().optional(),
    virtualPath: z.string().optional(),
    markdown_virtual_path: z.string().optional(),
    markdownVirtualPath: z.string().optional(),
  }).passthrough()).length(1),
}).passthrough();

const validatedRuntimeResultArtifactScopeShape = {
  protocol: z.literal(VALIDATED_RUNTIME_RESULT_PROTOCOL),
  runId: z.string().min(1).max(240),
  runtimeAttemptId: z.string().min(1).max(240),
  toolCallId: z.string().min(1).max(512),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
};

const validatedRuntimeResultArtifactSchema = z.discriminatedUnion("ok", [
  z.object({
    ...validatedRuntimeResultArtifactScopeShape,
    ok: z.literal(true),
    resultChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
    result: runtimeResultSchema,
  }).strict(),
  z.object({
    ...validatedRuntimeResultArtifactScopeShape,
    ok: z.literal(false),
    issues: z.array(jsonValueSchema).max(10_000),
  }).strict(),
]);

const generationStageArtifactSchema = z.object({
  protocol: z.literal(GENERATION_STAGE_PROTOCOL),
  runId: z.string().min(1).max(240),
  runtimeAttemptId: z.string().min(1).max(240),
  toolCallId: z.string().min(1).max(512),
  stage: z.enum([
    "collecting-prd-context",
    "structuring-prd",
    "drafting-prd",
    "validating-prd",
    "design-system",
    "mapping-components",
    "creating-flows",
    "generating-ui",
  ]),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const artifactDraftArtifactScopeShape = {
  protocol: z.literal(ARTIFACT_DRAFT_PROTOCOL),
  runId: z.string().min(1).max(240),
  runtimeAttemptId: z.string().min(1).max(240),
  toolCallId: z.string().min(1).max(512),
  artifactIndex: z.number().int().min(0).max(19),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
};

const artifactDraftArtifactSchema = z.discriminatedUnion("ok", [
  z.object({
    ...artifactDraftArtifactScopeShape,
    ok: z.literal(true),
    draftChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
    draft: runtimeArtifactDraftSchema,
  }).strict(),
  z.object({
    ...artifactDraftArtifactScopeShape,
    ok: z.literal(false),
    issues: z.array(jsonValueSchema).max(10_000),
  }).strict(),
]);

const prototypePatchArtifactScopeShape = {
  protocol: z.literal(PROTOTYPE_PATCH_PUBLICATION_PROTOCOL),
  runId: z.string().min(1).max(240),
  runtimeAttemptId: z.string().min(1).max(240),
  toolCallId: z.string().min(1).max(512),
  checksum: z.string().regex(/^[0-9a-f]{64}$/u),
};

const prototypePatchArtifactSchema = z.discriminatedUnion("ok", [
  z.object({
    ...prototypePatchArtifactScopeShape,
    ok: z.literal(true),
    patchChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
    patch: runtimePrototypePatchInputSchema,
  }).strict(),
  z.object({
    ...prototypePatchArtifactScopeShape,
    ok: z.literal(false),
    issues: z.array(jsonValueSchema).max(10_000),
  }).strict(),
]);

export class DeerFlowRuntimeAdapter implements RuntimePort {
  readonly adapter = "deerflow";
  private readonly csrfToken = randomBytes(32).toString("base64url");

  constructor(
    private readonly config: WorkerConfig,
    private readonly storage: RuntimeReadyBlobReader,
  ) {}

  async createThread(metadata: RuntimeThreadMetadata, signal?: AbortSignal) {
    const externalThreadId = runtimeThreadUuid(metadata.workbenchThreadId);
    const thread = await this.client(metadata.workbenchPrincipalId).threads.create({
      threadId: externalThreadId,
      ifExists: "do_nothing",
      metadata,
      signal,
    });
    if (
      thread.thread_id !== externalThreadId
      || thread.metadata?.workbenchThreadId !== metadata.workbenchThreadId
    ) {
      throw new Error("DEERFLOW_THREAD_BINDING_INVALID");
    }
    return { externalThreadId, metadata };
  }

  async execute(
    execution: RuntimeExecution,
    observer: RuntimeExecutionObserver,
    signal?: AbortSignal,
  ): Promise<RuntimeOutcome> {
    if (
      execution.request.requestedArtifactKinds.includes("prd")
      && execution.request.requestedArtifactKinds.some((kind) => (
        kind === "prototype" || kind === "code"
      ))
    ) {
      throw new Error("RUNTIME_ARTIFACT_PRD_MIXED_REQUEST_INVALID");
    }
    const liveness = new RuntimeProviderLivenessBudget(
      this.config.deerFlowSubmissionTimeoutMs,
      this.config.deerFlowIdleTimeoutMs,
      signal,
    );
    try {
      return await raceWithAbort(
        this.executeWithLiveness(
          execution,
          observer,
          liveness.signal,
          () => liveness.providerActivity(),
        ),
        liveness.signal,
      );
    } finally {
      liveness.stop();
    }
  }

  private async executeWithLiveness(
    execution: RuntimeExecution,
    observer: RuntimeExecutionObserver,
    signal: AbortSignal,
    onProviderActivity: () => void,
  ): Promise<RuntimeOutcome> {
    const submission = execution.submission;
    let baselineState = submission.mode === "reconcile"
      ? null
      : prototypePatchBaselineState(execution.prototypePatchBaselines);
    const client = this.client(execution.principalId, submission.providerIdempotencyKey);
    let recovered: Run | null;
    try {
      recovered = submission.mode === "join"
        ? await client.runs.get(execution.externalThreadId, submission.externalRunId, { signal })
        : await this.findExternalRun(
            client,
            execution.externalThreadId,
            execution.runtimeAttemptId,
            submission.providerIdempotencyKey,
            signal,
          );
    } catch (error) {
      if (submission.mode === "reconcile") {
        throw new RuntimeSubmissionUnknownError("RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE", {
          cause: error,
        });
      }
      throw error;
    }
    let externalRunId = submission.mode === "join" ? submission.externalRunId : null;
    if (recovered) {
      externalRunId = recovered.run_id;
      if (submission.mode === "join" && submission.externalRunId !== recovered.run_id) {
        throw new Error("RUNTIME_EXTERNAL_RUN_ID_CONFLICT");
      }
      if (submission.mode !== "join") {
        try {
          if (submission.mode === "submit") await observer.onSubmissionStarted();
          await observer.onExternalRunCreated(recovered.run_id);
        } catch (error) {
          throw new RuntimeSubmissionUnknownError("RUNTIME_SUBMISSION_RECONCILIATION_PERSISTENCE_UNKNOWN", {
            cause: error,
          });
        }
      }
    }
    baselineState ??= prototypePatchBaselineState(execution.prototypePatchBaselines);

    let externalRunPersistence: Promise<void> | null = externalRunId ? Promise.resolve() : null;
    const registerExternalRun = (candidate: string) => {
      if (externalRunId && externalRunId !== candidate) {
        externalRunPersistence = Promise.reject(new Error("RUNTIME_EXTERNAL_RUN_ID_CONFLICT"));
        return;
      }
      externalRunId = candidate;
      externalRunPersistence ??= observer.onExternalRunCreated(candidate);
    };

    let stream: AsyncGenerator<{ id?: string; event: string; data: unknown }>;
    let submissionMayHaveBeenAccepted = false;
    const streamIdleReconnect = Math.min(
      30_000,
      Math.max(1_000, Math.floor(this.config.deerFlowIdleTimeoutMs / 2)),
    );
    if (externalRunId) {
      stream = client.runs.joinStream(execution.externalThreadId, externalRunId, {
        signal,
        cancelOnDisconnect: false,
        lastEventId: submission.mode === "join"
          ? submission.lastExternalEventId ?? undefined
          : undefined,
        streamMode: this.streamMode(execution.request.requestedArtifactKinds),
        streamIdleReconnect,
      });
    } else {
      if (submission.mode === "reconcile") {
        throw new RuntimeSubmissionUnknownError();
      }
      const sourceHandles = execution.resume
        ? []
        : await this.uploadSources(execution, signal);
      const designAssetHandles = execution.resume
        ? []
        : await this.uploadDesignAssets(execution, signal);
      const artifactTargetHandles = execution.resume
        ? []
        : await this.uploadArtifactTargets(execution, signal);
      const runRequest = this.buildRunRequest(
        execution,
        sourceHandles,
        designAssetHandles,
        artifactTargetHandles,
      );
      await observer.onSubmissionStarted();
      submissionMayHaveBeenAccepted = true;
      stream = client.runs.stream(
        execution.externalThreadId,
        this.config.deerFlowAssistantId,
        {
          ...runRequest,
          signal,
          onDisconnect: "continue",
          streamIdleReconnect,
          onRunCreated: ({ run_id }) => registerExternalRun(run_id),
        },
      );
    }

    let assistantText = execution.providerTextState.rawAssistantText;
    let visibleAssistantText = execution.providerTextState.visibleAssistantText;
    const capabilityOutput = new KnowledgeGrantRedactionFilter(
      execution.providerTextState.redactionBuffer,
    );
    let finalState: unknown;
    let inputRequired: RuntimeInputRequired | null = null;
    const collapsePrdActivity = execution.request.requestedArtifactKinds.length === 1
      && execution.request.requestedArtifactKinds[0] === "prd";
    let activeNode: string | null = null;
    let requestActivityStarted = false;
    let resultToolCallId: string | null = null;
    const prototypeRequested = execution.request.requestedArtifactKinds.includes("prototype");
    let partEffects: RuntimeProgressEvent[] | null = null;
    const emitEvent = async (event: RuntimeProgressEvent) => {
      if (!partEffects) throw new Error("RUNTIME_EFFECT_WITHOUT_EXTERNAL_IDENTITY");
      partEffects.push(event);
    };
    const emittedStageSources = new Map<
      string,
      Extract<RuntimeProgressEvent, { type: "generation.stage" }>["stage"]
    >();
    const emittedStageSequence: Array<
      Extract<RuntimeProgressEvent, { type: "generation.stage" }>["stage"]
    > = [];
    const emittedDraftSources = new Map<string, string>();
    const emittedPatchSources = new Map<string, string>();
    const patchRevisions = baselineState.revisions;
    const pendingRecoveryRevisions = baselineState.recoveryRevisions;
    const uncheckpointedPatchArtifacts = new Set<number>();
    const latestCheckpoints = new Map<number, RuntimeArtifactDraft>();
    const latestPrototypeDocuments = baselineState.documents;
    const screenStreamingSourceId = runtimeAttemptSourceId(
      execution.runtimeAttemptId,
      "screen-streaming",
    );
    const draftSourceIsReplay = (
      artifactIndex: number,
      draft: RuntimeArtifactDraft,
      sourceEventId: string,
    ) => {
      const emittedFingerprint = emittedDraftSources.get(sourceEventId);
      if (emittedFingerprint === undefined) return false;
      const fingerprint = canonicalJson({ artifactIndex, draft });
      if (emittedFingerprint !== fingerprint) {
        throw new Error("RUNTIME_ARTIFACT_DRAFT_SOURCE_CONFLICT");
      }
      return true;
    };
    const emitStage = async (
      stage: Extract<RuntimeProgressEvent, { type: "generation.stage" }>["stage"],
      sourceEventId: string,
    ) => {
      const emittedStage = emittedStageSources.get(sourceEventId);
      if (emittedStage) {
        if (emittedStage !== stage) throw new Error("RUNTIME_GENERATION_STAGE_SOURCE_CONFLICT");
        return;
      }
      await emitEvent({ type: "generation.stage", stage, sourceEventId });
      emittedStageSources.set(sourceEventId, stage);
      emittedStageSequence.push(stage);
    };
    const emitDraft = async (
      artifactIndex: number,
      draft: RuntimeArtifactDraft,
      sourceEventId: string,
      checkpointScreens: PrototypePatchCheckpointScreen[],
      onCreated?: () => void,
    ) => {
      if (draftSourceIsReplay(artifactIndex, draft, sourceEventId)) return false;
      await emitEvent({
        type: "artifact.draft",
        artifactIndex,
        draft,
        sourceEventId,
        checkpointScreens,
      });
      emittedDraftSources.set(sourceEventId, canonicalJson({ artifactIndex, draft }));
      onCreated?.();
      if (draft.kind === "prototype") {
        await emitStage("screen-streaming", screenStreamingSourceId);
      }
      return true;
    };
    const emitCheckpointDrafts = async (
      submissions: ReturnType<typeof validatedArtifactDraftSubmissions>,
      assertReferenceEvidence: (draft: RuntimeArtifactDraft, declarationIndex: number) => void,
    ) => {
      for (const submission of submissions) {
        assertPrdGenerationStagesComplete(submission.draft, emittedStageSequence);
        assertReferenceEvidence(submission.draft, submission.declarationIndex);
        const sourceEventId = runtimeToolSourceId(
          execution.runtimeAttemptId,
          ARTIFACT_DRAFT_PUBLISH_TOOL,
          submission.toolCallId,
        );
        if (draftSourceIsReplay(submission.artifactIndex, submission.draft, sourceEventId)) continue;
        if (resultToolCallId) throw new Error("RUNTIME_ARTIFACT_DRAFT_AFTER_RESULT");
        const previousDocument = latestPrototypeDocuments.get(submission.artifactIndex);
        const checkpointScreens = checkpointPatchScreens(
          submission.artifactIndex,
          previousDocument,
          submission.draft,
          patchRevisions,
          pendingRecoveryRevisions,
        );
        await emitDraft(
          submission.artifactIndex,
          submission.draft,
          sourceEventId,
          checkpointScreens,
          () => {
            latestCheckpoints.set(submission.artifactIndex, submission.draft);
            replaceArtifactPrototypeDocument(
              submission.artifactIndex,
              latestPrototypeDocuments,
              submission.draft,
            );
            replaceArtifactPatchRevisions(
              submission.artifactIndex,
              patchRevisions,
              patchRevisionsFromCheckpointScreens(submission.artifactIndex, checkpointScreens),
            );
            clearArtifactPatchRecoveryRevisions(
              submission.artifactIndex,
              pendingRecoveryRevisions,
            );
            uncheckpointedPatchArtifacts.delete(submission.artifactIndex);
          },
        );
      }
    };
    const emitPatch = async (
      patch: RuntimePrototypePatchInput,
      sourceEventId: string,
    ) => {
      const fingerprint = canonicalJson(patch);
      const emittedFingerprint = emittedPatchSources.get(sourceEventId);
      if (emittedFingerprint) {
        if (emittedFingerprint !== fingerprint) {
          throw new Error("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");
        }
        return;
      }
      if (resultToolCallId) throw new Error("RUNTIME_PROTOTYPE_PATCH_AFTER_RESULT");
      const document = latestPrototypeDocuments.get(patch.artifactIndex);
      if (
        !document
        || pendingRecoveryRevisions.has(prototypePatchRevisionKey(
          patch.artifactIndex,
          patch.screenId,
        ))
        || !document.screens.some((screen) => screen.id === patch.screenId)
      ) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_CHECKPOINT_MISSING");
      }
      const key = prototypePatchRevisionKey(patch.artifactIndex, patch.screenId);
      const currentRevision = patchRevisions.get(key) ?? 0;
      if (
        patch.baseRevision !== currentRevision
        || patch.nextRevision !== currentRevision + 1
      ) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_REVISION_INVALID");
      }
      const applied = applyPrototypePatch(document, {
        screenId: patch.screenId,
        baseRevision: patch.baseRevision,
        nextRevision: patch.nextRevision,
        operations: patch.operations,
        resultingChecksum: patch.resultingChecksum,
      });
      const resultingChecksum = createHash("sha256")
        .update(applied.canonicalProjection)
        .digest("hex");
      if (resultingChecksum !== patch.resultingChecksum) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_CHECKSUM_INVALID");
      }
      await emitEvent({
        type: "artifact.prototype.patch",
        sourceEventId,
        patch,
      });
      emittedPatchSources.set(sourceEventId, fingerprint);
      patchRevisions.set(key, patch.nextRevision);
      latestPrototypeDocuments.set(patch.artifactIndex, applied.document);
      const checkpoint = latestCheckpoints.get(patch.artifactIndex);
      if (checkpoint?.kind === "prototype") {
        latestCheckpoints.set(patch.artifactIndex, { ...checkpoint, content: applied.document });
      }
      uncheckpointedPatchArtifacts.add(patch.artifactIndex);
    };
    const emitResultDrafts = async (
      submission: {
        result: RuntimeResult;
        toolCallId: string;
        declarationIndex: number;
        messageIndex: number;
      },
      assertReferenceEvidence: (draft: RuntimeArtifactDraft, declarationIndex: number) => void,
    ) => {
      if (uncheckpointedPatchArtifacts.size > 0) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_FINAL_CHECKPOINT_MISSING");
      }
      assertRuntimeResultCheckpoints(submission.result, latestCheckpoints);
      for (const draft of submission.result.artifacts) {
        assertPrdGenerationStagesComplete(draft, emittedStageSequence);
      }
      for (const draft of submission.result.artifacts) {
        assertReferenceEvidence(draft, submission.declarationIndex);
      }
      for (const [artifactIndex, draft] of submission.result.artifacts.entries()) {
        const sourceEventId = runtimeToolSourceId(
          execution.runtimeAttemptId,
          `${RUNTIME_RESULT_SUBMIT_TOOL}:artifact:${artifactIndex}`,
          submission.toolCallId,
        );
        const checkpointScreens = checkpointPatchScreens(
          artifactIndex,
          latestPrototypeDocuments.get(artifactIndex),
          draft,
          patchRevisions,
          pendingRecoveryRevisions,
        );
        await emitDraft(artifactIndex, draft, sourceEventId, checkpointScreens, () => {
          replaceArtifactPrototypeDocument(artifactIndex, latestPrototypeDocuments, draft);
          replaceArtifactPatchRevisions(
            artifactIndex,
            patchRevisions,
            patchRevisionsFromCheckpointScreens(artifactIndex, checkpointScreens),
          );
          clearArtifactPatchRecoveryRevisions(artifactIndex, pendingRecoveryRevisions);
        });
      }
    };
    const processArtifactState = async (state: unknown) => {
      const stageSubmissions = extractGenerationStageProgress(state, execution);
      const checkpointSubmissions = validatedArtifactDraftSubmissions(state, execution);
      const patchSubmissions = validatedPrototypePatchSubmissions(state, execution);
      const resultSubmissions = validatedRuntimeSubmissions(state, execution);
      if (resultSubmissions.length > 1) throw new Error("RUNTIME_RESULT_SUBMISSION_MULTIPLE");
      const resultSubmission = resultSubmissions[0];
      const assertReferenceEvidence = (
        draft: RuntimeArtifactDraft,
        artifactDeclarationIndex: number,
      ) => {
        if (
          draft.kind !== "prd"
          || !execution.request.requestedArtifactKinds.includes("prd")
        ) return;
        const collecting = stageSubmissions.find((submission) => (
          submission.stage === "collecting-prd-context"
        ));
        const structuring = stageSubmissions.find((submission) => (
          submission.stage === "structuring-prd"
        ));
        const drafting = stageSubmissions.find((submission) => (
          submission.stage === "drafting-prd"
        ));
        if (!collecting || !structuring || !drafting) {
          throw new Error("RUNTIME_ARTIFACT_PRD_GENERATION_STAGES_INCOMPLETE");
        }
        assertPrdReferenceReadEvidence(state, {
          collectingResponseIndex: collecting.messageIndex,
          structuringDeclarationIndex: structuring.declarationIndex,
          draftingDeclarationIndex: drafting.declarationIndex,
          artifactDeclarationIndex,
        });
      };
      assertCanvasToolCausality(
        state,
        execution.canvasTool?.reference.declaredTools ?? [],
        resultSubmission
          ? {
              declarationIndex: resultSubmission.declarationIndex,
              responseIndex: resultSubmission.messageIndex,
            }
          : undefined,
      );
      const causalEvents = [
        ...stageSubmissions.map((submission) => ({
          kind: "stage" as const,
          messageIndex: submission.messageIndex,
          submission,
        })),
        ...checkpointSubmissions.map((submission) => ({
          kind: "checkpoint" as const,
          messageIndex: submission.messageIndex,
          submission,
        })),
        ...patchSubmissions.map((submission) => ({
          kind: "patch" as const,
          messageIndex: submission.messageIndex,
          submission,
        })),
        ...(resultSubmission ? [{
          kind: "result" as const,
          messageIndex: resultSubmission.messageIndex,
          submission: resultSubmission,
        }] : []),
      ].sort((left, right) => left.messageIndex - right.messageIndex);
      for (const event of causalEvents) {
        if (event.kind === "stage") {
          await emitStage(event.submission.stage, event.submission.sourceEventId);
          continue;
        }
        if (event.kind === "checkpoint") {
          await emitCheckpointDrafts([event.submission], assertReferenceEvidence);
          continue;
        }
        if (event.kind === "patch") {
          await emitPatch(event.submission.patch, event.submission.sourceEventId);
          continue;
        }
        await emitResultDrafts(event.submission, assertReferenceEvidence);
        resultToolCallId = event.submission.toolCallId;
      }
    };
    try {
      for await (const part of stream) {
        onProviderActivity();
        // The SDK retains the previous SSE ID across comment-only heartbeat
        // frames and exposes them as an empty event. They carry no business
        // data and must not advance the durable provider cursor.
        if (!part.event && part.data === null) continue;
        // DeerFlow terminates its Redis-backed stream with an un-ID'd end/null
        // sentinel. The SDK carries the previous SSE ID onto that frame, so it
        // must not enter the durable business-event inbox or advance the cursor.
        if (part.event === "end") {
          if (part.data !== null) throw new Error("DEERFLOW_STREAM_END_INVALID");
          continue;
        }
        partEffects = [];
        const metadataRunId = externalRunIdFromEvent(part.event, part.data);
        if (metadataRunId) registerExternalRun(metadataRunId);
        if (!externalRunId || !externalRunPersistence) {
          throw new Error("RUNTIME_EXTERNAL_RUN_ID_MISSING");
        }
        await externalRunPersistence;
        if (signal?.aborted) throw abortError(signal);
        const externalPart = part.id
          ? {
              externalRunId,
              externalEventId: part.id,
              event: part.event,
              payload: jsonValueSchema.parse(part.data),
            }
          : null;
        if (externalPart && await observer.isExternalEventProcessed(externalPart)) {
          partEffects = null;
          continue;
        }

        const node = extractNode(part.data);
        if (node && collapsePrdActivity && !requestActivityStarted) {
          // Raw graph nodes remain in the persisted provider event above. PRD
          // activity is request-scoped so middleware names never reach the UI.
          await emitEvent(requestActivityEvent(execution, "running"));
          requestActivityStarted = true;
        } else if (node && !collapsePrdActivity && node !== activeNode) {
          if (activeNode) {
            await emitEvent(activityEvent(activeNode, "succeeded"));
          }
          activeNode = node;
          await emitEvent(activityEvent(node, "running"));
        }

        if (part.event === "error") {
          throw new Error("DEERFLOW_RUN_ERROR");
        }
        if (part.event === "values") {
          finalState = part.data;
          inputRequired = extractRuntimeInputRequired(part.data) ?? inputRequired;
          await processArtifactState(part.data);
        }
        const incoming = extractAssistantTextFrame(part.event, part.data);
        if (incoming) {
          const delta = assistantTextDelta(assistantText, incoming.text, incoming.kind);
          assistantText += delta;
          const visibleDelta = capabilityOutput.push(delta);
          if (visibleDelta) {
            if (prototypeRequested && resultToolCallId && visibleDelta.trim()) {
              await emitStage(
                "summarizing",
                runtimeToolSourceId(execution.runtimeAttemptId, "assistant-summary", resultToolCallId),
              );
            }
            await emitEvent({ type: "text.delta", delta: visibleDelta });
          }
        }
        const effects = partEffects;
        partEffects = null;
        if (!part.id) {
          if (effects.length > 0) throw new Error("RUNTIME_EXTERNAL_EVENT_ID_MISSING");
          continue;
        }
        await observer.onExternalEvent(externalPart!, effects);
        visibleAssistantText += visibleTextDeltaFromEffects(effects);
      }
    } catch (error) {
      let persistenceError: unknown = null;
      if (externalRunPersistence) {
        try {
          await externalRunPersistence;
        } catch (candidate) {
          persistenceError = candidate;
        }
      }
      if (submissionMayHaveBeenAccepted && !externalRunId) {
        let accepted = null;
        try {
          accepted = await this.findExternalRun(
            client,
            execution.externalThreadId,
            execution.runtimeAttemptId,
            submission.providerIdempotencyKey,
            signal,
          );
        } catch (lookupError) {
          throw new RuntimeSubmissionUnknownError("RUNTIME_SUBMISSION_RECONCILIATION_UNAVAILABLE", {
            cause: lookupError,
          });
        }
        if (accepted) {
          try {
            await observer.onExternalRunCreated(accepted.run_id);
          } catch (attachError) {
            throw new RuntimeSubmissionUnknownError(
              "RUNTIME_SUBMISSION_RECONCILIATION_PERSISTENCE_UNKNOWN",
              { cause: attachError },
            );
          }
          throw error;
        }
        throw new RuntimeSubmissionUnknownError("RUNTIME_SUBMISSION_UNKNOWN", { cause: error });
      }
      if (submissionMayHaveBeenAccepted && persistenceError) {
        throw new RuntimeSubmissionUnknownError(
          "RUNTIME_SUBMISSION_RECONCILIATION_PERSISTENCE_UNKNOWN",
          { cause: persistenceError },
        );
      }
      if (persistenceError) throw persistenceError;
      throw error;
    }

    if (!externalRunId || !externalRunPersistence) throw new Error("RUNTIME_EXTERNAL_RUN_ID_MISSING");
    await externalRunPersistence;
    if (finalState === undefined) {
      finalState = await client.threads.getState(execution.externalThreadId, undefined, { signal });
    }

    inputRequired ??= extractRuntimeInputRequired(finalState);
    partEffects = [];
    await processArtifactState(finalState);
    const providerTextBeforeFinalization = {
      rawAssistantText: assistantText,
      visibleAssistantText,
      redactionBuffer: capabilityOutput.snapshot(),
    };
    const terminalFrame = extractAssistantTextFrame("values", finalState);
    const terminalRawDelta = terminalFrame
      ? assistantTextDelta(assistantText, terminalFrame.text, terminalFrame.kind)
      : "";
    const terminalRawAssistantText = `${assistantText}${terminalRawDelta}`;
    const outcome = inputRequired
      ? assertNoKnowledgeGrant(inputRequired)
      : assertNoKnowledgeGrant(
          resolveRuntimeResult(finalState, execution.request.requestedArtifactKinds, execution),
        );
    if (execution.providerTextState.committedFinalization) {
      if (terminalRawDelta) throw new Error("RUNTIME_PROVIDER_TEXT_EVENT_AFTER_FINALIZATION");
      if (projectCompleteVisibleAssistantText(assistantText) !== visibleAssistantText) {
        throw new Error("RUNTIME_PROVIDER_TEXT_TERMINAL_PROJECTION_CONFLICT");
      }
      return outcome;
    }
    const providerTextCheckpoint = createRuntimeProviderTextCheckpoint(
      providerTextBeforeFinalization,
      terminalRawAssistantText,
    );
    const finalVisibleDelta = visibleProjectionDelta(
      visibleAssistantText,
      providerTextCheckpoint.terminal.visibleAssistantText,
    );
    const incrementalFilter = new KnowledgeGrantRedactionFilter(
      providerTextBeforeFinalization.redactionBuffer,
    );
    const incrementalVisibleDelta = `${incrementalFilter.push(terminalRawDelta)}${incrementalFilter.flush()}`;
    if (incrementalVisibleDelta !== finalVisibleDelta) {
      throw new Error("RUNTIME_PROVIDER_TEXT_TERMINAL_PROJECTION_CONFLICT");
    }
    if (finalVisibleDelta) {
      if (prototypeRequested && resultToolCallId && finalVisibleDelta.trim()) {
        await emitStage(
          "summarizing",
          runtimeToolSourceId(execution.runtimeAttemptId, "assistant-summary", resultToolCallId),
        );
      }
    }
    const derivedFinalizationEffects = partEffects;
    partEffects = null;
    const finalizationEffects = derivedFinalizationEffects;
    const finalizationPart = runtimeFinalizationPart(
        execution,
        externalRunId,
        finalState,
      outcome,
      finalizationEffects,
      providerTextCheckpoint.terminal.visibleAssistantText,
      providerTextCheckpoint,
      );
    await observer.onExternalFinalization(finalizationPart, finalizationEffects);
    return outcome;
  }

  async cancel(
    cancellation: RuntimeCancellation,
    onExternalRunRecovered: (externalRunId: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<RuntimeCancellationResult> {
    const client = this.client(cancellation.principalId);
    let run: Run | null;
    if (cancellation.externalRunId) {
      try {
        run = await client.runs.get(
          cancellation.externalThreadId,
          cancellation.externalRunId,
          { signal },
        );
      } catch (error) {
        if (!isSdkHttpStatus(error, 404)) throw error;
        return {
          disposition: "external_run_absent",
          externalRunId: cancellation.externalRunId,
          externalStatus: null,
        };
      }
    } else {
      run = await this.findExternalRun(
        client,
        cancellation.externalThreadId,
        cancellation.runtimeAttemptId,
        undefined,
        signal,
      );
    }
    if (!run) {
      return {
        disposition: "not_found",
        externalRunId: null,
        externalStatus: null,
      };
    }
    if (!cancellation.externalRunId) await onExternalRunRecovered(run.run_id);
    if (!TERMINAL_EXTERNAL_RUN_STATUSES.has(run.status)) {
      try {
        await client.runs.cancel(
          cancellation.externalThreadId,
          run.run_id,
          true,
          "interrupt",
          { signal },
        );
      } catch (error) {
        if (!isSdkHttpStatus(error, 404)) throw error;
        return {
          disposition: "external_run_absent",
          externalRunId: cancellation.externalRunId ?? run.run_id,
          externalStatus: null,
        };
      }
      return {
        disposition: "cancelled",
        externalRunId: run.run_id,
        externalStatus: "interrupted",
      };
    }
    return {
      disposition: "already_terminal",
      externalRunId: run.run_id,
      externalStatus: run.status,
    };
  }

  private buildRunRequest(
    execution: RuntimeExecution,
    sourceHandles: DeerFlowSourceHandle[],
    designAssetHandles: DeerFlowDesignAssetHandle[],
    artifactTargetHandles: DeerFlowArtifactTargetHandle[],
  ) {
    const knowledgeToolCapability = execution.knowledgeTool;
    const canvasToolCapability = execution.canvasTool;
    const knowledgeTool = knowledgeToolCapability
      ? knowledgeToolReferenceSchema.parse({
          protocol: "workbench.knowledge-tool-reference.v1",
          toolName: "workbench_knowledge_retrieve",
          releaseId: knowledgeToolCapability.releaseId,
          mode: "hybrid",
          routeScope: "production",
        })
      : null;
    const designAssetHandleMap = Object.fromEntries(
      designAssetHandles.map((asset) => [asset.assetId, asset.handle]),
    );
    const artifactTargetContentHandleMap = new Map(
      artifactTargetHandles
        .filter((target): target is DeerFlowArtifactTargetContentHandle => target.kind === "content")
        .map((target) => [target.artifactVersionId, target.handle]),
    );
    const artifactTargetAssetHandleMap = new Map(
      artifactTargetHandles
        .filter((target): target is DeerFlowArtifactTargetAssetHandle => target.kind === "asset")
        .map((target) => [
          artifactTargetAssetHandleKey(target.artifactVersionId, target.assetId),
          target.handle,
        ]),
    );
    const prototypePatchBaselines = prototypePatchBaselineContext(
      execution.prototypePatchBaselines,
    );
    const context = {
      protocol: "workbench.runtime.input.v1",
      runId: execution.runId,
      projectId: execution.projectId,
      threadId: execution.threadId,
      modelId: execution.request.modelId,
      workflow: execution.request.workflow,
      generationIntent: execution.request.generationIntent,
      targetSurface: execution.request.targetSurface,
      designStyle: execution.designStyleSnapshot
        ? {
            kind: "materialized",
            snapshot: execution.designStyleSnapshot,
            assetHandles: designAssetHandleMap,
          }
        : execution.request.designStyle,
      knowledgeReleaseId: knowledgeToolCapability?.releaseId ?? null,
      knowledgeTool,
      canvasTool: canvasToolCapability?.reference ?? null,
      sources: sourceHandles.map((source) => ({
        position: source.position,
        sourceId: source.sourceId,
        kind: source.sourceKind,
        blobId: source.blobId,
        fileName: source.fileName,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        sha256: source.sha256,
      })),
      deerFlowSources: sourceHandles.map((source) => ({
        position: source.position,
        fileName: source.fileName,
        fileType: source.mediaType,
        size: source.byteSize,
        deerFlowFile: source.original,
        extraction: source.extraction,
      })),
      artifactTargets: execution.artifactTargets.map((target) => {
        const content = target.content.mode === "inline"
          ? target.content
          : (() => {
              const handle = artifactTargetContentHandleMap.get(target.artifactVersionId);
              if (!handle) throw new Error("RUNTIME_ARTIFACT_TARGET_UPLOAD_MISSING");
              return {
                mode: "blob" as const,
                blobId: target.content.blobId,
                mediaType: target.content.locator.mediaType,
                byteSize: target.content.locator.byteSize,
                sha256: target.content.locator.sha256,
                handle,
              };
            })();
        return {
          artifactId: target.artifactId,
          artifactVersionId: target.artifactVersionId,
          screenIds: target.screenIds,
          kind: target.kind,
          schemaVersion: target.schemaVersion,
          checksum: target.checksum,
          content,
          assets: target.assets.map((asset) => {
            const handle = artifactTargetAssetHandleMap.get(
              artifactTargetAssetHandleKey(target.artifactVersionId, asset.assetId),
            );
            if (!handle) throw new Error("RUNTIME_ARTIFACT_TARGET_ASSET_UPLOAD_MISSING");
            return {
              ...asset.metadata,
              handle,
            };
          }),
        };
      }),
      prototypePatchBaselines,
      requestedArtifactKinds: execution.request.requestedArtifactKinds,
      outputContract: "workbench.runtime.result.v1",
    };
    const resultGuidance = runtimePrdResultGuidance(
      execution.request.requestedArtifactKinds,
      execution.request.workflow,
    );
    return {
      input: execution.resume ? null : {
        messages: [{
          role: "user",
          content: [
            "/workbench",
            "<workbench_context>",
            JSON.stringify(context),
            "</workbench_context>",
            ...(resultGuidance ? [resultGuidance] : []),
            execution.request.prompt,
          ].join("\n"),
        }],
      },
      ...(execution.resume ? { command: { resume: runtimeResumeValue(execution.resume) } } : {}),
      streamMode: this.streamMode(execution.request.requestedArtifactKinds),
      streamResumable: true,
      multitaskStrategy: "reject" as const,
      metadata: {
        workbench_runtime_attempt_id: execution.runtimeAttemptId,
        workbench_provider_idempotency_key: execution.submission.providerIdempotencyKey,
        workbench_run_id: execution.runId,
        workbench_attempt: execution.attempt,
      },
      context: {
        workbench: {
          runId: execution.runId,
          runtimeAttemptId: execution.runtimeAttemptId,
          requestedArtifactKinds: [...execution.request.requestedArtifactKinds],
          ...(knowledgeToolCapability ? { knowledgeEnabled: true } : {}),
          canvasTools: canvasToolCapability?.reference ?? null,
          prototypePatchBaselines,
        },
        ...(knowledgeToolCapability || canvasToolCapability ? {
          secrets: {
            ...(knowledgeToolCapability ? {
              WORKBENCH_KNOWLEDGE_CAPABILITY: JSON.stringify(knowledgeToolCapability),
            } : {}),
            ...(canvasToolCapability ? {
              WORKBENCH_CANVAS_CAPABILITY: JSON.stringify(canvasToolCapability),
            } : {}),
          },
        } : {}),
      },
      config: {
        configurable: {
          workbench_run_id: execution.runId,
          workbench_project_id: execution.projectId,
          workbench_thread_id: execution.threadId,
          workbench_canvas_tools: canvasToolCapability
            ? { declaredTools: [...canvasToolCapability.reference.declaredTools] }
            : null,
          model_name: execution.request.modelId,
          is_plan_mode: true,
          thinking_enabled: true,
          subagent_enabled: execution.request.requestedArtifactKinds.some(
            (kind) => kind === "prototype" || kind === "code",
          ),
        },
      },
    };
  }

  private streamMode(requestedArtifactKinds: readonly string[]): StreamMode | StreamMode[] {
    const modes = this.config.deerFlowStreamMode.map((mode) => {
      if (!STREAM_MODES.has(mode as StreamMode)) throw new Error(`DEERFLOW_STREAM_MODE_INVALID:${mode}`);
      return mode as StreamMode;
    });
    if (modes.length === 0) throw new Error("DEERFLOW_STREAM_MODE_MISSING");
    // A PRD is delivered through durable stage/draft/result tools found in
    // values snapshots. Persisting every token-sized messages event creates
    // enough backpressure to outrun DeerFlow's retained stream buffer.
    if (requestedArtifactKinds.length === 1 && requestedArtifactKinds[0] === "prd") {
      return "values";
    }
    return modes.length === 1 ? modes[0]! : modes;
  }

  private async findExternalRun(
    client: Client,
    externalThreadId: string,
    runtimeAttemptId: string,
    providerIdempotencyKey: string | undefined,
    signal?: AbortSignal,
  ) {
    let match: Run | null = null;
    for (let page = 0; page < MAX_RUN_RECOVERY_PAGES; page += 1) {
      const runs = await client.runs.list(externalThreadId, {
        limit: RUN_PAGE_SIZE,
        offset: page * RUN_PAGE_SIZE,
        select: ["run_id", "status", "metadata"],
        signal,
      });
      for (const run of runs) {
        if (
          run.metadata?.workbench_runtime_attempt_id !== runtimeAttemptId
          || (
            providerIdempotencyKey !== undefined
            && run.metadata?.workbench_provider_idempotency_key !== providerIdempotencyKey
          )
        ) continue;
        if (match && match.run_id !== run.run_id) throw new Error("RUNTIME_EXTERNAL_RUN_DUPLICATED");
        match = run;
      }
      if (runs.length < RUN_PAGE_SIZE) return match;
    }
    throw new Error("RUNTIME_EXTERNAL_RUN_RECOVERY_LIMIT_EXCEEDED");
  }

  private async uploadSources(execution: RuntimeExecution, signal?: AbortSignal) {
    const handles: DeerFlowSourceHandle[] = [];
    for (const source of execution.sources) {
      if (signal?.aborted) throw signal.reason ?? new Error("RUNTIME_ABORTED");
      const original = await this.uploadContent(
        execution.externalThreadId,
        execution.principalId,
        source.originalName,
        source.original,
        signal,
      );
      let extraction: DeerFlowSourceHandle["extraction"] = null;
      if (source.extraction) {
        const content = source.extraction.content;
        const handle = content.sha256 === source.original.sha256
          ? original
          : await this.uploadContent(
              execution.externalThreadId,
              execution.principalId,
              extractionFileName(source),
              content,
              signal,
            );
        extraction = {
          kind: source.extraction.kind,
          position: source.extraction.position,
          mediaType: content.mediaType,
          byteSize: content.byteSize,
          sha256: content.sha256,
          handle,
        };
      }
      handles.push({
        position: source.position,
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        blobId: source.blobId,
        fileName: source.originalName,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        sha256: source.sha256,
        original,
        extraction,
      });
    }
    return handles;
  }

  private async uploadDesignAssets(execution: RuntimeExecution, signal?: AbortSignal) {
    const handles: DeerFlowDesignAssetHandle[] = [];
    const uploadedByBlobId = new Map<string, DeerFlowContentHandle>();
    for (const [position, asset] of execution.designAssets.entries()) {
      if (signal?.aborted) throw signal.reason ?? new Error("RUNTIME_ABORTED");
      let handle = uploadedByBlobId.get(asset.blobId);
      if (!handle) {
        handle = await this.uploadContent(
          execution.externalThreadId,
          execution.principalId,
          designAssetFileName(asset, position),
          asset.content,
          signal,
        );
        uploadedByBlobId.set(asset.blobId, handle);
      }
      handles.push({ assetId: asset.assetId, handle });
    }
    return handles;
  }

  private async uploadArtifactTargets(execution: RuntimeExecution, signal?: AbortSignal) {
    const handles: DeerFlowArtifactTargetHandle[] = [];
    const uploadedByBlobId = new Map<string, {
      locator: RuntimeContentLocator;
      handle: DeerFlowContentHandle;
    }>();
    const uploadOnce = async (
      blobId: string,
      fileName: string,
      locator: RuntimeContentLocator,
    ) => {
      const uploaded = uploadedByBlobId.get(blobId);
      if (uploaded) {
        if (
          uploaded.locator.storageKey !== locator.storageKey
          || uploaded.locator.mediaType !== locator.mediaType
          || uploaded.locator.byteSize !== locator.byteSize
          || uploaded.locator.sha256 !== locator.sha256
        ) {
          throw new Error("RUNTIME_ARTIFACT_TARGET_BLOB_CONFLICT");
        }
        return uploaded.handle;
      }
      const handle = await this.uploadContent(
        execution.externalThreadId,
        execution.principalId,
        fileName,
        locator,
        signal,
      );
      uploadedByBlobId.set(blobId, { locator, handle });
      return handle;
    };
    for (const [position, target] of execution.artifactTargets.entries()) {
      if (signal?.aborted) throw signal.reason ?? new Error("RUNTIME_ABORTED");
      if (target.content.mode === "blob") {
        handles.push({
          kind: "content",
          artifactVersionId: target.artifactVersionId,
          handle: await uploadOnce(
            target.content.blobId,
            `target-${position + 1}-${target.kind}`,
            target.content.locator,
          ),
        });
      }
      for (const [assetPosition, asset] of target.assets.entries()) {
        handles.push({
          kind: "asset",
          artifactVersionId: target.artifactVersionId,
          assetId: asset.assetId,
          handle: await uploadOnce(
            asset.blobId,
            `target-${position + 1}-asset-${assetPosition + 1}-${asset.kind}`,
            asset.content,
          ),
        });
      }
    }
    return handles;
  }

  private async uploadContent(
    externalThreadId: string,
    principalId: string,
    fileName: string,
    locator: RuntimeContentLocator,
    signal?: AbortSignal,
  ): Promise<DeerFlowContentHandle> {
    const stored = await this.storage.getObject(locator, signal).catch((error: unknown) => {
      throw new Error("RUNTIME_SOURCE_STORAGE_READ_FAILED", { cause: error });
    });
    if (stored.byteSize !== locator.byteSize) {
      stored.body.destroy();
      throw new Error("RUNTIME_SOURCE_STORAGE_SIZE_MISMATCH");
    }
    const multipart = createMultipartUploadStream({
      source: stored.body,
      fileName,
      mediaType: locator.mediaType,
      byteSize: locator.byteSize,
      sha256: locator.sha256,
      signal,
    });
    let response: Response;
    try {
      response = await this.fetchGatewayWithTimeout(
        `/api/threads/${encodeURIComponent(externalThreadId)}/uploads`,
        {
          method: "POST",
          headers: {
            ...this.identityHeaders(principalId),
            "content-type": multipart.contentType,
            "content-length": String(multipart.contentLength),
            accept: "application/json",
          },
          body: multipart.body as unknown as BodyInit,
          duplex: "half",
        },
        signal,
      );
    } catch (error) {
      multipart.body.destroy();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("DEERFLOW_UPLOAD_FAILED");
    }
    const payload = gatewayUploadResponseSchema.parse(
      JSON.parse(await boundedResponseText(response, MAX_GATEWAY_RESPONSE_SIZE)),
    );
    const uploaded = payload.files[0];
    if (!uploaded) throw new Error("DEERFLOW_UPLOAD_HANDLE_MISSING");
    return {
      virtualPath: normalizeUploadVirtualPath(uploaded.virtual_path ?? uploaded.virtualPath),
      markdownVirtualPath: optionalUploadVirtualPath(
        uploaded.markdown_virtual_path ?? uploaded.markdownVirtualPath,
      ),
    };
  }

  private async fetchGatewayWithTimeout(
    path: string,
    init: RequestInit & { duplex?: "half" },
    signal?: AbortSignal,
  ) {
    return this.fetchFromBase(this.config.deerFlowGatewayUrl, path, init, signal);
  }

  private client(principalId: string, providerIdempotencyKey?: string) {
    return new Client({
      apiUrl: this.config.deerFlowLangGraphUrl,
      apiKey: null,
      timeoutMs: this.config.deerFlowTimeoutMs,
      callerOptions: {
        maxRetries: 0,
        fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
          tracedFetch(input, init)
        ),
      },
      defaultHeaders: {
        ...this.jsonHeaders(principalId),
        ...(providerIdempotencyKey ? { "Idempotency-Key": providerIdempotencyKey } : {}),
      },
      streamProtocol: "legacy",
    });
  }

  private async fetchFromBase(
    baseUrl: string,
    path: string,
    init: RequestInit & { duplex?: "half" },
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("DEERFLOW_REQUEST_TIMEOUT")), this.config.deerFlowTimeoutMs);
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await tracedFetch(`${baseUrl}/${path.replace(/^\/+/, "")}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private jsonHeaders(principalId?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      Cookie: `csrf_token=${this.csrfToken}`,
      "X-CSRF-Token": this.csrfToken,
    };
    Object.assign(headers, this.identityHeaders(principalId));
    return headers;
  }

  private identityHeaders(principalId?: string) {
    const headers: Record<string, string> = {};
    if (principalId) headers["X-DeerFlow-Owner-User-Id"] = principalId;
    if (this.config.deerFlowInternalToken) {
      headers["X-DeerFlow-Internal-Token"] = this.config.deerFlowInternalToken;
    }
    return headers;
  }
}

function assertNoKnowledgeGrant<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (KNOWLEDGE_GRANT_TOKEN.test(serialized)) throw new Error("RUNTIME_KNOWLEDGE_GRANT_LEAK");
  if (CANVAS_GRANT_TOKEN.test(serialized)) throw new Error("RUNTIME_CANVAS_GRANT_LEAK");
  return value;
}

export function createMultipartUploadStream(input: {
  source: VerifiedReadyObjectBody;
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  signal?: AbortSignal;
}) {
  assertMultipartInput(input);
  if (input.signal?.aborted) throw abortError(input.signal);
  let received = 0;
  const digest = createHash("sha256");
  const verified = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const bytes = byteChunk(chunk);
      received += bytes.byteLength;
      if (!Number.isSafeInteger(received) || received > input.byteSize) {
        callback(new Error("RUNTIME_SOURCE_STORAGE_SIZE_MISMATCH"));
        return;
      }
      digest.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      if (received !== input.byteSize) {
        callback(new Error("RUNTIME_SOURCE_STORAGE_SIZE_MISMATCH"));
        return;
      }
      if (digest.digest("hex") !== input.sha256) {
        callback(new Error("RUNTIME_SOURCE_STORAGE_DIGEST_MISMATCH"));
        return;
      }
      callback();
    },
  });
  input.source.pipe(verified);

  const form = new FormData();
  form.append("files", verified, {
    filename: input.fileName,
    contentType: input.mediaType,
    knownLength: input.byteSize,
  });
  const contentLength = form.getLengthSync();
  if (!Number.isSafeInteger(contentLength)) throw new Error("RUNTIME_SOURCE_MULTIPART_SIZE_INVALID");
  const stream = new PassThrough();
  form.once("error", (error) => stream.destroy(error));
  const abort = () => {
    const error = abortError(input.signal);
    input.source.destroy(error);
    verified.destroy(error);
    form.destroy(error);
    stream.destroy(error);
  };
  const cleanup = () => input.signal?.removeEventListener("abort", abort);
  input.signal?.addEventListener("abort", abort, { once: true });
  stream.once("end", cleanup);
  stream.once("close", cleanup);
  stream.once("error", cleanup);
  form.pipe(stream);

  return {
    body: stream,
    contentLength,
    contentType: form.getHeaders()["content-type"]!,
  };
}

function assertMultipartInput(input: {
  fileName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
}) {
  if (
    !input.fileName
    || !input.fileName.trim()
    || input.fileName.length > 500
    || input.fileName === "."
    || input.fileName === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(input.fileName)
  ) {
    throw new Error("RUNTIME_SOURCE_FILE_NAME_INVALID");
  }
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(input.mediaType)) {
    throw new Error("RUNTIME_SOURCE_MEDIA_TYPE_INVALID");
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    throw new Error("RUNTIME_SOURCE_SIZE_INVALID");
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error("RUNTIME_SOURCE_DIGEST_INVALID");
  }
}

function byteChunk(value: unknown): Uint8Array {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  throw new Error("RUNTIME_SOURCE_STORAGE_CHUNK_INVALID");
}

function abortError(signal?: AbortSignal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("RUNTIME_ABORTED");
}

function extractionFileName(source: RuntimeSource) {
  const content = source.extraction?.content;
  if (!content) throw new Error("RUNTIME_SOURCE_EXTRACTION_MISSING");
  return `extracted-${source.position}-${content.sha256.slice(0, 12)}${extensionForMediaType(content.mediaType)}`;
}

function designAssetFileName(asset: RuntimeDesignAsset, position: number) {
  return `design-${position}-${asset.sha256.slice(0, 12)}${extensionForMediaType(asset.mediaType)}`;
}

function extensionForMediaType(mediaType: string) {
  const extensions: Record<string, string> = {
    "application/json": ".json",
    "application/xml": ".xml",
    "font/otf": ".otf",
    "font/ttf": ".ttf",
    "font/woff": ".woff",
    "font/woff2": ".woff2",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
  };
  return extensions[mediaType] ?? ".bin";
}

export function normalizeUploadVirtualPath(value: string | undefined) {
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f\\?#]/.test(value)) {
    throw new Error("DEERFLOW_UPLOAD_HANDLE_INVALID");
  }
  const normalized = value.startsWith("/") ? value : `/${value}`;
  const prefix = "/mnt/user-data/uploads/";
  if (!normalized.startsWith(prefix)) throw new Error("DEERFLOW_UPLOAD_HANDLE_INVALID");
  const segments = normalized.slice(prefix.length).split("/");
  if (segments.length === 0 || segments.some((segment) => !safeVirtualPathSegment(segment))) {
    throw new Error("DEERFLOW_UPLOAD_HANDLE_INVALID");
  }
  return normalized;
}

function optionalUploadVirtualPath(value: string | undefined) {
  return value === undefined ? null : normalizeUploadVirtualPath(value);
}

function safeVirtualPathSegment(segment: string) {
  if (!segment) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "."
      && decoded !== ".."
      && !/[\u0000-\u001f\u007f/\\]/.test(decoded);
  } catch {
    return false;
  }
}

async function boundedResponseText(response: Response, maximumBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel("RESPONSE_TOO_LARGE").catch(() => undefined);
        throw new Error("DEERFLOW_RESPONSE_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received).toString("utf8");
}

export function resolveRuntimeResult(
  finalState: unknown,
  requestedKinds: string[],
  execution: Pick<RuntimeExecution, "runId" | "runtimeAttemptId">,
): RuntimeResult {
  const submissions = validatedRuntimeSubmissions(finalState, execution);
  if (submissions.length === 0) throw new Error("RUNTIME_RESULT_SUBMISSION_MISSING");
  if (submissions.length !== 1) throw new Error("RUNTIME_RESULT_SUBMISSION_MULTIPLE");
  const result = submissions[0]!.result;
  const missing = requestedKinds.filter((kind) => !result.artifacts.some((artifact) => artifact.kind === kind));
  if (missing.length) throw new Error(`RUNTIME_ARTIFACTS_MISSING:${missing.join(",")}`);
  const requested = new Set(requestedKinds);
  const unrequested = [...new Set(
    result.artifacts
      .map((artifact) => artifact.kind)
      .filter((kind) => !requested.has(kind)),
  )];
  if (unrequested.length) {
    throw new Error(`RUNTIME_ARTIFACTS_UNREQUESTED:${unrequested.join(",")}`);
  }
  return result;
}

function validatedRuntimeSubmissions(
  finalState: unknown,
  execution: Pick<RuntimeExecution, "runId" | "runtimeAttemptId">,
) {
  const messages = runtimeMessages(finalState);
  const currentTurnStart = currentTurnStartIndex(messages);
  if (currentTurnStart < 0) return [];

  const submissions: Array<{
    result: RuntimeResult;
    toolCallId: string;
    declarationIndex: number;
    messageIndex: number;
  }> = [];
  for (const trusted of trustedToolMessages(messages, currentTurnStart, RUNTIME_RESULT_SUBMIT_TOOL)) {
    const message = trusted.message;
    const rawArtifact = asRecord(messageValue(message, "artifact"));
    const parsed = validatedRuntimeResultArtifactSchema.safeParse(rawArtifact);
    if (!parsed.success) throw new Error("RUNTIME_RESULT_SUBMISSION_INVALID", { cause: parsed.error });
    const envelope = {
      protocol: parsed.data.protocol,
      runId: parsed.data.runId,
      runtimeAttemptId: parsed.data.runtimeAttemptId,
      toolCallId: parsed.data.toolCallId,
      ok: parsed.data.ok,
      ...(parsed.data.ok ? { resultChecksum: parsed.data.resultChecksum } : {}),
    };
    if (
      parsed.data.runId !== execution.runId
      || parsed.data.toolCallId !== trusted.toolCallId
      || sha256CanonicalPayload(envelope) !== parsed.data.checksum
      || (parsed.data.ok
        && sha256CanonicalPayload(rawArtifact?.result) !== parsed.data.resultChecksum)
    ) {
      throw new Error("RUNTIME_RESULT_SUBMISSION_SCOPE_INVALID");
    }
    if (parsed.data.runtimeAttemptId !== execution.runtimeAttemptId) continue;
    if (!parsed.data.ok) continue;
    submissions.push({
      result: parsed.data.result,
      toolCallId: trusted.toolCallId,
      declarationIndex: trusted.declarationIndex,
      messageIndex: trusted.messageIndex,
    });
  }
  return submissions;
}

function validatedArtifactDraftSubmissions(
  finalState: unknown,
  execution: Pick<RuntimeExecution, "runId" | "runtimeAttemptId">,
) {
  const messages = runtimeMessages(finalState);
  const currentTurnStart = currentTurnStartIndex(messages);
  if (currentTurnStart < 0) return [];

  const submissions: Array<{
    artifactIndex: number;
    draft: RuntimeArtifactDraft;
    toolCallId: string;
    declarationIndex: number;
    messageIndex: number;
  }> = [];
  for (const trusted of trustedToolMessages(
    messages,
    currentTurnStart,
    ARTIFACT_DRAFT_PUBLISH_TOOL,
  )) {
    const rawArtifact = asRecord(messageValue(trusted.message, "artifact"));
    const parsed = artifactDraftArtifactSchema.safeParse(rawArtifact);
    if (!parsed.success) throw new Error("RUNTIME_ARTIFACT_DRAFT_INVALID", { cause: parsed.error });
    const envelope = {
      protocol: parsed.data.protocol,
      runId: parsed.data.runId,
      runtimeAttemptId: parsed.data.runtimeAttemptId,
      toolCallId: parsed.data.toolCallId,
      artifactIndex: parsed.data.artifactIndex,
      ok: parsed.data.ok,
      ...(parsed.data.ok ? { draftChecksum: parsed.data.draftChecksum } : {}),
    };
    if (
      parsed.data.runId !== execution.runId
      || parsed.data.toolCallId !== trusted.toolCallId
      || sha256CanonicalPayload(envelope) !== parsed.data.checksum
      || (parsed.data.ok
        && sha256CanonicalPayload(rawArtifact?.draft) !== parsed.data.draftChecksum)
    ) {
      throw new Error("RUNTIME_ARTIFACT_DRAFT_SCOPE_INVALID");
    }
    if (parsed.data.runtimeAttemptId !== execution.runtimeAttemptId) continue;
    if (!parsed.data.ok) continue;
    submissions.push({
      artifactIndex: parsed.data.artifactIndex,
      draft: parsed.data.draft,
      toolCallId: trusted.toolCallId,
      declarationIndex: trusted.declarationIndex,
      messageIndex: trusted.messageIndex,
    });
  }
  return submissions;
}

function validatedPrototypePatchSubmissions(
  finalState: unknown,
  execution: Pick<RuntimeExecution, "runId" | "runtimeAttemptId">,
) {
  const messages = runtimeMessages(finalState);
  const currentTurnStart = currentTurnStartIndex(messages);
  if (currentTurnStart < 0) return [];

  const submissions: Array<{
    patch: RuntimePrototypePatchInput;
    sourceEventId: string;
    toolCallId: string;
    messageIndex: number;
  }> = [];
  for (const trusted of trustedToolMessages(
    messages,
    currentTurnStart,
    PROTOTYPE_PATCH_PUBLISH_TOOL,
  )) {
    const rawArtifact = asRecord(messageValue(trusted.message, "artifact"));
    const parsed = prototypePatchArtifactSchema.safeParse(rawArtifact);
    if (!parsed.success) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_INVALID", { cause: parsed.error });
    }
    const envelope = {
      protocol: parsed.data.protocol,
      runId: parsed.data.runId,
      runtimeAttemptId: parsed.data.runtimeAttemptId,
      toolCallId: parsed.data.toolCallId,
      ok: parsed.data.ok,
      ...(parsed.data.ok ? { patchChecksum: parsed.data.patchChecksum } : {}),
    };
    if (
      parsed.data.runId !== execution.runId
      || parsed.data.toolCallId !== trusted.toolCallId
      || sha256CanonicalPayload(envelope) !== parsed.data.checksum
      || (parsed.data.ok
        && sha256CanonicalPayload(rawArtifact?.patch) !== parsed.data.patchChecksum)
    ) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_SCOPE_INVALID");
    }
    if (parsed.data.runtimeAttemptId !== execution.runtimeAttemptId) continue;
    if (!parsed.data.ok) continue;
    submissions.push({
      patch: parsed.data.patch,
      sourceEventId: runtimeToolSourceId(
        execution.runtimeAttemptId,
        PROTOTYPE_PATCH_PUBLISH_TOOL,
        trusted.toolCallId,
      ),
      toolCallId: trusted.toolCallId,
      messageIndex: trusted.messageIndex,
    });
  }
  return submissions;
}

function assertRuntimeResultCheckpoints(
  result: RuntimeResult,
  latestCheckpoints: ReadonlyMap<number, RuntimeArtifactDraft>,
) {
  for (const [artifactIndex, checkpoint] of latestCheckpoints) {
    const finalDraft = result.artifacts[artifactIndex];
    if (!finalDraft || canonicalJson(finalDraft) !== canonicalJson(checkpoint)) {
      throw new Error("RUNTIME_ARTIFACT_DRAFT_FINAL_MISMATCH");
    }
  }
  for (const [artifactIndex, finalDraft] of result.artifacts.entries()) {
    if (
      (finalDraft.kind === "prd" || finalDraft.kind === "prototype")
      && !latestCheckpoints.has(artifactIndex)
    ) {
      throw new Error("RUNTIME_ARTIFACT_DRAFT_CHECKPOINT_MISSING");
    }
  }
}

function assertPrdGenerationStagesComplete(
  draft: RuntimeArtifactDraft,
  observed: ReadonlyArray<Extract<RuntimeProgressEvent, { type: "generation.stage" }>["stage"]>,
) {
  if (draft.kind !== "prd") return;
  if (
    observed.length !== PRD_GENERATION_STAGE_SEQUENCE.length
    || observed.some((stage, index) => stage !== PRD_GENERATION_STAGE_SEQUENCE[index])
  ) {
    throw new Error("RUNTIME_ARTIFACT_PRD_GENERATION_STAGES_INCOMPLETE");
  }
}

function checkpointPatchScreens(
  artifactIndex: number,
  previous: PrototypeDocument | undefined,
  next: RuntimeArtifactDraft,
  currentRevisions: ReadonlyMap<string, number>,
  recoveryRevisions: ReadonlyMap<string, number>,
): PrototypePatchCheckpointScreen[] {
  if (next.kind !== "prototype") return [];
  const checkpointScreens: PrototypePatchCheckpointScreen[] = [];
  for (const screen of next.content.screens) {
    const key = prototypePatchRevisionKey(artifactIndex, screen.id);
    let revision = currentRevisions.get(key) ?? 0;
    const recoveryRevision = recoveryRevisions.get(key);
    if (recoveryRevision !== undefined) {
      if (recoveryRevision < revision) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_RECOVERY_REVISION_INVALID");
      }
      revision = recoveryRevision;
    } else if (previous?.screens.some((candidate) => candidate.id === screen.id)) {
      const previousProjection = canonicalPrototypeScreenProjection(
        projectPrototypeScreen(previous, screen.id, revision),
      );
      const nextProjection = canonicalPrototypeScreenProjection(
        projectPrototypeScreen(next.content, screen.id, revision),
      );
      if (previousProjection !== nextProjection) {
        if (revision >= PROTOTYPE_PATCH_MAX_REVISION) {
          throw new Error("RUNTIME_PROTOTYPE_PATCH_REVISION_EXHAUSTED");
        }
        revision += 1;
      }
    }
    checkpointScreens.push({
      screenId: screen.id,
      revision,
      checksum: prototypeScreenChecksum(next.content, screen.id, revision),
    });
  }
  return checkpointScreens;
}

function prototypePatchBaselineState(baselines: readonly RuntimePrototypePatchBaseline[]) {
  const documents = new Map<number, PrototypeDocument>();
  const revisions = new Map<string, number>();
  const recoveryRevisions = new Map<string, number>();
  const artifactVersionIds = new Set<string>();
  for (const baseline of baselines) {
    if (
      !Number.isInteger(baseline.artifactIndex)
      || baseline.artifactIndex < 0
      || baseline.artifactIndex > 19
      || documents.has(baseline.artifactIndex)
      || !baseline.artifactVersionId
      || artifactVersionIds.has(baseline.artifactVersionId)
    ) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_BASELINE_IDENTITY_INVALID");
    }
    const document = prototypeDocumentSchema.parse(baseline.document);
    const documentScreenIds = new Set(document.screens.map((screen) => screen.id));
    const baselineScreenIds = new Set<string>();
    if (baseline.screens.length !== documentScreenIds.size) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_BASELINE_SCREEN_SET_INVALID");
    }
    for (const screen of baseline.screens) {
      if (
        baselineScreenIds.has(screen.screenId)
        || !documentScreenIds.has(screen.screenId)
        || !Number.isInteger(screen.revision)
        || screen.revision < 0
        || screen.revision > PROTOTYPE_PATCH_MAX_REVISION
        || !/^[a-f0-9]{64}$/u.test(screen.checksum)
        || prototypeScreenChecksum(document, screen.screenId, screen.revision) !== screen.checksum
        || (screen.status === "active" && screen.recoveryRevision !== null)
        || (
          screen.status === "degraded"
          && (
            screen.recoveryRevision === null
            || !Number.isInteger(screen.recoveryRevision)
            || screen.recoveryRevision < screen.revision
            || screen.recoveryRevision > PROTOTYPE_PATCH_MAX_REVISION
          )
        )
      ) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_BASELINE_SCREEN_INVALID");
      }
      baselineScreenIds.add(screen.screenId);
      const key = prototypePatchRevisionKey(baseline.artifactIndex, screen.screenId);
      revisions.set(key, screen.revision);
      if (screen.status === "degraded") {
        recoveryRevisions.set(key, screen.recoveryRevision!);
      }
    }
    documents.set(baseline.artifactIndex, document);
    artifactVersionIds.add(baseline.artifactVersionId);
  }
  return { documents, recoveryRevisions, revisions };
}

function prototypePatchBaselineContext(baselines: readonly RuntimePrototypePatchBaseline[]) {
  return baselines.map((baseline) => ({
    artifactIndex: baseline.artifactIndex,
    artifactVersionId: baseline.artifactVersionId,
    screens: baseline.screens.map((screen) => ({
      screenId: screen.screenId,
      status: screen.status,
      baseRevision: screen.status === "degraded"
        ? screen.recoveryRevision ?? screen.revision
        : screen.revision,
      checkpointRequired: screen.status === "degraded",
    })),
  }));
}

function prototypeScreenChecksum(
  document: PrototypeDocument,
  screenId: string,
  revision: number,
) {
  return createHash("sha256")
    .update(canonicalPrototypeScreenProjection(projectPrototypeScreen(document, screenId, revision)))
    .digest("hex");
}

function patchRevisionsFromCheckpointScreens(
  artifactIndex: number,
  screens: readonly PrototypePatchCheckpointScreen[],
) {
  return new Map(screens.map((screen) => [
    prototypePatchRevisionKey(artifactIndex, screen.screenId),
    screen.revision,
  ]));
}

function replaceArtifactPrototypeDocument(
  artifactIndex: number,
  documents: Map<number, PrototypeDocument>,
  draft: RuntimeArtifactDraft,
) {
  if (draft.kind === "prototype") documents.set(artifactIndex, draft.content);
  else documents.delete(artifactIndex);
}

function replaceArtifactPatchRevisions(
  artifactIndex: number,
  current: Map<string, number>,
  next: ReadonlyMap<string, number>,
) {
  const prefix = `${artifactIndex}\0`;
  for (const key of current.keys()) {
    if (key.startsWith(prefix)) current.delete(key);
  }
  for (const [key, revision] of next) current.set(key, revision);
}

function clearArtifactPatchRecoveryRevisions(
  artifactIndex: number,
  recoveryRevisions: Map<string, number>,
) {
  const prefix = `${artifactIndex}\0`;
  for (const key of recoveryRevisions.keys()) {
    if (key.startsWith(prefix)) recoveryRevisions.delete(key);
  }
}

function prototypePatchRevisionKey(artifactIndex: number, screenId: string) {
  return `${artifactIndex}\0${screenId}`;
}

function extractGenerationStageProgress(
  finalState: unknown,
  execution: Pick<RuntimeExecution, "runId" | "runtimeAttemptId">,
): Array<Extract<RuntimeProgressEvent, { type: "generation.stage" }> & {
  declarationIndex: number;
  messageIndex: number;
}> {
  const messages = runtimeMessages(finalState);
  const currentTurnStart = currentTurnStartIndex(messages);
  if (currentTurnStart < 0) return [];

  return trustedToolMessages(messages, currentTurnStart, GENERATION_STAGE_TOOL).flatMap((trusted) => {
    const artifact = generationStageArtifactSchema.safeParse(
      messageValue(trusted.message, "artifact"),
    );
    if (!artifact.success) {
      throw new Error("RUNTIME_GENERATION_STAGE_INVALID", { cause: artifact.error });
    }
    const payload = {
      protocol: artifact.data.protocol,
      runId: artifact.data.runId,
      runtimeAttemptId: artifact.data.runtimeAttemptId,
      toolCallId: artifact.data.toolCallId,
      stage: artifact.data.stage,
    };
    if (
      artifact.data.runId !== execution.runId
      || artifact.data.toolCallId !== trusted.toolCallId
      || sha256CanonicalPayload(payload) !== artifact.data.checksum
    ) {
      throw new Error("RUNTIME_GENERATION_STAGE_SCOPE_INVALID");
    }
    if (artifact.data.runtimeAttemptId !== execution.runtimeAttemptId) return [];
    return [{
      type: "generation.stage" as const,
      stage: artifact.data.stage,
      sourceEventId: runtimeToolSourceId(
        execution.runtimeAttemptId,
        GENERATION_STAGE_TOOL,
        trusted.toolCallId,
      ),
      declarationIndex: trusted.declarationIndex,
      messageIndex: trusted.messageIndex,
    }];
  });
}

function currentTurnStartIndex(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message && isHuman(message)) return index;
  }
  return -1;
}

function trustedToolMessages(
  messages: unknown[],
  currentTurnStart: number,
  toolName: string,
) {
  const declared = new Map<string, { index: number; name: string }>();
  const trusted: Array<{
    message: Record<string, unknown>;
    toolCallId: string;
    declarationIndex: number;
    messageIndex: number;
  }> = [];
  for (let index = currentTurnStart + 1; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (isAssistant(message)) {
      for (const call of messageToolCalls(message)) {
        const existing = declared.get(call.id);
        if (existing && existing.name !== call.name) {
          throw new Error("RUNTIME_TOOL_CALL_ID_CONFLICT");
        }
        declared.set(call.id, { index, name: call.name });
      }
      continue;
    }
    if (!isTool(message) || messageField(message, "name") !== toolName) continue;
    const toolCallId = messageField(message, "tool_call_id");
    const declaration = toolCallId ? declared.get(toolCallId) : undefined;
    if (!toolCallId || !declaration || declaration.name !== toolName || declaration.index >= index) {
      throw new Error("RUNTIME_TOOL_MESSAGE_UNDECLARED");
    }
    const status = messageField(message, "status")?.toLowerCase();
    if (status && status !== "success") continue;
    trusted.push({
      message,
      toolCallId,
      declarationIndex: declaration.index,
      messageIndex: index,
    });
  }
  return trusted;
}

export function assertCanvasToolCausality(
  state: unknown,
  declaredTools: readonly string[],
  result?: { declarationIndex: number; responseIndex: number },
) {
  const canvasTools = new Set<string>(canvasAgentToolNames);
  const allowed = new Set(declaredTools);
  const messages = runtimeMessages(state);
  const currentTurnStart = currentTurnStartIndex(messages);
  if (currentTurnStart < 0) return;
  const calls = new Map<string, { index: number; name: string }>();
  const responses = new Map<string, { index: number; status: string }>();

  for (let index = currentTurnStart + 1; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (isAssistant(message)) {
      for (const call of messageToolCalls(message)) {
        if (!canvasTools.has(call.name)) continue;
        const previous = calls.get(call.id);
        if (previous && (previous.name !== call.name || previous.index !== index)) {
          throw new Error("RUNTIME_CANVAS_TOOL_CALL_ID_CONFLICT");
        }
        if (!allowed.has(call.name)) throw new Error("RUNTIME_CANVAS_TOOL_NOT_DECLARED");
        if (result && index >= result.declarationIndex) {
          throw new Error("RUNTIME_CANVAS_TOOL_AFTER_RESULT");
        }
        calls.set(call.id, { index, name: call.name });
      }
      continue;
    }
    if (!isTool(message)) continue;
    const toolCallId = messageField(message, "tool_call_id");
    const name = messageField(message, "name");
    if (!toolCallId || !name || !canvasTools.has(name)) continue;
    const call = calls.get(toolCallId);
    if (!call || call.name !== name || call.index >= index) {
      throw new Error("RUNTIME_CANVAS_TOOL_MESSAGE_UNDECLARED");
    }
    if (responses.has(toolCallId)) throw new Error("RUNTIME_CANVAS_TOOL_RESPONSE_MULTIPLE");
    const parsedCanvasResult = canvasAgentToolResultSchema.safeParse(messageValue(message, "artifact"));
    if (
      !parsedCanvasResult.success
      || parsedCanvasResult.data.toolCallId !== toolCallId
      || parsedCanvasResult.data.toolName !== name
    ) throw new Error("RUNTIME_CANVAS_TOOL_RESPONSE_INVALID");
    if (result && index >= result.declarationIndex) {
      throw new Error("RUNTIME_CANVAS_TOOL_RESPONSE_AFTER_RESULT");
    }
    responses.set(toolCallId, { index, status: parsedCanvasResult.data.status });
  }

  if (!result) return;
  for (const [toolCallId] of calls) {
    const response = responses.get(toolCallId);
    if (!response) throw new Error("RUNTIME_CANVAS_TOOL_RESPONSE_MISSING");
    if (response.status === "waiting_client" || response.status === "waiting_approval") {
      throw new Error("RUNTIME_CANVAS_TOOL_PENDING");
    }
  }
}

function messageToolCalls(message: Record<string, unknown>) {
  const rawCalls = messageValue(message, "tool_calls");
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.flatMap((rawCall) => {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    const id = stringValue(call?.id);
    const name = stringValue(call?.name) ?? stringValue(fn?.name);
    return id && name ? [{ id, name }] : [];
  });
}

function runtimeToolSourceId(runtimeAttemptId: string, toolName: string, toolCallId: string) {
  return `deerflow:${createHash("sha256")
    .update("workbench-runtime-tool-event-v1\0")
    .update(runtimeAttemptId)
    .update("\0")
    .update(toolName)
    .update("\0")
    .update(toolCallId)
    .digest("hex")}`;
}

function runtimeAttemptSourceId(runtimeAttemptId: string, eventName: string) {
  return `deerflow:${createHash("sha256")
    .update("workbench-runtime-attempt-event-v1\0")
    .update(runtimeAttemptId)
    .update("\0")
    .update(eventName)
    .digest("hex")}`;
}

function sha256CanonicalPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function visibleTextDeltaFromEffects(effects: RuntimeProgressEvent[]) {
  return effects.flatMap((effect) => effect.type === "text.delta" ? [effect.delta] : []).join("");
}

function visibleProjectionDelta(previous: string, terminal: string) {
  if (terminal === previous) return "";
  if (terminal.startsWith(previous)) return terminal.slice(previous.length);
  throw new Error("RUNTIME_PROVIDER_TEXT_VISIBLE_PROJECTION_CONFLICT");
}

function runtimeFinalizationPart(
  execution: Pick<RuntimeExecution, "runtimeAttemptId">,
  externalRunId: string,
  finalState: unknown,
  outcome: RuntimeOutcome,
  effects: RuntimeProgressEvent[],
  visibleAssistantText: string,
  providerTextCheckpoint: ReturnType<typeof createRuntimeProviderTextCheckpoint>,
) {
  const protocol = "workbench.runtime-finalization.v2";
  return {
    externalRunId,
    externalEventId: `workbench-finalization:${sha256CanonicalPayload({
      protocol,
      runtimeAttemptId: execution.runtimeAttemptId,
      externalRunId,
    })}`,
    event: runtimeExternalFinalizationEvent,
    payload: createRuntimeFinalizationPayload({
      messagesSha256: sha256CanonicalPayload(jsonValueSchema.parse(runtimeMessages(finalState))),
      outcomeSha256: sha256CanonicalPayload(outcome),
      effects,
      visibleAssistantText,
      providerTextCheckpoint,
    }),
  };
}

export function extractRuntimeInputRequired(finalState: unknown): RuntimeInputRequired | null {
  const state = asRecord(finalState);
  const nested = asRecord(state?.values);
  const raw = state?.__interrupt__ ?? nested?.__interrupt__;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const approvals = raw.map((item, index) => {
    const interrupt = asRecord(item);
    if (interrupt?.resumable === false) throw new Error("RUNTIME_INTERRUPT_NOT_RESUMABLE");
    const value = interrupt?.value ?? item;
    const details = asRecord(value);
    const prompt = (
      stringValue(value)
      ?? stringValue(details?.prompt)
      ?? stringValue(details?.question)
      ?? stringValue(details?.message)
      ?? stringValue(details?.description)
      ?? "Additional input is required"
    ).slice(0, 4_000);
    const key = (
      stringValue(interrupt?.id)
      ?? `interrupt-${index}-${createHash("sha256").update(stableValue(value)).digest("hex").slice(0, 24)}`
    ).slice(0, 240);
    return {
      key,
      kind: (stringValue(details?.kind) ?? stringValue(details?.type) ?? "input").slice(0, 80),
      prompt,
      options: normalizeApprovalOptions(details?.options),
    };
  });

  return runtimeInputRequiredSchema.parse({
    protocol: "workbench.runtime.input-required.v1",
    approvals,
  });
}

export function normalizeApprovalOptions(value: unknown): ApprovalOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error("RUNTIME_APPROVAL_OPTIONS_INVALID");
  const normalized = value.map((option) => normalizeApprovalOption(option));
  const parsed = approvalOptionsSchema.safeParse(normalized);
  if (!parsed.success) throw new Error("RUNTIME_APPROVAL_OPTIONS_INVALID");
  return parsed.data;
}

function normalizeApprovalOption(value: unknown): ApprovalOption {
  if (typeof value === "string") {
    const label = normalizedLabel(value);
    return {
      id: optionId(label, value),
      label,
      description: null,
      value,
    };
  }

  const option = asRecord(value);
  if (!option) throw new Error("RUNTIME_APPROVAL_OPTION_INVALID");

  const identifierValue = ownValue(option, "id") ?? ownValue(option, "key");
  const explicitId = identifierValue === undefined ? undefined : normalizedIdentifier(identifierValue);
  const labelValue = ownValue(option, "label") ?? ownValue(option, "name") ?? ownValue(option, "title");
  const explicitLabel = labelValue === undefined ? undefined : normalizedLabelValue(labelValue);
  const descriptionValue = ownValue(option, "description") ?? ownValue(option, "detail");
  const description = normalizedDescription(descriptionValue);
  const rawValue = Object.prototype.hasOwnProperty.call(option, "value")
    ? option.value
    : identifierValue ?? explicitLabel;
  const parsedValue = jsonValueSchema.safeParse(rawValue);
  if (!parsedValue.success) throw new Error("RUNTIME_APPROVAL_OPTION_INVALID");
  const normalizedValue = parsedValue.data;
  const id = explicitId ?? optionId(scalarText(normalizedValue), normalizedValue);
  const label = explicitLabel ?? scalarText(normalizedValue) ?? id;

  return approvalOptionSchema.parse({
    id,
    label,
    description,
    value: normalizedValue,
  });
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function normalizedIdentifier(value: unknown): string {
  const text = (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : undefined
  )?.trim();
  if (!text || text.length > 128) throw new Error("RUNTIME_APPROVAL_OPTION_INVALID");
  return text;
}

function normalizedLabelValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("RUNTIME_APPROVAL_OPTION_INVALID");
  return normalizedLabel(value);
}

function normalizedLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 240) throw new Error("RUNTIME_APPROVAL_OPTION_INVALID");
  return label;
}

function normalizedDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 4_000) {
    throw new Error("RUNTIME_APPROVAL_OPTION_INVALID");
  }
  return value;
}

function optionId(candidate: string | undefined, value: JsonValue): string {
  const normalized = candidate?.trim();
  if (normalized && normalized.length <= 128) return normalized;
  return `option_${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 24)}`;
}

function scalarText(value: JsonValue): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function runtimeResumeValue(decisions: RuntimeResumeDecision[]) {
  if (decisions.length === 0) throw new Error("RUNTIME_RESUME_DECISION_MISSING");
  if (decisions.length === 1) return decisionValue(decisions[0]);
  return Object.fromEntries(decisions.map((decision) => [decision.key, decisionValue(decision)]));
}

function decisionValue(decision: RuntimeResumeDecision) {
  if (decision.decision === "submit") return decision.value;
  if (decision.value !== undefined) return decision.value;
  return { approved: decision.decision === "approve" };
}

function stableValue(value: unknown) {
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

function extractNode(data: unknown) {
  const direct = asRecord(data);
  const metadata = Array.isArray(data) ? asRecord(data[1]) : undefined;
  return stringValue(direct?.node) ?? stringValue(direct?.node_id) ?? stringValue(metadata?.langgraph_node) ?? null;
}

function runtimeMessages(finalState: unknown) {
  const state = asRecord(finalState);
  const nested = asRecord(state?.values);
  if (Array.isArray(state?.messages)) return state.messages;
  return Array.isArray(nested?.messages) ? nested.messages : [];
}

function isAssistant(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  if (asRecord(message.additional_kwargs)?.hide_from_ui === true) return false;
  return role === "assistant" || role === "ai" || ["ai", "assistant", "aimessage", "aimessagechunk"].includes(type ?? "");
}

function isHuman(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  const constructor = messageConstructor(message);
  return role === "user"
    || role === "human"
    || ["human", "user", "humanmessage", "usermessage"].includes(type ?? "")
    || constructor === "humanmessage";
}

function isTool(message: Record<string, unknown>) {
  const role = messageField(message, "role")?.toLowerCase();
  const type = messageField(message, "type")?.toLowerCase();
  return role === "tool"
    || type === "tool"
    || type === "toolmessage"
    || messageConstructor(message) === "toolmessage";
}

function messageConstructor(message: Record<string, unknown>) {
  return Array.isArray(message.id)
    ? message.id.filter((item): item is string => typeof item === "string").at(-1)?.toLowerCase()
    : undefined;
}

function messageField(message: Record<string, unknown>, field: string) {
  return stringValue(messageValue(message, field));
}

function messageValue(message: Record<string, unknown>, field: string) {
  for (const container of [message, asRecord(message.kwargs), asRecord(message.lc_kwargs)]) {
    if (container && container[field] !== undefined) return container[field];
  }
  return undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = asRecord(part);
    const type = stringValue(record?.type)?.toLowerCase();
    if (type === "thinking" || type === "reasoning") return [];
    const text = stringValue(record?.text) ?? stringValue(record?.content);
    return text ? [text] : [];
  }).join("");
}

function requestActivityEvent(
  execution: RuntimeExecution,
  status: "running" | "succeeded",
): RuntimeProgressEvent {
  return {
    type: "activity",
    activityId: `runtime:${createHash("sha256")
      .update(execution.runtimeAttemptId)
      .digest("hex")}`,
    status,
    label: execution.request.prompt.replace(/\s+/gu, " ").trim().slice(0, 240),
    detail: null,
  };
}

function activityEvent(node: string, status: "running" | "succeeded"): RuntimeProgressEvent {
  return {
    type: "activity",
    activityId: `deerflow:${node}`.slice(0, 128),
    status,
    label: node.replace(/[_-]+/g, " "),
    detail: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSdkHttpStatus(error: unknown, status: number) {
  return error instanceof Error
    && "status" in error
    && typeof error.status === "number"
    && error.status === status;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function externalRunIdFromEvent(event: string, data: unknown) {
  if (event !== "metadata") return null;
  const metadata = asRecord(data);
  return stringValue(metadata?.run_id) ?? null;
}

export function runtimeThreadUuid(workbenchThreadId: string) {
  return uuidV5(`workbench:deerflow-thread:v1:${workbenchThreadId}`, uuidV5.URL);
}
