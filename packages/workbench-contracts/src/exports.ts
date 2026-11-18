import { z } from "zod";
import { artifactContentBlobSchema } from "./artifacts.js";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  opaqueIdSchema,
  revisionSchema,
} from "./common.js";

export const exportFormatSchema = z.enum(["html", "react", "figma", "mcp", "docx", "pdf"]);
/** A build format describes the shape of the generated project. Packaging is
 * deliberately separate so adding a delivery action never creates another
 * renderer or another ExportJob. */
export const exportPackagingSchema = z.enum(["single_file", "zip"]);
export const exportStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
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

export const exportOptionsSchema = z.record(z.string(), jsonValueSchema);

export const exportCapabilityUnavailableReasonSchema = z.enum([
  "EXPORT_FIGMA_UNAVAILABLE",
]);

export const exportCapabilitySchema = z.object({
  available: z.boolean(),
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
});

export const exportCapabilitiesSchema = z.object({
  formats: z.object({
    html: exportCapabilitySchema,
    react: exportCapabilitySchema,
    figma: exportCapabilitySchema,
    mcp: exportCapabilitySchema,
    docx: exportCapabilitySchema,
    pdf: exportCapabilitySchema,
  }).strict(),
  packaging: z.object({
    single_file: exportCapabilitySchema,
    zip: exportCapabilitySchema,
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
  if (job.status === "cancelling" && (
    job.finishedAt !== null || job.output !== null || job.failure !== null
  )) {
    context.addIssue({code:z.ZodIssueCode.custom,path:["status"],message:"Cancelling exports await executor cleanup and cannot carry terminal state"});
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
  options: exportOptionsSchema.default({}),
}).strict().superRefine((request, context) => {
  if (request.format === "figma" && Object.keys(request.options).length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Figma Export does not accept client options",
    });
  }
  const requiredPackaging = requiredExportPackaging(request.format);
  if (requiredPackaging !== null && request.packaging !== requiredPackaging) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["packaging"],
      message: `${request.format} exports must use ${requiredPackaging} packaging`,
    });
  }
});

export function requiredExportPackaging(format: ExportFormat): ExportPackaging | null {
  if (format === "html") return null;
  return format === "docx" || format === "pdf" ? "single_file" : "zip";
}

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
export type ExportStatus = z.infer<typeof exportStatusSchema>;
export type ExportSelection = z.infer<typeof exportSelectionSchema>;
export type ExportCapabilities = z.infer<typeof exportCapabilitiesSchema>;
export type ExportCapabilityUnavailableReason = z.infer<typeof exportCapabilityUnavailableReasonSchema>;
export type ExportFailure = z.infer<typeof exportFailureSchema>;
export type ExportJob = z.infer<typeof exportJobSchema>;
export type CreateExportJobRequest = z.infer<typeof createExportJobRequestSchema>;
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
