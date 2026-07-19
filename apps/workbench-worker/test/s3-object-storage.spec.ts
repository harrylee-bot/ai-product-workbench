import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { S3RuntimeReadyBlobReader } from "../src/storage/s3-runtime-ready-blob-reader.js";

const config = {
  s3Bucket: "workbench",
  s3Region: "us-east-1",
  s3InternalEndpoint: "http://s3.test",
  s3ForcePathStyle: true,
  runtimeReadyBlobS3AccessKeyId: "runtime-access",
  runtimeReadyBlobS3SecretAccessKey: "runtime-secret",
};

describe("S3 runtime source reader", () => {
  it("returns a stream only when S3 size matches the immutable locator", async () => {
    const body = Readable.from([Buffer.from("test")]);
    const client = {
      send: vi.fn().mockResolvedValue({
        Body: body,
        ContentLength: 4,
        ContentType: "text/plain",
      }),
    };
    const adapter = new S3RuntimeReadyBlobReader(config, client as never);

    const result = await adapter.getObject({
      storageKey: "blobs/verified",
      byteSize: 4,
      mediaType: "text/plain",
      sha256: "a".repeat(64),
    });

    expect(result).toEqual({ body, byteSize: 4, mediaType: "text/plain" });
    const command = client.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: "workbench", Key: "blobs/verified" });
  });

  it("destroys a stream whose reported size differs from the snapshot", async () => {
    const body = Readable.from([Buffer.from("wrong")]);
    const destroy = vi.spyOn(body, "destroy");
    const client = {
      send: vi.fn().mockResolvedValue({ Body: body, ContentLength: 5 }),
    };
    const adapter = new S3RuntimeReadyBlobReader(config, client as never);

    await expect(adapter.getObject({
      storageKey: "blobs/verified",
      byteSize: 4,
      mediaType: "text/plain",
      sha256: "a".repeat(64),
    })).rejects.toThrow("RUNTIME_SOURCE_STORAGE_SIZE_MISMATCH");
    expect(destroy).toHaveBeenCalled();
  });
});
