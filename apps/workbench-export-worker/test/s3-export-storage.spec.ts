import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3ExportStorageAdapter } from "../src/storage/s3-export-storage.adapter.js";

const expectedBytes = Buffer.from("expected export");
const identity = {
  storageKey: "blobs/aa/output/g1",
  byteSize: expectedBytes.byteLength,
  sha256: createHash("sha256").update(expectedBytes).digest("hex"),
  mediaType: "text/html; charset=utf-8",
};

describe("S3ExportStorageAdapter", () => {
  it("does not delete a raced writer's object when byte verification fails", async () => {
    let heads = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        heads += 1;
        if (heads === 1) throw { name: "NotFound" };
        return headIdentity();
      }
      if (command instanceof PutObjectCommand) throw { name: "PreconditionFailed" };
      if (command instanceof GetObjectCommand) return {
        Body: Readable.from([Buffer.alloc(identity.byteSize, 1)]),
        ContentLength: identity.byteSize,
        ContentType: identity.mediaType,
      };
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("unexpected command");
    });
    let recorderResolved = false;
    const recordIntegrityFailure = vi.fn(async () => {
      await Promise.resolve();
      recorderResolved = true;
    });
    const storage = new S3ExportStorageAdapter(
      config(),
      recordIntegrityFailure,
      { send } as never,
    );
    await expect(storage.putVerified(identity, expectedBytes)).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");
    expect(recorderResolved).toBe(true);
    expect(recordIntegrityFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
      storageKey: identity.storageKey,
    }));
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });

  it("cleans up only an object created by this attempt when verification fails", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw { name: "NotFound" };
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof GetObjectCommand) return {
        Body: Readable.from([Buffer.alloc(identity.byteSize, 1)]),
        ContentLength: identity.byteSize,
        ContentType: identity.mediaType,
      };
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("unexpected command");
    });
    const recordIntegrityFailure = vi.fn(async () => undefined);
    const storage = new S3ExportStorageAdapter(
      config(),
      recordIntegrityFailure,
      { send } as never,
    );
    await expect(storage.putVerified(identity, expectedBytes)).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");
    expect(recordIntegrityFailure).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
  });
});

function headIdentity() {
  return {
    ContentLength: identity.byteSize,
    ContentType: identity.mediaType,
    Metadata: { sha256: identity.sha256, "byte-size": String(identity.byteSize) },
  };
}

function config() {
  return {
    s3Bucket: "workbench",
    s3Region: "us-east-1",
    s3InternalEndpoint: "http://127.0.0.1:9000",
    s3ForcePathStyle: true,
    s3ConditionalCreateMode: "s3-if-none-match" as const,
    exportS3AccessKeyId: "export-access",
    exportS3SecretAccessKey: "export-secret",
  };
}
