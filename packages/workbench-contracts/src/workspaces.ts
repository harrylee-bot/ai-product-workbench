import { z } from "zod";
import { opaqueIdSchema } from "./common.js";

export const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);

export const workspaceMemberSchema = z.object({
  principalId: opaqueIdSchema,
  role: workspaceRoleSchema,
  displayName: z.string().max(160).nullable(),
  email: z.string().email().max(320).nullable(),
}).strict();

export const workspaceMemberListSchema = z.object({
  items: z.array(workspaceMemberSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable(),
}).strict();

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceMemberList = z.infer<typeof workspaceMemberListSchema>;
