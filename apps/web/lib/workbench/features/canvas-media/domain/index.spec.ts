// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  workbenchCanvasMediaArtifactTitle,
  workbenchCanvasMediaBoardSize,
  workbenchCanvasMediaUploadProgress,
} from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workbench canvas Media domain", () => {
  it("preserves the fallback, scaling, and bitmap disposal rules", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(workbenchCanvasMediaBoardSize(imageFile())).resolves.toEqual({
      width: 480,
      height: 320,
    });

    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      close,
      height: 500,
      width: 1_000,
    }));
    await expect(workbenchCanvasMediaBoardSize(imageFile())).resolves.toEqual({
      width: 520,
      height: 260,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the existing Artifact title normalization and limit", () => {
    expect(workbenchCanvasMediaArtifactTitle("  hero.image.png  ")).toBe("hero.image");
    expect(workbenchCanvasMediaArtifactTitle(".png")).toBe("图片");
    expect(workbenchCanvasMediaArtifactTitle(`${"a".repeat(200)}.webp`)).toHaveLength(160);
  });

  it.each([
    ["ready", 0, 0, 96],
    ["verifying", 100, 100, 92],
    ["uploading", 20, 50, 50],
    ["uploading", 100, 100, 90],
    ["paused", 80, 20, 26],
    ["queued", 50, 0, 5],
    ["failed", 100, 100, 10],
  ])("maps %s upload progress without changing its numeric contract", (
    phase,
    hashPercent,
    uploadPercent,
    expected,
  ) => {
    expect(workbenchCanvasMediaUploadProgress({
      phase,
      hashPercent,
      uploadPercent,
    })).toBe(expected);
  });
});

function imageFile() {
  return new File(["image"], "hero.png", { type: "image/png", lastModified: 1 });
}
