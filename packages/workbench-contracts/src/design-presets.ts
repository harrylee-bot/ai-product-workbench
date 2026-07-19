import { z } from "zod";

export const designPresetIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

export const designPresetChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const designPresetSwatchSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

const colorTokenSchema = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);

export const designPresetDirectivesSchema = z.object({
  composition: z.string().min(20).max(2_000),
  hierarchy: z.string().min(20).max(2_000),
  typography: z.string().min(20).max(2_000),
  components: z.string().min(20).max(2_000),
  imagery: z.string().min(20).max(2_000),
  interaction: z.string().min(20).max(2_000),
}).strict();

export const designPresetTokensSchema = z.object({
  colors: z.object({
    canvas: colorTokenSchema,
    surface: colorTokenSchema,
    surfaceMuted: colorTokenSchema,
    textPrimary: colorTokenSchema,
    textSecondary: colorTokenSchema,
    accent: colorTokenSchema,
    accentContrast: colorTokenSchema,
    border: colorTokenSchema,
    focus: colorTokenSchema,
    danger: colorTokenSchema,
  }).strict(),
  typography: z.object({
    headingFamily: z.string().min(1).max(240),
    bodyFamily: z.string().min(1).max(240),
    headingWeight: z.number().int().min(100).max(900),
    bodyWeight: z.number().int().min(100).max(900),
    baseSizePx: z.number().int().min(12).max(24),
    lineHeight: z.number().min(1).max(2),
  }).strict(),
  geometry: z.object({
    cornerRadiusPx: z.number().int().min(0).max(32),
    controlRadiusPx: z.number().int().min(0).max(32),
    borderWidthPx: z.number().int().min(0).max(4),
    controlHeightPx: z.number().int().min(28).max(64),
  }).strict(),
  layout: z.object({
    density: z.enum(["compact", "balanced", "airy"]),
    spacingUnitPx: z.number().int().min(2).max(12),
    contentMaxWidthPx: z.number().int().min(640).max(1920),
    gridColumns: z.number().int().min(4).max(24),
  }).strict(),
  motion: z.object({
    durationFastMs: z.number().int().min(50).max(500),
    durationStandardMs: z.number().int().min(100).max(1_000),
    easing: z.string().min(1).max(120),
  }).strict(),
}).strict();

const designPresetDefinitionShape = {
  presetId: designPresetIdSchema,
  version: z.number().int().positive(),
  label: z.string().min(1).max(120),
  swatch: designPresetSwatchSchema,
  description: z.string().min(20).max(2_000),
  directives: designPresetDirectivesSchema,
  tokens: designPresetTokensSchema,
} as const;

export const designPresetDefinitionSchema = z.object(designPresetDefinitionShape).strict();

export const designPresetReferenceSchema = z.object({
  presetId: designPresetIdSchema,
  version: z.number().int().positive(),
  checksum: designPresetChecksumSchema,
}).strict();

export const designPresetCatalogItemSchema = z.object({
  ...designPresetDefinitionShape,
  checksum: designPresetChecksumSchema,
}).strict();

export const designPresetCatalogSchema = z.object({
  items: z.array(designPresetCatalogItemSchema).max(100),
}).strict().superRefine((catalog, context) => {
  const references = new Set<string>();
  for (const [index, item] of catalog.items.entries()) {
    const reference = `${item.presetId}@${item.version}`;
    if (references.has(reference)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "version"],
        message: "Design preset id and version pairs must be unique",
      });
    }
    references.add(reference);
  }
});

export const runtimePresetDesignStyleSnapshotSchema = z.object({
  protocol: z.literal("workbench.runtime.design-preset.v1"),
  source: designPresetReferenceSchema,
  label: designPresetDefinitionShape.label,
  swatch: designPresetDefinitionShape.swatch,
  description: designPresetDefinitionShape.description,
  directives: designPresetDirectivesSchema,
  tokens: designPresetTokensSchema,
}).strict();

export type DesignPresetDefinition = z.infer<typeof designPresetDefinitionSchema>;
export type DesignPresetReference = z.infer<typeof designPresetReferenceSchema>;
export type DesignPresetCatalogItem = z.infer<typeof designPresetCatalogItemSchema>;
export type DesignPresetCatalog = z.infer<typeof designPresetCatalogSchema>;
export type RuntimePresetDesignStyleSnapshot = z.infer<typeof runtimePresetDesignStyleSnapshotSchema>;

export function designPresetDefinitionFromCatalogItem(
  item: DesignPresetCatalogItem,
): DesignPresetDefinition {
  const { checksum: _checksum, ...definition } = designPresetCatalogItemSchema.parse(item);
  return designPresetDefinitionSchema.parse(definition);
}

export function designPresetDefinitionFromRuntimeSnapshot(
  snapshot: RuntimePresetDesignStyleSnapshot,
): DesignPresetDefinition {
  return designPresetDefinitionSchema.parse({
    presetId: snapshot.source.presetId,
    version: snapshot.source.version,
    label: snapshot.label,
    swatch: snapshot.swatch,
    description: snapshot.description,
    directives: snapshot.directives,
    tokens: snapshot.tokens,
  });
}

export function materializeRuntimeDesignPresetSnapshot(
  item: DesignPresetCatalogItem,
): RuntimePresetDesignStyleSnapshot {
  const parsed = designPresetCatalogItemSchema.parse(item);
  return runtimePresetDesignStyleSnapshotSchema.parse({
    protocol: "workbench.runtime.design-preset.v1",
    source: {
      presetId: parsed.presetId,
      version: parsed.version,
      checksum: parsed.checksum,
    },
    label: parsed.label,
    swatch: parsed.swatch,
    description: parsed.description,
    directives: parsed.directives,
    tokens: parsed.tokens,
  });
}
