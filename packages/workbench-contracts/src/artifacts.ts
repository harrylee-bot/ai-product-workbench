import { z } from "zod";
import { artifactCitationSchema } from "./citations.js";
import type { ArtifactCitation } from "./citations.js";
import { isoDateTimeSchema, jsonValueSchema, opaqueIdSchema } from "./common.js";
import type { JsonValue } from "./common.js";
import {
  designSystemDocumentSchema,
  publicDesignSystemDocumentSchema,
  type DesignSystemDocument,
  type PublicDesignSystemDocument,
} from "./design-systems.js";
import { prdDocumentSchema, type PrdDocument } from "./prd.js";
import {
  prototypeDocumentSchema,
  publicPrototypeDocumentSchema,
  type PrototypeDocument,
  type PublicPrototypeDocument,
} from "./prototype.js";

export const artifactKindSchema = z.enum([
  "prd",
  "prototype",
  "image",
  "code",
  "document",
  "data",
  "design_system",
]);

export const artifactVersionStatusSchema = z.enum(["staging", "ready", "rejected"]);

export const artifactVersionReferenceSchema = z.object({
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  version: z.number().int().positive(),
}).strict();

export const artifactVersionSchema = artifactVersionReferenceSchema.extend({
  kind: artifactKindSchema,
  schemaVersion: z.number().int().positive(),
  status: artifactVersionStatusSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  createdByRunId: opaqueIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
}).strict();

export const artifactSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  kind: artifactKindSchema,
  title: z.string().min(1).max(240),
  revision: z.number().int().nonnegative(),
  currentVersion: artifactVersionSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();

