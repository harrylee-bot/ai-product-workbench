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
import {
  prdDocumentV1Schema,
  prdDocumentV2Schema,
  prdDocumentV3Schema,
  type PrdDocumentV1,
  type PrdDocumentV2,
  type PrdDocumentV3,
} from "./prd.js";
import {
  prototypeDocumentSchema,
  publicPrototypeDocumentSchema,
  type PrototypeDocument,
  type PublicPrototypeDocument,
} from "./prototype.js";

import {
  sourcePrototypeInputSchema,
  sourcePrototypeDocumentSchema,
  publicSourcePrototypeDocumentSchema,
  type SourcePrototypeInput,
  type SourcePrototypeDocument,
  type PublicSourcePrototypeDocument,
} from "./source-prototype.js";

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
  sourcePrdVersionId: opaqueIdSchema.nullable().optional(),
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
  sourcePrdVersionId?: string | null;
  createdAt: string;
};

type ArtifactVersionInlineDetailBase = ArtifactVersionDetailMetadata & { contentMode: "inline" };

export type ArtifactVersionInlineLegacyDetail = ArtifactVersionInlineDetailBase & (
  | { kind: "prd"; schemaVersion: 1; content: PrdDocumentV1 }
  | { kind: "prototype"; schemaVersion: 1; content: PrototypeDocument }
  | { kind: "design_system"; schemaVersion: 1; content: DesignSystemDocument }
  | { kind: "image" | "code" | "document" | "data"; schemaVersion: number; content: JsonValue }
);

export type ArtifactVersionInlineDetail = ArtifactVersionInlineLegacyDetail
  | ArtifactVersionInlineDetailBase & { kind: "prd"; schemaVersion: 2; content: PrdDocumentV2 }
  | ArtifactVersionInlineDetailBase & { kind: "prd"; schemaVersion: 3; content: PrdDocumentV3 }
  | ArtifactVersionInlineDetailBase & { kind: "prototype"; schemaVersion: 2; content: SourcePrototypeDocument };

export const artifactVersionInlinePrdDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(1),
  content: prdDocumentV1Schema,
}).strict();

export const artifactVersionInlinePrdV2DetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(2),
  content: prdDocumentV2Schema,
}).strict();

export const artifactVersionInlinePrdV3DetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(3),
  content: prdDocumentV3Schema,
}).strict();

export const artifactVersionInlinePrototypeDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("prototype"),
  schemaVersion: z.literal(1),
  content: prototypeDocumentSchema,
}).strict();

export const artifactVersionInlineSourcePrototypeDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("prototype"),
  schemaVersion: z.literal(2),
  content: sourcePrototypeDocumentSchema,
}).strict();

export const artifactVersionInlineDesignSystemDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("design_system"),
  schemaVersion: z.literal(1),
  content: designSystemDocumentSchema,
}).strict();

