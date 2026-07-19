import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  designPresetCatalogSchema,
  designPresetDefinitionFromRuntimeSnapshot,
  designPresetDefinitionSchema,
  materializeRuntimeDesignPresetSnapshot,
  startRunRequestSchema,
} from "../src/index.js";

function definition() {
  return designPresetDefinitionSchema.parse({
    presetId: "workbench.test",
    version: 1,
    label: "Test preset",
    swatch: "#123456",
    description: "A complete immutable test preset for contract verification.",
    directives: {
      composition: "Use a stable grid with deliberate alignment and spacing.",
      hierarchy: "Express hierarchy with type, contrast, and whitespace first.",
      typography: "Use legible typography with a restrained and consistent scale.",
      components: "Keep component geometry and states explicit and predictable.",
      imagery: "Use product-specific imagery with clear subjects and useful crops.",
      interaction: "Keep transitions brief while preserving layout and visible focus.",
    },
    tokens: {
      colors: {
        canvas: "#f6f7f8",
        surface: "#ffffff",
        surfaceMuted: "#eceff1",
        textPrimary: "#101214",
        textSecondary: "#596168",
        accent: "#123456",
        accentContrast: "#ffffff",
        border: "#d2d7db",
        focus: "#2468a2",
        danger: "#c23b4a",
      },
      typography: {
        headingFamily: "Inter, sans-serif",
        bodyFamily: "Inter, sans-serif",
        headingWeight: 600,
        bodyWeight: 400,
        baseSizePx: 16,
        lineHeight: 1.5,
      },
      geometry: { cornerRadiusPx: 4, controlRadiusPx: 4, borderWidthPx: 1, controlHeightPx: 40 },
      layout: { density: "balanced", spacingUnitPx: 8, contentMaxWidthPx: 1280, gridColumns: 12 },
      motion: { durationFastMs: 100, durationStandardMs: 200, easing: "ease-out" },
    },
  });
}

describe("authoritative Design preset contracts", () => {
  it("requires an immutable version and checksum in every Run selection", () => {
    const request = {
      prompt: "Build it",
      modelId: "quality",
      workflow: "generate",
      targetSurface: "web",
      designStyle: { kind: "preset", presetId: "workbench.test" },
    };
    expect(startRunRequestSchema.safeParse(request).success).toBe(false);
    expect(startRunRequestSchema.safeParse({
      ...request,
      designStyle: {
        ...request.designStyle,
        version: 1,
        checksum: "a".repeat(64),
      },
    }).success).toBe(true);
  });

  it("materializes the full catalog payload into a runtime snapshot", () => {
    const payload = definition();
    const checksum = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const item = designPresetCatalogSchema.parse({
      items: [{ ...payload, checksum }],
    }).items[0]!;
    const snapshot = materializeRuntimeDesignPresetSnapshot(item);

    expect(snapshot).toMatchObject({
      protocol: "workbench.runtime.design-preset.v1",
      source: { presetId: "workbench.test", version: 1, checksum },
      label: "Test preset",
      tokens: { colors: { accent: "#123456" } },
    });
    expect(designPresetDefinitionFromRuntimeSnapshot(snapshot)).toEqual(payload);
  });

  it("rejects duplicate preset id and version pairs", () => {
    const payload = definition();
    const item = { ...payload, checksum: "a".repeat(64) };
    expect(designPresetCatalogSchema.safeParse({ items: [item, item] }).success).toBe(false);
  });
});
