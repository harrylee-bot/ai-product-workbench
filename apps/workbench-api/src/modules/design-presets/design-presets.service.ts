import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  canonicalJson,
  designPresetCatalogItemSchema,
  designPresetCatalogSchema,
  designPresetDefinitionFromCatalogItem,
  designPresetDefinitionSchema,
  designPresetReferenceSchema,
  type DesignPresetCatalog,
  type DesignPresetCatalogItem,
  type DesignPresetDefinition,
  type DesignPresetReference,
} from "@workbench/workbench-contracts";
import { designPresetSelectionProblem } from "../../common/problem-details.js";

const definitions = [
  {
    presetId: "workbench.alexandria",
    version: 1,
    label: "Alexandria",
    swatch: "#6f85ff",
    description: "A precise editorial product language with strong reading hierarchy and measured indigo emphasis.",
    directives: {
      composition: "Use a disciplined editorial grid, generous margins, and a clear primary reading column.",
      hierarchy: "Create hierarchy through scale, weight, and whitespace before introducing decorative treatment.",
      typography: "Pair authoritative serif-like display rhythm with highly legible neutral body typography.",
      components: "Keep controls restrained, information-dense, and aligned to an exact baseline and edge system.",
      imagery: "Use documentary or product-specific imagery with deliberate crops and concise supporting captions.",
      interaction: "Prefer quiet state transitions, explicit focus treatment, and stable layouts during updates.",
    },
    tokens: {
      colors: {
        canvas: "#f7f8fc",
        surface: "#ffffff",
        surfaceMuted: "#eef0f7",
        textPrimary: "#171925",
        textSecondary: "#5f6475",
        accent: "#6f85ff",
        accentContrast: "#ffffff",
        border: "#d8dbe7",
        focus: "#465ed6",
        danger: "#c73c52",
      },
      typography: {
        headingFamily: "Georgia, 'Times New Roman', serif",
        bodyFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        headingWeight: 600,
        bodyWeight: 400,
        baseSizePx: 16,
        lineHeight: 1.55,
      },
      geometry: { cornerRadiusPx: 4, controlRadiusPx: 4, borderWidthPx: 1, controlHeightPx: 40 },
      layout: { density: "balanced", spacingUnitPx: 8, contentMaxWidthPx: 1280, gridColumns: 12 },
      motion: { durationFastMs: 120, durationStandardMs: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    },
  },
  {
    presetId: "workbench.bauhaus",
    version: 1,
    label: "Bauhaus",
    swatch: "#d23b49",
    description: "A functional geometric language driven by primary color, visible structure, and direct composition.",
    directives: {
      composition: "Build with explicit geometric regions, asymmetric balance, and visibly intentional alignment.",
      hierarchy: "Use bold scale contrast and primary-color anchors to make the action order immediately obvious.",
      typography: "Use sturdy geometric sans typography with compact headlines and unambiguous functional labels.",
      components: "Expose structure through crisp borders, solid fills, and simple shapes without ornamental effects.",
      imagery: "Favor diagrammatic graphics, honest materials, and high-contrast crops that reinforce the layout.",
      interaction: "Make state changes immediate and graphic, with short motion and unmistakable pressed or focus states.",
    },
    tokens: {
      colors: {
        canvas: "#f4f1e8",
        surface: "#fffdf7",
        surfaceMuted: "#e4dfd2",
        textPrimary: "#171717",
        textSecondary: "#55514a",
        accent: "#d23b49",
        accentContrast: "#ffffff",
        border: "#171717",
        focus: "#1559a6",
        danger: "#b42318",
      },
      typography: {
        headingFamily: "Futura, 'Avenir Next', ui-sans-serif, sans-serif",
        bodyFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        headingWeight: 700,
        bodyWeight: 500,
        baseSizePx: 16,
        lineHeight: 1.4,
      },
      geometry: { cornerRadiusPx: 0, controlRadiusPx: 0, borderWidthPx: 2, controlHeightPx: 42 },
      layout: { density: "compact", spacingUnitPx: 8, contentMaxWidthPx: 1440, gridColumns: 12 },
      motion: { durationFastMs: 80, durationStandardMs: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    },
  },
  {
    presetId: "workbench.glacier",
    version: 1,
    label: "Glacier",
    swatch: "#6ab8f5",
    description: "A spacious, cool-toned system with translucent depth cues and calm technical precision.",
    directives: {
      composition: "Use open layouts, broad breathing room, and layered surfaces that preserve a calm visual field.",
      hierarchy: "Separate levels with tonal contrast and spacing while keeping every information group easy to scan.",
      typography: "Use light-to-medium neutral sans typography with comfortable leading and restrained display scale.",
      components: "Use subtle cool borders, softly elevated surfaces, and clear controls with minimal visual weight.",
      imagery: "Choose bright, clean product imagery with cool highlights, full subject visibility, and limited texture.",
      interaction: "Use smooth restrained transitions and luminous focus cues without moving surrounding content.",
    },
    tokens: {
      colors: {
        canvas: "#f3f8fc",
        surface: "#ffffff",
        surfaceMuted: "#e6f1f8",
        textPrimary: "#142634",
        textSecondary: "#587080",
        accent: "#2f91db",
        accentContrast: "#ffffff",
        border: "#c8dae6",
        focus: "#1676bd",
        danger: "#c34357",
      },
      typography: {
        headingFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        bodyFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        headingWeight: 500,
        bodyWeight: 400,
        baseSizePx: 16,
        lineHeight: 1.6,
      },
      geometry: { cornerRadiusPx: 8, controlRadiusPx: 6, borderWidthPx: 1, controlHeightPx: 42 },
      layout: { density: "airy", spacingUnitPx: 8, contentMaxWidthPx: 1280, gridColumns: 12 },
      motion: { durationFastMs: 140, durationStandardMs: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    },
  },
  {
    presetId: "workbench.carbon",
    version: 1,
    label: "Carbon",
    swatch: "#4da46a",
    description: "A dark operational system with compact density, durable contrast, and controlled green signals.",
    directives: {
      composition: "Prioritize operational density, persistent navigation, and stable regions for repeated daily work.",
      hierarchy: "Use contrast, alignment, and compact section labels to keep complex information quickly scannable.",
      typography: "Use robust system sans typography with tabular numerals and restrained heading size progression.",
      components: "Use dark solid surfaces, precise separators, and status colors only when they convey real meaning.",
      imagery: "Use sharply rendered product or technical imagery against neutral surfaces without atmospheric effects.",
      interaction: "Keep motion brief, preserve geometry between states, and expose keyboard focus with a bright outline.",
    },
    tokens: {
      colors: {
        canvas: "#111513",
        surface: "#1a201d",
        surfaceMuted: "#252c28",
        textPrimary: "#f1f5f2",
        textSecondary: "#a7b2ab",
        accent: "#4da46a",
        accentContrast: "#08120b",
        border: "#38413c",
        focus: "#76d492",
        danger: "#f06a73",
      },
      typography: {
        headingFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        bodyFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
        headingWeight: 600,
        bodyWeight: 400,
        baseSizePx: 15,
        lineHeight: 1.45,
      },
      geometry: { cornerRadiusPx: 3, controlRadiusPx: 3, borderWidthPx: 1, controlHeightPx: 36 },
      layout: { density: "compact", spacingUnitPx: 6, contentMaxWidthPx: 1440, gridColumns: 12 },
      motion: { durationFastMs: 90, durationStandardMs: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    },
  },
] satisfies readonly DesignPresetDefinition[];

const authoritativeDesignPresetCatalogSchema = designPresetCatalogSchema.superRefine(
  (catalog, context) => {
    for (const [index, item] of catalog.items.entries()) {
      if (catalogItemChecksum(item) !== item.checksum) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "checksum"],
          message: "Design preset checksum must match its canonical immutable definition",
        });
      }
    }
  },
);