export const artifactVersionInlineImageDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("image"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const artifactVersionInlineCodeDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("code"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const artifactVersionInlineDocumentDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("document"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const artifactVersionInlineDataDetailSchema = z.object({
  ...inlineDetailShape,
  kind: z.literal("data"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const artifactVersionInlineLegacyDetailSchema: z.ZodType<ArtifactVersionInlineLegacyDetail> = z.discriminatedUnion("kind", [
  artifactVersionInlinePrdDetailSchema,
  artifactVersionInlinePrototypeDetailSchema,
  artifactVersionInlineDesignSystemDetailSchema,
  artifactVersionInlineImageDetailSchema,
  artifactVersionInlineCodeDetailSchema,
  artifactVersionInlineDocumentDetailSchema,
  artifactVersionInlineDataDetailSchema,
]);

export const artifactVersionInlineDetailSchema: z.ZodType<ArtifactVersionInlineDetail, unknown> = z.union([
  artifactVersionInlineLegacyDetailSchema,
  artifactVersionInlinePrdV2DetailSchema,
  artifactVersionInlinePrdV3DetailSchema,
  artifactVersionInlineSourcePrototypeDetailSchema,
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
  if (
    (version.kind === "prototype" && version.schemaVersion !== 1)
    || (version.kind === "prd" && version.schemaVersion !== 1 && version.schemaVersion !== 2 && version.schemaVersion !== 3)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `${version.kind} schemaVersion is unsupported`,
    });
  }
});

export type ArtifactVersionDetail = ArtifactVersionInlineDetail | ArtifactVersionBlobDetail;

export const artifactVersionDetailSchema: z.ZodType<ArtifactVersionDetail, unknown> = z.union([
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

type PublicArtifactVersionInlineDetailBase = PublicArtifactVersionDetailMetadata & { contentMode: "inline" };

export type PublicArtifactVersionInlineLegacyDetail = PublicArtifactVersionInlineDetailBase & (
  | { kind: "prd"; schemaVersion: 1; content: PrdDocumentV1 }
  | { kind: "prototype"; schemaVersion: 1; content: PublicPrototypeDocument }
  | { kind: "design_system"; schemaVersion: 1; content: PublicDesignSystemDocument }
  | { kind: "image" | "code" | "document" | "data"; schemaVersion: number; content: JsonValue }
);

export type PublicArtifactVersionInlineDetail = PublicArtifactVersionInlineLegacyDetail
  | PublicArtifactVersionInlineDetailBase & { kind: "prd"; schemaVersion: 2; content: PrdDocumentV2 }
  | PublicArtifactVersionInlineDetailBase & { kind: "prd"; schemaVersion: 3; content: PrdDocumentV3 }
  | PublicArtifactVersionInlineDetailBase & { kind: "prototype"; schemaVersion: 2; content: PublicSourcePrototypeDocument };

export const publicArtifactVersionInlinePrdDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(1),
  content: prdDocumentV1Schema,
}).strict();

export const publicArtifactVersionInlinePrdV2DetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(2),
  content: prdDocumentV2Schema,
}).strict();

export const publicArtifactVersionInlinePrdV3DetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("prd"),
  schemaVersion: z.literal(3),
  content: prdDocumentV3Schema,
}).strict();

export const publicArtifactVersionInlinePrototypeDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("prototype"),
  schemaVersion: z.literal(1),
  content: publicPrototypeDocumentSchema,
}).strict();

export const publicArtifactVersionInlineSourcePrototypeDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("prototype"),
  schemaVersion: z.literal(2),
  content: publicSourcePrototypeDocumentSchema,
}).strict();

export const publicArtifactVersionInlineDesignSystemDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("design_system"),
  schemaVersion: z.literal(1),
  content: publicDesignSystemDocumentSchema,
}).strict();

export const publicArtifactVersionInlineImageDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("image"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const publicArtifactVersionInlineCodeDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("code"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const publicArtifactVersionInlineDocumentDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("document"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const publicArtifactVersionInlineDataDetailSchema = z.object({
  ...publicInlineDetailShape,
  kind: z.literal("data"),
  schemaVersion: z.number().int().positive(),
  content: jsonValueSchema,
}).strict();

export const publicArtifactVersionInlineLegacyDetailSchema: z.ZodType<PublicArtifactVersionInlineLegacyDetail> = z.discriminatedUnion("kind", [
  publicArtifactVersionInlinePrdDetailSchema,
  publicArtifactVersionInlinePrototypeDetailSchema,
  publicArtifactVersionInlineDesignSystemDetailSchema,
  publicArtifactVersionInlineImageDetailSchema,
  publicArtifactVersionInlineCodeDetailSchema,
  publicArtifactVersionInlineDocumentDetailSchema,
  publicArtifactVersionInlineDataDetailSchema,
]);

export const publicArtifactVersionInlineDetailSchema: z.ZodType<PublicArtifactVersionInlineDetail, unknown> = z.union([
  publicArtifactVersionInlineLegacyDetailSchema,
  publicArtifactVersionInlinePrdV2DetailSchema,
  publicArtifactVersionInlinePrdV3DetailSchema,
  publicArtifactVersionInlineSourcePrototypeDetailSchema,
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
  if (
    (version.kind === "prototype" && version.schemaVersion !== 1)
    || (version.kind === "prd" && version.schemaVersion !== 1 && version.schemaVersion !== 2 && version.schemaVersion !== 3)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `${version.kind} schemaVersion is unsupported`,
    });
  }
});

export type PublicArtifactVersionDetail = PublicArtifactVersionInlineDetail | PublicArtifactVersionBlobDetail;

export const publicArtifactVersionDetailSchema: z.ZodType<PublicArtifactVersionDetail, unknown> = z.union([
  publicArtifactVersionInlineDetailSchema,
  publicArtifactVersionBlobDetailSchema,
]);

export const artifactVersionListItemSchema = artifactVersionSchema.extend({
  contentMode: artifactVersionContentModeSchema,
}).strict().superRefine((version, context) => {
  if (
    (version.kind === "prototype" && version.schemaVersion !== 1 && !(version.schemaVersion === 2 && version.contentMode === "inline"))
    || (version.kind === "design_system" && version.schemaVersion !== 1)
    || (version.kind === "prd" && version.schemaVersion !== 1 && version.schemaVersion !== 2 && version.schemaVersion !== 3)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schemaVersion"],
      message: `${version.kind} schemaVersion is unsupported`,
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
  | { kind: "prd"; baseArtifactVersionId: string; document: PrdDocumentV1 }
  | { kind: "prd"; baseArtifactVersionId: string; document: PrdDocumentV2 }
  | { kind: "prd"; baseArtifactVersionId: string; document: PrdDocumentV3 }
  | { kind: "prototype"; baseArtifactVersionId: string; document: PrototypeDocument }
  | { kind: "prototype"; baseArtifactVersionId: string; document: SourcePrototypeInput };

type CreateArtifactVersionLegacyRequest =
  | { kind: "prd"; baseArtifactVersionId: string; document: PrdDocumentV1 }
  | { kind: "prototype"; baseArtifactVersionId: string; document: PrototypeDocument };

export const createPrdArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prd"),
  document: prdDocumentV1Schema,
}).strict();

export const createPrdV2ArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prd"),
  document: prdDocumentV2Schema,
}).strict();

