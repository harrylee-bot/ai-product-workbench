import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { entityTagMatches, parseByteRange } from "../../common/byte-content.js";
import type { ReadyBlobStoragePort } from "./object-storage.port.js";
import { objectStorageUnavailableProblem } from "./object-storage.problems.js";

export type ReadyObjectPointer = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
};

export async function readReadyObject(
  storage: ReadyBlobStoragePort,
  pointer: ReadyObjectPointer,
  rangeHeader?: string,
  ifNoneMatch?: string,
) {
  const etag = `"${pointer.sha256}"`;
  if (entityTagMatches(ifNoneMatch, etag)) {
    return {
      notModified: true as const,
      etag,
      byteSize: pointer.byteSize,
      mediaType: pointer.mediaType,
    };
  }

  const range = parseByteRange(rangeHeader, pointer.byteSize);
  let stored;
  try {
    // A partial object cannot prove the immutable full-object digest. Always
    // verify the complete Blob and project the requested range from that stream.
    stored = await storage.getObject({ key: pointer.storageKey });
  } catch {
    throw objectStorageUnavailableProblem();
  }
  if (stored.byteSize !== pointer.byteSize) {
    stored.body.destroy();
    throw new Error("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");
  }
  if (stored.mediaType !== null && stored.mediaType !== pointer.mediaType) {
    stored.body.destroy();
    throw new Error("OBJECT_STORAGE_MEDIA_TYPE_MISMATCH");
  }
  if (stored.contentRange !== null) {
    stored.body.destroy();
    throw new Error("OBJECT_STORAGE_CONTENT_RANGE_MISMATCH");
  }
  const expectedByteSize = range ? range.end - range.start + 1 : pointer.byteSize;
  const contentRange = range
    ? `bytes ${range.start}-${range.end}/${pointer.byteSize}`
    : null;
  return {
    notModified: false as const,
    etag,
    body: Readable.from(verifiedObjectSlice(
      stored.body,
      pointer.byteSize,
      pointer.sha256,
      range ?? { start: 0, end: pointer.byteSize - 1 },
    )),
    byteSize: expectedByteSize,
    mediaType: pointer.mediaType,
    range,
    contentRange,
  };
}

async function* verifiedObjectSlice(
  source: Readable,
  expectedSourceBytes: number,
  expectedSha256: string,
  range: { start: number; end: number },
) {
  const digest = createHash("sha256");
  let sourceBytes = 0;
  let selectedBytes = 0;
  let heldByte: Buffer | null = null;

  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const chunkStart = sourceBytes;
      const chunkEnd = chunkStart + chunk.byteLength - 1;
      sourceBytes += chunk.byteLength;
      if (sourceBytes > expectedSourceBytes) throw new Error("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");
      digest.update(chunk);

      const selectedStart = Math.max(range.start, chunkStart);
      const selectedEnd = Math.min(range.end, chunkEnd);
      if (selectedStart > selectedEnd) continue;
      const selected = chunk.subarray(
        selectedStart - chunkStart,
        selectedEnd - chunkStart + 1,
      );
      selectedBytes += selected.byteLength;

      const pending: Buffer = heldByte
        ? Buffer.concat([heldByte, selected], heldByte.byteLength + selected.byteLength)
        : selected;
      if (pending.byteLength > 1) yield pending.subarray(0, pending.byteLength - 1);
      heldByte = Buffer.from(pending.subarray(pending.byteLength - 1));
    }

    const expectedSelectedBytes = range.end - range.start + 1;
    if (sourceBytes !== expectedSourceBytes || selectedBytes !== expectedSelectedBytes) {
      throw new Error("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");
    }
    if (digest.digest("hex") !== expectedSha256) {
      throw new Error("OBJECT_STORAGE_SHA256_MISMATCH");
    }
    if (heldByte) yield heldByte;
  } finally {
    source.destroy();
  }
}
