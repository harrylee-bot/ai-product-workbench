// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const toCanvas = vi.hoisted(() => vi.fn());

vi.mock("html-to-image", () => ({ toCanvas }));

import { captureCanvasVisual, CanvasVisualCaptureError } from "./visual-capture";

const target = {
  boardNodeId: "node-1",
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  screenId: "screen-1",
} as const;

describe("captureCanvasVisual", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    toCanvas.mockReset();
    const bytes = Uint8Array.from({ length: 12 }, (_value, index) => index + 1);
    toCanvas.mockImplementation(async (_element, options) => mockCanvas(
      options.canvasWidth,
      options.canvasHeight,
      bytes,
    ));
  });

  it("captures only the target prototype viewport and returns a digest-bound wire payload", async () => {
    const boardNode = document.createElement("section");
    boardNode.dataset.canvasScreenNode = "";
    boardNode.dataset.canvasBoardNodeId = target.boardNodeId;
    const visual = document.createElement("div");
    visual.dataset.canvasVisualScreen = "";
    visual.dataset.canvasArtifactId = target.artifactId;
    visual.dataset.canvasArtifactVersionId = target.artifactVersionId;
    visual.dataset.canvasScreenId = target.screenId;
    Object.defineProperties(visual, {
      clientHeight: { configurable: true, value: 900 },
      clientWidth: { configurable: true, value: 1_440 },
    });
    boardNode.append(visual);
    document.body.append(boardNode);

    const capture = await captureCanvasVisual(target, "visual-capability-1", { document });

    expect(capture).toMatchObject({
      protocol: "workbench.canvas-visual-capture.v1",
      visualCapabilityId: "visual-capability-1",
      mediaType: "image/webp",
      byteSize: 12,
      width: 1_440,
      height: 900,
      dataBase64: "AQIDBAUGBwgJCgsM",
      sha256: "206402cab345415716d9a33469feba57a90dc200c064bc0190b4191af058b0eb",
    });
    expect(capture.sha256).toHaveLength(64);
    expect(toCanvas).toHaveBeenCalledWith(
      visual,
      expect.objectContaining({
        canvasHeight: 900,
        canvasWidth: 1_440,
        type: "image/webp",
        width: 1_440,
        height: 900,
      }),
    );
  });

  it("fails closed when the target screen is absent", async () => {
    await expect(captureCanvasVisual(target, "visual-capability-1", {
      document,
      lookupTimeoutMs: 0,
    })).rejects.toMatchObject({ code: "CANVAS_VISUAL_TARGET_UNAVAILABLE" });
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("does not send an oversized image after bounded retries", async () => {
    toCanvas.mockImplementation(async (_element, options) => mockCanvas(
      options.canvasWidth,
      options.canvasHeight,
      new Uint8Array(1_048_577),
    ));
    const boardNode = document.createElement("section");
    boardNode.dataset.canvasScreenNode = "";
    boardNode.dataset.canvasBoardNodeId = target.boardNodeId;
    const visual = document.createElement("div");
    visual.dataset.canvasVisualScreen = "";
    visual.dataset.canvasArtifactId = target.artifactId;
    visual.dataset.canvasArtifactVersionId = target.artifactVersionId;
    visual.dataset.canvasScreenId = target.screenId;
    Object.defineProperties(visual, {
      clientHeight: { configurable: true, value: 900 },
      clientWidth: { configurable: true, value: 1_440 },
    });
    boardNode.append(visual);
    document.body.append(boardNode);

    const promise = captureCanvasVisual(target, "visual-capability-1", { document });
    await expect(promise).rejects.toBeInstanceOf(CanvasVisualCaptureError);
    await expect(promise).rejects.toMatchObject({ code: "CANVAS_VISUAL_SIZE_LIMIT" });
    expect(toCanvas.mock.calls.length).toBeGreaterThan(1);
  });

  it("fails closed before rendering a cross-origin resource", async () => {
    const boardNode = document.createElement("section");
    boardNode.dataset.canvasScreenNode = "";
    boardNode.dataset.canvasBoardNodeId = target.boardNodeId;
    const visual = document.createElement("div");
    visual.dataset.canvasVisualScreen = "";
    visual.dataset.canvasArtifactId = target.artifactId;
    visual.dataset.canvasArtifactVersionId = target.artifactVersionId;
    visual.dataset.canvasScreenId = target.screenId;
    Object.defineProperties(visual, {
      clientHeight: { configurable: true, value: 900 },
      clientWidth: { configurable: true, value: 1_440 },
    });
    const image = document.createElement("img");
    image.src = "https://assets.example.invalid/screen.png";
    visual.append(image);
    boardNode.append(visual);
    document.body.append(boardNode);

    await expect(captureCanvasVisual(target, "visual-capability-1", { document }))
      .rejects.toMatchObject({ code: "CANVAS_VISUAL_CROSS_ORIGIN_RESOURCE" });
    expect(toCanvas).not.toHaveBeenCalled();
  });
});

function mockCanvas(
  width: number,
  height: number,
  bytes: Uint8Array,
): HTMLCanvasElement {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return {
    width,
    height,
    toBlob: (callback: BlobCallback, type?: string) => {
      callback(new Blob([buffer], { type }));
    },
  } as HTMLCanvasElement;
}
