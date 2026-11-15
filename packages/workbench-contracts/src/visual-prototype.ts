import { z } from "zod";
import { startRunRequestSchema, runSchema, runEventSchema } from "./runs.js";
import { runtimeMaterializedDesignStyleSnapshotSchema } from "./design-systems.js";
import { importSourceKindSchema, importSourceDescriptorSchema, runSourceSnapshotManifestSchema } from "./import-sources.js";
import { artifactIrIdSchema } from "./citations.js";
import { sha256Schema } from "./files.js";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";

const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const prototypePlanStatusSchema = z.enum(["draft", "approved", "generating", "ready", "failed", "cancelled"]);
export const prototypeRevisionStatusSchema = z.enum(["queued", "generating", "ready", "confirmed", "rejected", "failed", "cancelled"]);
export const prototypeFeedbackStatusSchema = z.enum(["open", "resolved"]);
export const prototypeShareStatusSchema = z.enum(["active", "revoked", "expired"]);
export const prototypeExportStatusSchema = z.enum(["queued", "building", "succeeded", "failed", "cancelled"]);
export const prototypeExportFormatSchema = z.enum(["html", "react"]);

export const prototypePageSchema = z.object({
  id: opaqueIdSchema,
  slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9/_-]*$/u),
  title: shortText(160),
  route: z.string().min(1).max(512).regex(/^\//u),
  order: z.number().int().nonnegative().max(500),
  content: z.string().min(1).max(2_097_152).describe("This page's DOM fragment. Execute the revision's verified previewHtml for the complete shared runtime."),
  sha256: sha256Schema,
}).strict();

const failureSchema = z.object({ code: shortText(120), detail: shortText(2_000) }).strict();

export const prototypePlanSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  rootPlanId: opaqueIdSchema.nullable().default(null),
  sourceRevisionId: opaqueIdSchema.nullable().default(null),
  contentVersion: z.number().int().positive().default(1),
  status: prototypePlanStatusSchema,
  prompt: shortText(20_000),
  title: shortText(240),
  revision: revisionSchema,
  createdById: opaqueIdSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  failure: failureSchema.nullable(),
}).strict();

export const prototypeRevisionSummarySchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  planId: opaqueIdSchema,
  version: z.number().int().positive().default(1),
  sourceRevisionId: opaqueIdSchema.nullable().default(null),
  revision: revisionSchema,
  status: prototypeRevisionStatusSchema,
  title: shortText(240),
  documentSha256: sha256Schema,
  createdById: opaqueIdSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  failure: failureSchema.nullable(),
}).strict();

export const prototypeRevisionSchema = prototypeRevisionSummarySchema.extend({
  pages: z.array(prototypePageSchema).min(1).max(50),
  previewHtml: z.string().min(1).nullable().default(null).describe("The verified immutable HTML document, loaded only by a direct revision read; null while pending or in mutation responses."),
}).superRefine((value, context) => {
  if (new Set(value.pages.map((page) => page.id)).size !== value.pages.length) {
    context.addIssue({ code: "custom", path: ["pages"], message: "Page ids must be unique" });
  }
});

export const prototypeRevisionListSchema = z.array(prototypeRevisionSummarySchema).max(50);

/** Anonymous share projection; excludes the author identity and workflow internals. */
export const prototypePublicRevisionSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  planId: opaqueIdSchema,
  version: z.number().int().positive().default(1),
  sourceRevisionId: opaqueIdSchema.nullable().default(null),
  revision: revisionSchema,
  status: prototypeRevisionStatusSchema,
  title: shortText(240),
  pages: z.array(prototypePageSchema).min(1).max(50),
  previewHtml: z.string().min(1).nullable().default(null).describe("The same verified immutable HTML document used by the private revision preview."),
  documentSha256: sha256Schema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  failure: failureSchema.nullable(),
}).strict();

