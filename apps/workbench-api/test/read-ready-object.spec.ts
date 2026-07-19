import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { readReadyObject } from "../src/platform/object-storage/read-ready-object.js";

const bytes = Buffer.from("0123456789", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const pointer = {
  storageKey: "blobs/01/hash/g1",
  sha256,
  byteSize: bytes.byteLength,
  mediaType: "application/octet-stream",
};

describe("readReadyObject byte integrity", () => {
  it("streams a full object only when its bytes match the trusted DB digest", async () => {
    const storage = objectStorage(bytes);
    const result = await readReadyObject(storage as never, pointer);

    expect(await consume(result.body)).toEqual(bytes);
    expect(storage.getObject).toHaveBeenCalledWith({ key: pointer.storageKey });
  });

  it("verifies the complete object before completing a range response", async () => {
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

  it("fails a same-size metadata-spoofed object before the response can complete", async () => {
    const tampered = Buffer.from("abcdefghij", "utf8");
    const result = await readReadyObject(objectStorage(tampered) as never, pointer);

    await expect(consume(result.body)).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");
  });

  it("fails closed for truncation and contradictory range metadata", async () => {
    const truncated = objectStorage(bytes.subarray(0, 9), { byteSize: 10 });
    const truncatedResult = await readReadyObject(truncated as never, pointer);
    await expect(consume(truncatedResult.body)).rejects.toThrow("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");

    const ranged = objectStorage(bytes, { contentRange: "bytes 0-9/10" });
    await expect(readReadyObject(ranged as never, pointer)).rejects.toThrow(
      "OBJECT_STORAGE_CONTENT_RANGE_MISMATCH",
    );
  });

  it("does not access object storage for a matching immutable ETag", async () => {
    const storage = objectStorage(bytes);
    await expect(readReadyObject(storage as never, pointer, undefined, `W/"${sha256}"`))
      .resolves.toMatchObject({ notModified: true });
    expect(storage.getObject).not.toHaveBeenCalled();
  });
});

function objectStorage(
  body: Buffer,
  overrides: { byteSize?: number; contentRange?: string | null } = {},
) {
  return {
    getObject: vi.fn(async () => ({
      body: Readable.from(chunk(body)),
      byteSize: overrides.byteSize ?? body.byteLength,
      mediaType: pointer.mediaType,
      contentRange: overrides.contentRange ?? null,
    })),
  };
}

function chunk(value: Buffer) {
  return [value.subarray(0, 2), value.subarray(2, 7), value.subarray(7)];
}

async function consume(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.from(value));
  return Buffer.concat(chunks);
}
