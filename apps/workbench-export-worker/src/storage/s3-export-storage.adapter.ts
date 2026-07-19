import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ExportWorkerConfig } from "../config.js";
import type { ExportStoragePort, StoredIdentity } from "./storage.port.js";

type S3Sender = Pick<S3Client, "send">;

export class S3ExportStorageAdapter implements ExportStoragePort {
  private readonly client: S3Sender;

  constructor(
    private readonly config: Pick<
      ExportWorkerConfig,
      | "s3Bucket"
      | "s3Region"
      | "s3InternalEndpoint"
      | "s3ForcePathStyle"
      | "exportS3AccessKeyId"
      | "exportS3SecretAccessKey"
    >,
    client?: S3Sender,
  ) {
    this.client = client ?? new S3Client({
      region: config.s3Region,
      ...(config.s3InternalEndpoint ? { endpoint: config.s3InternalEndpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.exportS3AccessKeyId,
        secretAccessKey: config.exportS3SecretAccessKey,
      },
    });
  }

  async readVerified(identity: StoredIdentity, maximumBytes: number, signal?: AbortSignal) {
    if (identity.byteSize > maximumBytes) throw new Error("EXPORT_INPUT_SIZE_LIMIT_EXCEEDED");
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: identity.storageKey,
    }), signal ? { abortSignal: signal } : undefined);
    if (!(result.Body instanceof Readable) || result.ContentLength === undefined) {
      throw new Error("EXPORT_STORAGE_BODY_UNSUPPORTED");
    }
    if (result.ContentLength !== identity.byteSize || result.ContentType !== identity.mediaType) {
      result.Body.destroy();
      throw new Error("EXPORT_STORAGE_IDENTITY_MISMATCH");
    }
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const value of result.Body) {
        if (signal?.aborted) throw abortError(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteSize += chunk.byteLength;
        if (byteSize > identity.byteSize || byteSize > maximumBytes) throw new Error("EXPORT_STORAGE_IDENTITY_MISMATCH");
        chunks.push(chunk);
        digest.update(chunk);
      }
    } finally {
      result.Body.destroy();
    }
    if (byteSize !== identity.byteSize || digest.digest("hex") !== identity.sha256) {
      throw new Error("EXPORT_STORAGE_IDENTITY_MISMATCH");
    }
    return Buffer.concat(chunks, byteSize);
  }

  async putVerified(identity: StoredIdentity, bytes: Uint8Array, signal?: AbortSignal) {
    if (bytes.byteLength !== identity.byteSize || createHash("sha256").update(bytes).digest("hex") !== identity.sha256) {
      throw new Error("EXPORT_OUTPUT_IDENTITY_MISMATCH");
    }
    const existing = await this.head(identity.storageKey, signal);
    if (existing) {
      if (!matches(existing, identity)) throw new Error("EXPORT_STORAGE_DESTINATION_IDENTITY_CONFLICT");
      await this.readVerified(identity, identity.byteSize, signal);
      return;
    }
    let created = false;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: identity.storageKey,
        Body: bytes,
        ContentLength: identity.byteSize,
        ContentType: identity.mediaType,
        IfNoneMatch: "*",
        Metadata: { sha256: identity.sha256, "byte-size": String(identity.byteSize) },
      }), signal ? { abortSignal: signal } : undefined);
      created = true;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const raced = await this.head(identity.storageKey, signal);
      if (!raced || !matches(raced, identity)) throw new Error("EXPORT_STORAGE_DESTINATION_IDENTITY_CONFLICT");
    }
    try {
      await this.readVerified(identity, identity.byteSize, signal);
    } catch (error) {
      if (created) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: identity.storageKey })).catch(() => undefined);
      }
      throw error;
    }
  }

  private async head(key: string, signal?: AbortSignal) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }), signal ? { abortSignal: signal } : undefined);
      if (result.ContentLength === undefined) throw new Error("EXPORT_STORAGE_SIZE_MISSING");
      return {
        byteSize: result.ContentLength,
        mediaType: result.ContentType ?? null,
        sha256: result.Metadata?.sha256 ?? null,
        metadataByteSize: result.Metadata?.["byte-size"] ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

function matches(stored: { byteSize: number; mediaType: string | null; sha256: string | null; metadataByteSize: string | null }, expected: StoredIdentity) {
  return stored.byteSize === expected.byteSize
    && stored.mediaType === expected.mediaType
    && stored.sha256 === expected.sha256
    && stored.metadataByteSize === String(expected.byteSize);
}

function isPreconditionFailed(error: unknown) {
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === "PreconditionFailed" || candidate?.Code === "PreconditionFailed" || candidate?.$metadata?.httpStatusCode === 412;
}

function isNotFound(error: unknown) {
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === "NotFound" || candidate?.name === "NoSuchKey" || candidate?.Code === "NotFound" || candidate?.Code === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404;
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("EXPORT_ABORTED");
}
