import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  stageReadyObject,
  type ReadyObjectIntegrityRecorder,
} from "@workbench/workbench-content-security";
import type { WorkerConfig } from "../config.js";
import type { RuntimeContentLocator } from "../runtime/runtime.port.js";
import type { RuntimeReadyBlobReader } from "./runtime-ready-blob-reader.port.js";

type S3Reader = Pick<S3Client, "send">;

export class S3RuntimeReadyBlobReader implements RuntimeReadyBlobReader {
  private readonly client: S3Reader;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      | "s3Bucket"
      | "s3Region"
      | "s3InternalEndpoint"
      | "s3ForcePathStyle"
      | "runtimeReadyBlobS3AccessKeyId"
      | "runtimeReadyBlobS3SecretAccessKey"
    >,
    private readonly recordIntegrityFailure: ReadyObjectIntegrityRecorder,
    client?: S3Reader,
  ) {
    this.client = client ?? new S3Client({
      region: config.s3Region,
      ...(config.s3InternalEndpoint ? { endpoint: config.s3InternalEndpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.runtimeReadyBlobS3AccessKeyId,
        secretAccessKey: config.runtimeReadyBlobS3SecretAccessKey,
      },
    });
  }

  async getObject(locator: RuntimeContentLocator, signal?: AbortSignal) {
    const staged = await stageReadyObject(locator, async (requestSignal) => {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: locator.storageKey,
      }), requestSignal ? { abortSignal: requestSignal } : undefined);
      if (!(result.Body instanceof Readable)) {
        throw new Error("RUNTIME_SOURCE_STORAGE_BODY_UNSUPPORTED");
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
}
