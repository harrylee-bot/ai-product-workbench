import { decodePreviewTokenSecret } from "@workbench/workbench-preview-token";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export type PreviewConfig = ReturnType<typeof loadPreviewConfig>;

export function loadPreviewConfig() {
  const production = optional("NODE_ENV") === "production";
  const databaseUrl = required("WORKBENCH_DATABASE_URL");
  const publicOrigin = origin(
    "WORKBENCH_PREVIEW_ORIGIN",
    required("WORKBENCH_PREVIEW_ORIGIN"),
    production,
  );
  const webOrigin = origin(
    "WORKBENCH_WEB_ORIGIN",
    required("WORKBENCH_WEB_ORIGIN"),
    production,
  );
  if (publicOrigin === webOrigin) throw new Error("WORKBENCH_PREVIEW_ORIGIN must be independent from WORKBENCH_WEB_ORIGIN");
  const s3InternalEndpoint = optionalUrl("WORKBENCH_S3_INTERNAL_ENDPOINT");
  const previewS3AccessKeyId = required("WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID");
  const previewS3SecretAccessKey = required("WORKBENCH_PREVIEW_S3_SECRET_ACCESS_KEY");
  return {
    databaseUrl,
    host: optional("WORKBENCH_PREVIEW_HOST") ?? "0.0.0.0",
    port: positiveInteger("WORKBENCH_PREVIEW_PORT", 4300, 65_535),
    publicOrigin,
    webOrigin,
    tokenSecret: decodePreviewTokenSecret(required("WORKBENCH_PREVIEW_TOKEN_SECRET")),
    tokenMaximumTtlSeconds: positiveInteger("WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS", 3_600, 86_400),
    maximumHtmlBytes: positiveInteger("WORKBENCH_PREVIEW_MAX_HTML_BYTES", 50 * 1024 * 1024, 100 * 1024 * 1024),
    maximumConcurrency: positiveInteger("WORKBENCH_PREVIEW_MAX_CONCURRENCY", 4, 1_000),
    spoolDirectory: absoluteDirectory(
      "WORKBENCH_PREVIEW_SPOOL_DIR",
      optional("WORKBENCH_PREVIEW_SPOOL_DIR")
        ?? (production ? "/var/lib/workbench-preview" : join(tmpdir(), "workbench-preview")),
    ),
    s3Bucket: required("WORKBENCH_S3_BUCKET"),
    s3Region: optional("WORKBENCH_S3_REGION") ?? "us-east-1",
    s3InternalEndpoint,
    s3ForcePathStyle: booleanValue(
      "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE",
      Boolean(s3InternalEndpoint),
    ),
    previewS3AccessKeyId,
    previewS3SecretAccessKey,
  };
}

function absoluteDirectory(name: string, value: string) {
  const normalized = normalize(value);
  if (!isAbsolute(normalized) || normalized === "/" || normalized.includes("\0")) {
    throw new Error(`${name} must be an absolute non-root directory`);
  }
  return normalized;
}

function required(name: string) {
  const value = optional(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optional(name: string) {
  return process.env[name]?.trim() || undefined;
}

function optionalUrl(name: string) {
  const value = optional(name);
  if (!value) return undefined;
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials or a fragment`);
  }
  return value.replace(/\/+$/, "");
}

function origin(name: string, value: string, requireHttps: boolean) {
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (requireHttps && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${name} must be a bare ${requireHttps ? "HTTPS" : "HTTP(S)"} origin`);
  }
  return url.origin;
}

function positiveInteger(name: string, fallback: number, maximum: number) {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  return parsed;
}

function booleanValue(name: string, fallback: boolean) {
  const value = optional(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
