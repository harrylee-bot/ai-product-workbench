import { z } from "zod";
import type { GenerationPreview } from "./generation-preview.js";
import { approvalDecisionSchema, approvalOptionsSchema } from "./approvals.js";
import { artifactCitationSchema, type ArtifactCitation } from "./citations.js";
import { jsonValueSchema, type JsonValue } from "./common.js";
import {
  prdDocumentV1Schema,
  runtimePrdDocumentSchema,
  runtimePrdDocumentV2Schema,
  runtimePrdDocumentV3Schema,
  type PrdDocument,
} from "./prd.js";
import {
  type PrototypePatchCheckpointScreen,
  type RuntimePrototypePatchInput,
} from "./prototype-patches.js";
import { prototypeDocumentSchema, type PrototypeDocument } from "./prototype.js";
import {
  runArtifactTargetSchema,
  type RunArtifactTarget,
  type RunGenerationStage,
} from "./runs.js";

export const runtimeCitationSchema = artifactCitationSchema;

export const runtimeArtifactOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({
    kind: z.literal("revise"),
    target: runArtifactTargetSchema,
  }).strict(),
]);

const runtimeArtifactDraftBaseShape = {
  title: z.string().min(1).max(240),
  citations: z.array(runtimeCitationSchema).min(1).max(1_000),
};

type RuntimeArtifactDraftBase = {
  title: string;
  citations: ArtifactCitation[];
};

type RuntimeArtifactOperation =
  | { kind: "create" }
  | { kind: "revise"; target: RunArtifactTarget };

export type RuntimeArtifactDraft = RuntimeArtifactDraftBase & (
  | {
      kind: "prd";
      schemaVersion: 1 | 2 | 3;
      content: PrdDocument;
      operation: RuntimeArtifactOperation;
    }
  | {
      kind: "prototype";
      schemaVersion: 1;
      content: PrototypeDocument;
      operation: RuntimeArtifactOperation;
    }
  | {
      kind: "image" | "code" | "document" | "data";
      schemaVersion: number;
      content: JsonValue;
      operation: RuntimeArtifactOperation;
    }
);

function refineRuntimePrdDraft(
  draft: {
    title: string;
    citations: ArtifactCitation[];
    content: PrdDocument;
  },
  context: z.RefinementCtx,
) {
  if (draft.title !== draft.content.title) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["title"],
      message: "PRD Artifact title must match the document and cover title",
    });
  }
  const contentCitations = [...draft.content.citations].sort((left, right) => left.id.localeCompare(right.id));
  const draftCitations = [...draft.citations].sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(contentCitations) !== JSON.stringify(draftCitations)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["citations"],
      message: "PRD draft citations must exactly match content citations",
    });
  }
}

export const runtimeArtifactDraftPrdV1RevisionSchema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(1),
  content: prdDocumentV1Schema,
  operation: z.object({
    kind: z.literal("revise"),
    target: runArtifactTargetSchema,
  }).strict(),
}).strict();

export const runtimeArtifactDraftPrdV2Schema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(2),
  content: runtimePrdDocumentV2Schema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftPrdV3Schema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(3),
  content: runtimePrdDocumentV3Schema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftPrdSchema: z.ZodType<RuntimeArtifactDraft, unknown> = z.union([
  runtimeArtifactDraftPrdV1RevisionSchema,
  runtimeArtifactDraftPrdV2Schema,
  runtimeArtifactDraftPrdV3Schema,
]);

