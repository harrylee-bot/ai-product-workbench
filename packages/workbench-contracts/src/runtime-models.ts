import { z } from "zod";
import { runWorkflowSchema } from "./runs.js";

export const runtimeModelSupportedWorkflowsSchema = z.array(runWorkflowSchema)
  .min(1)
  .max(runWorkflowSchema.options.length)
  .refine(
    (workflows) => new Set(workflows).size === workflows.length,
    "supportedWorkflows must be unique",
  );

export const runtimeModelSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(240),
  description: z.string().max(4_000).nullable(),
  supportedWorkflows: runtimeModelSupportedWorkflowsSchema,
  supportsThinking: z.boolean(),
  supportsReasoningEffort: z.boolean(),
}).strict();

export const runtimeModelListSchema = z.object({
  items: z.array(runtimeModelSchema).max(200),
}).strict().superRefine(({ items }, context) => {
  const ids = new Set<string>();
  for (const [index, model] of items.entries()) {
    if (ids.has(model.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate runtime model id: ${model.id}`,
        path: ["items", index, "id"],
      });
    }
    ids.add(model.id);
  }
});

export type RuntimeModel = z.infer<typeof runtimeModelSchema>;
export type RuntimeModelList = z.infer<typeof runtimeModelListSchema>;
