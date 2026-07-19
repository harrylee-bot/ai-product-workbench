/// <reference lib="webworker" />

import { createSHA256 } from "hash-wasm";

type DigestWorkerRequest = {
  type: "hash";
  blob: Blob;
  chunkSize: number;
};

type DigestWorkerResponse =
  | { type: "progress"; bytesHashed: number }
  | { type: "complete"; digest: string }
  | { type: "error"; message: string };

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<DigestWorkerRequest>) => {
  if (event.data.type !== "hash") return;
  void hash(event.data).catch((error: unknown) => {
    post({
      type: "error",
      message: error instanceof Error ? error.message : "UPLOAD_DIGEST_WORKER_FAILED",
    });
  });
};

async function hash({ blob, chunkSize }: DigestWorkerRequest) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("UPLOAD_DIGEST_WORKER_CHUNK_SIZE_INVALID");
  }
  const hasher = await createSHA256();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + chunkSize);
    hasher.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    offset = end;
    post({ type: "progress", bytesHashed: offset });
  }
  post({ type: "complete", digest: hasher.digest("hex") });
}

function post(message: DigestWorkerResponse) {
  workerScope.postMessage(message);
}
