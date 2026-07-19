import { describe, expect, it } from "vitest";
import {
  normalizePreviewCustomViewport,
  previewDeviceModes,
  previewDevicePresets,
  resolvePreviewViewport,
} from "./preview-device";

describe("Preview device viewport", () => {
  it("defines the complete Stage 5 device matrix", () => {
    expect(previewDeviceModes).toEqual([
      "mobile",
      "phone-landscape",
      "tablet",
      "desktop",
      "responsive",
      "custom",
    ]);
    expect(previewDevicePresets).toEqual({
      mobile: { width: 390, height: 844 },
      "phone-landscape": { width: 844, height: 390 },
      tablet: { width: 768, height: 1_024 },
      desktop: { width: 1_440, height: 900 },
    });
  });

  it("keeps a fixed iframe viewport and scales only its outer presentation", () => {
    expect(resolvePreviewViewport(
      "desktop",
      { width: 1_000, height: 700 },
      { width: 720, height: 450 },
    )).toEqual({
      width: 1_440,
      height: 900,
      renderedWidth: 720,
      renderedHeight: 450,
      scale: 0.5,
      fixed: true,
    });
  });

  it("fills the available layout viewport in responsive mode", () => {
    expect(resolvePreviewViewport(
      "responsive",
      { width: 1_000, height: 700 },
      { width: 831.9, height: 477.8 },
    )).toEqual({
      width: 831,
      height: 477,
      renderedWidth: 831,
      renderedHeight: 477,
      scale: 1,
      fixed: false,
    });
  });

  it("normalizes unsafe custom dimensions before layout", () => {
    expect(normalizePreviewCustomViewport({ width: 10, height: 9_000 })).toEqual({
      width: 240,
      height: 1_600,
    });
    expect(normalizePreviewCustomViewport({ width: Number.NaN, height: 844.4 })).toEqual({
      width: 240,
      height: 844,
    });
  });
});
