import { describe, expect, it, vi } from "vitest";

import {
  captureWorkbenchScreen,
  WorkbenchScreenCaptureError,
  WorkbenchScreenCaptureUnavailableError,
} from "./screen-capture";

describe("captureWorkbenchScreen", () => {
  it("captures one PNG frame and immediately stops screen sharing", async () => {
    const stop = vi.fn();
    const drawImage = vi.fn();
    const video = videoElement({ width: 1440, height: 900 });
    const canvas = canvasElement(drawImage, new Blob(["png"], { type: "image/png" }));
    const getDisplayMedia = vi.fn(async () => mediaStream(stop, { width: 1920, height: 1080 }));

    const file = await captureWorkbenchScreen({
      createCanvas: () => canvas,
      createFile: (parts, name, options) => new File(parts, name, options),
      createVideo: () => video,
      getDisplayMedia,
      now: () => new Date(2026, 6, 14, 9, 8, 7),
    });

    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: false, video: true });
    expect(canvas.width).toBe(1440);
    expect(canvas.height).toBe(900);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1440, 900);
    expect(file.name).toBe("workbench-screen-20260714-090807.png");
    expect(file.type).toBe("image/png");
    expect(stop).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });

  it("falls back to video track dimensions", async () => {
    const stop = vi.fn();
    const drawImage = vi.fn();
    const canvas = canvasElement(drawImage, new Blob(["png"], { type: "image/png" }));

    await captureWorkbenchScreen({
      createCanvas: () => canvas,
      createFile: (parts, name, options) => new File(parts, name, options),
      createVideo: () => videoElement({ width: 0, height: 0, readyState: 0 }),
      getDisplayMedia: async () => mediaStream(stop, { width: 1280, height: 720 }),
      now: () => new Date(2026, 6, 14, 0, 0, 0),
    });

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("bounds ultra-high-resolution captures without changing their aspect ratio", async () => {
    const canvas = canvasElement(vi.fn(), new Blob(["png"], { type: "image/png" }));

    await captureWorkbenchScreen({
      createCanvas: () => canvas,
      createFile: (parts, name, options) => new File(parts, name, options),
      createVideo: () => videoElement({ width: 7680, height: 4320 }),
      getDisplayMedia: async () => mediaStream(vi.fn(), { width: 7680, height: 4320 }),
      now: () => new Date(2026, 6, 14, 0, 0, 0),
    });

    expect(canvas.width).toBe(4096);
    expect(canvas.height).toBe(2304);
  });

  it("stops screen sharing when frame encoding fails", async () => {
    const stop = vi.fn();
    const canvas = canvasElement(vi.fn(), null);

    await expect(captureWorkbenchScreen({
      createCanvas: () => canvas,
      createFile: (parts, name, options) => new File(parts, name, options),
      createVideo: () => videoElement({ width: 800, height: 600 }),
      getDisplayMedia: async () => mediaStream(stop, { width: 800, height: 600 }),
      now: () => new Date(),
    })).rejects.toBeInstanceOf(WorkbenchScreenCaptureError);

    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects cleanly outside a supported browser", async () => {
    await expect(captureWorkbenchScreen()).rejects.toBeInstanceOf(
      WorkbenchScreenCaptureUnavailableError,
    );
  });
});

function videoElement({
  width,
  height,
  readyState = 1,
}: {
  width: number;
  height: number;
  readyState?: number;
}): HTMLVideoElement {
  const listeners = new Map<string, EventListener>();
  const video = {
    autoplay: false,
    muted: false,
    playsInline: false,
    readyState,
    videoWidth: width,
    videoHeight: height,
    srcObject: null,
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      listeners.set(name, listener);
      if (name === "loadedmetadata") queueMicrotask(() => listener(new Event(name)));
    }),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => {
      queueMicrotask(() => callback(0, {} as VideoFrameCallbackMetadata));
      return 1;
    }),
    cancelVideoFrameCallback: vi.fn(),
  };
  return video as unknown as HTMLVideoElement;
}

function canvasElement(
  drawImage: ReturnType<typeof vi.fn>,
  blob: Blob | null,
): HTMLCanvasElement {
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((callback: BlobCallback) => callback(blob)),
  };
  return canvas as unknown as HTMLCanvasElement;
}

function mediaStream(
  stop: ReturnType<typeof vi.fn>,
  settings: MediaTrackSettings,
): MediaStream {
  const track = { getSettings: () => settings, stop } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}
