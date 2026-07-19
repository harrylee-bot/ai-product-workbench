import { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { ObjectStorageConfig } from "./object-storage.config.js";
import type { ReadyBlobStoragePort, StoredObjectBody } from "./object-storage.port.js";
import { createS3Client } from "./s3-client.js";

@Injectable()
export class S3ReadyBlobStorageAdapter implements ReadyBlobStoragePort {
  private readonly client;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = createS3Client(config, config.readyBlobCredentials);
  }

  async getObject(input: { key: string; range?: { start: number; end: number } }): Promise<StoredObjectBody> {
    this.config.assertConfigured();
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ...(input.range ? { Range: `bytes=${input.range.start}-${input.range.end}` } : {}),
    }));
    if (!(result.Body instanceof Readable) || result.ContentLength === undefined) {
      throw new Error("S3 returned an unsupported object body");
    }
    return {
      body: result.Body,
      byteSize: safeStorageInteger(result.ContentLength),
      mediaType: result.ContentType ?? null,
      contentRange: result.ContentRange ?? null,
    };
  }
}

function safeStorageInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("S3 returned an unsafe object size");
  return value;
}
