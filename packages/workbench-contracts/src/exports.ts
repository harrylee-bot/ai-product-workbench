import { z } from "zod";
import { artifactContentBlobSchema } from "./artifacts.js";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  opaqueIdSchema,
  revisionSchema,
} from "./common.js";

export const exportFormatSchema = z.enum(["html", "react", "figma", "mcp"]);
/** A build format describes the shape of the generated project. Packaging is
 * deliberately separate so adding a delivery action never creates another
 * renderer or another ExportJob. */
export const exportPackagingSchema = z.enum(["single_file", "zip"]);
export const exportDeliveryKindSchema = z.enum(["download", "clipboard", "external"]);
export const externalExportTargetSchema = z.enum(["ai_studio", "netlify", "lovable", "bolt"]);
export const externalExportAuthenticationSchema = z.enum([
  "not_required",
  "required",
  "authenticated",
]);
export const externalExportDeliveryStatusSchema = z.enum([
  "pending_confirmation",
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
export const exportStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const maximumExportBoardNodeSelectionCount = 512;

export const exportBoardNodeIdsSchema = z.array(opaqueIdSchema)
  .min(1)
  .max(maximumExportBoardNodeSelectionCount)
  .superRefine((nodeIds, context) => {
    const seen = new Set<string>();
    nodeIds.forEach((nodeId, index) => {
      if (seen.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `Duplicate Board node id: ${nodeId}`,
        });
      }
      if (index > 0 && compareExportBoardNodeIds(nodeIds[index - 1]!, nodeId) >= 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Board node ids must be in canonical ascending order",
        });
      }
      seen.add(nodeId);
    });
  });

export const exportSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("release") }).strict(),
  z.object({ kind: z.literal("board") }).strict(),
  z.object({
    kind: z.literal("board_nodes"),
    nodeIds: exportBoardNodeIdsSchema,
  }).strict(),
  z.object({
    kind: z.literal("artifact"),
    artifactId: opaqueIdSchema,
    artifactVersionId: opaqueIdSchema,
    screenId: opaqueIdSchema.optional(),
  }).strict(),
]);

export const exportOptionsSchema = z.record(jsonValueSchema);

export const createExportOptionsSchema = exportOptionsSchema;

export const exportCapabilityUnavailableReasonSchema = z.enum([
  "EXPORT_FIGMA_UNAVAILABLE",
  "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
  "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
]);

export const exportCapabilitySchema = z.object({
  available: z.boolean(),
  authentication: externalExportAuthenticationSchema,
  reasonCode: exportCapabilityUnavailableReasonSchema.nullable(),
}).strict().superRefine((capability, context) => {
  if (capability.available && capability.reasonCode !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCode"],
      message: "Available export capabilities cannot carry a failure reason",
    });
  }
  if (!capability.available && capability.reasonCode === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasonCode"],
      message: "Unavailable export capabilities require a stable reason code",
    });
  }
  if (capability.authentication === "authenticated" && !capability.available) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authentication"],
      message: "Authenticated export capabilities must be available",
    });
  }
});

export const availableExportCapabilitySchema = exportCapabilitySchema;
export const figmaExportCapabilitySchema = exportCapabilitySchema;

export const exportCapabilitiesSchema = z.object({
  formats: z.object({
    html: exportCapabilitySchema,
    react: exportCapabilitySchema,
    figma: figmaExportCapabilitySchema,
    mcp: exportCapabilitySchema,
  }).strict(),
  packaging: z.object({
    single_file: exportCapabilitySchema,
    zip: exportCapabilitySchema,
  }).strict(),
  external: z.object({
    ai_studio: exportCapabilitySchema,
    netlify: exportCapabilitySchema,
    lovable: exportCapabilitySchema,
    bolt: exportCapabilitySchema,
  }).strict(),
}).strict();

export const exportFailureSchema = z.object({
  code: z.string().min(1).max(120),
  detail: z.string().max(4_000).nullable(),
}).strict();

