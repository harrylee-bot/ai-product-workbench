import { createSHA256 } from "hash-wasm";

const HASH_CHUNK_SIZE = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type DigestWorkerRequest = {
  type: "hash";
  blob: Blob;
  chunkSize: number;
};

type DigestWorkerResponse =
  | { type: "progress"; bytesHashed: number }
  | { type: "complete"; digest: string }
  | { type: "error"; message: string };

export type WorkbenchDigestWorker = {
  onmessage: ((event: MessageEvent<DigestWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DigestWorkerRequest): void;
  terminate(): void;
};

export type Sha256BlobOptions = {
  signal?: AbortSignal;
  onProgress?: (bytesHashed: number, byteSize: number) => void;
  workerFactory?: () => WorkbenchDigestWorker;
};

export async function sha256Blob(
  blob: Blob,
  options: Sha256BlobOptions = {},
): Promise<string> {
  if (options.workerFactory || typeof window !== "undefined") {
    if (!options.workerFactory && typeof Worker === "undefined") {
      throw new Error("UPLOAD_DIGEST_WORKER_UNAVAILABLE");
    }
    return sha256BlobInWorker(blob, options);
  }
  return sha256BlobOutsideBrowser(blob, options);
}

async function sha256BlobInWorker(blob: Blob, options: Sha256BlobOptions): Promise<string> {
  throwIfAborted(options.signal);
  const worker: WorkbenchDigestWorker = options.workerFactory?.() ?? new Worker(
    new URL("./upload-digest.worker.ts", import.meta.url),
    { name: "workbench-upload-digest", type: "module" },
  );

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const fail = (error: unknown) => settle(() => reject(normalizeError(error)));
    const onAbort = () => fail(abortError(options.signal));

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "progress") {
        if (Number.isSafeInteger(message.bytesHashed)
          && message.bytesHashed >= 0
          && message.bytesHashed <= blob.size) {
          options.onProgress?.(message.bytesHashed, blob.size);
        }
        return;
      }
      if (message.type === "error") {
        fail(new Error(message.message || "UPLOAD_DIGEST_WORKER_FAILED"));
        return;
      }
      if (!SHA256_PATTERN.test(message.digest)) {
        fail(new Error("UPLOAD_DIGEST_WORKER_INVALID_RESULT"));
        return;
      }
      settle(() => resolve(message.digest));
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      fail(new Error(event.message || "UPLOAD_DIGEST_WORKER_FAILED"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      worker.postMessage({ type: "hash", blob, chunkSize: HASH_CHUNK_SIZE });
    } catch (error) {
      fail(error);
    }
  });
}

// Vitest runs without a browser Worker. Production browsers never use this path.
async function sha256BlobOutsideBrowser(blob: Blob, options: Sha256BlobOptions): Promise<string> {
  const hasher = await createSHA256();
  let offset = 0;
  while (offset < blob.size) {
    throwIfAborted(options.signal);
    const end = Math.min(blob.size, offset + HASH_CHUNK_SIZE);
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    throwIfAborted(options.signal);
    hasher.update(bytes);
    offset = end;
    options.onProgress?.(offset, blob.size);
  }
  const digest = hasher.digest("hex");
  if (!SHA256_PATTERN.test(digest)) throw new Error("UPLOAD_DIGEST_INVALID_RESULT");
  return digest;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The upload digest was aborted", "AbortError");
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error("UPLOAD_DIGEST_WORKER_FAILED");
}
