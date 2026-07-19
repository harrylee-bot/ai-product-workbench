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
}).strict();

export const projectPreviewSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  boardId: opaqueIdSchema,
  boardRevision: revisionSchema,
  selection: exportSelectionSchema,
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