export const exportJobSchema = z.object({
  id: opaqueIdSchema,
  releaseId: opaqueIdSchema,
  createdById: opaqueIdSchema,
  format: exportFormatSchema,
  packaging: exportPackagingSchema,
  selection: exportSelectionSchema,
  status: exportStatusSchema,
  revision: revisionSchema,
  options: exportOptionsSchema,
  output: artifactContentBlobSchema.nullable(),
  failure: exportFailureSchema.nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((job, context) => {
  if (job.status === "queued" && (
    job.startedAt !== null
    || job.finishedAt !== null
    || job.output !== null
    || job.failure !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Queued exports cannot have execution state",
    });
  }
  if (job.status === "running" && (
    job.startedAt === null
    || job.finishedAt !== null
    || job.output !== null
    || job.failure !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Running exports require startedAt and cannot have terminal state",
    });
  }
  if (job.status === "succeeded" && (
    job.startedAt === null
    || job.finishedAt === null
    || job.output === null
    || job.failure !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Succeeded exports require timestamps and a non-empty output Blob",
    });
  }
  if (job.status === "failed" && (
    job.finishedAt === null
    || job.output !== null
    || job.failure === null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Failed exports require finishedAt and failure details",
    });
  }
  if (job.status === "cancelled" && (
    job.finishedAt === null
    || job.output !== null
    || job.failure !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Cancelled exports require finishedAt and cannot have output or failure details",
    });
  }
});

export const createExportJobRequestSchema = z.object({
  releaseId: opaqueIdSchema,
  format: exportFormatSchema,
  packaging: exportPackagingSchema,
  selection: exportSelectionSchema,
  options: createExportOptionsSchema.default({}),
}).strict().superRefine((request, context) => {
  if (request.format === "figma" && Object.keys(request.options).length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Figma Export does not accept client options",
    });
  }
  if (request.format !== "html" && request.packaging !== "zip") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["packaging"],
      message: `${request.format} exports must use zip packaging`,
    });
  }
});

export const externalExportPayloadSnapshotSchema = z.object({
  exportJobId: opaqueIdSchema,
  releaseId: opaqueIdSchema,
  format: exportFormatSchema,
  packaging: exportPackagingSchema,
  selection: exportSelectionSchema,
  output: z.object({
    mediaType: z.string().min(1).max(255),
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileName: z.string().min(1).max(500),
  }).strict(),
}).strict();

export const createExternalExportDeliveryRequestSchema = z.object({
  target: externalExportTargetSchema,
}).strict();

export const externalExportFailureSchema = z.object({
  code: z.string().min(1).max(120),
  detail: z.string().max(4_000).nullable(),
}).strict();

