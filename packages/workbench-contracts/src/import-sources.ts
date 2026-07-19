import { z } from "zod";
import {
  fileNameSchema,
  mediaTypeSchema,
  safeIntegerSchema,
  sha256Schema,
} from "./files.js";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";

export const runSourceBlobLimit = 50;

/**
 * A source is a durable, project-scoped input to a Run. It is deliberately
 * separate from the upload transport: a source can later point at a frozen
 * external snapshot without changing the Run contract.
 */
export const importSourceKindSchema = z.enum([
  "file",
  "design_md",
  "url_snapshot",
  "github_snapshot",
  "figma_snapshot",
]);

export const importSourceStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "deleted",
]);

const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
const githubRepositorySchema = z.string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const figmaFileKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const figmaVersionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const importSourceUrlSchema = z.string().url().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "Import source URLs must use HTTP(S)");

export const importSourceDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    fileAssetId: opaqueIdSchema,
    originalName: fileNameSchema,
    mediaType: mediaTypeSchema,
  }).strict(),
  z.object({
    kind: z.literal("design_md"),
    fileAssetId: opaqueIdSchema,
    originalName: fileNameSchema,
    mediaType: mediaTypeSchema,
  }).strict(),
  z.object({
    kind: z.literal("url_snapshot"),
    sourceUrl: importSourceUrlSchema,
    resolvedUrl: importSourceUrlSchema.nullable(),
  }).strict(),
  z.object({
    kind: z.literal("github_snapshot"),
    repository: githubRepositorySchema,
    commitSha: gitCommitShaSchema,
  }).strict(),
  z.object({
    kind: z.literal("figma_snapshot"),
    fileKey: figmaFileKeySchema,
    versionId: figmaVersionIdSchema,
  }).strict(),
]);

export const importSourceFailureSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2_000),
}).strict();

export const importSourceSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  createdById: opaqueIdSchema,
  kind: importSourceKindSchema,
  status: importSourceStatusSchema,
  label: z.string().trim().min(1).max(240),
  descriptor: importSourceDescriptorSchema.nullable(),
  checksum: sha256Schema.nullable(),
  revision: revisionSchema,
  failure: importSourceFailureSchema.nullable(),
  deletedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((source, context) => {
  if (source.descriptor !== null && source.descriptor.kind !== source.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["descriptor", "kind"],
      message: "Import source kind must match its descriptor",
    });
  }
  if (source.status === "ready" && source.descriptor === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["descriptor"],
      message: "Ready import sources require a frozen descriptor",
    });
  }
  if (source.status === "ready" && source.checksum === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["checksum"],
      message: "Ready import sources require a content checksum",
    });
  }
  if ((source.status === "deleted") !== (source.deletedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deletedAt"],
      message: "Deleted import sources require deletedAt and no other status may set it",
    });
  }
  if ((source.status === "failed") !== (source.failure !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure"],
      message: "Failed import sources require a public failure",
    });
  }
});

const fileSourceRequest = z.object({
  kind: z.literal("file"),
  fileAssetId: opaqueIdSchema,
  label: z.string().trim().min(1).max(240).optional(),
}).strict();

const designMdSourceRequest = z.object({
  kind: z.literal("design_md"),
  fileAssetId: opaqueIdSchema,
  label: z.string().trim().min(1).max(240).optional(),
}).strict();

const urlSourceRequest = z.object({
  kind: z.literal("url_snapshot"),
  sourceUrl: importSourceUrlSchema,
  label: z.string().trim().min(1).max(240).optional(),
}).strict();

const githubSourceRequest = z.object({
  kind: z.literal("github_snapshot"),
  repository: githubRepositorySchema,
  /** A branch/tag is resolved by the Import Worker; callers cannot pin a fake SHA. */
  ref: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/),
  label: z.string().trim().min(1).max(240).optional(),
}).strict();

const figmaSourceRequest = z.object({
  kind: z.literal("figma_snapshot"),
  fileKey: figmaFileKeySchema,
  versionId: figmaVersionIdSchema.optional(),
  label: z.string().trim().min(1).max(240).optional(),
}).strict();

export const createImportSourceRequestSchema = z.discriminatedUnion("kind", [
  fileSourceRequest,
  designMdSourceRequest,
  urlSourceRequest,
  githubSourceRequest,
  figmaSourceRequest,
]);

export const importSourceListSchema = z.object({
  items: z.array(importSourceSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const importSourceBlobSchema = z.object({
  id: opaqueIdSchema,
  importSourceId: opaqueIdSchema,
  position: z.number().int().nonnegative().max(49),
  blobId: opaqueIdSchema,
  role: z.string().min(1).max(80),
  path: z.string().max(1_024).nullable(),
  mediaType: mediaTypeSchema,
  byteSize: safeIntegerSchema,
  sha256: sha256Schema,
}).strict();

export const runSourceSnapshotManifestSchema = z.object({
  protocol: z.literal("workbench.import-source-snapshot.v1"),
  sourceRevision: revisionSchema,
  checksum: sha256Schema,
  blobs: z.array(importSourceBlobSchema.omit({ id: true, importSourceId: true })).max(runSourceBlobLimit),
}).strict();

export const runSourceSnapshotSchema = z.object({
  id: opaqueIdSchema,
  runId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  position: z.number().int().nonnegative().max(49),
  sourceId: opaqueIdSchema,
  kind: importSourceKindSchema,
  label: z.string().trim().min(1).max(240),
  checksum: sha256Schema,
  descriptor: importSourceDescriptorSchema,
  snapshot: runSourceSnapshotManifestSchema,
  createdAt: isoDateTimeSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.descriptor.kind !== snapshot.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["descriptor", "kind"],
      message: "Run source snapshot kind must match its descriptor",
    });
  }
  if (snapshot.snapshot.checksum !== snapshot.checksum) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["snapshot", "checksum"],
      message: "Run source snapshot checksum must match its frozen manifest",
    });
  }
  const blobIds = new Set<string>();
  for (const [index, blob] of snapshot.snapshot.blobs.entries()) {
    if (blob.position !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "blobs", index, "position"],
        message: "Run source snapshot blobs must use contiguous positions",
      });
    }
    if (blobIds.has(blob.blobId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "blobs", index, "blobId"],
        message: "Run source snapshot blobs must be unique",
      });
    }
    blobIds.add(blob.blobId);
  }
});

export const runSourceIdsSchema = z.array(opaqueIdSchema).max(50).default([]).refine(
  (ids) => new Set(ids).size === ids.length,
  "sourceIds must be unique",
);

export type ImportSourceKind = z.infer<typeof importSourceKindSchema>;
export type ImportSourceStatus = z.infer<typeof importSourceStatusSchema>;
export type ImportSourceDescriptor = z.infer<typeof importSourceDescriptorSchema>;
export type ImportSource = z.infer<typeof importSourceSchema>;
export type CreateImportSourceRequest = z.infer<typeof createImportSourceRequestSchema>;
export type ImportSourceList = z.infer<typeof importSourceListSchema>;
export type ImportSourceBlob = z.infer<typeof importSourceBlobSchema>;
export type RunSourceSnapshot = z.infer<typeof runSourceSnapshotSchema>;
