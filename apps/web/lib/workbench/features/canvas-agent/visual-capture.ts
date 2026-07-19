import { toCanvas } from "html-to-image";
import {
  canvasVisualCaptureWireSchema,
  type CanvasScreenReference,
  type CanvasVisualCaptureWire,
} from "@workbench/workbench-contracts";

export const canvasVisualCaptureLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDimension: 2_048,
  maxBase64Length: 1_500_000,
  lookupTimeoutMs: 2_000,
});

const captureMediaTypes = ["image/webp", "image/jpeg", "image/png"] as const;
const captureQualities = [0.86, 0.72, 0.56, 0.42] as const;

type CaptureMediaType = (typeof captureMediaTypes)[number];

export type CanvasVisualCaptureOptions = {
  document?: Document;
  lookupTimeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Capture the rendered prototype viewport associated with one Canvas screen.
 * The returned bytes are wire-only; callers must never put them in durable
 * command/result records.
 */
export async function captureCanvasVisual(
  target: CanvasScreenReference,
  visualCapabilityId: string,
  options: CanvasVisualCaptureOptions = {},
): Promise<CanvasVisualCaptureWire> {
  const documentRef = options.document ?? globalThis.document;
  if (!documentRef) throw new CanvasVisualCaptureError("CANVAS_VISUAL_DOCUMENT_UNAVAILABLE");
  if (!visualCapabilityId) throw new CanvasVisualCaptureError("CANVAS_VISUAL_CAPABILITY_INVALID");

  const element = await waitForVisualElement(
    documentRef,
    target,
    options.signal,
    options.lookupTimeoutMs ?? canvasVisualCaptureLimits.lookupTimeoutMs,
  );
  assertNoCrossOriginResources(element);
  await waitForRenderableResources(element, options.signal);

  const width = boundedElementDimension(element, "width");
  const height = boundedElementDimension(element, "height");
  if (width <= 0 || height <= 0) {
    throw new CanvasVisualCaptureError("CANVAS_VISUAL_DIMENSIONS_INVALID");
  }

  const maxScale = Math.min(1, canvasVisualCaptureLimits.maxDimension / Math.max(width, height));
  // Keep retries deterministic. Lowering both raster scale and JPEG/WebP
  // quality gives large screens a bounded path without silently truncating.
  const scales = uniquePositive([
    maxScale,
    maxScale * 0.82,
    maxScale * 0.64,
    maxScale * 0.48,
    maxScale * 0.32,
  ]);

  let lastError: unknown = null;
  for (const scale of scales) {
    const outputWidth = Math.max(1, Math.min(canvasVisualCaptureLimits.maxDimension, Math.round(width * scale)));
    const outputHeight = Math.max(1, Math.min(canvasVisualCaptureLimits.maxDimension, Math.round(height * scale)));
    for (const type of captureMediaTypes) {
      const qualities = type === "image/png" ? [1] : captureQualities;
      for (const quality of qualities) {
        throwIfAborted(options.signal);
        try {
          const canvas = await toCanvas(element, {
            backgroundColor: "#ffffff",
            canvasHeight: outputHeight,
            canvasWidth: outputWidth,
            imagePlaceholder: "",
            fetchRequestInit: options.signal ? { signal: options.signal } : undefined,
            pixelRatio: 1,
            quality,
            skipAutoScale: true,
            style: {
              animation: "none",
              caretColor: "transparent",
              transition: "none",
            },
            type,
            width,
            height,
          });
          if (
            canvas.width <= 0
            || canvas.height <= 0
            || canvas.width > canvasVisualCaptureLimits.maxDimension
            || canvas.height > canvasVisualCaptureLimits.maxDimension
          ) throw new CanvasVisualCaptureError("CANVAS_VISUAL_DIMENSIONS_INVALID");
          const blob = await encodeCanvas(canvas, type, quality);
          if (!blob) throw new CanvasVisualCaptureError("CANVAS_VISUAL_RENDER_EMPTY");
          const mediaType = normalizeMediaType(blob.type, type);
          if (!mediaType) throw new CanvasVisualCaptureError("CANVAS_VISUAL_MEDIA_TYPE_INVALID");
          if (blob.size <= 0 || blob.size > canvasVisualCaptureLimits.maxBytes) {
            throw new CanvasVisualCaptureError("CANVAS_VISUAL_SIZE_LIMIT");
          }
          const bytes = await readBlobBytes(blob);
          if (bytes.byteLength !== blob.size || bytes.byteLength > canvasVisualCaptureLimits.maxBytes) {
            throw new CanvasVisualCaptureError("CANVAS_VISUAL_SIZE_LIMIT");
          }
          const dataBase64 = bytesToBase64(bytes);
          if (dataBase64.length > canvasVisualCaptureLimits.maxBase64Length) {
            throw new CanvasVisualCaptureError("CANVAS_VISUAL_BASE64_LIMIT");
          }
          const sha256 = await digestSha256(bytes);
          return canvasVisualCaptureWireSchema.parse({
            protocol: "workbench.canvas-visual-capture.v1",
            visualCapabilityId,
            mediaType,
            byteSize: bytes.byteLength,
            width: canvas.width,
            height: canvas.height,
            sha256,
            dataBase64,
          });
        } catch (error) {
          lastError = error;
          throwIfAborted(options.signal);
        }
      }
    }
  }
  throw lastError instanceof CanvasVisualCaptureError
    ? lastError
    : new CanvasVisualCaptureError("CANVAS_VISUAL_RENDER_FAILED");
}

export class CanvasVisualCaptureError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CanvasVisualCaptureError";
  }
}