export const externalExportDeliverySchema = z.object({
  id: opaqueIdSchema,
  exportJobId: opaqueIdSchema,
  createdById: opaqueIdSchema,
  target: externalExportTargetSchema,
  authentication: externalExportAuthenticationSchema,
  status: externalExportDeliveryStatusSchema,
  revision: revisionSchema,
  attempt: z.number().int().nonnegative(),
  payload: externalExportPayloadSnapshotSchema,
  remoteReference: z.string().min(1).max(500).nullable(),
  failure: externalExportFailureSchema.nullable(),
  createdAt: isoDateTimeSchema,
  confirmedAt: isoDateTimeSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  transferAuthorizedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((delivery, context) => {
  if (delivery.remoteReference !== null && delivery.transferAuthorizedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remoteReference"],
      message: "Remote references require a durable transfer authorization",
    });
  }
  if (delivery.transferAuthorizedAt !== null && (
    delivery.attempt < 1 || delivery.confirmedAt === null || delivery.startedAt === null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transferAuthorizedAt"],
      message: "Transfer authorization requires a confirmed execution attempt",
    });
  }
  if (delivery.status === "pending_confirmation" && (
    delivery.confirmedAt !== null || delivery.startedAt !== null || delivery.finishedAt !== null
    || delivery.transferAuthorizedAt !== null || delivery.remoteReference !== null || delivery.failure !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Pending deliveries cannot have execution state" });
  }
  if (delivery.status === "pending_confirmation" && delivery.attempt !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["attempt"], message: "Pending deliveries cannot have execution attempts" });
  }
  if (["running", "cancelling", "succeeded", "failed"].includes(delivery.status) && delivery.attempt < 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["attempt"], message: "Executed deliveries require at least one attempt" });
  }
  if (delivery.status === "queued" && (
    delivery.confirmedAt === null || delivery.startedAt !== null || delivery.finishedAt !== null
    || delivery.transferAuthorizedAt !== null || delivery.remoteReference !== null || delivery.failure !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Queued deliveries require confirmation and cannot have terminal state" });
  }
  if (delivery.status === "running" && (
    delivery.confirmedAt === null || delivery.startedAt === null || delivery.finishedAt !== null
    || delivery.remoteReference !== null || delivery.failure !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Running deliveries require confirmation and startedAt" });
  }
  if (delivery.status === "cancelling" && (
    delivery.confirmedAt === null || delivery.startedAt === null || delivery.finishedAt !== null
    || delivery.failure !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Cancelling deliveries require execution timestamps and cannot have terminal state" });
  }
  if (delivery.status === "succeeded" && (
    delivery.confirmedAt === null || delivery.startedAt === null || delivery.finishedAt === null
    || delivery.transferAuthorizedAt === null || delivery.remoteReference === null || delivery.failure !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Succeeded deliveries require a remote reference and timestamps" });
  }
  if (delivery.status === "failed" && (
    delivery.confirmedAt === null || delivery.finishedAt === null || delivery.failure === null
    || delivery.remoteReference !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Failed deliveries require confirmation, finishedAt, and failure details" });
  }
  if (delivery.status === "cancelled" && (
    delivery.finishedAt === null || delivery.remoteReference !== null || delivery.failure !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Cancelled deliveries cannot have output or failure details" });
  }
});

export const externalExportDeliveryListSchema = z.object({
  items: z.array(externalExportDeliverySchema).max(100),
}).strict();

export const exportPreviewTokenResponseSchema = z.object({
  url: z.string().url().min(1).max(2_048),
  expiresAt: isoDateTimeSchema,
}).strict();

export const exportJobListSchema = z.object({
  items: z.array(exportJobSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type ExportPackaging = z.infer<typeof exportPackagingSchema>;
export type ExportDeliveryKind = z.infer<typeof exportDeliveryKindSchema>;
export type ExternalExportTarget = z.infer<typeof externalExportTargetSchema>;
export type ExternalExportAuthentication = z.infer<typeof externalExportAuthenticationSchema>;
export type ExternalExportDeliveryStatus = z.infer<typeof externalExportDeliveryStatusSchema>;
export type ExportStatus = z.infer<typeof exportStatusSchema>;
export type ExportSelection = z.infer<typeof exportSelectionSchema>;
export type ExportCapabilities = z.infer<typeof exportCapabilitiesSchema>;
export type ExportCapabilityUnavailableReason = z.infer<typeof exportCapabilityUnavailableReasonSchema>;
export type ExportFailure = z.infer<typeof exportFailureSchema>;
export type ExportJob = z.infer<typeof exportJobSchema>;
export type CreateExportJobRequest = z.infer<typeof createExportJobRequestSchema>;
export type ExternalExportPayloadSnapshot = z.infer<typeof externalExportPayloadSnapshotSchema>;
export type CreateExternalExportDeliveryRequest = z.infer<typeof createExternalExportDeliveryRequestSchema>;
export type ExternalExportDelivery = z.infer<typeof externalExportDeliverySchema>;
export type ExternalExportDeliveryList = z.infer<typeof externalExportDeliveryListSchema>;
export type ExportPreviewTokenResponse = z.infer<typeof exportPreviewTokenResponseSchema>;
export type ExportJobList = z.infer<typeof exportJobListSchema>;

export type ExportSelectableBoardNode = {
  id: string;
  kind: string;
  parentNodeId: string | null;
};

export type ExportBoardNodeSelectionResolution<Node extends ExportSelectableBoardNode> = {
  selectedNodes: Node[];
  missingNodeIds: string[];
};

/**
 * Resolves an immutable Board selection. Explicit nodes are always included;
 * selecting a Frame additionally includes every descendant of that Frame.
 */
export function resolveExportBoardNodeSelection<Node extends ExportSelectableBoardNode>(
  boardNodes: readonly Node[],
  nodeIds: readonly string[],
): ExportBoardNodeSelectionResolution<Node> {
  const requestedIds = new Set(nodeIds);
  const nodesById = new Map(boardNodes.map((node) => [node.id, node]));
  const missingNodeIds = nodeIds.filter((nodeId) => !nodesById.has(nodeId));
  const selectedIds = new Set(nodeIds.filter((nodeId) => nodesById.has(nodeId)));
  const childrenByParentId = new Map<string, Node[]>();

  for (const node of boardNodes) {
    if (node.parentNodeId === null) continue;
    const children = childrenByParentId.get(node.parentNodeId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentNodeId, children);
  }

  const pendingFrames = boardNodes.filter((node) => (
    requestedIds.has(node.id) && node.kind === "frame"
  ));
  for (let index = 0; index < pendingFrames.length; index += 1) {
    const frame = pendingFrames[index]!;
    for (const child of childrenByParentId.get(frame.id) ?? []) {
      if (selectedIds.has(child.id)) continue;
      selectedIds.add(child.id);
      if (child.kind === "frame") pendingFrames.push(child);
    }
  }

  return {
    selectedNodes: boardNodes.filter((node) => selectedIds.has(node.id)),
    missingNodeIds,
  };
}

const utf8Encoder = new TextEncoder();

export function compareExportBoardNodeIds(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
