import { z } from "zod";
import { artifactIrIdSchema } from "./citations.js";
import { isoDateTimeSchema, jsonValueSchema, opaqueIdSchema, type JsonValue } from "./common.js";
import {
  runtimePresetDesignStyleSnapshotSchema,
  type RuntimePresetDesignStyleSnapshot,
} from "./design-presets.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const tokenPathSchema = z.string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/);
const colorSchema = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);
const dimensionSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:px|rem|em|%|vh|vw)$/);
const shadowLiteralSchema = z.object({
  color: colorSchema,
  offsetX: z.number().finite(),
  offsetY: z.number().finite(),
  blur: z.number().finite().nonnegative(),
  spread: z.number().finite(),
}).strict();

export const designSystemTokenTypeSchema = z.enum([
  "color",
  "number",
  "dimension",
  "fontFamily",
  "fontWeight",
  "duration",
  "string",
  "boolean",
  "shadow",
]);

export const designSystemTokenLiteralSchema = z.object({
  kind: z.literal("literal"),
  value: jsonValueSchema,
}).strict();

export const designSystemTokenAliasSchema = z.object({
  kind: z.literal("alias"),
  path: tokenPathSchema,
}).strict();

export const designSystemTokenSchema = z.object({
  id: artifactIrIdSchema,
  path: tokenPathSchema,
  type: designSystemTokenTypeSchema,
  value: z.union([designSystemTokenLiteralSchema, designSystemTokenAliasSchema]),
  description: z.string().min(1).max(1_000).nullable(),
}).strict();

const designSystemAssetBaseShape = {
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  blobId: opaqueIdSchema,
  mediaType: z.string().min(1).max(255),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
};

export const designSystemImageAssetSchema = z.object({
  ...designSystemAssetBaseShape,
  kind: z.literal("image"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const designSystemFontAssetSchema = z.object({
  ...designSystemAssetBaseShape,
  kind: z.literal("font"),
  family: z.string().min(1).max(240),
  weight: z.number().int().min(100).max(900),
  style: z.enum(["normal", "italic"]),
}).strict();

export const designSystemAssetSchema = z.discriminatedUnion("kind", [
  designSystemImageAssetSchema,
  designSystemFontAssetSchema,
]);

export const publicDesignSystemImageAssetSchema = designSystemImageAssetSchema.omit({ blobId: true });
export const publicDesignSystemFontAssetSchema = designSystemFontAssetSchema.omit({ blobId: true });
export const publicDesignSystemAssetSchema = z.discriminatedUnion("kind", [
  publicDesignSystemImageAssetSchema,
  publicDesignSystemFontAssetSchema,
]);

export const designSystemPrincipleSchema = z.object({
  id: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  description: z.string().min(1).max(4_000),
}).strict();

export const designSystemGuidelineSchema = z.object({
  id: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  description: z.string().min(1).max(4_000),
  principleIds: z.array(artifactIrIdSchema).max(100),
  tokenPaths: z.array(tokenPathSchema).max(500),
  componentIds: z.array(artifactIrIdSchema).max(500),
}).strict();

export const designSystemComponentVariantSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  description: z.string().min(1).max(2_000).nullable(),
  tokenPaths: z.array(tokenPathSchema).max(500),
  assetIds: z.array(artifactIrIdSchema).max(100),
}).strict();

export const designSystemComponentStateSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  description: z.string().min(1).max(2_000).nullable(),
  tokenPaths: z.array(tokenPathSchema).max(500),
  assetIds: z.array(artifactIrIdSchema).max(100),
}).strict();

export const designSystemComponentUsageSchema = z.object({
  summary: z.string().min(1).max(4_000),
  do: z.array(z.string().min(1).max(1_000)).max(100),
  dont: z.array(z.string().min(1).max(1_000)).max(100),
}).strict();

export const designSystemComponentSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  description: z.string().min(1).max(4_000),
  usage: designSystemComponentUsageSchema,
  tokenPaths: z.array(tokenPathSchema).max(1_000),
  assetIds: z.array(artifactIrIdSchema).max(500),
  variants: z.array(designSystemComponentVariantSchema).max(500),
  states: z.array(designSystemComponentStateSchema).max(500),
}).strict();

