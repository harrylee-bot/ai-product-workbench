import { z } from "zod";
import {
  artifactKindSchema,
  artifactVersionReferenceSchema,
  artifactVersionStatusSchema,
} from "./artifacts.js";
import { canvasSnapshotSchema } from "./canvas-agent-tools.js";
import {
  approvalDecisionSchema,
  approvalOptionsSchema,
  approvalStatusSchema,
} from "./approvals.js";
import { isoDateTimeSchema, jsonValueSchema, opaqueIdSchema } from "./common.js";
import { artifactIrIdSchema } from "./citations.js";
import { designPresetReferenceSchema } from "./design-presets.js";
import {
  runSourceBlobLimit,
  runSourceIdsSchema,
  runSourceSnapshotSchema,
} from "./import-sources.js";
import {
  prototypePatchChecksumSchema,
  prototypePatchDegradedEventPayloadSchema,
  prototypePatchEventPayloadSchema,
  prototypePatchRevisionSchema,
} from "./prototype-patches.js";
import { prototypeDocumentSchema } from "./prototype.js";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);

export const runPhaseSchema = z.enum([
  "understanding",
  "retrieving_knowledge",
  "planning",
  "generating",
  "validating",
  "publishing",
]);

export const runGenerationStageSchema = z.enum([
  "thinking",
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
  "design-system",
  "mapping-components",
  "creating-flows",
  "generating-ui",
  "screen-streaming",
  "summarizing",
  "screen-stable",
]);

export const runWorkflowSchema = z.enum([
  "generate",
  "redesign",
  "ideate",
  "edit",
]);

export const runGenerationIntentSchema = z.enum([
  "followup-design",
  "interactive-prototype",
]);

export const runTargetSurfaceSchema = z.enum(["app", "web"]);
export const runtimeRequestedArtifactKindSchema = artifactKindSchema.exclude(["design_system"]);

export const runDesignStyleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("automatic") }).strict(),
  z.object({
    kind: z.literal("preset"),
    ...designPresetReferenceSchema.shape,
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    artifactVersionId: opaqueIdSchema,
  }).strict(),
]);

export const runArtifactTargetSchema = artifactVersionReferenceSchema
  .pick({ artifactId: true, artifactVersionId: true })
  .extend({
    screenIds: z.array(opaqueIdSchema).max(12).refine(
      (screenIds) => new Set(screenIds).size === screenIds.length,
      "screenIds must be unique",
    ),
  })
  .strict();

export const runArtifactTargetsSchema = z.array(runArtifactTargetSchema)
  .max(12)
  .superRefine((targets, context) => {
    const artifactIds = new Set<string>();
    const versionIds = new Set<string>();
    let selectedUnits = 0;
    for (const [index, target] of targets.entries()) {
      if (versionIds.has(target.artifactVersionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "artifactVersionId"],
          message: "artifactTargets must contain at most one selection per ArtifactVersion",
        });
      }
      if (artifactIds.has(target.artifactId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "artifactId"],
          message: "artifactTargets must contain at most one selection per Artifact",
        });
      }
      artifactIds.add(target.artifactId);
      versionIds.add(target.artifactVersionId);
      selectedUnits += Math.max(1, target.screenIds.length);
    }
    if (selectedUnits > 12) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "artifactTargets may select at most 12 ArtifactVersions or screens",
      });
    }
  });

type RunWorkflowArtifactTargetInput = Readonly<{
  workflow: z.infer<typeof runWorkflowSchema>;
  generationIntent: z.infer<typeof runGenerationIntentSchema> | null;
  artifactTargets: z.infer<typeof runArtifactTargetsSchema>;
  requestedArtifactKinds: readonly z.infer<typeof runtimeRequestedArtifactKindSchema>[];
}>;

const genericChinesePrdPromptPattern = /^(?:(?:请|麻烦|劳驾|可以|能否|帮(?:我|忙)?|协助|给我|我想要|我要))*(?:(?:写|生成|创建|输出|编写|撰写|制作|完善|整理|做|出))*(?:(?:一|1)?(?:个|份|篇)?)*(?:(?:产品|业务)?需求(?:文档|说明书)?|产品需求文档|PRD)(?:吧|谢谢)?[。.!！?？]*$/iu;
const genericEnglishPrdPromptPattern = /^(?:(?:please|couldyou|canyou|kindly))*(?:(?:helpme))*(?:(?:write|create|generate|draft|make|prepare))*(?:(?:a|an|the))*(?:(?:product|business))*(?:(?:requirements?document)|prd)(?:please)?[.!?]*$/iu;