export const artifactListSchema = z.object({
  items: z.array(artifactSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const artifactVersionContentModeSchema = z.enum(["inline", "blob"]);

const artifactVersionDetailBaseShape = {
  ...artifactVersionReferenceSchema.shape,
  status: artifactVersionStatusSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  citations: z.array(artifactCitationSchema).max(1_000),
  createdByRunId: opaqueIdSchema.nullable(),
  knowledgeReleaseId: opaqueIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
};

const inlineDetailShape = {
  ...artifactVersionDetailBaseShape,
  contentMode: z.literal("inline"),
};

type ArtifactVersionDetailMetadata = ArtifactVersionReference & {
  status: z.infer<typeof artifactVersionStatusSchema>;
  checksum: string;
  citations: ArtifactCitation[];
  createdByRunId: string | null;
  knowledgeReleaseId: string | null;
  createdAt: string;
};

export type ArtifactVersionInlineDetail = ArtifactVersionDetailMetadata & { contentMode: "inline" } & (
  | { kind: "prd"; schemaVersion: 1; content: PrdDocument }
  | { kind: "prototype"; schemaVersion: 1; content: PrototypeDocument }
  | { kind: "design_system"; schemaVersion: 1; content: DesignSystemDocument }
  | { kind: "image" | "code" | "document" | "data"; schemaVersion: number; content: JsonValue }
);

export const artifactVersionInlineDetailSchema: z.ZodType<ArtifactVersionInlineDetail> = z.discriminatedUnion("kind", [
  z.object({ ...inlineDetailShape, kind: z.literal("prd"), schemaVersion: z.literal(1), content: prdDocumentSchema }).strict(),
  z.object({ ...inlineDetailShape, kind: z.literal("prototype"), schemaVersion: z.literal(1), content: prototypeDocumentSchema }).strict(),
  z.object({ ...inlineDetailShape, kind: z.literal("design_system"), schemaVersion: z.literal(1), content: designSystemDocumentSchema }).strict(),
  z.object({ ...inlineDetailShape, kind: z.literal("image"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...inlineDetailShape, kind: z.literal("code"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...inlineDetailShape, kind: z.literal("document"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...inlineDetailShape, kind: z.literal("data"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
]);

export const artifactContentBlobSchema = z.object({
  blobId: opaqueIdSchema,
  mediaType: z.string().min(1).max(255),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fileName: z.string().min(1).max(500).nullable(),
}).strict();

export type ArtifactContentBlob = {
  blobId: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  fileName: string | null;
};

export type ArtifactVersionBlobDetail = ArtifactVersionDetailMetadata & {
  kind: Exclude<z.infer<typeof artifactKindSchema>, "design_system">;
  schemaVersion: number;
  contentMode: "blob";
  blob: ArtifactContentBlob;
};

export const artifactVersionBlobDetailSchema: z.ZodType<ArtifactVersionBlobDetail> = z.object({
  ...artifactVersionDetailBaseShape,
  kind: artifactKindSchema.exclude(["design_system"]),
  schemaVersion: z.number().int().positive(),
  contentMode: z.literal("blob"),
  blob: artifactContentBlobSchema,
}).strict().superRefine((version, context) => {
  if ((version.kind === "prd" || version.kind === "prototype") && version.schemaVersion !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `${version.kind} schemaVersion must be 1`,
    });
  }
});

export type ArtifactVersionDetail = ArtifactVersionInlineDetail | ArtifactVersionBlobDetail;

export const artifactVersionDetailSchema: z.ZodType<ArtifactVersionDetail> = z.union([
  artifactVersionInlineDetailSchema,
  artifactVersionBlobDetailSchema,
]);

const publicArtifactVersionDetailBaseShape = {
  ...artifactVersionReferenceSchema.shape,
  status: z.literal("ready"),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  citations: z.array(artifactCitationSchema).max(1_000),
  createdAt: isoDateTimeSchema,
};

const publicInlineDetailShape = {
  ...publicArtifactVersionDetailBaseShape,
  contentMode: z.literal("inline"),
};

type PublicArtifactVersionDetailMetadata = ArtifactVersionReference & {
  status: "ready";
  checksum: string;
  citations: ArtifactCitation[];
  createdAt: string;
};

export type PublicArtifactVersionInlineDetail = PublicArtifactVersionDetailMetadata & { contentMode: "inline" } & (
  | { kind: "prd"; schemaVersion: 1; content: PrdDocument }
  | { kind: "prototype"; schemaVersion: 1; content: PublicPrototypeDocument }
  | { kind: "design_system"; schemaVersion: 1; content: PublicDesignSystemDocument }
  | { kind: "image" | "code" | "document" | "data"; schemaVersion: number; content: JsonValue }
);

export const publicArtifactVersionInlineDetailSchema: z.ZodType<PublicArtifactVersionInlineDetail> = z.discriminatedUnion("kind", [
  z.object({ ...publicInlineDetailShape, kind: z.literal("prd"), schemaVersion: z.literal(1), content: prdDocumentSchema }).strict(),
  z.object({ ...publicInlineDetailShape, kind: z.literal("prototype"), schemaVersion: z.literal(1), content: publicPrototypeDocumentSchema }).strict(),
  z.object({ ...publicInlineDetailShape, kind: z.literal("design_system"), schemaVersion: z.literal(1), content: publicDesignSystemDocumentSchema }).strict(),
  z.object({ ...publicInlineDetailShape, kind: z.literal("image"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...publicInlineDetailShape, kind: z.literal("code"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...publicInlineDetailShape, kind: z.literal("document"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
  z.object({ ...publicInlineDetailShape, kind: z.literal("data"), schemaVersion: z.number().int().positive(), content: jsonValueSchema }).strict(),
]);

export const publicArtifactContentBlobSchema = artifactContentBlobSchema.omit({ blobId: true });
export type PublicArtifactContentBlob = z.infer<typeof publicArtifactContentBlobSchema>;

export type PublicArtifactVersionBlobDetail = PublicArtifactVersionDetailMetadata & {
  kind: Exclude<z.infer<typeof artifactKindSchema>, "design_system">;
  schemaVersion: number;
  contentMode: "blob";
  blob: PublicArtifactContentBlob;
};

export const publicArtifactVersionBlobDetailSchema: z.ZodType<PublicArtifactVersionBlobDetail> = z.object({
  ...publicArtifactVersionDetailBaseShape,
  kind: artifactKindSchema.exclude(["design_system"]),
  schemaVersion: z.number().int().positive(),
  contentMode: z.literal("blob"),
  blob: publicArtifactContentBlobSchema,
}).strict().superRefine((version, context) => {
  if ((version.kind === "prd" || version.kind === "prototype") && version.schemaVersion !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `${version.kind} schemaVersion must be 1`,
    });
  }
});

export type PublicArtifactVersionDetail = PublicArtifactVersionInlineDetail | PublicArtifactVersionBlobDetail;

export const publicArtifactVersionDetailSchema: z.ZodType<PublicArtifactVersionDetail> = z.union([
  publicArtifactVersionInlineDetailSchema,
  publicArtifactVersionBlobDetailSchema,
]);

export const artifactVersionListItemSchema = artifactVersionSchema.extend({
  contentMode: artifactVersionContentModeSchema,
}).strict().superRefine((version, context) => {
  if (["prd", "prototype", "design_system"].includes(version.kind) && version.schemaVersion !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `${version.kind} schemaVersion must be 1`,
    });
  }
  if (version.kind === "design_system" && version.contentMode !== "inline") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contentMode"],
      message: "design_system versions must use inline content",
    });
  }
});

export const artifactVersionListSchema = z.object({
  items: z.array(artifactVersionListItemSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const artifactVersionReactionSchema = z.enum(["like", "dislike"]);

export const artifactVersionPreferenceSchema = z.object({
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  screenId: opaqueIdSchema.nullable(),
  favorite: z.boolean(),
  reaction: artifactVersionReactionSchema.nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
}).strict().superRefine((preference, context) => {
  const invalidVirtualDefault = preference.revision === 0
    && (preference.createdAt !== null || preference.updatedAt !== null);
  const invalidPersistedPreference = preference.revision > 0
    && (preference.createdAt === null || preference.updatedAt === null);
  if (invalidVirtualDefault || invalidPersistedPreference) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only the virtual revision 0 preference may omit persistence timestamps",
    });
  }
});

export const updateArtifactVersionPreferenceRequestSchema = z.object({
  favorite: z.boolean(),
  reaction: artifactVersionReactionSchema.nullable(),
}).strict();

export const artifactVersionPreferenceTargetQuerySchema = z.object({
  screenId: opaqueIdSchema.optional(),
}).strict();

export const artifactVersionFavoriteListItemSchema = z.object({
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  artifactKind: artifactKindSchema,
  artifactTitle: z.string().min(1).max(240),
  artifactVersion: z.number().int().positive(),
  screenId: opaqueIdSchema.nullable(),
  screenName: z.string().min(1).max(240).nullable(),
  updatedAt: isoDateTimeSchema,
}).strict().superRefine((item, context) => {
  const hasScreen = item.screenId !== null && item.screenName !== null;
  if ((item.artifactKind === "prototype") !== hasScreen) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Prototype favourites require one screen and non-Prototype favourites cannot name a screen",
    });
  }
});

export const artifactVersionFavoriteListSchema = z.object({
  items: z.array(artifactVersionFavoriteListItemSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export type CreateArtifactVersionRequest =
  | { kind: "prd"; baseArtifactVersionId: string; document: PrdDocument }
  | { kind: "prototype"; baseArtifactVersionId: string; document: PrototypeDocument };

export const createPrdArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prd"),
  document: prdDocumentSchema,
}).strict();

export const createPrototypeArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prototype"),
  document: prototypeDocumentSchema,
}).strict();

const createArtifactVersionRequestDiscriminatedSchema = z.discriminatedUnion("kind", [
  createPrdArtifactVersionRequestSchema,
  createPrototypeArtifactVersionRequestSchema,
]);

export const createArtifactVersionRequestSchema =
  createArtifactVersionRequestDiscriminatedSchema as z.ZodType<CreateArtifactVersionRequest>;

export const createImageArtifactRequestSchema = z.object({
  kind: z.literal("image"),
  title: z.string().trim().min(1).max(240),
  source: z.object({
    kind: z.literal("file"),
    fileAssetId: opaqueIdSchema,
  }).strict(),
}).strict();

export const createArtifactRequestSchema = z.discriminatedUnion("kind", [
  createImageArtifactRequestSchema,
]);

export const createdImageArtifactSchema = artifactSchema.extend({
  kind: z.literal("image"),
  currentVersion: artifactVersionSchema.extend({
    kind: z.literal("image"),
    schemaVersion: z.literal(1),
    status: z.literal("ready"),
  }).strict(),
}).strict();

export const createdImageArtifactVersionDetailSchema = z.object({
  ...artifactVersionDetailBaseShape,
  status: z.literal("ready"),
  kind: z.literal("image"),
  schemaVersion: z.literal(1),
  contentMode: z.literal("blob"),
  blob: artifactContentBlobSchema,
}).strict();

export const artifactCreationSchema = z.object({
  artifact: createdImageArtifactSchema,
  artifactVersion: createdImageArtifactVersionDetailSchema,
}).strict().superRefine((creation, context) => {
  const current = creation.artifact.currentVersion;
  const version = creation.artifactVersion;
  if (
    creation.artifact.kind !== "image"
    || version.kind !== "image"
    || version.contentMode !== "blob"
    || version.schemaVersion !== 1
    || version.status !== "ready"
    || version.artifactId !== creation.artifact.id
    || current === null
    || current.artifactId !== creation.artifact.id
    || current.artifactVersionId !== version.artifactVersionId
    || current.version !== version.version
    || current.kind !== version.kind
    || current.schemaVersion !== version.schemaVersion
    || current.status !== version.status
    || current.checksum !== version.checksum
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Artifact creation must return one ready blob-backed image and its matching current version",
    });
  }
});

export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactList = z.infer<typeof artifactListSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type ArtifactVersionReference = z.infer<typeof artifactVersionReferenceSchema>;
export type ArtifactVersionContentMode = z.infer<typeof artifactVersionContentModeSchema>;
export type ArtifactVersionListItem = z.infer<typeof artifactVersionListItemSchema>;
export type ArtifactVersionList = z.infer<typeof artifactVersionListSchema>;
export type ArtifactVersionReaction = z.infer<typeof artifactVersionReactionSchema>;
export type ArtifactVersionPreference = z.infer<typeof artifactVersionPreferenceSchema>;
export type ArtifactVersionPreferenceTargetQuery = z.infer<typeof artifactVersionPreferenceTargetQuerySchema>;
export type ArtifactVersionFavoriteListItem = z.infer<typeof artifactVersionFavoriteListItemSchema>;
export type ArtifactVersionFavoriteList = z.infer<typeof artifactVersionFavoriteListSchema>;
export type UpdateArtifactVersionPreferenceRequest = z.infer<typeof updateArtifactVersionPreferenceRequestSchema>;
export type ArtifactCreation = z.infer<typeof artifactCreationSchema>;
export type CreateArtifactRequest = z.infer<typeof createArtifactRequestSchema>;
