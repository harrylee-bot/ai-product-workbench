import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema } from "./common.js";
import { sha256Schema } from "./files.js";

export const confirmArtifactFinalizationRequestSchema = z.object({ checksum: sha256Schema }).strict();
export const artifactFinalizationSchema = z.object({
  id: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  confirmedById: opaqueIdSchema,
  checksum: sha256Schema,
  status: z.enum(["confirmed", "ingesting", "ingested", "rejected", "withdrawn"]),
  confirmedAt: isoDateTimeSchema,
  withdrawnAt: isoDateTimeSchema.nullable(),
  ingestionJob: z.object({
    id: opaqueIdSchema,
    status: z.enum(["queued", "converting", "indexing", "publishing", "published", "failed", "withdrawn"]),
    attempt: z.number().int().nonnegative(),
    errorCode: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    releases: z.array(z.object({
      id: opaqueIdSchema, version: z.number().int().positive(),
      status: z.enum(["building", "ready", "failed", "retired"]),
      parentReleaseId: opaqueIdSchema.nullable(),
    }).strict()),
  }).strict().nullable(),
}).strict();
export const artifactFinalizationStateSchema = artifactFinalizationSchema.nullable();
export type ArtifactFinalization = z.infer<typeof artifactFinalizationSchema>;
