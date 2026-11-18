/// <reference lib="webworker" />

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

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
  const hasher = sha256.create();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + chunkSize);
    hasher.update(new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
    offset = end;
    post({ type: "progress", bytesHashed: offset });
  }
  post({ type: "complete", digest: bytesToHex(hasher.digest()) });
}

function post(message: DigestWorkerResponse) {
  workerScope.postMessage(message);
}
