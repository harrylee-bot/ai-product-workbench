import { z } from "zod";
import { opaqueIdSchema } from "./common.js";

export const artifactIrIdSchema = z.string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]+)*$/);

export const artifactCitationLocatorSchema = z.object({
  heading: z.string().min(1).max(500).nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
}).strict().superRefine((locator, context) => {
  if (locator.startLine !== null && locator.endLine !== null && locator.endLine < locator.startLine) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endLine"],
      message: "endLine must not be before startLine",
    });
  }
});

export const artifactCitationSchema = z.object({
  id: artifactIrIdSchema,
  documentId: opaqueIdSchema,
  chunkId: opaqueIdSchema,
  sourcePath: z.string().min(1).max(1_024),
  title: z.string().min(1).max(240).nullable(),
  quote: z.string().min(1).max(2_000).nullable(),
  locator: artifactCitationLocatorSchema,
}).strict();

export type ArtifactCitation = z.infer<typeof artifactCitationSchema>;
export type ArtifactCitationLocator = z.infer<typeof artifactCitationLocatorSchema>;
