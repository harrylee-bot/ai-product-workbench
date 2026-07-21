import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ConfigService } from "@nestjs/config";
import { fileExtractionParser } from "@workbench/workbench-contracts";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { FileApiConfig } from "../src/modules/files/file-api.config.js";
import { ObjectStorageConfig } from "../src/platform/object-storage/object-storage.config.js";
import {
  normalizeEtag,
  S3MultipartStorageAdapter,
} from "../src/platform/object-storage/s3-multipart-storage.adapter.js";
import { S3CanvasVisualStorageAdapter } from "../src/platform/object-storage/s3-canvas-visual-storage.adapter.js";
import { S3ReadyBlobStorageAdapter } from "../src/platform/object-storage/s3-ready-blob-storage.adapter.js";
import { readReadyObject } from "../src/platform/object-storage/read-ready-object.js";

function apiConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    WORKBENCH_S3_BUCKET: "workbench-files",
    WORKBENCH_S3_REGION: "us-east-1",
    WORKBENCH_S3_INTERNAL_ENDPOINT: "http://127.0.0.1:9000",
    WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: "true",
    ...overrides,
  };
  return new FileApiConfig({ get: vi.fn((name: string) => values[name]) } as unknown as ConfigService);
}

function storageConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    WORKBENCH_S3_BUCKET: "workbench-files",
    WORKBENCH_S3_REGION: "us-east-1",
    WORKBENCH_S3_INTERNAL_ENDPOINT: "http://127.0.0.1:9000",
    WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: "true",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.workbench.example.test/workbench-files",
    WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID: "staging-access",
    WORKBENCH_API_STAGING_S3_SECRET_ACCESS_KEY: "staging-secret",
    WORKBENCH_API_READY_BLOB_S3_ACCESS_KEY_ID: "ready-access",
    WORKBENCH_API_READY_BLOB_S3_SECRET_ACCESS_KEY: "ready-secret",
    WORKBENCH_API_CANVAS_VISUAL_S3_ACCESS_KEY_ID: "canvas-visual-access",
    WORKBENCH_API_CANVAS_VISUAL_S3_SECRET_ACCESS_KEY: "canvas-visual-secret",
    ...overrides,
  };
  return new ObjectStorageConfig({ get: vi.fn((name: string) => values[name]) } as unknown as ConfigService);
}

describe("FileApiConfig", () => {
  it("loads one S3-compatible vocabulary and safe upload defaults", () => {
    expect(storageConfig()).toMatchObject({
      bucket: "workbench-files",
      region: "us-east-1",
      internalEndpoint: "http://127.0.0.1:9000",
      browserUploadBucketUrl: "https://uploads.workbench.example.test/workbench-files",
      forcePathStyle: true,
      stagingCredentials: { accessKeyId: "staging-access", secretAccessKey: "staging-secret" },
      readyBlobCredentials: { accessKeyId: "ready-access", secretAccessKey: "ready-secret" },
      canvasVisualCredentials: { accessKeyId: "canvas-visual-access", secretAccessKey: "canvas-visual-secret" },
    });
    expect(apiConfig()).toMatchObject({
      stagingPrefix: "staging/files",
      parser: fileExtractionParser,
    });
    expect(() => storageConfig().assertConfigured()).not.toThrow();
  });

  it("rejects half-configured credentials, unsafe prefixes, and out-of-range numeric settings", () => {
    expect(() => storageConfig({ WORKBENCH_API_STAGING_S3_SECRET_ACCESS_KEY: "" }))
      .toThrow("WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID and WORKBENCH_API_STAGING_S3_SECRET_ACCESS_KEY are required");
    expect(() => storageConfig({ WORKBENCH_API_READY_BLOB_S3_ACCESS_KEY_ID: "" }))
      .toThrow("WORKBENCH_API_READY_BLOB_S3_ACCESS_KEY_ID and WORKBENCH_API_READY_BLOB_S3_SECRET_ACCESS_KEY are required");
    expect(() => storageConfig({ WORKBENCH_API_CANVAS_VISUAL_S3_SECRET_ACCESS_KEY: "" }))
      .toThrow("WORKBENCH_API_CANVAS_VISUAL_S3_ACCESS_KEY_ID and WORKBENCH_API_CANVAS_VISUAL_S3_SECRET_ACCESS_KEY are required");
    expect(() => storageConfig({
      WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID: "",
      AWS_ACCESS_KEY_ID: "ambient-access",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
    })).toThrow("WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID");
    expect(() => apiConfig({ WORKBENCH_S3_STAGING_PREFIX: "../private" })).toThrow();
    expect(() => apiConfig({ WORKBENCH_FILE_SIGNED_URL_TTL_SECONDS: "5" })).toThrow();
    expect(() => storageConfig({ WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "" }))
      .toThrow("WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL is required");
    expect(() => storageConfig({ WORKBENCH_S3_BUCKET: "" }))
      .toThrow("Missing WORKBENCH_S3_BUCKET");
    expect(() => storageConfig({
      NODE_ENV: "production",
      WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "http://uploads.workbench.example.test/workbench-files",
    })).toThrow("must be a safe HTTPS URL");
    expect(() => storageConfig({
      NODE_ENV: "production",
      WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "http://127.0.0.1:9000/workbench-files",
    })).not.toThrow();
  });
});

