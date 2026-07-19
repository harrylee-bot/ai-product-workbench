import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema } from "./common.js";
import { projectSchema } from "./projects.js";

export const createProjectRemixRequestSchema = z.object({
  workspaceId: opaqueIdSchema,
  title: z.string().trim().min(1).max(160).optional(),
}).strict();

export const projectLineageSchema = z.object({
  targetProjectId: opaqueIdSchema,
  sourceReleaseId: opaqueIdSchema,
  sourceShareId: opaqueIdSchema,
  createdById: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  createdAt: isoDateTimeSchema,
}).strict();

export const createProjectRemixResponseSchema = z.object({
  project: projectSchema,
  lineage: projectLineageSchema,
}).strict();

export type CreateProjectRemixRequest = z.infer<typeof createProjectRemixRequestSchema>;
export type ProjectLineage = z.infer<typeof projectLineageSchema>;
export type CreateProjectRemixResponse = z.infer<typeof createProjectRemixResponseSchema>;