/**
 * A PRD create request needs a business subject from the prompt or an explicit
 * source. The Artifact kind itself is an output choice, not requirement input.
 */
export function isGenericPrdCreationPrompt(prompt: string): boolean {
  const compact = prompt.normalize("NFKC").replace(/\s+/gu, "").trim();
  return genericChinesePrdPromptPattern.test(compact)
    || genericEnglishPrdPromptPattern.test(compact);
}

export function hasMissingPrdRequirementSource(
  request: {
    workflow: string;
    prompt: string;
    requestedArtifactKinds: readonly string[];
    sourceIds: readonly string[];
    artifactTargets: readonly unknown[];
    canvasSnapshot?: { selectedScreens: readonly unknown[] } | null;
  },
  attachmentCount = 0,
): boolean {
  return request.workflow === "generate"
    && request.requestedArtifactKinds.includes("prd")
    && request.artifactTargets.length === 0
    && request.sourceIds.length === 0
    && attachmentCount === 0
    && (request.canvasSnapshot?.selectedScreens.length ?? 0) === 0
    && isGenericPrdCreationPrompt(request.prompt);
}

export const missingPrdRequirementSourceMessage =
  "请先说明要建设或修改的业务功能、目标用户和核心变化，或附上现有需求资料；仅要求生成需求文档不足以形成可信 PRD";

export function refineRunWorkflowArtifactTargets(
  request: RunWorkflowArtifactTargetInput,
  context: z.RefinementCtx,
): void {
  const requestsPrd = request.requestedArtifactKinds.includes("prd");
  const hasDuplicateKinds = new Set(request.requestedArtifactKinds).size
    !== request.requestedArtifactKinds.length;
  if (hasDuplicateKinds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestedArtifactKinds"],
      message: "Requested artifact kinds must be unique",
    });
  }
  if (requestsPrd && request.requestedArtifactKinds.some((kind) => kind !== "prd")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestedArtifactKinds"],
      message: "PRD must be requested in its own Run: complete the PRD Run before requesting other artifact kinds",
    });
  }

  if (request.workflow === "edit") {
    if (request.generationIntent !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generationIntent"],
        message: "Only the generate workflow accepts a generation intent",
      });
    }
    if (request.artifactTargets.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactTargets"],
        message: "The edit workflow requires at least one Artifact target",
      });
    }
    return;
  }

  if (request.workflow === "generate") {
    if (request.artifactTargets.length === 0) {
      if (request.generationIntent !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["generationIntent"],
          message: "A generation intent requires explicit source screens",
        });
      }
      return;
    }
    if (request.generationIntent === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generationIntent"],
        message: "Targeted Generate requires an explicit generation intent",
      });
    }
    if (!request.requestedArtifactKinds.includes("prototype")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedArtifactKinds"],
        message: "Generate Artifact targets require prototype in requestedArtifactKinds",
      });
    }
    for (const [index, target] of request.artifactTargets.entries()) {
      if (target.screenIds.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifactTargets", index, "screenIds"],
          message: "Generate Prototype targets require at least one explicitly selected screen",
        });
      }
    }
    return;
  }

  if (request.generationIntent !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["generationIntent"],
      message: "Only the generate workflow accepts a generation intent",
    });
  }
  if (request.artifactTargets.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["artifactTargets"],
      message: "Artifact targets are not valid for the redesign or ideate workflows",
    });
  }
}

export const runFailureSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
}).strict();

