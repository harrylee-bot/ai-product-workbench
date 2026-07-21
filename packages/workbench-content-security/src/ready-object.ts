import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MEMORY_THRESHOLD_BYTES = MEBIBYTE;
const DEFAULT_MAXIMUM_OBJECT_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAXIMUM_IN_FLIGHT_BYTES = 2 * DEFAULT_MAXIMUM_OBJECT_BYTES;
const DEFAULT_SPOOL_DIRECTORY = join(tmpdir(), "workbench-ready-object-spool");
const inFlightBytesBySpoolDirectory = new Map<string, number>();
const verifiedReadyObjectBodyBrand: unique symbol = Symbol("verified-ready-object-body");

export type ReadyObjectManifest = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
};

export type ReadyObjectSource = {
  body: Readable;
  byteSize: number | null;
  mediaType: string | null;
  contentRange: string | null;
};

export type ReadyObjectSourceLoader = (signal?: AbortSignal) => Promise<ReadyObjectSource>;

export type ReadyObjectByteRange = {
  start: number;
  end: number;
};

export type ReadyObjectStagingOptions = {
  recordIntegrityFailure: ReadyObjectIntegrityRecorder;
  range?: ReadyObjectByteRange;
  signal?: AbortSignal;
  spoolDirectory?: string;
  memoryThresholdBytes?: number;
  maximumObjectBytes?: number;
  maximumInFlightBytes?: number;
};

export const readyObjectIntegrityFailureCodes = [
  "OBJECT_STORAGE_BYTE_SIZE_MISMATCH",
  "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
  "OBJECT_STORAGE_CONTENT_RANGE_MISMATCH",
  "OBJECT_STORAGE_SHA256_MISMATCH",
] as const;

export type ReadyObjectIntegrityFailureCode = typeof readyObjectIntegrityFailureCodes[number];

export type ReadyObjectIntegrityFailure = {
  failureCode: ReadyObjectIntegrityFailureCode;
  storageKey: string;
  expectedSha256: string;
  expectedByteSize: number;
  expectedMediaType: string;
  observedSha256: string | null;
  observedByteSize: number | null;
  observedMediaType: string | null;
  observedContentRange: string | null;
};

export type ReadyObjectIntegrityRecorder = (
  failure: ReadyObjectIntegrityFailure,
) => Promise<void>;

export type VerifiedReadyObjectBody = Readable & {
  readonly [verifiedReadyObjectBodyBrand]: true;
};

export type VerifiedReadyObject = {
  manifest: Readonly<ReadyObjectManifest>;
  body: VerifiedReadyObjectBody;
  byteSize: number;
  range: ReadyObjectByteRange | null;
};

export class ReadyObjectIntegrityError extends Error {
  readonly name = "ReadyObjectIntegrityError";

  constructor(readonly failure: ReadyObjectIntegrityFailure) {
    super(failure.failureCode);
  }
}

/**
 * Materializes and verifies the complete immutable object before returning a
 * readable body. The returned stream is the only byte-bearing value exposed by
 * this API and is branded so downstream adapters cannot accidentally accept a
 * raw object-store stream.
 */
export async function stageReadyObject(
  manifest: ReadyObjectManifest,
  loadSource: ReadyObjectSourceLoader,
  options: ReadyObjectStagingOptions,
): Promise<VerifiedReadyObject> {
  assertReadyObjectManifest(manifest);
  const policy = stagingPolicy(options);
  if (manifest.byteSize > policy.maximumObjectBytes) {
    throw new Error("READY_OBJECT_MAXIMUM_BYTES_EXCEEDED");
  }
  const selectedRange = options.range ?? { start: 0, end: manifest.byteSize - 1 };
  assertReadyObjectRange(selectedRange, manifest.byteSize);
  assertNotAborted(options.signal);

  const releaseReservation = reserveInFlightBytes(
    policy.spoolDirectory,
    manifest.byteSize,
    policy.maximumInFlightBytes,
  );
  let source: ReadyObjectSource | null = null;

  try {
    source = await loadSource(options.signal);
    assertNotAborted(options.signal);
    const observedMetadata = assertSourceMetadata(source, manifest);
    const body = manifest.byteSize <= policy.memoryThresholdBytes
      ? await stageVerifiedObjectInMemory(
          source.body,
          manifest,
          selectedRange,
          observedMetadata,
          options.signal,
        )
      : await stageVerifiedObjectOnDisk(
          source.body,
          manifest,
          selectedRange,
          policy.spoolDirectory,
          observedMetadata,
          options.signal,
        );
    if (options.signal?.aborted) {
      body.destroy();
      throw abortReason(options.signal);
    }
    source = null;
    releaseReservationWhenDone(body, releaseReservation, options.signal);
    return {
      manifest: Object.freeze({ ...manifest }),
      body,
      byteSize: selectedRange.end - selectedRange.start + 1,
      range: options.range ?? null,
    };
  } catch (error) {
    source?.body.destroy();
    releaseReservation();
    if (error instanceof ReadyObjectIntegrityError) {
      try {
        await options.recordIntegrityFailure(error.failure);
      } catch {
        throw new Error("READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED");
      }
    }
    throw error;
  }
}

