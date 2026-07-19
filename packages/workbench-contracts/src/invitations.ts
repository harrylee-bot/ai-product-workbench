import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";
import { projectMemberSchema, projectRoleSchema } from "./projects.js";

export const projectInvitationEmailSchema = z.string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .email();

export const projectInvitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const projectInvitationDeliveryStatusSchema = z.literal("not_configured");

export const projectInvitationTokenSchema = z.string()
  .min(96)
  .max(256)
  .regex(
    /^wbi_[A-Za-z0-9_-]{48,128}\.[A-Za-z0-9_-]{43}$/,
    "Project invitation tokens must use the wbi_ prefix and signed base64url encoding",
  );

export const projectInvitationSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  email: projectInvitationEmailSchema,
  role: projectRoleSchema,
  status: projectInvitationStatusSchema,
  deliveryStatus: projectInvitationDeliveryStatusSchema,
  createdById: opaqueIdSchema,
  acceptedById: opaqueIdSchema.nullable(),
  revision: revisionSchema,
  expiresAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((invitation, context) => {
  const accepted = invitation.status === "accepted";
  const revoked = invitation.status === "revoked";
  if (accepted !== (invitation.acceptedAt !== null && invitation.acceptedById !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Accepted invitations require acceptedAt and acceptedById",
    });
  }
  if (revoked !== (invitation.revokedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Revoked invitations require revokedAt",
    });
  }
  if (!accepted && (invitation.acceptedAt !== null || invitation.acceptedById !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["acceptedAt"],
      message: "Only accepted invitations may identify an accepting principal",
    });
  }
  if (!revoked && invitation.revokedAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revokedAt"],
      message: "Only revoked invitations may have revokedAt",
    });
  }
});

export const projectInvitationListItemSchema = z.object({
  invitation: projectInvitationSchema,
  token: projectInvitationTokenSchema.nullable(),
}).strict().superRefine((item, context) => {
  if ((item.invitation.status === "pending") !== (item.token !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["token"],
      message: "Only pending invitations expose an acceptance token to Project owners",
    });
  }
});

export const projectInvitationListSchema = z.object({
  items: z.array(projectInvitationListItemSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable(),
}).strict();

export const createProjectInvitationRequestSchema = z.object({
  email: projectInvitationEmailSchema,
  role: projectRoleSchema,
}).strict();

export const createProjectInvitationResponseSchema = z.object({
  invitation: projectInvitationSchema,
  token: projectInvitationTokenSchema,
  deliveryStatus: projectInvitationDeliveryStatusSchema,
}).strict();

export const projectInvitationTokenRequestSchema = z.object({
  token: projectInvitationTokenSchema,
}).strict();

export const projectInvitationPreviewSchema = z.object({
  invitationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectTitle: z.string().min(1).max(160),
  workspaceId: opaqueIdSchema,
  workspaceName: z.string().min(1).max(160),
  email: projectInvitationEmailSchema,
  role: projectRoleSchema,
  status: projectInvitationStatusSchema,
  expiresAt: isoDateTimeSchema,
}).strict();

export const acceptProjectInvitationResponseSchema = z.object({
  invitation: projectInvitationSchema,
  member: projectMemberSchema,
}).strict();

export type ProjectInvitationStatus = z.infer<typeof projectInvitationStatusSchema>;
export type ProjectInvitation = z.infer<typeof projectInvitationSchema>;
export type ProjectInvitationListItem = z.infer<typeof projectInvitationListItemSchema>;
export type ProjectInvitationList = z.infer<typeof projectInvitationListSchema>;
export type CreateProjectInvitationRequest = z.infer<typeof createProjectInvitationRequestSchema>;
export type CreateProjectInvitationResponse = z.infer<typeof createProjectInvitationResponseSchema>;
export type ProjectInvitationTokenRequest = z.infer<typeof projectInvitationTokenRequestSchema>;
export type ProjectInvitationPreview = z.infer<typeof projectInvitationPreviewSchema>;
export type AcceptProjectInvitationResponse = z.infer<typeof acceptProjectInvitationResponseSchema>;