async function waitForVisualElement(
  documentRef: Document,
  target: CanvasScreenReference,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HTMLElement> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const element = findVisualElement(documentRef, target);
    if (element) return element;
    await delay(32, signal);
  }
  throw new CanvasVisualCaptureError("CANVAS_VISUAL_TARGET_UNAVAILABLE");
}

function findVisualElement(
  documentRef: Document,
  target: CanvasScreenReference,
): HTMLElement | null {
  const elements = documentRef.querySelectorAll<HTMLElement>("[data-canvas-visual-screen]");
  for (const element of elements) {
    if (
      element.getAttribute("data-canvas-artifact-id") !== target.artifactId
      || element.getAttribute("data-canvas-artifact-version-id") !== target.artifactVersionId
      || element.getAttribute("data-canvas-screen-id") !== target.screenId
    ) continue;
    const boardNode = element.closest<HTMLElement>("[data-canvas-screen-node]");
    if (boardNode?.getAttribute("data-canvas-board-node-id") === target.boardNodeId) return element;
  }
  return null;
}

async function waitForRenderableResources(
  element: HTMLElement,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  const documentRef = element.ownerDocument;
  const fonts = documentRef.fonts?.ready;
  if (fonts) {
    await withAbortTimeout(
      fonts,
      signal,
      canvasVisualCaptureLimits.lookupTimeoutMs,
      "CANVAS_VISUAL_FONT_UNAVAILABLE",
    );
  }
  const images = [...element.querySelectorAll<HTMLImageElement>("img")];
  await Promise.all(images.map(async (image) => {
    throwIfAborted(signal);
    if (!image.complete) {
      await new Promise<void>((resolve, reject) => {
        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new CanvasVisualCaptureError("CANVAS_VISUAL_IMAGE_UNAVAILABLE"));
        };
        const cleanup = () => {
          globalThis.clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          image.removeEventListener("load", onLoad);
          image.removeEventListener("error", onError);
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException("Canvas visual capture aborted", "AbortError"));
        };
        const timer = globalThis.setTimeout(() => {
          cleanup();
          reject(new CanvasVisualCaptureError("CANVAS_VISUAL_IMAGE_UNAVAILABLE"));
        }, canvasVisualCaptureLimits.lookupTimeoutMs);
        image.addEventListener("load", onLoad, { once: true });
        image.addEventListener("error", onError, { once: true });
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (typeof image.naturalWidth === "number" && image.naturalWidth === 0 && image.src) {
      throw new CanvasVisualCaptureError("CANVAS_VISUAL_IMAGE_UNAVAILABLE");
    }
  }));
}

