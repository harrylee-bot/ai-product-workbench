import { z } from "zod";
import { jsonValueSchema, opaqueIdSchema } from "./common.js";

export const approvalOptionSchema = z.object({
  id: opaqueIdSchema,
  label: z.string().min(1).max(240),
  description: z.string().max(4_000).nullable(),
  value: jsonValueSchema,
}).strict();

export const approvalOptionsSchema = z.array(approvalOptionSchema).max(50).superRefine((options, context) => {
  const ids = new Set<string>();
  for (const [index, option] of options.entries()) {
    if (ids.has(option.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate approval option id: ${option.id}`,
        path: [index, "id"],
      });
    }
    ids.add(option.id);
  }
});

export const approvalDecisionSchema = z.enum(["approve", "reject", "submit"]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "submitted", "expired"]);

export type ApprovalOption = z.infer<typeof approvalOptionSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
