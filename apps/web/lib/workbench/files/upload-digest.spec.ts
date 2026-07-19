import { describe, expect, it, vi } from "vitest";

import { sha256Blob, type WorkbenchDigestWorker } from "./upload-digest";

const HASH_CHUNK_SIZE = 4 * 1024 * 1024;
const VALID_DIGEST = "a".repeat(64);

type WorkerResponse = Parameters<
  NonNullable<WorkbenchDigestWorker["onmessage"]>
>[0]["data"];

function controlledWorker() {
  const worker: WorkbenchDigestWorker = {
    onmessage: null,
    onerror: null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };

  return {
    worker,
    emitMessage(data: WorkerResponse) {
      worker.onmessage?.({ data } as MessageEvent<WorkerResponse>);
    },
    emitError(message: string) {
      const preventDefault = vi.fn();
      worker.onerror?.({ message, preventDefault } as unknown as ErrorEvent);
      return preventDefault;
    },
  };
}

describe("sha256Blob worker", () => {
  it("reports valid progress, resolves the digest, and terminates the worker", async () => {
    const blob = new Blob(["workbench"]);
    const progress = vi.fn();
    const controlled = controlledWorker();

    const digestPromise = sha256Blob(blob, {
      workerFactory: () => controlled.worker,
      onProgress: progress,
    });

    expect(controlled.worker.postMessage).toHaveBeenCalledWith({
      type: "hash",
      blob,
      chunkSize: HASH_CHUNK_SIZE,
    });

    controlled.emitMessage({ type: "progress", bytesHashed: 4 });
    controlled.emitMessage({ type: "progress", bytesHashed: blob.size + 1 });
    controlled.emitMessage({ type: "complete", digest: VALID_DIGEST });

    await expect(digestPromise).resolves.toBe(VALID_DIGEST);
    expect(progress).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(4, blob.size);
    expect(controlled.worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker when hashing is aborted", async () => {
    const controller = new AbortController();
    const controlled = controlledWorker();
    const reason = new Error("digest cancelled");
    const digestPromise = sha256Blob(new Blob(["workbench"]), {
      signal: controller.signal,
      workerFactory: () => controlled.worker,
    });

    controller.abort(reason);

    await expect(digestPromise).rejects.toBe(reason);
    expect(controlled.worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a worker error event and prevents its default handling", async () => {
    const controlled = controlledWorker();
    const digestPromise = sha256Blob(new Blob(["workbench"]), {
      workerFactory: () => controlled.worker,
    });

    const preventDefault = controlled.emitError("worker crashed");

    await expect(digestPromise).rejects.toThrow("worker crashed");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(controlled.worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an error response from the worker", async () => {
    const controlled = controlledWorker();
    const digestPromise = sha256Blob(new Blob(["workbench"]), {
      workerFactory: () => controlled.worker,
    });

    controlled.emitMessage({ type: "error", message: "hash failed" });

    await expect(digestPromise).rejects.toThrow("hash failed");
    expect(controlled.worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an invalid digest returned by the worker", async () => {
    const controlled = controlledWorker();
    const digestPromise = sha256Blob(new Blob(["workbench"]), {
      workerFactory: () => controlled.worker,
    });

    controlled.emitMessage({ type: "complete", digest: "not-a-sha256" });

    await expect(digestPromise).rejects.toThrow("UPLOAD_DIGEST_WORKER_INVALID_RESULT");
    expect(controlled.worker.terminate).toHaveBeenCalledOnce();
  });
});
