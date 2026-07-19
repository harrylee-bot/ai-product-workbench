const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_EDGE = 4_096;
const MAX_CAPTURE_PIXELS = 16_000_000;
const VIDEO_METADATA_READY_STATE = 1;

type DisplayCaptureDependencies = {
  createCanvas: () => HTMLCanvasElement;
  createFile: (parts: BlobPart[], fileName: string, options: FilePropertyBag) => File;
  createVideo: () => HTMLVideoElement;
  getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  now: () => Date;
};

export class WorkbenchScreenCaptureUnavailableError extends Error {
  constructor() {
    super("Screen capture is unavailable in this browser");
    this.name = "WorkbenchScreenCaptureUnavailableError";
  }
}

export class WorkbenchScreenCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchScreenCaptureError";
  }
}

export async function captureWorkbenchScreen(
  dependencies?: DisplayCaptureDependencies,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
): Promise<File> {
  const environment = dependencies ?? browserDisplayCaptureDependencies();
  const stream = await environment.getDisplayMedia({ audio: false, video: true });
  let video: HTMLVideoElement | null = null;

  try {
    video = environment.createVideo();
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    await waitForVideoMetadata(video, timeoutMs);
    await video.play();
    await waitForVideoFrame(video, timeoutMs);

    const trackSettings = stream.getVideoTracks()[0]?.getSettings();
    const sourceWidth = positiveDimension(video.videoWidth, trackSettings?.width);
    const sourceHeight = positiveDimension(video.videoHeight, trackSettings?.height);
    if (!sourceWidth || !sourceHeight) {
      throw new WorkbenchScreenCaptureError("The captured screen did not expose valid dimensions");
    }
    const { width, height } = fitCaptureDimensions(sourceWidth, sourceHeight);

    const canvas = environment.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new WorkbenchScreenCaptureError("The browser could not create a screen capture canvas");
    }
    context.drawImage(video, 0, 0, width, height);

    const blob = await canvasToPng(canvas);
    const capturedAt = environment.now();
    return environment.createFile(
      [blob],
      `workbench-screen-${captureTimestamp(capturedAt)}.png`,
      { type: "image/png", lastModified: capturedAt.getTime() },
    );
  } finally {
    try {
      video?.pause();
      if (video) video.srcObject = null;
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
  }
}

function browserDisplayCaptureDependencies(): DisplayCaptureDependencies {
  if (
    typeof navigator === "undefined"
    || typeof document === "undefined"
    || typeof File === "undefined"
    || !navigator.mediaDevices?.getDisplayMedia
  ) {
    throw new WorkbenchScreenCaptureUnavailableError();
  }

  return {
    createCanvas: () => document.createElement("canvas"),
    createFile: (parts, fileName, options) => new File(parts, fileName, options),
    createVideo: () => document.createElement("video"),
    getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
    now: () => new Date(),
  };
}

function waitForVideoMetadata(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (
    video.readyState >= VIDEO_METADATA_READY_STATE
    && video.videoWidth > 0
    && video.videoHeight > 0
  ) {
    return Promise.resolve();
  }

  return eventWithTimeout(video, "loadedmetadata", timeoutMs, "screen metadata");
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve();

  return new Promise((resolve, reject) => {
    let callbackId = 0;
    const timeout = setTimeout(() => {
      video.cancelVideoFrameCallback(callbackId);
      reject(new WorkbenchScreenCaptureError("Timed out while waiting for the captured screen frame"));
    }, timeoutMs);
    callbackId = video.requestVideoFrameCallback(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function eventWithTimeout(
  target: HTMLVideoElement,
  eventName: "loadedmetadata",
  timeoutMs: number,
  description: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      target.removeEventListener(eventName, handleSuccess);
      target.removeEventListener("error", handleError);
    };
    const handleSuccess = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new WorkbenchScreenCaptureError(`Failed to read ${description}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new WorkbenchScreenCaptureError(`Timed out while waiting for ${description}`));
    }, timeoutMs);

    target.addEventListener(eventName, handleSuccess, { once: true });
    target.addEventListener("error", handleError, { once: true });
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new WorkbenchScreenCaptureError("The browser returned an empty screen capture"));
    }, "image/png");
  });
}

function positiveDimension(primary: number, fallback: number | undefined): number | null {
  const candidate = primary > 0 ? primary : fallback;
  if (!candidate || !Number.isFinite(candidate) || candidate <= 0) return null;
  return Math.round(candidate);
}

function fitCaptureDimensions(sourceWidth: number, sourceHeight: number) {
  const edgeScale = Math.min(1, MAX_CAPTURE_EDGE / sourceWidth, MAX_CAPTURE_EDGE / sourceHeight);
  const pixelScale = Math.min(1, Math.sqrt(MAX_CAPTURE_PIXELS / (sourceWidth * sourceHeight)));
  const scale = Math.min(edgeScale, pixelScale);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function captureTimestamp(date: Date): string {
  const component = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    component(date.getMonth() + 1),
    component(date.getDate()),
    "-",
    component(date.getHours()),
    component(date.getMinutes()),
    component(date.getSeconds()),
  ].join("");
}
