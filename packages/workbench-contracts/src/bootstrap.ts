import { z } from "zod";
import { artifactSchema } from "./artifacts.js";
import { boardSchema } from "./boards.js";
import { projectRoleSchema, projectSchema } from "./projects.js";
import { runSchema } from "./runs.js";
import { threadEntrySchema, threadSchema } from "./threads.js";

export const projectBootstrapSchema = z.object({
  project: projectSchema,
  access: z.object({ role: projectRoleSchema }).strict(),
  threads: z.array(threadSchema),
  selectedThreadId: z.string().nullable(),
  entries: z.array(threadEntrySchema),
  board: boardSchema,
  artifacts: z.array(artifactSchema),
  latestRun: runSchema.nullable(),
}).strict().superRefine((bootstrap, context) => {
  if (bootstrap.selectedThreadId === null) {
    if (bootstrap.entries.length > 0 || bootstrap.latestRun !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A bootstrap without a selected Thread cannot contain entries or a Run",
        path: ["selectedThreadId"],
      });
    }
    return;
  }

  if (!bootstrap.threads.some((thread) => thread.id === bootstrap.selectedThreadId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "selectedThreadId must reference one of the returned Threads",
      path: ["selectedThreadId"],
    });
  }
  for (const [index, entry] of bootstrap.entries.entries()) {
    if (entry.threadId !== bootstrap.selectedThreadId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bootstrap entries must belong to the selected Thread",
        path: ["entries", index, "threadId"],
      });
    }
  }
  if (bootstrap.latestRun && bootstrap.latestRun.threadId !== bootstrap.selectedThreadId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "latestRun must belong to the selected Thread",
      path: ["latestRun", "threadId"],
    });
  }
});

export type ProjectBootstrap = z.infer<typeof projectBootstrapSchema>;