export const runSchema = z.object({
  id: opaqueIdSchema,
  requestId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  threadId: opaqueIdSchema,
  retryOfRunId: opaqueIdSchema.nullable(),
  status: runStatusSchema,
  modelId: z.string().min(1).max(128),
  workflow: runWorkflowSchema,
  generationIntent: runGenerationIntentSchema.nullable(),
  targetSurface: runTargetSurfaceSchema,
  designStyle: runDesignStyleSchema,
  artifactTargets: runArtifactTargetsSchema,
  requestedArtifactKinds: z.array(runtimeRequestedArtifactKindSchema).max(12),
  sources: z.array(runSourceSnapshotSchema).max(50),
  knowledgeReleaseId: opaqueIdSchema.nullable(),
  phase: runPhaseSchema.nullable(),
  phaseLabel: z.string().min(1).max(240).nullable(),
  progress: z.number().min(0).max(1).nullable(),
  attempt: z.number().int().nonnegative(),
  lastEventSequence: z.number().int().nonnegative(),
  cancelRequestedAt: isoDateTimeSchema.nullable(),
  failure: runFailureSchema.nullable(),
  cancellationReason: z.string().max(1_000).nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
}).strict().superRefine((run, context) => {
  refineRunWorkflowArtifactTargets(run, context);
  if (run.retryOfRunId === run.id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["retryOfRunId"],
      message: "A Run cannot retry itself",
    });
  }
  const sourceIds = new Set<string>();
  let sourceBlobCount = 0;
  for (const [index, source] of run.sources.entries()) {
    if (source.runId !== run.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", index, "runId"],
        message: "Run source snapshots must belong to the returned Run",
      });
    }
    if (source.projectId !== run.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", index, "projectId"],
        message: "Run source snapshots must belong to the returned Project",
      });
    }
    if (source.position !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", index, "position"],
        message: "Run source snapshots must use contiguous request positions",
      });
    }
    if (sourceIds.has(source.sourceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources", index, "sourceId"],
        message: "Run source snapshots must reference unique Import Sources",
      });
    }
    sourceIds.add(source.sourceId);
    sourceBlobCount += source.snapshot.blobs.length;
  }
  if (sourceBlobCount > runSourceBlobLimit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sources"],
      message: `A Run may materialize at most ${runSourceBlobLimit} source blobs`,
    });
  }
});

export const runListSchema = z.object({
  items: z.array(runSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const startRunRequestObjectSchema = z.object({
  prompt: z.string().trim().min(1).max(50_000),
  modelId: z.string().min(1).max(128),
  workflow: runWorkflowSchema,
  generationIntent: runGenerationIntentSchema.nullable().default(null),
  targetSurface: runTargetSurfaceSchema,
  designStyle: runDesignStyleSchema,
  sourceIds: runSourceIdsSchema,
  artifactTargets: runArtifactTargetsSchema.default([]),
  requestedArtifactKinds: z.array(runtimeRequestedArtifactKindSchema).max(12).default([]),
  // Captured by the active Canvas client before submission. The server binds it
  // to the resulting RuntimeAttempt; it must never carry an Agent session id.
  canvasSnapshot: canvasSnapshotSchema.nullable().default(null),
}).strict();

export const startRunRequestSchema = startRunRequestObjectSchema.superRefine((request, context) => {
  if (hasMissingPrdRequirementSource(request)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["prompt"],
      message: missingPrdRequirementSourceMessage,
    });
  }
  if (
    request.workflow === "redesign"
    && request.sourceIds.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceIds"],
      message: "The redesign workflow requires at least one ready Import Source",
    });
  }
  refineRunWorkflowArtifactTargets(request, context);
  if (request.canvasSnapshot != null && request.canvasSnapshot.runId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canvasSnapshot", "runId"],
      message: "A client Canvas snapshot cannot claim a Run before submission",
    });
  }
});

const runEventBase = {
  protocol: z.literal("workbench.run.v1"),
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  threadId: opaqueIdSchema,
  runId: opaqueIdSchema,
  requestId: opaqueIdSchema,
  sequence: z.number().int().positive(),
  occurredAt: isoDateTimeSchema,
  traceId: z.string().min(1).max(128),
};

const event = <TType extends string, TPayload extends z.ZodTypeAny>(type: TType, payload: TPayload) =>
  z.object({ ...runEventBase, type: z.literal(type), payload });