export async function consumeVerifiedReadyObjectBody(
  body: VerifiedReadyObjectBody,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    body.destroy();
    throw new Error("READY_OBJECT_CONSUMER_MAXIMUM_BYTES_INVALID");
  }
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteSize += chunk.byteLength;
      if (!Number.isSafeInteger(byteSize) || byteSize > maximumBytes) {
        throw new Error("READY_OBJECT_CONSUMER_MAXIMUM_BYTES_EXCEEDED");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, byteSize);
  } finally {
    body.destroy();
  }
}

function assertReadyObjectManifest(manifest: ReadyObjectManifest) {
  if (!manifest.storageKey.trim()) throw new Error("READY_OBJECT_STORAGE_KEY_INVALID");
  if (!Number.isSafeInteger(manifest.byteSize) || manifest.byteSize < 1) {
    throw new Error("READY_OBJECT_BYTE_SIZE_INVALID");
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
    throw new Error("READY_OBJECT_SHA256_INVALID");
  }
  if (!manifest.mediaType.trim()) throw new Error("READY_OBJECT_MEDIA_TYPE_INVALID");
}

function assertReadyObjectRange(range: ReadyObjectByteRange, byteSize: number) {
  if (
    !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || range.start < 0
    || range.end < range.start
    || range.end >= byteSize
  ) {
    throw new Error("READY_OBJECT_RANGE_INVALID");
  }
}

function assertSourceMetadata(source: ReadyObjectSource, manifest: ReadyObjectManifest) {
  const observed = {
    observedSha256: null,
    observedByteSize: source.byteSize,
    observedMediaType: source.mediaType,
    observedContentRange: source.contentRange,
  } as const;
  if (source.byteSize !== manifest.byteSize) {
    throw integrityError(manifest, "OBJECT_STORAGE_BYTE_SIZE_MISMATCH", observed);
  }
  if (source.mediaType !== manifest.mediaType) {
    throw integrityError(manifest, "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH", observed);
  }
  if (source.contentRange !== null) {
    throw integrityError(manifest, "OBJECT_STORAGE_CONTENT_RANGE_MISMATCH", observed);
  }
  return observed;
}

async function stageVerifiedObjectInMemory(
  source: Readable,
  manifest: ReadyObjectManifest,
  range: ReadyObjectByteRange,
  observedMetadata: ObservedReadyObjectMetadata,
  signal?: AbortSignal,
): Promise<VerifiedReadyObjectBody> {
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    for await (const value of source) {
      assertNotAborted(signal);
      const chunk = byteChunk(value);
      byteSize += chunk.byteLength;
      digest.update(chunk);
      if (byteSize > manifest.byteSize) {
        throw integrityError(manifest, "OBJECT_STORAGE_BYTE_SIZE_MISMATCH", {
          ...observedMetadata,
          observedByteSize: byteSize,
          observedSha256: digest.digest("hex"),
        });
      }
      chunks.push(chunk);
    }
    const observedSha256 = digest.digest("hex");
    assertObservedIdentity(manifest, observedMetadata, byteSize, observedSha256);
    const verified = Buffer.concat(chunks, manifest.byteSize);
    return verifiedBody(Readable.from([verified.subarray(range.start, range.end + 1)]));
  } finally {
    source.destroy();
  }
}