export const runtimeArtifactDraftPrototypeSchema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("prototype"),
  schemaVersion: z.literal(1),
  content: prototypeDocumentSchema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftImageSchema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("image"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftCodeSchema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("code"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftDocumentSchema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("document"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftDataSchema = z.object({
  ...runtimeArtifactDraftBaseShape,
  kind: z.literal("data"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
  operation: runtimeArtifactOperationSchema,
}).strict();

export const runtimeArtifactDraftContractSchema: z.ZodType<RuntimeArtifactDraft, unknown> = z.union([
  runtimeArtifactDraftPrdSchema,
  runtimeArtifactDraftPrototypeSchema,
  runtimeArtifactDraftImageSchema,
  runtimeArtifactDraftCodeSchema,
  runtimeArtifactDraftDocumentSchema,
  runtimeArtifactDraftDataSchema,
]).describe("A PRD draft's top-level citations exactly match its content citations; enforced by the runtime Zod contract.");

export const runtimeArtifactDraftSchema: z.ZodType<RuntimeArtifactDraft, unknown> = z.discriminatedUnion("kind", [
  z.object({
    ...runtimeArtifactDraftBaseShape,
    kind: z.literal("prd"),
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    content: runtimePrdDocumentSchema,
    operation: runtimeArtifactOperationSchema,
  }).strict(),
  runtimeArtifactDraftPrototypeSchema,
  runtimeArtifactDraftImageSchema,
  runtimeArtifactDraftCodeSchema,
  runtimeArtifactDraftDocumentSchema,
  runtimeArtifactDraftDataSchema,
]).superRefine((draft, context) => {
  if (draft.kind !== "prd") return;
  const expectedSchemaVersion = draft.content.protocol === "workbench.prd.v3" ? 3 : draft.content.protocol === "workbench.prd.v2" ? 2 : 1;
  if (draft.schemaVersion !== expectedSchemaVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `PRD schemaVersion must be ${expectedSchemaVersion} for ${draft.content.protocol}`,
    });
  }
  if (draft.operation.kind === "create" && draft.content.protocol === "workbench.prd.v1") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content", "protocol"],
      message: "New PRD Artifacts must use workbench.prd.v3 or compatible workbench.prd.v2; v1 is revision-only",
    });
  }
  if (draft.operation.kind === "create" && draft.content.protocol !== "workbench.prd.v1") {
    for (const [index, row] of draft.content.sections.safetyBaseline.rows.entries()) {
      if (row.applicability === "不涉及" && row.remarks !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content", "sections", "safetyBaseline", "rows", index, "remarks"],
          message: "A newly created PRD safety row marked 不涉及 must use null remarks",
        });
      }
    }
  }
  refineRuntimePrdDraft(draft, context);
});

export type RuntimeResult = {
  protocol: "workbench.runtime.result.v1";
  message: string;
  artifacts: RuntimeArtifactDraft[];
};

export const runtimeResultContractSchema: z.ZodType<RuntimeResult, unknown> = z.object({
  protocol: z.literal("workbench.runtime.result.v1"),
  message: z.string().max(100_000),
  artifacts: z.array(runtimeArtifactDraftContractSchema).max(20),
}).strict();

export const runtimeResultSchema: z.ZodType<RuntimeResult, unknown> = z.object({
  protocol: z.literal("workbench.runtime.result.v1"),
  message: z.string().max(100_000),
  artifacts: z.array(runtimeArtifactDraftSchema).max(20),
}).strict().superRefine((result, context) => {
  const revisedArtifactIds = new Set<string>();
  for (const [index, artifact] of result.artifacts.entries()) {
    if (artifact.operation.kind !== "revise") continue;
    if (revisedArtifactIds.has(artifact.operation.target.artifactId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts", index, "operation", "target", "artifactId"],
        message: "A Runtime result may revise an Artifact at most once",
      });
    }
    revisedArtifactIds.add(artifact.operation.target.artifactId);
  }
});

export const runtimeApprovalRequestSchema = z.object({
  key: z.string().min(1).max(240),
  kind: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4_000),
  options: approvalOptionsSchema.default([]),
}).strict();

export const runtimeInputRequiredSchema = z.object({
  protocol: z.literal("workbench.runtime.input-required.v1"),
  approvals: z.array(runtimeApprovalRequestSchema).min(1).max(20),
}).strict();

export const runtimeResumeDecisionSchema = z.object({
  key: z.string().min(1).max(240),
  decision: approvalDecisionSchema,
  value: jsonValueSchema.optional(),
}).strict();

export type RuntimeApprovalRequest = z.infer<typeof runtimeApprovalRequestSchema>;
export type RuntimeInputRequired = z.infer<typeof runtimeInputRequiredSchema>;
export type RuntimeResumeDecision = z.infer<typeof runtimeResumeDecisionSchema>;
export type RuntimeOutcome = RuntimeResult | RuntimeInputRequired;

export const runtimeOutcomeSchema = z.union([
  runtimeResultSchema,
  runtimeInputRequiredSchema,
]) as z.ZodType<RuntimeOutcome>;

export type RuntimeProgressEvent =
  | { type: "artifact.preview"; preview: GenerationPreview }
  | { type: "phase"; phase: "understanding" | "retrieving_knowledge" | "planning" | "generating" | "validating" | "publishing"; label: string; progress: number | null }
  | { type: "generation.stage"; stage: RunGenerationStage; sourceEventId: string }
  | {
      type: "artifact.draft";
      artifactIndex: number;
      sourceEventId: string;
      draft: RuntimeArtifactDraft;
      checkpointScreens: PrototypePatchCheckpointScreen[];
    }
  | { type: "artifact.prototype.patch"; sourceEventId: string; patch: RuntimePrototypePatchInput }
  | { type: "text.delta"; delta: string }
  | { type: "activity"; activityId: string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; label: string; detail: string | null };
