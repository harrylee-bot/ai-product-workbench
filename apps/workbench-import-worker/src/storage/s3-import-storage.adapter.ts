import { createHash } from "node:crypto";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  conditionalObjectCreateHeader,
  conditionalObjectCreateInput,
  isConditionalObjectCreateConflict,
  setObjectStorageRequestHeader,
} from "@workbench/workbench-content-security";
import { RetryableImportError } from "../errors.js";
import type { ImportWorkerConfig } from "../config.js";

export type BlobIdentity = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
};

type Sender = Pick<S3Client, "send">;

export class S3ImportStorageAdapter {
  private readonly client: Sender;

  constructor(
    private readonly config: Pick<ImportWorkerConfig, "s3Bucket" | "s3Region" | "s3InternalEndpoint" | "s3ForcePathStyle" | "s3ConditionalCreateMode" | "importS3AccessKeyId" | "importS3SecretAccessKey">,
    client?: Sender,
  ) {
    this.client = client ?? new S3Client({
      region: config.s3Region,
      ...(config.s3InternalEndpoint ? { endpoint: config.s3InternalEndpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: config.importS3AccessKeyId, secretAccessKey: config.importS3SecretAccessKey },
    });
  }

  async put(identity: BlobIdentity, bytes: Buffer, signal?: AbortSignal) {
    if (bytes.byteLength !== identity.byteSize || createHash("sha256").update(bytes).digest("hex") !== identity.sha256) {
      throw new RetryableImportError("IMPORT_BLOB_IDENTITY_MISMATCH", "Downloaded source bytes did not match their frozen identity");
    }
    const existing = await this.head(identity.storageKey, signal);
    if (existing) {
      if (!matches(existing, identity)) throw new RetryableImportError("IMPORT_STORAGE_IDENTITY_CONFLICT", "The canonical source object already contains different bytes");
      return;
    }
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
    } catch (error) {
      if (!isConditionalObjectCreateConflict(error)) throw new RetryableImportError("IMPORT_STORAGE_WRITE_FAILED", "The source object could not be published", { cause: error });
    }
    const published = await this.head(identity.storageKey, signal);
    if (!published || !matches(published, identity)) throw new RetryableImportError("IMPORT_STORAGE_IDENTITY_CONFLICT", "The published source object failed identity verification");
  }

  private async head(key: string, signal?: AbortSignal) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }), signal ? { abortSignal: signal } : undefined);
      if (result.ContentLength === undefined) throw new Error("IMPORT_STORAGE_SIZE_MISSING");
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

function matches(stored: { byteSize: number; mediaType: string | null; sha256: string | null; metadataByteSize: string | null }, expected: BlobIdentity) {
  return stored.byteSize === expected.byteSize && stored.mediaType === expected.mediaType && stored.sha256 === expected.sha256 && stored.metadataByteSize === String(expected.byteSize);
}

function attachConditionalCreateHeader(
  command: PutObjectCommand,
  mode: ImportWorkerConfig["s3ConditionalCreateMode"],
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