async function stageVerifiedObjectOnDisk(
  source: Readable,
  manifest: ReadyObjectManifest,
  range: ReadyObjectByteRange,
  spoolDirectory: string,
  observedMetadata: ObservedReadyObjectMetadata,
  signal?: AbortSignal,
): Promise<VerifiedReadyObjectBody> {
  let requestDirectory: string | null = null;
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  let streamOwnsFileHandle = false;
  try {
    await assertSecureSpoolDirectory(spoolDirectory);
    requestDirectory = await mkdtemp(join(spoolDirectory, "object-"));
    const filePath = join(requestDirectory, "verified-object");
    fileHandle = await open(filePath, "wx+", 0o600);

    // Keep the staged inode anonymous. Crashes, aborts, and failed verification
    // cannot leave plaintext object bytes addressable in the spool directory.
    await unlink(filePath);
    await rm(requestDirectory, { recursive: true, force: true });
    requestDirectory = null;

    const digest = createHash("sha256");
    let byteSize = 0;
    for await (const value of source) {
      assertNotAborted(signal);
      const chunk = byteChunk(value);
      byteSize += chunk.byteLength;
      digest.update(chunk);
      if (byteSize > manifest.byteSize) {
        throw integrityError(manifest, "OBJECT_STORAGE_BYTE_SIZE_MISMATCH", {
          ...observedMetadata,
          observedByteSize: byteSize,
          observedSha256: digest.digest("hex"),
        });
      }
      await writeComplete(fileHandle, chunk);
    }
    const observedSha256 = digest.digest("hex");
    assertObservedIdentity(manifest, observedMetadata, byteSize, observedSha256);

    const body = fileHandle.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: true,
      emitClose: true,
    });
    streamOwnsFileHandle = true;
    return verifiedBody(body);
  } finally {
    source.destroy();
    if (!streamOwnsFileHandle) await fileHandle?.close().catch(() => undefined);
    if (requestDirectory) {
      await rm(requestDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function assertObservedIdentity(
  manifest: ReadyObjectManifest,
  observedMetadata: ObservedReadyObjectMetadata,
  observedByteSize: number,
  observedSha256: string,
) {
  if (observedByteSize !== manifest.byteSize) {
    throw integrityError(manifest, "OBJECT_STORAGE_BYTE_SIZE_MISMATCH", {
      ...observedMetadata,
      observedByteSize,
      observedSha256,
    });
  }
  if (observedSha256 !== manifest.sha256) {
    throw integrityError(manifest, "OBJECT_STORAGE_SHA256_MISMATCH", {
      ...observedMetadata,
      observedByteSize,
      observedSha256,
    });
  }
}

type ObservedReadyObjectMetadata = Pick<
  ReadyObjectIntegrityFailure,
  "observedSha256" | "observedByteSize" | "observedMediaType" | "observedContentRange"
>;

function integrityError(
  manifest: ReadyObjectManifest,
  failureCode: ReadyObjectIntegrityFailureCode,
  observed: ObservedReadyObjectMetadata,
) {
  return new ReadyObjectIntegrityError({
    failureCode,
    storageKey: manifest.storageKey,
    expectedSha256: manifest.sha256,
    expectedByteSize: manifest.byteSize,
    expectedMediaType: manifest.mediaType,
    ...observed,
  });
}

function verifiedBody(body: Readable): VerifiedReadyObjectBody {
  return body as VerifiedReadyObjectBody;
}

function byteChunk(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error("READY_OBJECT_SOURCE_CHUNK_INVALID");
}

async function assertSecureSpoolDirectory(spoolDirectory: string) {
  await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(spoolDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("READY_OBJECT_SPOOL_DIRECTORY_INSECURE");
  }
}

async function writeComplete(fileHandle: Awaited<ReturnType<typeof open>>, chunk: Buffer) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await fileHandle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("READY_OBJECT_SPOOL_WRITE_FAILED");
    offset += bytesWritten;
  }
}

function stagingPolicy(options: ReadyObjectStagingOptions) {
  const memoryThresholdBytes = boundedInteger(
    options.memoryThresholdBytes ?? DEFAULT_MEMORY_THRESHOLD_BYTES,
    "memoryThresholdBytes",
    0,
  );
  const maximumObjectBytes = boundedInteger(
    options.maximumObjectBytes ?? DEFAULT_MAXIMUM_OBJECT_BYTES,
    "maximumObjectBytes",
    1,
  );
  const maximumInFlightBytes = boundedInteger(
    options.maximumInFlightBytes ?? DEFAULT_MAXIMUM_IN_FLIGHT_BYTES,
    "maximumInFlightBytes",
    1,
  );
  if (memoryThresholdBytes > maximumObjectBytes) {
    throw new Error("memoryThresholdBytes must not exceed maximumObjectBytes");
  }
  return {
    memoryThresholdBytes,
    maximumObjectBytes,
    maximumInFlightBytes,
    spoolDirectory: resolve(options.spoolDirectory ?? DEFAULT_SPOOL_DIRECTORY),
  };
}

function boundedInteger(value: number, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer no smaller than ${minimum}`);
  }
  return value;
}

function reserveInFlightBytes(spoolDirectory: string, byteSize: number, maximumBytes: number) {
  const current = inFlightBytesBySpoolDirectory.get(spoolDirectory) ?? 0;
  if (byteSize > maximumBytes || current > maximumBytes - byteSize) {
    throw new Error("READY_OBJECT_IN_FLIGHT_BYTES_EXCEEDED");
  }
  inFlightBytesBySpoolDirectory.set(spoolDirectory, current + byteSize);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const reserved = inFlightBytesBySpoolDirectory.get(spoolDirectory) ?? 0;
    const remaining = Math.max(0, reserved - byteSize);
    if (remaining === 0) inFlightBytesBySpoolDirectory.delete(spoolDirectory);
    else inFlightBytesBySpoolDirectory.set(spoolDirectory, remaining);
  };
}

function releaseReservationWhenDone(
  body: VerifiedReadyObjectBody,
  release: () => void,
  signal?: AbortSignal,
) {
  body.once("end", release);
  body.once("close", release);
  body.once("error", release);
  if (!signal) return;
  const abort = () => body.destroy(abortReason(signal));
  if (signal.aborted) abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    body.once("close", () => signal.removeEventListener("abort", abort));
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Ready object staging aborted", "AbortError");
}