@Injectable()
export class DesignPresetsService {
  private readonly catalog: DesignPresetCatalog;

  constructor() {
    const items = definitions.map(materializeCatalogItem);
    const catalog = authoritativeDesignPresetCatalogSchema.parse({ items });
    this.catalog = deepFreeze(catalog);
  }

  list(): DesignPresetCatalog {
    return this.catalog;
  }

  resolve(reference: DesignPresetReference): DesignPresetCatalogItem {
    const selected = designPresetReferenceSchema.parse(reference);
    const versions = this.catalog.items.filter((item) => item.presetId === selected.presetId);
    if (versions.length === 0) {
      throw designPresetSelectionProblem(
        "RUN_DESIGN_PRESET_UNKNOWN",
        "The selected design preset is not present in the authoritative catalog",
        { "designStyle.presetId": [`Unknown design preset: ${selected.presetId}`] },
      );
    }
    const item = versions.find((candidate) => candidate.version === selected.version);
    if (!item) {
      throw designPresetSelectionProblem(
        "RUN_DESIGN_PRESET_VERSION_MISMATCH",
        "The selected design preset version is not present in the authoritative catalog",
        { "designStyle.version": [`Unknown version ${selected.version} for ${selected.presetId}`] },
      );
    }
    if (item.checksum !== selected.checksum) {
      throw designPresetSelectionProblem(
        "RUN_DESIGN_PRESET_CHECKSUM_MISMATCH",
        "The selected design preset checksum does not match its immutable catalog version",
        { "designStyle.checksum": ["Refresh the design preset catalog before starting the Run"] },
      );
    }
    verifyCatalogItemChecksum(item);
    return item;
  }
}

function materializeCatalogItem(definition: DesignPresetDefinition): DesignPresetCatalogItem {
  const parsed = designPresetDefinitionSchema.parse(definition);
  return designPresetCatalogItemSchema.parse({
    ...parsed,
    checksum: sha256Canonical(parsed),
  });
}

function verifyCatalogItemChecksum(item: DesignPresetCatalogItem) {
  const actual = catalogItemChecksum(item);
  if (actual !== item.checksum) throw new Error(`DESIGN_PRESET_CHECKSUM_INVALID:${item.presetId}@${item.version}`);
}

function catalogItemChecksum(item: DesignPresetCatalogItem) {
  return sha256Canonical(designPresetDefinitionFromCatalogItem(item));
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
