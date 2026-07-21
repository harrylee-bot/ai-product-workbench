import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeVerifiedReadyObjectBody,
  stageReadyObject,
  type ReadyObjectIntegrityFailure,
  type VerifiedReadyObjectBody,
} from "../src/ready-object.js";

const trustedBytes = Buffer.from("0123456789", "utf8");
const manifest = {
  storageKey: "blobs/01/immutable/g1",
  sha256: createHash("sha256").update(trustedBytes).digest("hex"),
  byteSize: trustedBytes.byteLength,
  mediaType: "application/octet-stream",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("ready-object secure staging", () => {
  it("records a same-size digest mismatch before exposing any byte-bearing value", async () => {
    const tampered = Buffer.from("abcdefghij", "utf8");
    let recorderResolved = false;
    const recordIntegrityFailure = vi.fn(async (_failure: ReadyObjectIntegrityFailure) => {
      await Promise.resolve();
      recorderResolved = true;
    });
    let exposed: VerifiedReadyObjectBody | undefined;

    await expect((async () => {
      const staged = await stageReadyObject(manifest, async () => source(tampered), {
        recordIntegrityFailure,
      });
      exposed = staged.body;
    })()).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");

    expect(exposed).toBeUndefined();
    expect(recorderResolved).toBe(true);
    expect(recordIntegrityFailure).toHaveBeenCalledWith({
      failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
      storageKey: manifest.storageKey,
      expectedSha256: manifest.sha256,
      expectedByteSize: manifest.byteSize,
      expectedMediaType: manifest.mediaType,
      observedSha256: createHash("sha256").update(tampered).digest("hex"),
      observedByteSize: tampered.byteLength,
      observedMediaType: manifest.mediaType,
      observedContentRange: null,
    });
  });

  it("verifies the full object into an anonymous disk inode before exposing a range", async () => {
    const spoolDirectory = await secureSpoolDirectory();
    const staged = await stageReadyObject(manifest, async () => source(trustedBytes), {
      recordIntegrityFailure: vi.fn(async () => undefined),
      range: { start: 3, end: 6 },
      spoolDirectory,
      memoryThresholdBytes: 0,
      maximumObjectBytes: 100,
      maximumInFlightBytes: 100,
    });

    expect(await readdir(spoolDirectory)).toEqual([]);
    await expect(consumeVerifiedReadyObjectBody(staged.body, staged.byteSize))
      .resolves.toEqual(Buffer.from("3456"));
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("treats provider metadata as evidence rather than a trust root", async () => {
    const recordIntegrityFailure = vi.fn(async (_failure: ReadyObjectIntegrityFailure) => undefined);
    await expect(stageReadyObject(manifest, async () => ({
      ...source(trustedBytes),
      mediaType: "text/plain",
    }), { recordIntegrityFailure })).rejects.toThrow("OBJECT_STORAGE_MEDIA_TYPE_MISMATCH");
    await expect(stageReadyObject(manifest, async () => ({
      ...source(trustedBytes),
      contentRange: "bytes 0-9/10",
    }), { recordIntegrityFailure })).rejects.toThrow("OBJECT_STORAGE_CONTENT_RANGE_MISMATCH");

    expect(recordIntegrityFailure.mock.calls.map(([failure]) => failure.failureCode)).toEqual([
      "OBJECT_STORAGE_MEDIA_TYPE_MISMATCH",
      "OBJECT_STORAGE_CONTENT_RANGE_MISMATCH",
    ]);
  });

  it("fails closed when durable incident persistence does not commit", async () => {
    const recordIntegrityFailure = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(stageReadyObject(manifest, async () => source(Buffer.from("abcdefghij")), {
      recordIntegrityFailure,
    })).rejects.toThrow("READY_OBJECT_INTEGRITY_INCIDENT_PERSISTENCE_FAILED");
    expect(recordIntegrityFailure).toHaveBeenCalledOnce();
  });
});

function source(bytes: Buffer) {
  return {
    body: Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
    byteSize: manifest.byteSize,
    mediaType: manifest.mediaType,
    contentRange: null,
  };
}

async function secureSpoolDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "workbench-content-security-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
