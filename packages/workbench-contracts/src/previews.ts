import { z } from "zod";

import {
  exportFailureSchema,
  exportPreviewTokenResponseSchema,
  exportSelectionSchema,
  type ExportPreviewTokenResponse,
} from "./exports.js";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";

/**
 * A Preview is a short-lived, read-authorized rendering command. It is
 * intentionally separate from ExportJob: a Preview never grants download
 * access and is not included in the Export API's job collection.
 */
export const previewStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

export const createProjectPreviewRequestSchema = z.object({
  boardId: opaqueIdSchema,
  boardRevision: revisionSchema,
  selection: exportSelectionSchema,
  initialScreenId: opaqueIdSchema.nullable().optional(),
}).strict().superRefine((preview, context) => {
  if (preview.selection.kind === "artifact" && preview.selection.screenId !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Project Preview selection cannot crop a Prototype to one screen",
      path: ["selection", "screenId"],
    });
  }
  if (preview.initialScreenId != null && preview.selection.kind !== "artifact") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "initialScreenId requires an Artifact selection",
      path: ["initialScreenId"],
    });
  }
});

export const projectPreviewSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  boardRevision: revisionSchema,
  selection: exportSelectionSchema,
  // Older API deployments return the opening screen separately from selection.
  initialScreenId: opaqueIdSchema.nullable().optional(),
  status: previewStatusSchema,
  revision: revisionSchema,
  failure: exportFailureSchema.nullable(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();

export const previewTokenResponseSchema = exportPreviewTokenResponseSchema;

export type PreviewStatus = z.infer<typeof previewStatusSchema>;
export type CreateProjectPreviewRequest = z.infer<typeof createProjectPreviewRequestSchema>;
export type ProjectPreview = z.infer<typeof projectPreviewSchema>;
export type PreviewTokenResponse = ExportPreviewTokenResponse;
