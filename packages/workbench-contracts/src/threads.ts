import { z } from "zod";
import { approvalOptionsSchema } from "./approvals.js";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";

export const threadStatusSchema = z.enum(["active", "archived"]);

export const threadSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  title: z.string().min(1).max(160),
  status: threadStatusSchema,
  revision: revisionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const createThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(160),
});

export const updateThreadRequestSchema = createThreadRequestSchema;

export const threadListSchema = z.object({
  items: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});

export const threadEntryRoleSchema = z.enum(["user", "assistant", "system"]);
export const threadEntryKindSchema = z.enum(["message", "activity", "approval"]);

export const threadUserPromptContentSchema = z.object({
  protocol: z.literal("workbench.entry.v1"),
  type: z.literal("user.prompt"),
  text: z.string().min(1).max(50_000),
  sourceIds: z.array(opaqueIdSchema).max(50),
}).strict();

export const threadAssistantMessageContentSchema = z.object({
  protocol: z.literal("workbench.entry.v1"),
  type: z.literal("assistant.message"),
  text: z.string().max(100_000),
}).strict();

export const threadActivityContentSchema = z.object({
  protocol: z.literal("workbench.entry.v1"),
  type: z.literal("activity.status"),
  activityId: opaqueIdSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  label: z.string().min(1).max(240),
  detail: z.string().max(2_000).nullable(),
}).strict();

export const threadApprovalContentSchema = z.object({
  protocol: z.literal("workbench.entry.v1"),
  type: z.literal("approval.request"),
  approvalId: opaqueIdSchema,
  kind: z.string().min(1).max(80),
  prompt: z.string().min(1).max(4_000),
  options: approvalOptionsSchema,
  attempt: z.number().int().nonnegative(),
}).strict();

export const threadEntryContentSchema = z.discriminatedUnion("type", [
  threadUserPromptContentSchema,
  threadAssistantMessageContentSchema,
  threadActivityContentSchema,
  threadApprovalContentSchema,
]);

export const threadEntrySchema = z.object({
  id: opaqueIdSchema,
  threadId: opaqueIdSchema,
  sequence: z.number().int().positive(),
  role: threadEntryRoleSchema,
  kind: threadEntryKindSchema,
  content: threadEntryContentSchema,
  producedByRunId: opaqueIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
}).strict().superRefine((entry, context) => {
  const expected = entryEnvelopeFor(entry.content.type);
  if (entry.role !== expected.role) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${entry.content.type} requires role ${expected.role}`,
      path: ["role"],
    });
  }
  if (entry.kind !== expected.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${entry.content.type} requires kind ${expected.kind}`,
      path: ["kind"],
    });
  }
});

function entryEnvelopeFor(type: z.infer<typeof threadEntryContentSchema>["type"]): {
  role: z.infer<typeof threadEntryRoleSchema>;
  kind: z.infer<typeof threadEntryKindSchema>;
} {
  if (type === "user.prompt") return { role: "user", kind: "message" };
  if (type === "assistant.message") return { role: "assistant", kind: "message" };
  if (type === "activity.status") return { role: "system", kind: "activity" };
  return { role: "system", kind: "approval" };
}

export const threadEntryListSchema = z.object({
  items: z.array(threadEntrySchema),
  nextAfterSequence: z.number().int().positive().nullable(),
});

export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;
export type ThreadList = z.infer<typeof threadListSchema>;
export type ThreadEntry = z.infer<typeof threadEntrySchema>;
export type ThreadEntryContent = z.infer<typeof threadEntryContentSchema>;
export type ThreadEntryList = z.infer<typeof threadEntryListSchema>;
