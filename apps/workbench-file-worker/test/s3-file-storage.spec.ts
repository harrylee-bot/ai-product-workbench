import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { S3FileStorageAdapter } from "../src/storage/s3-file-storage.adapter.js";

const config = {
  s3Bucket: "workbench",
  s3Region: "us-east-1",
  s3InternalEndpoint: "http://s3.test",
  s3ForcePathStyle: true,
  s3ConditionalCreateMode: "s3-if-none-match" as const,
  filePipelineS3AccessKeyId: "file-pipeline-access",
  filePipelineS3SecretAccessKey: "file-pipeline-secret",
};

const bytes = Buffer.from("test");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const promoted = {
  sourceKey: "staging/project/upload",
  destinationKey: `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}/g1`,
  byteSize: bytes.byteLength,
  sha256,
  mediaType: "text/plain",
};

describe("S3FileStorageAdapter", () => {
  it("returns a streaming object with a validated positive size", async () => {
    const client = new FakeS3();
    const adapter = storageAdapter(client);

    await expect(adapter.getObject(promoted.sourceKey)).resolves.toMatchObject({
      byteSize: 4,
      mediaType: "application/octet-stream",
    });
    expect(client.commands[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("reuses an existing destination only after metadata and actual bytes match", async () => {
    const client = new FakeS3();
    client.destination = exactDestination();
    const adapter = storageAdapter(client);

    await adapter.promoteObject(promoted);

    expect(client.commands.filter((command) => command instanceof PutObjectCommand)).toHaveLength(0);
    expect(client.commands.some((command) => command instanceof GetObjectCommand)).toBe(true);
  });

  it("publishes with create-only PutObject and verifies the resulting bytes", async () => {
    const client = new FakeS3();
    const adapter = storageAdapter(client);

    await adapter.promoteObject(promoted);

    const put = client.commands.find((command) => command instanceof PutObjectCommand);
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put?.input).toMatchObject({
      Bucket: "workbench",
      Key: promoted.destinationKey,
      ContentLength: 4,
      ContentType: "text/plain",
      IfNoneMatch: "*",
      Metadata: { sha256, "byte-size": "4" },
    });
    expect(client.destination?.bytes.equals(bytes)).toBe(true);
  });

  it("streams generated content to a create-only content-addressed destination", async () => {
    const client = new FakeS3();
    const adapter = storageAdapter(client);

    await adapter.putContentAddressed({
      body: Readable.from([bytes]),
      destinationKey: promoted.destinationKey,
      byteSize: bytes.byteLength,
      sha256,
      mediaType: "text/plain",
    });

    const put = client.commands.find((command) => command instanceof PutObjectCommand);
    expect(put?.input).toMatchObject({
      Key: promoted.destinationKey,
      ContentLength: 4,
      IfNoneMatch: "*",
      Metadata: { sha256, "byte-size": "4" },
    });
    expect(client.destination?.bytes.equals(bytes)).toBe(true);
  });

  it("never overwrites a pre-existing destination with different identity", async () => {
    const client = new FakeS3();
    client.destination = {
      bytes: Buffer.from("evil"),
      mediaType: "text/plain",
      sha256: "b".repeat(64),
    };
    const adapter = storageAdapter(client);

    await expect(adapter.promoteObject(promoted)).rejects.toMatchObject({
      code: "FILE_STORAGE_DESTINATION_IDENTITY_CONFLICT",
    });
    expect(client.commands.filter((command) => command instanceof PutObjectCommand)).toHaveLength(0);
    expect(client.destination.bytes.toString()).toBe("evil");
  });

  it("handles a conditional-create race only when the winner stored identical bytes", async () => {
    const client = new FakeS3();
    client.preconditionRace = exactDestination();
    const adapter = storageAdapter(client);

    await expect(adapter.promoteObject(promoted)).resolves.toBeUndefined();

    const put = client.commands.find((command) => command instanceof PutObjectCommand);
    expect(put?.input.IfNoneMatch).toBe("*");
  });

  it("uses idempotent S3 deletion for staging cleanup", async () => {
    const client = new FakeS3();
    const adapter = storageAdapter(client);

    await adapter.deleteObject(promoted.sourceKey);

    expect(client.commands[0]).toBeInstanceOf(DeleteObjectCommand);
  });
});

type Destination = {
  bytes: Buffer;
  mediaType: string;
  sha256: string;
};

function storageAdapter(client: FakeS3) {
  return new S3FileStorageAdapter(
    config,
    vi.fn(async () => undefined),
    client as never,
  );
}

class FakeS3 {
  commands: Array<HeadObjectCommand | GetObjectCommand | PutObjectCommand | DeleteObjectCommand> = [];
  destination: Destination | null = null;
  preconditionRace: Destination | null = null;

  async send(command: HeadObjectCommand | GetObjectCommand | PutObjectCommand | DeleteObjectCommand) {
    this.commands.push(command);
    if (command instanceof HeadObjectCommand) {
      if (!this.destination) throw notFound();
      return {
        ContentLength: this.destination.bytes.byteLength,
        ContentType: this.destination.mediaType,
        Metadata: {
          sha256: this.destination.sha256,
          "byte-size": String(this.destination.bytes.byteLength),
        },
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = command.input.Key === promoted.sourceKey
        ? { bytes, mediaType: "application/octet-stream" }
        : this.destination;
      if (!object) throw notFound();
      return {
        Body: Readable.from([object.bytes]),
        ContentLength: object.bytes.byteLength,
        ContentType: object.mediaType,
      };
    }
    if (command instanceof PutObjectCommand) {
      if (this.preconditionRace) {
        this.destination = this.preconditionRace;
        this.preconditionRace = null;
        throw preconditionFailed();
      }
      if (this.destination) throw preconditionFailed();
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      this.destination = {
        bytes: Buffer.concat(chunks),
        mediaType: command.input.ContentType ?? "application/octet-stream",
        sha256: command.input.Metadata?.sha256 ?? "",
      };
      return {};
    }
    return {};
  }
}

function exactDestination(): Destination {
  return { bytes: Buffer.from(bytes), mediaType: "text/plain", sha256 };
}

function notFound() {
  return Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
}

function preconditionFailed() {
  return Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
}