describe("split S3 object storage adapters", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates opaque multipart state and normalizes paginated provider ETags", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "provider_1" } as never;
      if (command instanceof ListPartsCommand && command.input.PartNumberMarker === undefined) {
        return {
          Parts: [{ PartNumber: 1, ETag: "etag-1", Size: 8 }],
          IsTruncated: true,
          NextPartNumberMarker: "1",
        } as never;
      }
      if (command instanceof ListPartsCommand) {
        return {
          Parts: [{ PartNumber: 2, ETag: '"etag-2"', Size: 2 }],
          IsTruncated: false,
        } as never;
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    }) as never);
    const adapter = new S3MultipartStorageAdapter(storageConfig());

    await expect(adapter.createMultipartUpload({
      key: "staging/files/project/upload",
      mediaType: "application/pdf",
      metadata: { "file-asset-id": "file_1" },
    })).resolves.toEqual({ uploadId: "provider_1" });
    await expect(adapter.listMultipartParts({
      key: "staging/files/project/upload",
      uploadId: "provider_1",
    })).resolves.toEqual([
      { partNumber: 1, etag: '"etag-1"', byteSize: 8 },
      { partNumber: 2, etag: '"etag-2"', byteSize: 2 },
    ]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("treats missing abort state and missing objects as idempotent provider outcomes", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof AbortMultipartUploadCommand) {
        throw Object.assign(new Error("gone"), { name: "NoSuchUpload" });
      }
      if (command instanceof HeadObjectCommand) {
        throw Object.assign(new Error("gone"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      }
      throw new Error("unexpected command");
    }) as never);
    const adapter = new S3MultipartStorageAdapter(storageConfig());

    await expect(adapter.abortMultipartUpload({ key: "staging/key", uploadId: "provider_1" })).resolves.toBeUndefined();
    await expect(adapter.statObject("missing/key")).resolves.toBeNull();
  });

  it("treats a missing Canvas visual object as an idempotent delete", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) {
        throw Object.assign(new Error("gone"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      }
      throw new Error("unexpected command");
    }) as never);
    const adapter = new S3CanvasVisualStorageAdapter(storageConfig());

    await expect(adapter.deleteObject("canvas-visuals/missing.webp")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not hide a denied Canvas visual delete", async () => {
    const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(denied as never);
    const adapter = new S3CanvasVisualStorageAdapter(storageConfig());

    await expect(adapter.deleteObject("canvas-visuals/protected.webp")).rejects.toBe(denied);
  });

  it("passes a zero-byte Canvas object to immutable verification and records an incident", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return {
          Body: Readable.from([]),
          ContentLength: 0,
          ContentType: "image/webp",
        } as never;
      }
      throw new Error("unexpected command");
    }) as never);
    const adapter = new S3CanvasVisualStorageAdapter(storageConfig());
    const expected = Buffer.from("not-empty", "utf8");
    const recordIntegrityFailure = vi.fn().mockResolvedValue(undefined);

    await expect(readReadyObject(
      adapter,
      {
        storageKey: "canvas-visuals/zero.webp",
        sha256: createHash("sha256").update(expected).digest("hex"),
        byteSize: expected.byteLength,
        mediaType: "image/webp",
      },
      undefined,
      undefined,
      { recordIntegrityFailure },
    )).rejects.toThrow("OBJECT_STORAGE_BYTE_SIZE_MISMATCH");
    expect(recordIntegrityFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "OBJECT_STORAGE_BYTE_SIZE_MISMATCH",
      observedByteSize: 0,
      observedMediaType: "image/webp",
    }));
  });

  it("signs browser parts against the public bucket URL instead of the internal endpoint", async () => {
    const adapter = new S3MultipartStorageAdapter(storageConfig());

    const signed = await adapter.signMultipartPart({
      key: "staging/files/project/upload",
      uploadId: "provider_1",
      partNumber: 1,
      contentLength: 8,
      expiresInSeconds: 600,
    });
    const signedUrl = new URL(signed.url);

    expect(signedUrl.origin).toBe("https://uploads.workbench.example.test");
    expect(signedUrl.pathname).toBe("/workbench-files/staging/files/project/upload");
    expect(signedUrl.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    expect(signedUrl.searchParams.has("x-amz-checksum-crc32")).toBe(false);
    expect(signedUrl.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
    expect(signed.url).not.toContain("127.0.0.1:9000");
  });

  it("signs browser parts at a virtual-hosted custom-domain root", async () => {
    const adapter = new S3MultipartStorageAdapter(storageConfig({
      WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "https://uploads.workbench.example.test",
    }));

    const signed = await adapter.signMultipartPart({
      key: "staging/files/project/upload",
      uploadId: "provider_1",
      partNumber: 1,
      contentLength: 8,
      expiresInSeconds: 600,
    });

    const signedUrl = new URL(signed.url);
    expect(signedUrl.origin).toBe("https://uploads.workbench.example.test");
    expect(signedUrl.pathname).toBe("/staging/files/project/upload");
  });

  it("streams Node object bodies and preserves range metadata", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        expect(command.input.Range).toBe("bytes=3-6");
        return {
          Body: Readable.from("data"),
          ContentLength: 4,
          ContentType: "text/plain",
          ContentRange: "bytes 3-6/10",
        } as never;
      }
      throw new Error("unexpected command");
    }) as never);
    const adapter = new S3ReadyBlobStorageAdapter(storageConfig());

    await expect(adapter.getObject({ key: "blobs/hash", range: { start: 3, end: 6 } })).resolves.toMatchObject({
      byteSize: 4,
      mediaType: "text/plain",
      contentRange: "bytes 3-6/10",
    });
  });

  it("normalizes quoted and unquoted multipart ETags", () => {
    expect(normalizeEtag("etag")).toBe('"etag"');
    expect(normalizeEtag('"etag"')).toBe('"etag"');
  });
});
