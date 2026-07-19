import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { booleanValue, optionalString } from "../config/config-values.js";

@Injectable()
export class ObjectStorageConfig {
  readonly bucket: string;
  readonly region: string;
  readonly internalEndpoint: string | undefined;
  readonly browserUploadBucketUrl: string;
  readonly forcePathStyle: boolean;
  readonly stagingCredentials: S3RoleCredentials;
  readonly readyBlobCredentials: S3RoleCredentials;
  readonly canvasVisualCredentials: S3RoleCredentials;

  constructor(config: ConfigService) {
    this.bucket = optionalString(config, "WORKBENCH_S3_BUCKET") ?? "";
    this.region = optionalString(config, "WORKBENCH_S3_REGION") ?? "us-east-1";
    this.internalEndpoint = storageUrl(config, "WORKBENCH_S3_INTERNAL_ENDPOINT", {
      browserFacing: false,
      required: false,
    });
    this.browserUploadBucketUrl = storageUrl(
      config,
      "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL",
      { browserFacing: true, required: true },
    )!;
    this.forcePathStyle = booleanValue(
      config,
      "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE",
      Boolean(this.internalEndpoint),
    );
    // Validate the shared bucket vocabulary before role-specific credentials so
    // a malformed base configuration fails with its primary actionable error.
    this.assertConfigured();
    this.stagingCredentials = roleCredentials(config, "WORKBENCH_API_STAGING_S3");
    this.readyBlobCredentials = roleCredentials(config, "WORKBENCH_API_READY_BLOB_S3");
    this.canvasVisualCredentials = roleCredentials(config, "WORKBENCH_API_CANVAS_VISUAL_S3");
  }

  assertConfigured() {
    if (!this.bucket) throw new Error("Missing WORKBENCH_S3_BUCKET");
  }
}

export type S3RoleCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

function roleCredentials(config: ConfigService, prefix: string): S3RoleCredentials {
  const accessKeyName = `${prefix}_ACCESS_KEY_ID`;
  const secretKeyName = `${prefix}_SECRET_ACCESS_KEY`;
  const accessKeyId = optionalString(config, accessKeyName);
  const secretAccessKey = optionalString(config, secretKeyName);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`${accessKeyName} and ${secretKeyName} are required`);
  }
  return { accessKeyId, secretAccessKey };
}

function storageUrl(
  config: ConfigService,
  name: string,
  options: { browserFacing: boolean; required: boolean },
): string | undefined {
  const value = optionalString(config, name);
  if (!value) {
    if (options.required) throw new Error(`${name} is required`);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a safe HTTP(S) URL`);
  }
  const requireHttps = options.browserFacing
    && optionalString(config, "NODE_ENV") === "production"
    && !isLoopbackHostname(url.hostname);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (requireHttps && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be a safe ${requireHttps ? "HTTPS" : "HTTP(S)"} URL without credentials, query, or fragment`);
  }
  return value.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