const feedbackAnchorBase = {
  sourceRevisionId: opaqueIdSchema,
  pageId: opaqueIdSchema,
  quote: z.string().max(1_000).optional(),
};
const feedbackPageAnchorSchema = z.object({ ...feedbackAnchorBase, scope: z.literal("page") }).strict();
const feedbackNodeAnchorSchema = z.object({ ...feedbackAnchorBase, scope: z.literal("node"), nodeId: artifactIrIdSchema }).strict();
/** Old unidentifiable anchors are migrated once to an explicit unresolved state. */
export const prototypeFeedbackAnchorSchema = z.discriminatedUnion("scope", [
  feedbackPageAnchorSchema, feedbackNodeAnchorSchema,
  z.object({ ...feedbackAnchorBase, scope: z.literal("unresolved") }).strict(),
]);
export const createPrototypeFeedbackAnchorSchema = z.discriminatedUnion("scope", [feedbackPageAnchorSchema, feedbackNodeAnchorSchema]);

export const prototypeFeedbackSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  revisionId: opaqueIdSchema,
  createdById: opaqueIdSchema,
  body: shortText(4_000),
  anchor: prototypeFeedbackAnchorSchema.nullable(),
  status: prototypeFeedbackStatusSchema,
  revision: revisionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
}).strict();

export const prototypeShareSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  revisionId: opaqueIdSchema,
  revision: revisionSchema,
  status: prototypeShareStatusSchema,
  url: z.string().url(),
  expiresAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
}).strict();

export const prototypePublicShareSchema = z.object({
  share: prototypeShareSchema,
  revision: prototypePublicRevisionSchema,
}).strict();

export const prototypeExportArtifactSchema = z.object({
  downloadUrl: z.string().url(),
  artifactSha256: sha256Schema,
  byteSize: z.number().int().positive(),
  mediaType: z.string().min(1).max(255),
}).strict();

export const prototypeExportSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  revisionId: opaqueIdSchema,
  format: prototypeExportFormatSchema,
  status: prototypeExportStatusSchema,
  revision: revisionSchema,
  artifact: prototypeExportArtifactSchema.nullable(),
  failure: failureSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "succeeded" && value.artifact === null) {
    context.addIssue({ code: "custom", path: ["artifact"], message: "Succeeded exports require an artifact" });
  }
  if (value.status === "failed" && value.failure === null) {
    context.addIssue({ code: "custom", path: ["failure"], message: "Failed exports require failure details" });
  }
  if (value.status === "cancelled" && (value.artifact !== null || value.failure !== null)) {
    context.addIssue({ code: "custom", path: ["status"], message: "Cancelled exports cannot carry an artifact or failure" });
  }
});

