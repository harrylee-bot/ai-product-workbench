import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  conditionalObjectCreateHeader,
  conditionalObjectCreateInput,
  consumeVerifiedReadyObjectBody,
  isConditionalObjectCreateConflict,
  setObjectStorageRequestHeader,
  stageReadyObject,
  type ReadyObjectIntegrityRecorder,
} from "@workbench/workbench-content-security";
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
      | "s3ConditionalCreateMode"
      | "exportS3AccessKeyId"
      | "exportS3SecretAccessKey"
    >,
    private readonly recordIntegrityFailure: ReadyObjectIntegrityRecorder,
    client?: S3Sender,
  ) {
    this.client = client ?? new S3Client({
      region: config.s3Region,
      ...(config.s3InternalEndpoint ? { endpoint: config.s3InternalEndpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.exportS3AccessKeyId,
        secretAccessKey: config.exportS3SecretAccessKey,
      },
    });
  }

  async readVerified(identity: StoredIdentity, maximumBytes: number, signal?: AbortSignal) {
    if (identity.byteSize > maximumBytes) throw new Error("EXPORT_INPUT_SIZE_LIMIT_EXCEEDED");
    const staged = await stageReadyObject(identity, async (requestSignal) => {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: identity.storageKey,
      }), requestSignal ? { abortSignal: requestSignal } : undefined);
      if (!(result.Body instanceof Readable)) {
        throw new Error("EXPORT_STORAGE_BODY_UNSUPPORTED");
      }
      return {
        body: result.Body,
        byteSize: result.ContentLength ?? null,
        mediaType: result.ContentType ?? null,
        contentRange: result.ContentRange ?? null,
      };
    }, {
      recordIntegrityFailure: this.recordIntegrityFailure,
      maximumObjectBytes: maximumBytes,
      memoryThresholdBytes: Math.min(maximumBytes, 1024 * 1024),
      ...(signal ? { signal } : {}),
    });
    return consumeVerifiedReadyObjectBody(staged.body, staged.byteSize);
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
      const command = new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: identity.storageKey,
        Body: bytes,
        ContentLength: identity.byteSize,
        ContentType: identity.mediaType,
        ...conditionalObjectCreateInput(this.config.s3ConditionalCreateMode),
        Metadata: { sha256: identity.sha256, "byte-size": String(identity.byteSize) },
      });
      attachConditionalCreateHeader(command, this.config.s3ConditionalCreateMode);
      await this.client.send(command, signal ? { abortSignal: signal } : undefined);
      created = true;
    } catch (error) {
      if (!isConditionalObjectCreateConflict(error)) throw error;
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

function attachConditionalCreateHeader(
  command: PutObjectCommand,
  mode: ExportWorkerConfig["s3ConditionalCreateMode"],
) {
  const header = conditionalObjectCreateHeader(mode);
  if (!header) return;
  command.middlewareStack.add(
    (next) => async (arguments_) => {
      setObjectStorageRequestHeader(arguments_.request, header);
      return next(arguments_);
    },
    { step: "build", name: "workbenchOssForbidOverwrite", priority: "low" },
  );
}

function isNotFound(error: unknown) {
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === "NotFound" || candidate?.name === "NoSuchKey" || candidate?.Code === "NotFound" || candidate?.Code === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404;
}
