import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Readable } from "node:stream";
import type { StoredObjectBody } from "../../platform/object-storage/object-storage.port.js";
import { booleanValue } from "../../platform/config/config-values.js";

/** Read-only adapter for immutable V2 export artifacts written by the worker. */
@Injectable()
export class PrototypeArtifactStorageReader {
  private readonly bucket: string;
  private readonly client: S3Client | undefined;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>("WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET")?.trim() || "";
    const accessKeyId = config.get<string>("WORKBENCH_PROTOTYPE_ARTIFACT_S3_ACCESS_KEY_ID")?.trim();
    const secretAccessKey = config.get<string>("WORKBENCH_PROTOTYPE_ARTIFACT_S3_SECRET_ACCESS_KEY")?.trim();
    if (this.bucket && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        region: config.get<string>("WORKBENCH_S3_REGION")?.trim() || "us-east-1",
        endpoint: config.get<string>("WORKBENCH_S3_INTERNAL_ENDPOINT")?.trim() || undefined,
        forcePathStyle: booleanValue(config, "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE", Boolean(config.get<string>("WORKBENCH_S3_INTERNAL_ENDPOINT")?.trim())),
        credentials: { accessKeyId, secretAccessKey },
      });
    }
  }

  async getObject(key: string): Promise<StoredObjectBody & { sha256: string | null }> {
    if (!this.client || !this.bucket) throw new Error("PROTOTYPE_ARTIFACT_STORAGE_UNAVAILABLE");
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body || result.ContentLength === undefined) throw new Error("PROTOTYPE_ARTIFACT_OBJECT_INVALID");
    if (result.ContentLength < 1 || result.ContentLength > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(result.Metadata?.sha256 ?? "")) throw new Error("PROTOTYPE_ARTIFACT_MANIFEST_INVALID");
    const chunks: Buffer[] = []; let byteSize = 0; const digest = createHash("sha256");
    for await (const chunk of toNodeReadable(result.Body)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.length;
      if (byteSize > result.ContentLength) throw new Error("PROTOTYPE_ARTIFACT_SIZE_MISMATCH");
      digest.update(bytes); chunks.push(bytes);
    }
    if (byteSize !== result.ContentLength || digest.digest("hex") !== result.Metadata?.sha256) throw new Error("PROTOTYPE_ARTIFACT_INTEGRITY_FAILURE");
    return {
      body: Readable.from(Buffer.concat(chunks)),
      byteSize: result.ContentLength,
      mediaType: result.ContentType ?? null,
      contentRange: result.ContentRange ?? null,
      sha256: result.Metadata?.sha256 ?? null,
    };
  }
}

function toNodeReadable(value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (value && typeof value === "object" && Symbol.asyncIterator in value) return Readable.from(value as AsyncIterable<Uint8Array>);
  throw new Error("PROTOTYPE_ARTIFACT_BODY_INVALID");
}
