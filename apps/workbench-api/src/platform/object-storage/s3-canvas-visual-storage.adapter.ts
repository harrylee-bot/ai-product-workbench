import { Injectable } from "@nestjs/common";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { ObjectStorageConfig } from "./object-storage.config.js";
import type {
  CanvasVisualStoragePort,
  StoredObjectBody,
} from "./object-storage.port.js";
import { createS3Client } from "./s3-client.js";

@Injectable()
export class S3CanvasVisualStorageAdapter implements CanvasVisualStoragePort {
  private readonly client;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = createS3Client(config, config.canvasVisualCredentials);
  }

  async putObject(input: {
    key: string;
    body: Uint8Array;
    byteSize: number;
    mediaType: string;
    sha256: string;
  }): Promise<void> {
    this.config.assertConfigured();
    if (input.body.byteLength !== input.byteSize) {
      throw new Error("CANVAS_VISUAL_STORAGE_SIZE_MISMATCH");
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      Body: input.body,
      ContentLength: input.byteSize,
      ContentType: input.mediaType,
      ChecksumSHA256: Buffer.from(input.sha256, "hex").toString("base64"),
      Metadata: { sha256: input.sha256 },
    }));
  }

  async getObject(input: { key: string; range?: { start: number; end: number } }): Promise<StoredObjectBody> {
    this.config.assertConfigured();
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ...(input.range ? { Range: `bytes=${input.range.start}-${input.range.end}` } : {}),
    }));
    if (!result.Body || result.ContentLength === undefined) {
      throw new Error("CANVAS_VISUAL_STORAGE_OBJECT_INVALID");
    }
    return {
      body: toNodeReadable(result.Body),
      byteSize: safeByteSize(result.ContentLength),
      mediaType: result.ContentType ?? null,
      contentRange: result.ContentRange ?? null,
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.config.assertConfigured();
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    }));
  }
}

function toNodeReadable(value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (value && typeof value === "object" && Symbol.asyncIterator in value) {
    return Readable.from(value as AsyncIterable<Uint8Array>);
  }
  throw new Error("CANVAS_VISUAL_STORAGE_BODY_INVALID");
}

function safeByteSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_048_576) {
    throw new Error("CANVAS_VISUAL_STORAGE_SIZE_INVALID");
  }
  return value;
}