export const prototypeWorkflowActionRequestSchema = z.object({ reason: z.string().trim().max(2_000).optional() }).strict();
export const createPrototypePlanRequestSchema = z.object({ prompt: shortText(20_000), title: shortText(240), generationRequest: startRunRequestSchema }).strict();
export const revisePrototypeRevisionRequestSchema = z.object({ feedbackIds: z.array(opaqueIdSchema).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "Feedback ids must be unique"), prompt: shortText(4_000).optional() }).strict();
export const createPrototypeFeedbackRequestSchema = z.object({ body: shortText(4_000), anchor: createPrototypeFeedbackAnchorSchema.nullable().optional() }).strict();
export const createPrototypeShareRequestSchema = z.object({ revisionId: opaqueIdSchema, expiresAt: isoDateTimeSchema.nullable().optional() }).strict();
export const createPrototypeExportRequestSchema = z.object({ revisionId: opaqueIdSchema, format: prototypeExportFormatSchema }).strict();
export const prototypeListQuerySchema = z.object({ cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
export const prototypeMutationHeadersSchema = z.object({ idempotencyKey: idempotencyKeySchema, ifMatch: z.string().min(1).max(256).optional() }).strict();

export type PrototypePlanStatus = z.infer<typeof prototypePlanStatusSchema>;
export type PrototypeRevisionStatus = z.infer<typeof prototypeRevisionStatusSchema>;
export type PrototypeFeedbackStatus = z.infer<typeof prototypeFeedbackStatusSchema>;
export type PrototypeShareStatus = z.infer<typeof prototypeShareStatusSchema>;
export type PrototypeExportStatus = z.infer<typeof prototypeExportStatusSchema>;
export type PrototypePage = z.infer<typeof prototypePageSchema>;
export type PrototypePlan = z.infer<typeof prototypePlanSchema>;
export type PrototypeRevision = z.infer<typeof prototypeRevisionSchema>;
export type PrototypeRevisionSummary = z.infer<typeof prototypeRevisionSummarySchema>;
export type PrototypeRevisionList = z.infer<typeof prototypeRevisionListSchema>;
export type PrototypePublicRevision = z.infer<typeof prototypePublicRevisionSchema>;
export type PrototypeFeedback = z.infer<typeof prototypeFeedbackSchema>;
export type PrototypeShare = z.infer<typeof prototypeShareSchema>;
export type PrototypePublicShare = z.infer<typeof prototypePublicShareSchema>;
export type PrototypeExportArtifact = z.infer<typeof prototypeExportArtifactSchema>;
export type PrototypeExport = z.infer<typeof prototypeExportSchema>;
export type CreatePrototypePlanRequest = z.infer<typeof createPrototypePlanRequestSchema>;
export type CreatePrototypeFeedbackRequest = z.infer<typeof createPrototypeFeedbackRequestSchema>;
export type CreatePrototypeShareRequest = z.infer<typeof createPrototypeShareRequestSchema>;
export type CreatePrototypeExportRequest = z.infer<typeof createPrototypeExportRequestSchema>;
export type PrototypeWorkflowActionRequest = z.infer<typeof prototypeWorkflowActionRequestSchema>;

export const prototypePlanListSchema = z.array(prototypePlanSchema).max(100);
export const prototypeFeedbackListSchema = z.array(prototypeFeedbackSchema).max(100);
export const prototypeShareListSchema = z.array(prototypeShareSchema).max(100);
export const prototypeExportListSchema = z.array(prototypeExportSchema).max(100);
export type RevisePrototypeRevisionRequest = z.infer<typeof revisePrototypeRevisionRequestSchema>;

export const prototypeRevisionDiffSchema = z.object({ sourceRevisionId: opaqueIdSchema.nullable(), pages: z.array(z.object({ pageId: opaqueIdSchema, change: z.enum(["added", "removed", "changed", "unchanged"]) }).strict()).max(100) }).strict();
export type PrototypeRevisionDiff = z.infer<typeof prototypeRevisionDiffSchema>;

/** Authorized recovery point; events are compact state seeds, not a contiguous replay. */
export const prototypeProgressSchema = z.object({
  projectId: opaqueIdSchema,
  planId: opaqueIdSchema,
  status: prototypePlanStatusSchema,
  input: z.object({
    requestedArtifactKinds: z.array(z.string().max(80)).max(12),
    modelId: z.string().max(128).nullable(),
    targetSurface: z.string().max(80).nullable(),
    sourceIds: z.array(opaqueIdSchema).max(50),
    designStyle: z.string().max(160).nullable(),
  }).strict(),
  run: runSchema.nullable(),
  events: z.array(runEventSchema).max(64),
  coverage: z.literal("window"),
  finalRevisionId: opaqueIdSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.run && value.run.projectId !== value.projectId) ctx.addIssue({ code: "custom", message: "Run project mismatch" });
  for (const event of value.events) {
    if (!value.run || event.runId !== value.run.id || event.projectId !== value.projectId || event.requestId !== value.run.requestId || event.threadId !== value.run.threadId || event.sequence > value.run.lastEventSequence) ctx.addIssue({ code: "custom", message: "Snapshot event identity or cursor mismatch" });
    if (value.run && "attempt" in event.payload && event.payload.attempt !== value.run.attempt) ctx.addIssue({ code: "custom", message: "Snapshot attempt mismatch" });
  }
});
export type PrototypeProgress = z.infer<typeof prototypeProgressSchema>;

/** Immutable context captured when a draft is created or explicitly adjusted. */
export const prototypeInputSnapshotSchema = z.object({
  sources: z.array(z.object({sourceId:opaqueIdSchema,kind:importSourceKindSchema,label:shortText(240),checksum:sha256Schema,descriptor:importSourceDescriptorSchema,snapshot:runSourceSnapshotManifestSchema}).strict()).max(50),
  designStyle: z.object({artifactVersionId:opaqueIdSchema.nullable(),snapshot:runtimeMaterializedDesignStyleSnapshotSchema.nullable(),snapshotSha256:sha256Schema.nullable()}).strict(),
  knowledgeReleaseId:opaqueIdSchema.nullable(),
}).strict();
export const prototypePlanInputSchema = z.object({plan:prototypePlanSchema,request:startRunRequestSchema,snapshot:prototypeInputSnapshotSchema.nullable(),sha256:sha256Schema}).strict();
export const updatePrototypePlanRequestSchema=createPrototypePlanRequestSchema;
export const createPrototypeRevisionPlanRequestSchema=createPrototypePlanRequestSchema.extend({feedbackIds:z.array(opaqueIdSchema).max(100).default([])}).refine(value=>new Set(value.feedbackIds).size===value.feedbackIds.length,"Feedback ids must be unique");
export type PrototypeInputSnapshot=z.infer<typeof prototypeInputSnapshotSchema>;
export type PrototypePlanInput=z.infer<typeof prototypePlanInputSchema>;
export type UpdatePrototypePlanRequest=z.infer<typeof updatePrototypePlanRequestSchema>;
export type CreatePrototypeRevisionPlanRequest=z.infer<typeof createPrototypeRevisionPlanRequestSchema>;

/** Source input remains historical; modificationRequest is the effective edit input for this operation. */
export const prototypeRevisionInputSchema = prototypePlanInputSchema.extend({ modificationRequest: startRunRequestSchema });
export type PrototypeRevisionInput = z.infer<typeof prototypeRevisionInputSchema>;

export const prototypeFeedbackQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: prototypeFeedbackStatusSchema.optional(),
  pageId: opaqueIdSchema.optional(),
}).strict();
export type PrototypeFeedbackQuery = Partial<z.infer<typeof prototypeFeedbackQuerySchema>>;
export const prototypeFeedbackPageSchema = z.object({ items: prototypeFeedbackListSchema, nextCursor: z.string().nullable() }).strict();
export const prototypeFeedbackLocationsQuerySchema = prototypeFeedbackQuerySchema.extend({ sourceRevisionId: opaqueIdSchema });
export const prototypeFeedbackLocationSchema = z.object({
  feedback: prototypeFeedbackSchema,
  targetRevisionId: opaqueIdSchema,
  status: z.enum(["resolved", "missing", "version"]),
  pageId: opaqueIdSchema.nullable(),
  nodeId: artifactIrIdSchema.nullable(),
  reason: z.enum(["page_missing", "node_missing", "unidentified_node", "source_unavailable"]).nullable(),
}).strict();
export const prototypeFeedbackLocationsSchema = z.object({sourceRevisionId:opaqueIdSchema,targetRevisionId:opaqueIdSchema,items:z.array(prototypeFeedbackLocationSchema).max(100),nextCursor:z.string().nullable()}).strict();
export type PrototypeFeedbackLocations = z.infer<typeof prototypeFeedbackLocationsSchema>;
export type PrototypeFeedbackLocation = z.infer<typeof prototypeFeedbackLocationSchema>;
