import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";

export const projectStatusSchema = z.enum(["active", "archived"]);
export const projectRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const projectRelationshipSchema = z.enum(["owned", "shared"]);

export const projectSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  title: z.string().min(1).max(160),
  summary: z.string().max(2_000).nullable(),
  status: projectStatusSchema,
  revision: revisionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const createProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(2_000).optional(),
});

export const updateProjectRequestSchema = createProjectRequestSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one project field is required",
);

export const projectListItemSchema = projectSchema.extend({
  role: projectRoleSchema,
  relationship: projectRelationshipSchema,
});

export const projectListSchema = z.object({
  items: z.array(projectListItemSchema),
  nextCursor: z.string().nullable(),
});

export const duplicateProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
}).strict();

export const projectDuplicateSchema = z.object({
  sourceProjectId: opaqueIdSchema,
  project: projectSchema,
  createdAt: isoDateTimeSchema,
});

export const projectMemberSchema = z.object({
  projectId: opaqueIdSchema,
  principalId: opaqueIdSchema,
  role: projectRoleSchema,
  displayName: z.string().max(160).nullable(),
  email: z.string().email().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const projectMemberListSchema = z.object({
  items: z.array(projectMemberSchema),
});

export const setProjectMemberRoleRequestSchema = z.object({
  role: projectRoleSchema,
}).strict();

export type Project = z.infer<typeof projectSchema>;
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export type ProjectRelationship = z.infer<typeof projectRelationshipSchema>;
export type ProjectListItem = z.infer<typeof projectListItemSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type DuplicateProjectRequest = z.infer<typeof duplicateProjectRequestSchema>;
export type ProjectDuplicate = z.infer<typeof projectDuplicateSchema>;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export type ProjectMemberList = z.infer<typeof projectMemberListSchema>;
export type SetProjectMemberRoleRequest = z.infer<typeof setProjectMemberRoleRequestSchema>;
export type ProjectList = z.infer<typeof projectListSchema>;
