import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  stageReadyObject,
  type ReadyObjectIntegrityRecorder,
  type ReadyObjectManifest,
} from "@workbench/workbench-content-security";
import { RetryableVerificationError } from "../errors.js";
import type { FileWorkerConfig } from "../config.js";
import type {
  ContentAddressedObject,
  FileStoragePort,
  PromotedObject,
  ReadyFileStoragePort,
} from "./storage.port.js";

type S3Sender = Pick<S3Client, "send">;

export class S3FileStorageAdapter implements FileStoragePort, ReadyFileStoragePort {
  private readonly client: S3Sender;

  constructor(
    private readonly config: Pick<
      FileWorkerConfig,
      | "s3Bucket"
      | "s3Region"
      | "s3InternalEndpoint"
      | "s3ForcePathStyle"
      | "filePipelineS3AccessKeyId"
      | "filePipelineS3SecretAccessKey"
    >,
    private readonly recordIntegrityFailure: ReadyObjectIntegrityRecorder,
    client?: S3Sender,
  ) {
    this.client = client ?? new S3Client({
      region: config.s3Region,
      ...(config.s3InternalEndpoint ? { endpoint: config.s3InternalEndpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.filePipelineS3AccessKeyId,
        secretAccessKey: config.filePipelineS3SecretAccessKey,
      },
    });
  }

  async getObject(key: string, signal?: AbortSignal) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!(result.Body instanceof Readable) || result.ContentLength === undefined) {
      throw new Error("FILE_STORAGE_BODY_UNSUPPORTED");
    }
    const byteSize = safeStorageSize(result.ContentLength);
    return { body: result.Body, byteSize, mediaType: result.ContentType ?? null };
  }

  async readReadyObject(manifest: ReadyObjectManifest, signal?: AbortSignal) {
    const staged = await stageReadyObject(manifest, async (requestSignal) => {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: manifest.storageKey }),
        requestSignal ? { abortSignal: requestSignal } : undefined,
      );
      if (!(result.Body instanceof Readable)) {
        throw new Error("FILE_STORAGE_BODY_UNSUPPORTED");
      }
      return {
        body: result.Body,
        byteSize: result.ContentLength ?? null,
        mediaType: result.ContentType ?? null,
        contentRange: result.ContentRange ?? null,
      };
    }, {
      recordIntegrityFailure: this.recordIntegrityFailure,
      ...(signal ? { signal } : {}),
    });
    return {
      body: staged.body,
      byteSize: staged.byteSize,
      mediaType: staged.manifest.mediaType,
    };
  }

  async promoteObject(object: PromotedObject, signal?: AbortSignal) {
    const current = await this.headObject(object.destinationKey, signal);
    if (current) {
      if (!matches(current, object)) throw storageIdentityConflict();
      await this.verifyObjectBytes(object, signal);
      return;
    }

    const source = await this.getObject(object.sourceKey, signal);
    if (source.byteSize !== object.byteSize) {
      source.body.destroy();
      throw new RetryableVerificationError(
        "FILE_STORAGE_SOURCE_IDENTITY_MISMATCH",
        "The staging object changed before publication",
      );
    }
    await this.publishNewObject(object, source.body, signal);
  }

  async putContentAddressed(object: ContentAddressedObject, signal?: AbortSignal) {
    const current = await this.headObject(object.destinationKey, signal);
    if (current) {
      object.body.destroy();
      if (!matches(current, object)) throw storageIdentityConflict();
      await this.verifyObjectBytes(object, signal);
      return;
    }
    await this.publishNewObject(object, object.body, signal);
  }

  async deleteObject(key: string, signal?: AbortSignal) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  private async headObject(key: string, signal?: AbortSignal) {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (result.ContentLength === undefined) throw new Error("FILE_STORAGE_SIZE_MISSING");
      return {
        byteSize: safeStorageSize(result.ContentLength),
        mediaType: result.ContentType ?? null,
        sha256: result.Metadata?.sha256 ?? null,
        metadataByteSize: result.Metadata?.["byte-size"] ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async publishNewObject(
    object: Omit<ContentAddressedObject, "body">,
    sourceBody: Readable,
    signal?: AbortSignal,
  ) {
    const digest = createHash("sha256");
    let byteSize = 0;
    const hashingBody = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.byteLength;
        if (!Number.isSafeInteger(byteSize) || byteSize > object.byteSize) {
          callback(storageIdentityConflict());
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    sourceBody.pipe(hashingBody);
    let created = false;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: object.destinationKey,
        Body: hashingBody,
        ContentLength: object.byteSize,
        ContentType: object.mediaType,
        IfNoneMatch: "*",
        Metadata: {
          sha256: object.sha256,
          "byte-size": String(object.byteSize),
        },
      }), signal ? { abortSignal: signal } : undefined);
      created = true;
    } catch (error) {
      sourceBody.destroy();
      hashingBody.destroy();
      if (!isPreconditionFailed(error)) throw error;
      const raced = await this.headObject(object.destinationKey, signal);
      if (!matches(raced, object)) throw storageIdentityConflict();
      await this.verifyObjectBytes(object, signal);
      return;
    } finally {
      sourceBody.destroy();
    }

    if (byteSize !== object.byteSize || digest.digest("hex") !== object.sha256) {
      if (created) await this.deleteObject(object.destinationKey, signal).catch(() => undefined);
      throw new RetryableVerificationError(
        "FILE_STORAGE_SOURCE_IDENTITY_MISMATCH",
        "The source object changed during publication",
      );
    }

    const promoted = await this.headObject(object.destinationKey, signal);
    if (!matches(promoted, object)) throw storageIdentityConflict();
    await this.verifyObjectBytes(object, signal);
  }

  private async verifyObjectBytes(object: StoredIdentity, signal?: AbortSignal) {
    const stored = await this.getObject(object.destinationKey, signal);
    if (stored.byteSize !== object.byteSize || stored.mediaType !== object.mediaType) {
      stored.body.destroy();
      throw storageIdentityConflict();
    }
    const digest = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const value of stored.body) {
        if (signal?.aborted) throw signal.reason;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteSize += chunk.byteLength;
        if (!Number.isSafeInteger(byteSize) || byteSize > object.byteSize) {
          throw storageIdentityConflict();
        }
        digest.update(chunk);
      }
    } finally {
      stored.body.destroy();
    }
    if (byteSize !== object.byteSize || digest.digest("hex") !== object.sha256) {
      throw storageIdentityConflict();
    }
  }
}

function matches(
  stored: { byteSize: number; mediaType: string | null; sha256: string | null; metadataByteSize: string | null } | null,
  expected: StoredIdentity,
) {
  return stored !== null
    && stored.byteSize === expected.byteSize
    && stored.mediaType === expected.mediaType
    && stored.sha256 === expected.sha256
    && stored.metadataByteSize === String(expected.byteSize);
}

type StoredIdentity = Pick<PromotedObject, "destinationKey" | "byteSize" | "sha256" | "mediaType">;

function safeStorageSize(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("FILE_STORAGE_SIZE_INVALID");
  return value;
}

function isPreconditionFailed(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed"
    || candidate.Code === "PreconditionFailed"
    || candidate.$metadata?.httpStatusCode === 412;
}

function storageIdentityConflict() {
  return new RetryableVerificationError(
    "FILE_STORAGE_DESTINATION_IDENTITY_CONFLICT",
    "The reserved storage destination contains different bytes",
  );
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound"
    || candidate.name === "NoSuchKey"
    || candidate.Code === "NotFound"
    || candidate.Code === "NoSuchKey"
    || candidate.$metadata?.httpStatusCode === 404;
}
