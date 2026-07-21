import { createHash } from "node:crypto";
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
    const bytes = Buffer.from("test");
    const body = Readable.from([bytes]);
    const client = {
      send: vi.fn().mockResolvedValue({
        Body: body,
        ContentLength: 4,
        ContentType: "text/plain",
      }),
    };
    const adapter = new S3RuntimeReadyBlobReader(
      config,
      vi.fn(async () => undefined),
      client as never,
    );

    const result = await adapter.getObject({
      storageKey: "blobs/verified",
      byteSize: 4,
      mediaType: "text/plain",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    expect(result).toMatchObject({ byteSize: 4, mediaType: "text/plain" });
    await expect(readAll(result.body)).resolves.toEqual(bytes);
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
    const adapter = new S3RuntimeReadyBlobReader(
      config,
      vi.fn(async () => undefined),
      client as never,
    );

    await expect(adapter.getObject({
      storageKey: "blobs/verified",
      byteSize: 4,
      mediaType: "text/plain",
      sha256: "a".repeat(64),
    })).rejects.toThrow("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");
    expect(destroy).toHaveBeenCalled();
  });
});

async function readAll(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of body) chunks.push(Buffer.from(value));
  return Buffer.concat(chunks);
}
