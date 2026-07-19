import { z } from "zod";
import { approvalDecisionSchema, approvalOptionsSchema } from "./approvals.js";
import { artifactCitationSchema, type ArtifactCitation } from "./citations.js";
import { jsonValueSchema, type JsonValue } from "./common.js";
import { prdDocumentSchema, type PrdDocument } from "./prd.js";
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
  citations: z.array(runtimeCitationSchema).max(1_000),
  operation: runtimeArtifactOperationSchema,
};

export type RuntimeArtifactDraft = {
  title: string;
  citations: ArtifactCitation[];
  operation: { kind: "create" } | { kind: "revise"; target: RunArtifactTarget };
} & (
  | { kind: "prd"; schemaVersion: 1; content: PrdDocument }
  | { kind: "prototype"; schemaVersion: 1; content: PrototypeDocument }
  | { kind: "image" | "code" | "document" | "data"; schemaVersion: number; content: JsonValue }
);

export const runtimeArtifactDraftSchema: z.ZodType<RuntimeArtifactDraft> = z.discriminatedUnion("kind", [
  z.object({ ...runtimeArtifactDraftBaseShape, kind: z.literal("prd"), schemaVersion: z.literal(1), content: prdDocumentSchema }).strict(),
  z.object({ ...runtimeArtifactDraftBaseShape, kind: z.literal("prototype"), schemaVersion: z.literal(1), content: prototypeDocumentSchema }).strict(),
  z.object({ ...runtimeArtifactDraftBaseShape, kind: z.literal("image"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...runtimeArtifactDraftBaseShape, kind: z.literal("code"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...runtimeArtifactDraftBaseShape, kind: z.literal("document"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...runtimeArtifactDraftBaseShape, kind: z.literal("data"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
]).superRefine((draft, context) => {
  if (draft.kind !== "prd") return;
  const contentCitations = [...draft.content.citations].sort((left, right) => left.id.localeCompare(right.id));
  const draftCitations = [...draft.citations].sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(contentCitations) !== JSON.stringify(draftCitations)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["citations"],
      message: "PRD draft citations must exactly match content citations",
    });
  }
});

export type RuntimeResult = {
  protocol: "workbench.runtime.result.v1";
  message: string;
  artifacts: RuntimeArtifactDraft[];
};

export const runtimeResultSchema: z.ZodType<RuntimeResult> = z.object({
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