export const createPrdV3ArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prd"),
  document: prdDocumentV3Schema,
}).strict();

export const createPrototypeArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prototype"),
  document: prototypeDocumentSchema,
}).strict();

export const createSourcePrototypeArtifactVersionRequestSchema = z.object({
  baseArtifactVersionId: opaqueIdSchema,
  kind: z.literal("prototype"),
  document: sourcePrototypeInputSchema,
}).strict();

export const createArtifactVersionRequestLegacySchema: z.ZodType<CreateArtifactVersionLegacyRequest> = z.discriminatedUnion("kind", [
  createPrdArtifactVersionRequestSchema,
  createPrototypeArtifactVersionRequestSchema,
]);

export const createArtifactVersionRequestSchema: z.ZodType<CreateArtifactVersionRequest, unknown> = z.union([
  createArtifactVersionRequestLegacySchema,
  createPrdV2ArtifactVersionRequestSchema,
  createPrdV3ArtifactVersionRequestSchema,
  createSourcePrototypeArtifactVersionRequestSchema,
]);

export const createImageArtifactRequestSchema = z.object({
  kind: z.literal("image"),
  title: z.string().trim().min(1).max(240),
  source: z.object({
    kind: z.literal("file"),
    fileAssetId: opaqueIdSchema,
  }).strict(),
}).strict();

export const createSourcePrototypeArtifactRequestSchema = z.object({
  kind: z.literal("prototype"),
  title: z.string().trim().min(1).max(240),
  document: sourcePrototypeInputSchema,
}).strict().superRefine((request, context) => {
  if (request.title !== request.document.title) context.addIssue({ code: "custom", path: ["title"], message: "Artifact and source prototype titles must match" });
});

export const createArtifactRequestSchema = z.union([
  createImageArtifactRequestSchema,
  createSourcePrototypeArtifactRequestSchema,
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

export const createdSourcePrototypeArtifactSchema = artifactSchema.extend({
  kind: z.literal("prototype"),
  currentVersion: artifactVersionSchema.extend({
    kind: z.literal("prototype"), schemaVersion: z.literal(2), status: z.literal("ready"),
  }).strict(),
}).strict();

export const createdSourcePrototypeArtifactVersionDetailSchema = artifactVersionInlineSourcePrototypeDetailSchema.extend({ status: z.literal("ready") });

export const artifactCreationSchema = z.union([
  z.object({ artifact: createdImageArtifactSchema, artifactVersion: createdImageArtifactVersionDetailSchema }).strict(),
  z.object({ artifact: createdSourcePrototypeArtifactSchema, artifactVersion: createdSourcePrototypeArtifactVersionDetailSchema }).strict(),
]).superRefine((creation, context) => {
  const current = creation.artifact.currentVersion;
  const version = creation.artifactVersion;
  if (
    creation.artifact.kind !== version.kind
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
      message: "Artifact creation must return one ready artifact and its matching current version",
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