const designSystemDocumentShape = {
  protocol: z.literal("workbench.design-system.v1"),
  documentId: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  tokens: z.array(designSystemTokenSchema).max(5_000),
  assets: z.array(designSystemAssetSchema).max(2_000),
  principles: z.array(designSystemPrincipleSchema).max(500),
  guidelines: z.array(designSystemGuidelineSchema).max(2_000),
  components: z.array(designSystemComponentSchema).max(2_000),
} as const;

export const designSystemDocumentSchema = z.object(designSystemDocumentShape).strict()
  .superRefine((document, context) => validateDesignSystemDocument(document, context));

export const publicDesignSystemDocumentSchema = z.object({
  ...designSystemDocumentShape,
  assets: z.array(publicDesignSystemAssetSchema).max(2_000),
}).strict().superRefine((document, context) => validateDesignSystemDocument(document, context));

export const createDesignSystemRequestSchema = z.object({
  title: z.string().trim().min(1).max(240),
  document: designSystemDocumentSchema,
}).strict();

export const designSystemCreationSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  checksum: sha256Schema,
  createdById: opaqueIdSchema,
  idempotencyKey: z.string().min(8).max(128),
  requestHash: sha256Schema,
  createdAt: isoDateTimeSchema,
}).strict();

export const designSystemCatalogItemSchema = z.object({
  projectId: opaqueIdSchema,
  projectTitle: z.string().min(1).max(240),
  artifactId: opaqueIdSchema,
  artifactTitle: z.string().min(1).max(240),
  artifactVersionId: opaqueIdSchema,
  version: z.number().int().positive(),
  checksum: sha256Schema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();

export const designSystemCatalogSchema = z.object({
  items: z.array(designSystemCatalogItemSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export const importDesignSystemRequestSchema = z.object({
  sourceArtifactVersionId: opaqueIdSchema,
}).strict();

export const designSystemImportSchema = z.object({
  id: opaqueIdSchema,
  targetProjectId: opaqueIdSchema,
  targetArtifactId: opaqueIdSchema,
  targetArtifactVersionId: opaqueIdSchema,
  sourceProjectId: opaqueIdSchema,
  sourceArtifactId: opaqueIdSchema,
  sourceArtifactVersionId: opaqueIdSchema,
  sourceChecksum: sha256Schema,
  createdById: opaqueIdSchema,
  idempotencyKey: z.string().min(8).max(128),
  requestHash: sha256Schema,
  createdAt: isoDateTimeSchema,
}).strict();

export const runtimeDesignTokenSchema = z.object({
  id: artifactIrIdSchema,
  path: tokenPathSchema,
  type: designSystemTokenTypeSchema,
  value: jsonValueSchema,
  description: z.string().min(1).max(1_000).nullable(),
}).strict();

export const runtimeDesignAssetSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  kind: z.enum(["image", "font"]),
  artifactVersionId: opaqueIdSchema,
  blobId: opaqueIdSchema,
  mediaType: z.string().min(1).max(255),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
}).strict();

export const runtimeDesignStyleSnapshotSchema = z.object({
  protocol: z.literal("workbench.runtime.design-style.v1"),
  source: z.object({
    projectId: opaqueIdSchema,
    artifactId: opaqueIdSchema,
    artifactVersionId: opaqueIdSchema,
    checksum: sha256Schema,
  }).strict(),
  documentId: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  tokens: z.array(runtimeDesignTokenSchema).max(5_000),
  assets: z.array(runtimeDesignAssetSchema).max(2_000),
  principles: z.array(designSystemPrincipleSchema).max(500),
  guidelines: z.array(designSystemGuidelineSchema).max(2_000),
  components: z.array(designSystemComponentSchema).max(2_000),
}).strict();

export const runtimeMaterializedDesignStyleSnapshotSchema = z.discriminatedUnion("protocol", [
  runtimeDesignStyleSnapshotSchema,
  runtimePresetDesignStyleSnapshotSchema,
]);

export type DesignSystemDocument = z.infer<typeof designSystemDocumentSchema>;
export type PublicDesignSystemDocument = z.infer<typeof publicDesignSystemDocumentSchema>;
export type DesignSystemImport = z.infer<typeof designSystemImportSchema>;
export type ImportDesignSystemRequest = z.infer<typeof importDesignSystemRequestSchema>;
export type CreateDesignSystemRequest = z.infer<typeof createDesignSystemRequestSchema>;
export type DesignSystemCreation = z.infer<typeof designSystemCreationSchema>;
export type DesignSystemCatalogItem = z.infer<typeof designSystemCatalogItemSchema>;
export type DesignSystemCatalog = z.infer<typeof designSystemCatalogSchema>;
export type RuntimeDesignStyleSnapshot = z.infer<typeof runtimeDesignStyleSnapshotSchema>;
export type RuntimeMaterializedDesignStyleSnapshot =
  | RuntimeDesignStyleSnapshot
  | RuntimePresetDesignStyleSnapshot;

export type DesignSystemAssetPin = Readonly<{
  assetId: string;
  kind: string;
  blobId: string;
  mediaType: string;
  byteSize: number | bigint;
  sha256: string;
}>;

export function materializeRuntimeDesignStyleSnapshot(input: Readonly<{
  projectId: string;
  artifactId: string;
  artifactVersionId: string;
  checksum: string;
  document: unknown;
  assetPins: readonly DesignSystemAssetPin[];
}>): RuntimeDesignStyleSnapshot {
  const document = designSystemDocumentSchema.parse(input.document);
  const pins = new Map(input.assetPins.map((pin) => [pin.assetId, pin]));
  if (pins.size !== input.assetPins.length || pins.size !== document.assets.length) {
    throw new Error("DESIGN_SYSTEM_ASSET_PIN_MISMATCH");
  }

  const assets = document.assets.map((asset) => {
    const pin = pins.get(asset.id);
    const byteSize = pin && typeof pin.byteSize === "bigint" ? Number(pin.byteSize) : pin?.byteSize;
    if (
      !pin
      || pin.kind !== asset.kind
      || pin.blobId !== asset.blobId
      || pin.mediaType !== asset.mediaType
      || byteSize !== asset.byteSize
      || pin.sha256 !== asset.sha256
    ) {
      throw new Error("DESIGN_SYSTEM_ASSET_PIN_MISMATCH");
    }
    return {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      artifactVersionId: input.artifactVersionId,
      blobId: asset.blobId,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
    };
  });

  const byPath = new Map(document.tokens.map((token) => [token.path, token]));
  const resolved = new Map<string, JsonValue>();
  const visiting = new Set<string>();
  const resolve = (path: string): JsonValue => {
    const existing = resolved.get(path);
    if (existing !== undefined) return existing;
    if (visiting.has(path)) throw new Error("DESIGN_SYSTEM_TOKEN_ALIAS_CYCLE");
    const token = byPath.get(path);
    if (!token) throw new Error("DESIGN_SYSTEM_TOKEN_ALIAS_MISSING");
    visiting.add(path);
    const value = token.value.kind === "literal" ? token.value.value : resolve(token.value.path);
    visiting.delete(path);
    resolved.set(path, value);
    return value;
  };

  return runtimeDesignStyleSnapshotSchema.parse({
    protocol: "workbench.runtime.design-style.v1",
    source: {
      projectId: input.projectId,
      artifactId: input.artifactId,
      artifactVersionId: input.artifactVersionId,
      checksum: input.checksum,
    },
    documentId: document.documentId,
    title: document.title,
    tokens: document.tokens.map((token) => ({
      id: token.id,
      path: token.path,
      type: token.type,
      value: resolve(token.path),
      description: token.description,
    })),
    assets,
    principles: document.principles,
    guidelines: document.guidelines,
    components: document.components,
  });
}

function validateDesignSystemDocument(
  document: Readonly<{
    documentId: string;
    tokens: readonly z.infer<typeof designSystemTokenSchema>[];
    assets: readonly { id: string }[];
    principles: readonly z.infer<typeof designSystemPrincipleSchema>[];
    guidelines: readonly z.infer<typeof designSystemGuidelineSchema>[];
    components: readonly z.infer<typeof designSystemComponentSchema>[];
  }>,
  context: z.RefinementCtx,
) {
  const tokenByPath = new Map(document.tokens.map((token) => [token.path, token]));
  const assetIds = new Set(document.assets.map((asset) => asset.id));
  const principleIds = new Set(document.principles.map((principle) => principle.id));
  const componentIds = new Set(document.components.map((component) => component.id));
  const ids = [
    document.documentId,
    ...document.tokens.map((token) => token.id),
    ...document.assets.map((asset) => asset.id),
    ...document.principles.map((principle) => principle.id),
    ...document.guidelines.map((guideline) => guideline.id),
    ...document.components.flatMap((component) => [
      component.id,
      ...component.variants.map((variant) => variant.id),
      ...component.states.map((state) => state.id),
    ]),
  ];
  addDuplicateIssues(ids, context, [], "Design System ids must be globally unique");
  addDuplicateIssues(document.tokens.map((token) => token.path), context, ["tokens"], "Token paths must be unique");

  for (const [index, token] of document.tokens.entries()) {
    if (token.value.kind === "literal" && !literalMatchesType(token.type, token.value.value)) {
      addIssue(context, ["tokens", index, "value"], `Literal does not match token type ${token.type}`);
    }
    if (token.value.kind === "alias") {
      const target = tokenByPath.get(token.value.path);
      if (!target) addIssue(context, ["tokens", index, "value", "path"], `Unknown token path: ${token.value.path}`);
      else if (target.type !== token.type) addIssue(context, ["tokens", index, "value", "path"], "Token aliases must preserve token type");
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (path: string) => {
    if (visiting.has(path)) {
      addIssue(context, ["tokens"], `Token aliases contain a cycle at ${path}`);
      return;
    }
    if (visited.has(path)) return;
    const token = tokenByPath.get(path);
    if (!token) return;
    visiting.add(path);
    if (token.value.kind === "alias") visit(token.value.path);
    visiting.delete(path);
    visited.add(path);
  };
  document.tokens.forEach((token) => visit(token.path));

  for (const [index, guideline] of document.guidelines.entries()) {
    validateReferences(guideline.principleIds, principleIds, context, ["guidelines", index, "principleIds"], "principle");
    validateReferences(guideline.tokenPaths, new Set(tokenByPath.keys()), context, ["guidelines", index, "tokenPaths"], "token path");
    validateReferences(guideline.componentIds, componentIds, context, ["guidelines", index, "componentIds"], "component");
  }
  for (const [componentIndex, component] of document.components.entries()) {
    validateReferences(component.tokenPaths, new Set(tokenByPath.keys()), context, ["components", componentIndex, "tokenPaths"], "token path");
    validateReferences(component.assetIds, assetIds, context, ["components", componentIndex, "assetIds"], "asset");
    for (const [variantIndex, variant] of component.variants.entries()) {
      validateReferences(variant.tokenPaths, new Set(tokenByPath.keys()), context, ["components", componentIndex, "variants", variantIndex, "tokenPaths"], "token path");
      validateReferences(variant.assetIds, assetIds, context, ["components", componentIndex, "variants", variantIndex, "assetIds"], "asset");
    }
    for (const [stateIndex, state] of component.states.entries()) {
      validateReferences(state.tokenPaths, new Set(tokenByPath.keys()), context, ["components", componentIndex, "states", stateIndex, "tokenPaths"], "token path");
      validateReferences(state.assetIds, assetIds, context, ["components", componentIndex, "states", stateIndex, "assetIds"], "asset");
    }
  }
}

function literalMatchesType(type: z.infer<typeof designSystemTokenTypeSchema>, value: JsonValue) {
  if (type === "color") return colorSchema.safeParse(value).success;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "dimension") return dimensionSchema.safeParse(value).success;
  if (type === "fontFamily" || type === "string") return typeof value === "string" && value.length > 0;
  if (type === "fontWeight") return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 900;
  if (type === "duration") return typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (type === "boolean") return typeof value === "boolean";
  return shadowLiteralSchema.safeParse(value).success;
}

function addDuplicateIssues(values: readonly string[], context: z.RefinementCtx, path: (string | number)[], label: string) {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const value of values) {
    if (seen.has(value) && !reported.has(value)) {
      reported.add(value);
      addIssue(context, path, `${label}: ${value}`);
    }
    seen.add(value);
  }
}

function validateReferences(
  references: readonly string[],
  targets: ReadonlySet<string>,
  context: z.RefinementCtx,
  path: (string | number)[],
  label: string,
) {
  addDuplicateIssues(references, context, path, `Duplicate ${label} reference`);
  for (const reference of references) {
    if (!targets.has(reference)) addIssue(context, path, `Unknown ${label}: ${reference}`);
  }
}

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string) {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
