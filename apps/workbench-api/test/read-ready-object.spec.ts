import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readReadyObject as readReadyObjectWithoutRecorder,
  type ReadyObjectIntegrityFailure,
  type ReadyObjectReadOptions,
  type ReadyObjectPointer,
} from "../src/platform/object-storage/read-ready-object.js";

const bytes = Buffer.from("0123456789", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const pointer = {
  storageKey: "blobs/01/hash/g1",
  sha256,
  byteSize: bytes.byteLength,
  mediaType: "application/octet-stream",
};
const temporaryDirectories: string[] = [];
const recordIntegrityFailure = vi.fn(async (_failure: ReadyObjectIntegrityFailure) => undefined);

afterEach(async () => {
  recordIntegrityFailure.mockClear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("readReadyObject byte integrity", () => {
  it("returns a full object only after its bytes match the trusted DB digest", async () => {
    const storage = objectStorage(bytes);
    const result = await readReadyObject(storage as never, pointer);

    expect(await consume(result.body)).toEqual(bytes);
    expect(storage.getObject).toHaveBeenCalledWith({ key: pointer.storageKey });
  });

  it("verifies the complete object before exposing a range response", async () => {
    const storage = objectStorage(bytes);
    const result = await readReadyObject(storage as never, pointer, "bytes=3-6");

    expect(await consume(result.body)).toEqual(Buffer.from("3456"));
    expect(result).toMatchObject({
      byteSize: 4,
      range: { start: 3, end: 6 },
      contentRange: "bytes 3-6/10",
    });
    expect(storage.getObject).toHaveBeenCalledWith({ key: pointer.storageKey });
  });

  it("emits zero response bytes for a same-size metadata-spoofed object", async () => {
    const tampered = Buffer.from("abcdefghij", "utf8");
    const spoolDirectory = await secureSpoolDirectory();
    let exposedBody: Readable | undefined;

    await expect((async () => {
      const result = await readReadyObject(
        objectStorage(tampered) as never,
        pointer,
        undefined,
        undefined,
        diskOptions(spoolDirectory),
      );
      exposedBody = result.body;
      return consume(result.body);
    })()).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");
    expect(exposedBody).toBeUndefined();
    expect(recordIntegrityFailure).toHaveBeenCalledOnce();
    expect(recordIntegrityFailure).toHaveBeenCalledWith({
      failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
      storageKey: pointer.storageKey,
      expectedSha256: pointer.sha256,
      expectedByteSize: pointer.byteSize,
      expectedMediaType: pointer.mediaType,
      observedSha256: createHash("sha256").update(tampered).digest("hex"),
      observedByteSize: tampered.byteLength,
      observedMediaType: pointer.mediaType,
      observedContentRange: null,
    });
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("emits zero response bytes for truncation and contradictory metadata", async () => {
    const spoolDirectory = await secureSpoolDirectory();
    const truncated = objectStorage(bytes.subarray(0, 9), { byteSize: 10 });
    await expect(readReadyObject(
      truncated as never,
      pointer,
      undefined,
      undefined,
      diskOptions(spoolDirectory),
    ))
      .rejects.toThrow("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");
    expect(await readdir(spoolDirectory)).toEqual([]);

    const ranged = objectStorage(bytes, { contentRange: "bytes 0-9/10" });
    await expect(readReadyObject(ranged as never, pointer)).rejects.toThrow(
      "OBJECT_STORAGE_CONTENT_RANGE_MISMATCH",
    );

    const wrongType = objectStorage(bytes, { mediaType: "text/plain" });
    await expect(readReadyObject(wrongType as never, pointer)).rejects.toThrow(
      "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
    );

    const missingType = objectStorage(bytes, { mediaType: null });
    await expect(readReadyObject(missingType as never, pointer)).rejects.toThrow(
      "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
    );
    expect(recordIntegrityFailure.mock.calls.map(([failure]) => failure.failureCode)).toEqual([
      "OBJECT_STORAGE_BYTE_SIZE_MISMATCH",
      "OBJECT_STORAGE_CONTENT_RANGE_MISMATCH",
      "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
      "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
    ]);
  });

  it("fails closed when the durable incident transaction cannot commit", async () => {
    const persistenceFailure = vi.fn(async () => Promise.reject(new Error("database unavailable")));
    let exposedBody: Readable | undefined;

    await expect((async () => {
      const result = await readReadyObjectWithoutRecorder(
        objectStorage(Buffer.from("abcdefghij")) as never,
        pointer,
        undefined,
        undefined,
        { recordIntegrityFailure: persistenceFailure },
      );
      exposedBody = result.body;
      return consume(result.body);
    })()).rejects.toThrow("READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED");
    expect(exposedBody).toBeUndefined();
    expect(persistenceFailure).toHaveBeenCalledOnce();
  });

  it("does not access object storage for a matching immutable ETag", async () => {
    const storage = objectStorage(bytes);
    await expect(readReadyObject(storage as never, pointer, undefined, `W/"${sha256}"`))
      .resolves.toMatchObject({ notModified: true });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("preserves cancellation while object storage is resolving response headers", async () => {
    const storageAbort = new DOMException("S3 request aborted", "AbortError");
    await expect(readReadyObject(rejectingStorage(storageAbort) as never, pointer))
      .rejects.toBe(storageAbort);

    const controller = new AbortController();
    const disconnectReason = new DOMException("client disconnected", "AbortError");
    const storage = {
      getObject: vi.fn(async () => {
        controller.abort(disconnectReason);
        throw storageAbort;
      }),
    };
    await expect(readReadyObject(
      storage as never,
      pointer,
      undefined,
      undefined,
      { signal: controller.signal },
    )).rejects.toBe(disconnectReason);
  });

  it("maps non-cancellation object storage header failures to unavailable", async () => {
    await expect(readReadyObject(
      rejectingStorage(new Error("connection reset")) as never,
      pointer,
    )).rejects.toMatchObject({
      status: 502,
      response: expect.objectContaining({ code: "OBJECT_STORAGE_UNAVAILABLE" }),
    });
  });

  it("uses an unlinked secure disk spool for larger objects and releases it after success", async () => {
    const spoolDirectory = await secureSpoolDirectory();
    const result = await readReadyObject(objectStorage(bytes) as never, pointer, "bytes=2-7", undefined, {
      spoolDirectory,
      memoryThresholdBytes: 1,
      maximumObjectBytes: 100,
      maximumInFlightBytes: 100,
    });

    expect(await readdir(spoolDirectory)).toEqual([]);
    await expect(consume(result.body)).resolves.toEqual(Buffer.from("234567"));
    expect(result.body.closed).toBe(true);
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("closes the anonymous spool and releases its byte budget when the response aborts", async () => {
    const spoolDirectory = await secureSpoolDirectory();
    const options = {
      spoolDirectory,
      memoryThresholdBytes: 1,
      maximumObjectBytes: 100,
      maximumInFlightBytes: bytes.byteLength,
    };
    const first = await readReadyObject(objectStorage(bytes) as never, pointer, undefined, undefined, options);

    await expect(readReadyObject(objectStorage(bytes) as never, pointer, undefined, undefined, options))
      .rejects.toThrow("READY_OBJECT_IN_FLIGHT_BYTES_EXCEEDED");
    first.body.once("error", () => undefined);
    const closed = new Promise<void>((resolve) => first.body.once("close", resolve));
    first.body.destroy(new DOMException("client disconnected", "AbortError"));
    await closed;
    expect(first.body.closed).toBe(true);
    expect(await readdir(spoolDirectory)).toEqual([]);

    const recovered = await readReadyObject(
      objectStorage(bytes) as never,
      pointer,
      undefined,
      undefined,
      options,
    );
    await expect(consume(recovered.body)).resolves.toEqual(bytes);
  });

  it("removes the anonymous spool and releases its budget when verification aborts or errors", async () => {
    const spoolDirectory = await secureSpoolDirectory();
    const options = diskOptions(spoolDirectory);
    const controller = new AbortController();
    const abortedStorage = streamStorage(Readable.from((async function* () {
      yield bytes.subarray(0, 2);
      controller.abort(new DOMException("client disconnected", "AbortError"));
      yield bytes.subarray(2);
    })()));

    await expect(readReadyObject(
      abortedStorage as never,
      pointer,
      undefined,
      undefined,
      { ...options, signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedStorage.getObject).toHaveBeenCalledWith({
      key: pointer.storageKey,
      signal: controller.signal,
    });
    expect(await readdir(spoolDirectory)).toEqual([]);

    const failedStorage = streamStorage(Readable.from((async function* () {
      yield bytes.subarray(0, 2);
      throw new Error("object store stream failed");
    })()));
    await expect(readReadyObject(
      failedStorage as never,
      pointer,
      undefined,
      undefined,
      options,
    )).rejects.toThrow("object store stream failed");
    expect(await readdir(spoolDirectory)).toEqual([]);

    const recovered = await readReadyObject(
      objectStorage(bytes) as never,
      pointer,
      undefined,
      undefined,
      options,
    );
    await expect(consume(recovered.body)).resolves.toEqual(bytes);
  });
});

function objectStorage(
  body: Buffer,
  overrides: {
    byteSize?: number;
    contentRange?: string | null;
    mediaType?: string | null;
  } = {},
) {
  return {
    getObject: vi.fn(async () => ({
      body: Readable.from(chunk(body)),
      byteSize: overrides.byteSize ?? body.byteLength,
      mediaType: Object.hasOwn(overrides, "mediaType") ? overrides.mediaType! : pointer.mediaType,
      contentRange: overrides.contentRange ?? null,
    })),
  };
}

function streamStorage(body: Readable) {
  return {
    getObject: vi.fn(async () => ({
      body,
      byteSize: pointer.byteSize,
      mediaType: pointer.mediaType,
      contentRange: null,
    })),
  };
}

function rejectingStorage(error: Error) {
  return { getObject: vi.fn(async () => Promise.reject(error)) };
}

function chunk(value: Buffer) {
  return [value.subarray(0, 2), value.subarray(2, 7), value.subarray(7)];
}

async function consume(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.from(value));
  return Buffer.concat(chunks);
}

async function secureSpoolDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "workbench-ready-object-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function diskOptions(spoolDirectory: string) {
  return {
    spoolDirectory,
    memoryThresholdBytes: 1,
    maximumObjectBytes: 100,
    maximumInFlightBytes: 100,
  };
}

function readReadyObject(
  storage: Parameters<typeof readReadyObjectWithoutRecorder>[0],
  readyPointer: ReadyObjectPointer,
  rangeHeader?: string,
  ifNoneMatch?: string,
  options: Omit<ReadyObjectReadOptions, "recordIntegrityFailure"> = {},
) {
  return readReadyObjectWithoutRecorder(storage, readyPointer, rangeHeader, ifNoneMatch, {
    ...options,
    recordIntegrityFailure,
  });
}
