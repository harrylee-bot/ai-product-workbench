import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";
import { sha256Schema } from "./files.js";
import { publicProjectReleaseSchema } from "./releases.js";

export const shareScopeSchema = z.enum(["view", "remix"]);
export const shareStatusSchema = z.enum(["active", "revoked", "expired"]);

export const shareTokenSchema = z.string()
  .min(47)
  .max(256)
  .regex(/^wbs_[A-Za-z0-9_-]{43,252}$/, "Share tokens must use the wbs_ prefix and unpadded base64url encoding");

export const shareTokenHashSchema = sha256Schema;

export const shareGrantSchema = z.object({
  id: opaqueIdSchema,
  releaseId: opaqueIdSchema,
  createdById: opaqueIdSchema,
  scope: shareScopeSchema,
  status: shareStatusSchema,
  revision: revisionSchema,
  expiresAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((share, context) => {
  if (share.status === "active" && share.revokedAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Active shares cannot have revokedAt",
    });
  }
  if (share.status === "revoked" && share.revokedAt === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Revoked shares require revokedAt",
    });
  }
  if (share.status === "expired" && share.revokedAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Expired shares cannot have revokedAt",
    });
  }
});

export const rotateShareGrantRequestSchema = z.object({
  releaseId: opaqueIdSchema,
  scope: shareScopeSchema.default("view"),
  expiresAt: isoDateTimeSchema.nullable().default(null),
}).strict();

export const rotateShareGrantResponseSchema = z.object({
  share: shareGrantSchema,
  token: shareTokenSchema,
  revokedGrantCount: z.number().int().nonnegative(),
}).strict();

export const shareGrantListSchema = z.object({
  items: z.array(shareGrantSchema).max(100),
  activeCount: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const revokeProjectShareGrantsResponseSchema = z.object({
  projectId: opaqueIdSchema,
  activeGrantCount: z.literal(0),
}).strict();

export const publicShareSchema = z.object({
  shareId: opaqueIdSchema,
  scope: shareScopeSchema,
  expiresAt: isoDateTimeSchema.nullable(),
  release: publicProjectReleaseSchema,
}).strict();

export type ShareScope = z.infer<typeof shareScopeSchema>;
export type ShareStatus = z.infer<typeof shareStatusSchema>;
export type ShareGrant = z.infer<typeof shareGrantSchema>;
export type RotateShareGrantRequest = z.infer<typeof rotateShareGrantRequestSchema>;
export type RotateShareGrantResponse = z.infer<typeof rotateShareGrantResponseSchema>;
export type ShareGrantList = z.infer<typeof shareGrantListSchema>;
export type RevokeProjectShareGrantsResponse = z.infer<typeof revokeProjectShareGrantsResponseSchema>;
export type PublicShare = z.infer<typeof publicShareSchema>;