export const runQueuedEventSchema = event("run.queued", z.object({ position: z.number().int().nonnegative().nullable() }));
export const runStartedEventSchema = event("run.started", z.object({ attempt: z.number().int().positive() }));
export const runGenerationStageChangedEventSchema = event("run.generation.stage.changed", z.object({
  attempt: z.number().int().positive(),
  stage: runGenerationStageSchema,
}));
export const runPhaseChangedEventSchema = event("run.phase.changed", z.object({
  phase: runPhaseSchema,
  label: z.string().min(1).max(240),
  progress: z.number().min(0).max(1).nullable(),
}));
export const runInputRequiredEventSchema = event("run.input.required", z.object({
  approvalId: opaqueIdSchema,
  kind: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4_000),
  options: approvalOptionsSchema,
  attempt: z.number().int().nonnegative(),
}));
export const runInputSubmittedEventSchema = event("run.input.submitted", z.object({
  approvalId: opaqueIdSchema,
  decision: z.enum(["approve", "reject", "submit"]),
}));
export const messageStartedEventSchema = event("message.started", z.object({ entryId: opaqueIdSchema }));
export const messageDeltaEventSchema = event("message.delta", z.object({ entryId: opaqueIdSchema, delta: z.string().max(32_000) }));
export const messageCompletedEventSchema = event("message.completed", z.object({ entryId: opaqueIdSchema }));
export const activityChangedEventSchema = event("activity.changed", z.object({
  activityId: opaqueIdSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  label: z.string().min(1).max(240),
  detail: z.string().max(2_000).nullable(),
}));
export const artifactDraftScreenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  route: z.string().min(1).max(1_024).regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/),
  viewport: z.object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }).strict(),
  revision: prototypePatchRevisionSchema,
  checksum: prototypePatchChecksumSchema,
}).strict();

export const artifactDraftCreatedEventSchema = event("artifact.draft.created", z.object({
  attempt: z.number().int().positive(),
  artifactIndex: z.number().int().nonnegative(),
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  kind: runtimeRequestedArtifactKindSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  draftChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  screens: z.array(artifactDraftScreenSchema).max(500),
}).strict().superRefine((draft, context) => {
  if (draft.kind === "prototype" && draft.screens.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["screens"],
      message: "Prototype drafts must contain at least one screen",
    });
  }
  if (draft.kind !== "prototype" && draft.screens.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["screens"],
      message: "Only prototype drafts may contain screens",
    });
  }
  const screenIds = new Set<string>();
  for (const [index, screen] of draft.screens.entries()) {
    if (screenIds.has(screen.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screens", index, "id"],
        message: "Draft screen ids must be unique",
      });
    }
    screenIds.add(screen.id);
  }
}));
export const artifactPrototypePatchCreatedEventSchema = event(
  "artifact.prototype.patch.created",
  prototypePatchEventPayloadSchema,
);
export const artifactPrototypePatchDegradedEventSchema = event(
  "artifact.prototype.patch.degraded",
  prototypePatchDegradedEventPayloadSchema,
);
export const artifactVersionCreatedEventSchema = event("artifact.version.created", artifactVersionReferenceSchema);
export const runCancelRequestedEventSchema = event("run.cancel.requested", z.object({}));
export const runCancelledEventSchema = event("run.cancelled", z.object({ reason: z.string().max(1_000).nullable() }));
export const runCompletedEventSchema = event("run.completed", z.object({ artifactCount: z.number().int().nonnegative() }));
export const runFailedEventSchema = event("run.failed", z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
}));

export type RunEvent =
  | z.infer<typeof runQueuedEventSchema>
  | z.infer<typeof runStartedEventSchema>
  | z.infer<typeof runGenerationStageChangedEventSchema>
  | z.infer<typeof runPhaseChangedEventSchema>
  | z.infer<typeof runInputRequiredEventSchema>
  | z.infer<typeof runInputSubmittedEventSchema>
  | z.infer<typeof messageStartedEventSchema>
  | z.infer<typeof messageDeltaEventSchema>
  | z.infer<typeof messageCompletedEventSchema>
  | z.infer<typeof activityChangedEventSchema>
  | z.infer<typeof artifactDraftCreatedEventSchema>
  | z.infer<typeof artifactPrototypePatchCreatedEventSchema>
  | z.infer<typeof artifactPrototypePatchDegradedEventSchema>
  | z.infer<typeof artifactVersionCreatedEventSchema>
  | z.infer<typeof runCancelRequestedEventSchema>
  | z.infer<typeof runCancelledEventSchema>
  | z.infer<typeof runCompletedEventSchema>
  | z.infer<typeof runFailedEventSchema>;

