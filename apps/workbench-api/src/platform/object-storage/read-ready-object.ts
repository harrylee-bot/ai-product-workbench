import {
  ReadyObjectIntegrityError,
  readyObjectIntegrityFailureCodes,
  stageReadyObject,
  type ReadyObjectIntegrityFailure,
  type ReadyObjectIntegrityFailureCode,
  type ReadyObjectIntegrityRecorder,
  type ReadyObjectManifest,
  type ReadyObjectStagingOptions,
} from "@workbench/workbench-content-security";
import { entityTagMatches, parseByteRange } from "../../common/byte-content.js";
import type { ReadyBlobStoragePort } from "./object-storage.port.js";
import { objectStorageUnavailableProblem } from "./object-storage.problems.js";

export {
  ReadyObjectIntegrityError,
  readyObjectIntegrityFailureCodes,
};
export type {
  ReadyObjectIntegrityFailure,
  ReadyObjectIntegrityFailureCode,
  ReadyObjectIntegrityRecorder,
};

export type ReadyObjectPointer = ReadyObjectManifest;

export type ReadyObjectReadOptions = Omit<ReadyObjectStagingOptions, "range">;

export async function readReadyObject(
  storage: ReadyBlobStoragePort,
  pointer: ReadyObjectPointer,
  rangeHeader: string | undefined,
  ifNoneMatch: string | undefined,
  options: ReadyObjectReadOptions,
) {
  assertReadyObjectPointer(pointer);
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
  const staged = await stageReadyObject(pointer, async (signal) => {
    try {
      return await storage.getObject({
        key: pointer.storageKey,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw objectStorageUnavailableProblem();
    }
  }, {
    ...options,
    ...(range ? { range } : {}),
    ...(options.spoolDirectory
      ? {}
      : process.env.WORKBENCH_READY_OBJECT_SPOOL_DIR?.trim()
        ? { spoolDirectory: process.env.WORKBENCH_READY_OBJECT_SPOOL_DIR.trim() }
        : {}),
  });

  return {
    notModified: false as const,
    etag,
    body: staged.body,
    byteSize: staged.byteSize,
    mediaType: pointer.mediaType,
    range,
    contentRange: range
      ? `bytes ${range.start}-${range.end}/${pointer.byteSize}`
      : null,
  };
}

function assertReadyObjectPointer(pointer: ReadyObjectPointer) {
  if (!pointer.storageKey.trim()) throw new Error("READY_OBJECT_STORAGE_KEY_INVALID");
  if (!Number.isSafeInteger(pointer.byteSize) || pointer.byteSize < 1) {
    throw new Error("READY_OBJECT_BYTE_SIZE_INVALID");
  }
  if (!/^[a-f0-9]{64}$/u.test(pointer.sha256)) {
    throw new Error("READY_OBJECT_SHA256_INVALID");
  }
  if (!pointer.mediaType.trim()) throw new Error("READY_OBJECT_MEDIA_TYPE_INVALID");
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Ready object read aborted", "AbortError");
}
