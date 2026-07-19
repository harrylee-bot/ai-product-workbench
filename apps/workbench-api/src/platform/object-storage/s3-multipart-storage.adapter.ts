import { Injectable } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ObjectStorageConfig } from "./object-storage.config.js";
import type {
  MultipartStoragePort,
  StoredMultipartPart,
  StoredObjectMetadata,
} from "./object-storage.port.js";
import { createS3BrowserUploadClient, createS3Client } from "./s3-client.js";

@Injectable()
export class S3MultipartStorageAdapter implements MultipartStoragePort {
  private readonly client;
  private readonly browserUploadClient;

  constructor(private readonly config: ObjectStorageConfig) {
    this.client = createS3Client(config, config.stagingCredentials);
    this.browserUploadClient = createS3BrowserUploadClient(config, config.stagingCredentials);
  }

  async createMultipartUpload(input: { key: string; mediaType: string; metadata: Record<string, string> }) {
    this.config.assertConfigured();
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ContentType: input.mediaType,
      Metadata: input.metadata,
    }));
    if (!result.UploadId) throw new Error("S3 did not return a multipart upload id");
    return { uploadId: result.UploadId };
  }

  async signMultipartPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    expiresInSeconds: number;
  }) {
    this.config.assertConfigured();
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000);
    const url = await getSignedUrl(
      this.browserUploadClient,
      new UploadPartCommand({
        Bucket: this.config.browserUploadBucketUrl,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        ContentLength: input.contentLength,
      }),
      { expiresIn: input.expiresInSeconds },
    );
    if (new URL(url).origin !== new URL(this.config.browserUploadBucketUrl).origin) {
      throw new Error("S3 browser upload signer returned an unexpected origin");
    }
    return { url, headers: {}, expiresAt };
  }

  async listMultipartParts(input: { key: string; uploadId: string }) {
    this.config.assertConfigured();
    const parts: StoredMultipartPart[] = [];
    let marker: string | undefined;
    do {
      const result = await this.client.send(new ListPartsCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumberMarker: marker,
        MaxParts: 1_000,
      }));
      for (const part of result.Parts ?? []) {
        if (!part.PartNumber || !part.ETag || part.Size === undefined) {
          throw new Error("S3 returned an incomplete multipart part record");
        }
        parts.push({
          partNumber: part.PartNumber,
          etag: normalizeEtag(part.ETag),
          byteSize: safeStorageInteger(part.Size, true),
        });
      }
      if (parts.length > 10_000) throw new Error("S3 returned more than 10,000 multipart parts");
      marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
      if (result.IsTruncated && !marker) throw new Error("S3 truncated ListParts without a continuation marker");
    } while (marker !== undefined);
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }) {
    this.config.assertConfigured();
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }));
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }) {
    this.config.assertConfigured();
    try {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }));
    } catch (error) {
      if (!isNoSuchUpload(error)) throw error;
    }
  }

  async statObject(key: string): Promise<StoredObjectMetadata | null> {
    this.config.assertConfigured();
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }));
      if (result.ContentLength === undefined) throw new Error("S3 object has no Content-Length");
      return {
        byteSize: safeStorageInteger(result.ContentLength),
        mediaType: result.ContentType ?? null,
        etag: result.ETag ? normalizeEtag(result.ETag) : null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

export function normalizeEtag(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed : `"${trimmed.replace(/"/g, "")}"`;
}

function safeStorageInteger(value: number, requirePositive = false) {
  if (!Number.isSafeInteger(value) || value < 0 || (requirePositive && value === 0)) {
    throw new Error("S3 returned an unsafe object size");
  }
  return value;
}

function isNoSuchUpload(error: unknown) {
  return errorName(error) === "NoSuchUpload";
}

function isNotFound(error: unknown) {
  const name = errorName(error);
  const status = typeof error === "object" && error !== null && "$metadata" in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;
  return name === "NotFound" || name === "NoSuchKey" || status === 404;
}

function errorName(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
}