export const runEventSchema: z.ZodType<RunEvent> = z.discriminatedUnion("type", [
  runQueuedEventSchema,
  runStartedEventSchema,
  runGenerationStageChangedEventSchema,
  runPhaseChangedEventSchema,
  runInputRequiredEventSchema,
  runInputSubmittedEventSchema,
  messageStartedEventSchema,
  messageDeltaEventSchema,
  messageCompletedEventSchema,
  activityChangedEventSchema,
  artifactDraftCreatedEventSchema,
  artifactPrototypePatchCreatedEventSchema,
  artifactPrototypePatchDegradedEventSchema,
  artifactVersionCreatedEventSchema,
  runCancelRequestedEventSchema,
  runCancelledEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
]);

export const runPrototypePatchCheckpointQuerySchema = z.object({
  screenId: artifactIrIdSchema.optional(),
}).strict();

export const runPrototypePatchCheckpointScreenSchema = z.object({
  screenId: artifactIrIdSchema,
  revision: prototypePatchRevisionSchema,
  checksum: prototypePatchChecksumSchema,
}).strict();

export const runPrototypePatchCheckpointSchema = z.object({
  protocol: z.literal("workbench.prototype-patch-checkpoint.v1"),
  projectId: opaqueIdSchema,
  runId: opaqueIdSchema,
  requestId: opaqueIdSchema,
  attempt: z.number().int().positive(),
  runtimeAttemptId: opaqueIdSchema,
  artifactIndex: z.number().int().min(0).max(19),
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  status: artifactVersionStatusSchema,
  document: prototypeDocumentSchema,
  documentChecksum: prototypePatchChecksumSchema,
  screens: z.array(runPrototypePatchCheckpointScreenSchema).min(1).max(500),
  lastSequence: z.number().int().nonnegative(),
}).strict().superRefine((checkpoint, context) => {
  const documentScreenIds = new Set(checkpoint.document.screens.map((screen) => screen.id));
  const seenScreenIds = new Set<string>();
  for (const [index, screen] of checkpoint.screens.entries()) {
    if (seenScreenIds.has(screen.screenId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screens", index, "screenId"],
        message: "Checkpoint screen ids must be unique",
      });
    }
    if (!documentScreenIds.has(screen.screenId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screens", index, "screenId"],
        message: "Checkpoint screen must exist in the Prototype document",
      });
    }
    seenScreenIds.add(screen.screenId);
  }
});

export const approvalResponseSchema = z.object({
  decision: approvalDecisionSchema,
  value: jsonValueSchema.optional(),
}).strict().nullable();

export const runApprovalSchema = z.object({
  id: opaqueIdSchema,
  runId: opaqueIdSchema,
  kind: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4_000),
  options: approvalOptionsSchema,
  attempt: z.number().int().nonnegative(),
  status: approvalStatusSchema,
  response: approvalResponseSchema,
  decidedById: opaqueIdSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const runApprovalListSchema = z.object({
  items: z.array(runApprovalSchema),
});

export const submitApprovalRequestSchema = z.object({
  decision: approvalDecisionSchema,
  value: jsonValueSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.decision === "submit" && request.value === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "A submitted approval requires a value",
    });
  }
});

export const submitApprovalResponseSchema = z.object({
  approval: runApprovalSchema,
  run: runSchema,
});

export type Run = z.infer<typeof runSchema>;
export type RunFailure = z.infer<typeof runFailureSchema>;
export type RunList = z.infer<typeof runListSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunGenerationStage = z.infer<typeof runGenerationStageSchema>;
export type RunWorkflow = z.infer<typeof runWorkflowSchema>;
export type RunGenerationIntent = z.infer<typeof runGenerationIntentSchema>;
export type RunTargetSurface = z.infer<typeof runTargetSurfaceSchema>;
export type RunDesignStyle = z.infer<typeof runDesignStyleSchema>;
export type RunArtifactTarget = z.infer<typeof runArtifactTargetSchema>;
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;
export type RunPrototypePatchCheckpoint = z.infer<typeof runPrototypePatchCheckpointSchema>;
export type RunApproval = z.infer<typeof runApprovalSchema>;
export type RunApprovalList = z.infer<typeof runApprovalListSchema>;
export type SubmitApprovalRequest = z.infer<typeof submitApprovalRequestSchema>;
export type SubmitApprovalResponse = z.infer<typeof submitApprovalResponseSchema>;