function assertNoCrossOriginResources(element: HTMLElement): void {
  const documentRef = element.ownerDocument;
  const origin = documentRef.location?.origin;
  if (!origin || origin === "null") return;
  const elements = [element, ...element.querySelectorAll<HTMLElement | SVGElement>("*")];
  for (const candidate of elements) {
    if (candidate instanceof HTMLImageElement) {
      assertSameOriginUrl(candidate.currentSrc || candidate.src, documentRef);
    } else if (typeof SVGImageElement !== "undefined" && candidate instanceof SVGImageElement) {
      assertSameOriginUrl(candidate.href.baseVal, documentRef);
    }
    const style = documentRef.defaultView?.getComputedStyle(candidate);
    if (!style) continue;
    for (const property of [
      style.backgroundImage,
      style.borderImageSource,
      style.listStyleImage,
      style.maskImage,
    ]) {
      for (const url of cssResourceUrls(property)) assertSameOriginUrl(url, documentRef);
    }
  }
}

function assertSameOriginUrl(value: string, documentRef: Document): void {
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return;
  let url: URL;
  try {
    url = new URL(value, documentRef.baseURI);
  } catch {
    throw new CanvasVisualCaptureError("CANVAS_VISUAL_RESOURCE_URL_INVALID");
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== documentRef.location.origin) {
    throw new CanvasVisualCaptureError("CANVAS_VISUAL_CROSS_ORIGIN_RESOURCE");
  }
}

function cssResourceUrls(value: string): string[] {
  const urls: string[] = [];
  const expression = /url\(\s*(["']?)(.*?)\1\s*\)/giu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) {
    if (match[2]) urls.push(match[2]);
  }
  return urls;
}

function boundedElementDimension(element: HTMLElement, axis: "width" | "height"): number {
  const client = axis === "width" ? element.clientWidth : element.clientHeight;
  if (Number.isFinite(client) && client > 0) return Math.ceil(client);
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  const value = computed?.[axis] ?? "";
  const parsed = Number.parseFloat(value);
  if (Number.isFinite(parsed) && parsed > 0) return Math.ceil(parsed);
  const rect = element.getBoundingClientRect();
  const fallback = axis === "width" ? rect.width : rect.height;
  return Number.isFinite(fallback) && fallback > 0 ? Math.ceil(fallback) : 0;
}

function normalizeMediaType(value: string, requested: CaptureMediaType): CaptureMediaType | null {
  const normalized = value.toLowerCase().split(";", 1)[0];
  return captureMediaTypes.includes(normalized as CaptureMediaType)
    ? normalized as CaptureMediaType
    : requested === normalized
      ? requested
      : null;
}

async function digestSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new CanvasVisualCaptureError("CANVAS_VISUAL_DIGEST_UNAVAILABLE");
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const digest = await subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof FileReader === "undefined") {
    throw new CanvasVisualCaptureError("CANVAS_VISUAL_BYTES_UNAVAILABLE");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new CanvasVisualCaptureError("CANVAS_VISUAL_BYTES_UNAVAILABLE"));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new CanvasVisualCaptureError("CANVAS_VISUAL_BYTES_UNAVAILABLE"));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  mediaType: CaptureMediaType,
  quality: number,
): Promise<Blob> {
  if (typeof canvas.toBlob !== "function") {
    return Promise.reject(new CanvasVisualCaptureError("CANVAS_VISUAL_ENCODER_UNAVAILABLE"));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new CanvasVisualCaptureError("CANVAS_VISUAL_RENDER_EMPTY"));
    }, mediaType, quality);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(result);
}

function uniquePositive(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0).map((value) => Number(value.toFixed(5))))];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Canvas visual capture aborted", "AbortError");
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Canvas visual capture aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Canvas visual capture aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withAbortTimeout<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException("Canvas visual capture aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Canvas visual capture aborted", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new CanvasVisualCaptureError(timeoutCode));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(new CanvasVisualCaptureError(timeoutCode));
      },
    );
  });
}
