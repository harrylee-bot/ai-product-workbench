import { maximumImportSourceManifestBlobs } from "./import/source-types.js";
import { parseConditionalObjectCreateMode } from "@workbench/workbench-content-security";

export type ImportWorkerConfig = ReturnType<typeof loadImportWorkerConfig>;

const mebibyte = 1024 * 1024;

export function loadImportWorkerConfig() {
  const databaseUrl = required("WORKBENCH_DATABASE_URL");
  const s3InternalEndpoint = optionalUrl("WORKBENCH_S3_INTERNAL_ENDPOINT");
  const scanMode = optional("WORKBENCH_FILE_SCAN_MODE") ?? "fail-closed";
  if (scanMode !== "clamav" && scanMode !== "fail-closed") throw new Error("WORKBENCH_FILE_SCAN_MODE must be clamav or fail-closed");
  const maximumSourceBytes = positiveInteger("WORKBENCH_IMPORT_MAX_SOURCE_BYTES", 50 * mebibyte, 512 * mebibyte);
  const maximumUrlBytes = positiveInteger("WORKBENCH_IMPORT_MAX_URL_BYTES", 10 * mebibyte, 100 * mebibyte);
  const maximumGithubBytes = positiveInteger("WORKBENCH_IMPORT_MAX_GITHUB_BYTES", 50 * mebibyte, 512 * mebibyte);
  const maximumFigmaBytes = positiveInteger("WORKBENCH_IMPORT_MAX_FIGMA_BYTES", 50 * mebibyte, 512 * mebibyte);
  const maximumImportBlobBytes = Math.max(maximumUrlBytes, maximumGithubBytes, maximumFigmaBytes);
  const clamAvStreamMaxBytes = positiveInteger("WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES", 50 * mebibyte, 512 * mebibyte);
  if (clamAvStreamMaxBytes < maximumImportBlobBytes) {
    throw new Error("WORKBENCH_IMPORT_CLAMAV_STREAM_MAX_BYTES must cover the largest configured external import blob");
  }
  return {
    databaseUrl,
    queueConnectionString: pgConnectionString(databaseUrl),
    concurrency: positiveInteger("WORKBENCH_IMPORT_CONCURRENCY", 2, 8),
    maximumAttempts: positiveInteger("WORKBENCH_IMPORT_MAX_ATTEMPTS", 3, 8),
    maximumSourceBytes,
    maximumUrlBytes,
    maximumGithubBytes,
    maximumFigmaBytes,
    maximumImportBlobBytes,
    maximumGithubFiles: positiveInteger("WORKBENCH_IMPORT_MAX_GITHUB_FILES", maximumImportSourceManifestBlobs, maximumImportSourceManifestBlobs),
    requestTimeoutMs: positiveInteger("WORKBENCH_IMPORT_REQUEST_TIMEOUT_MS", 30_000, 120_000),
    maximumRedirects: positiveInteger("WORKBENCH_IMPORT_MAX_REDIRECTS", 3, 8),
    staleRunningMs: positiveInteger("WORKBENCH_IMPORT_STALE_RUNNING_MS", 15 * 60_000, 24 * 60 * 60_000),
    reconciliationIntervalMs: positiveInteger("WORKBENCH_IMPORT_RECONCILE_INTERVAL_MS", 60_000, 60 * 60_000),
    scanMode,
    clamAvHost: optional("WORKBENCH_CLAMAV_HOST") ?? "127.0.0.1",
    clamAvPort: positiveInteger("WORKBENCH_CLAMAV_PORT", 3310, 65_535),
    clamAvTimeoutMs: positiveInteger("WORKBENCH_CLAMAV_TIMEOUT_MS", 120_000, 600_000),
    clamAvSignatureMaxAgeMs: positiveInteger("WORKBENCH_CLAMAV_SIGNATURE_MAX_AGE_MS", 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000),
    clamAvStreamMaxBytes,
    githubToken: optional("WORKBENCH_IMPORT_GITHUB_TOKEN"),
    figmaToken: optional("WORKBENCH_IMPORT_FIGMA_TOKEN"),
    s3Bucket: required("WORKBENCH_S3_BUCKET"),
    s3Region: optional("WORKBENCH_S3_REGION") ?? "us-east-1",
    s3InternalEndpoint,
    s3ForcePathStyle: booleanValue("WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE", Boolean(s3InternalEndpoint)),
    s3ConditionalCreateMode: parseConditionalObjectCreateMode(
      optional("WORKBENCH_S3_CONDITIONAL_CREATE_MODE"),
    ),
    importS3AccessKeyId: required("WORKBENCH_IMPORT_S3_ACCESS_KEY_ID"),
    importS3SecretAccessKey: required("WORKBENCH_IMPORT_S3_SECRET_ACCESS_KEY"),
    pendingBlobPrefix: cleanPrefix(optional("WORKBENCH_IMPORT_PENDING_BLOB_PREFIX") ?? "pending/imports"),
    canonicalBlobPrefix: cleanPrefix(optional("WORKBENCH_CANONICAL_BLOB_PREFIX") ?? "blobs"),
  };
}

export function pgConnectionString(value: string) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url.toString();
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

function cleanPrefix(value: string) {
  const cleaned = value.replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned.split("/").some((part) => part === "." || part === "..")) throw new Error("Blob prefixes must be non-empty relative object key prefixes");
  return cleaned;
}
