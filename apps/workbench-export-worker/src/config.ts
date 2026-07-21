import { exportDeliveryQueueOptions } from "@workbench/workbench-contracts";
import { parseConditionalObjectCreateMode } from "@workbench/workbench-content-security";

export type ExportWorkerConfig = ReturnType<typeof loadExportWorkerConfig>;

export function loadExportWorkerConfig() {
  const databaseUrl = required("WORKBENCH_DATABASE_URL");
  const s3InternalEndpoint = optionalUrl("WORKBENCH_S3_INTERNAL_ENDPOINT");
  const exportS3AccessKeyId = required("WORKBENCH_EXPORT_S3_ACCESS_KEY_ID");
  const exportS3SecretAccessKey = required("WORKBENCH_EXPORT_S3_SECRET_ACCESS_KEY");
  const staleRunningMs = positiveInteger(
    "WORKBENCH_EXPORT_STALE_RUNNING_MS",
    20 * 60 * 1_000,
    24 * 60 * 60 * 1_000,
  );
  const deliveryJobExpireMs = exportDeliveryQueueOptions.expireInSeconds * 1_000;
  if (staleRunningMs <= deliveryJobExpireMs) {
    throw new Error("WORKBENCH_EXPORT_STALE_RUNNING_MS must exceed the export.delivery job expiration");
  }
  return {
    databaseUrl,
    queueConnectionString: pgConnectionString(databaseUrl),
    concurrency: positiveInteger("WORKBENCH_EXPORT_CONCURRENCY", 1, 8),
    maximumInputBytes: positiveInteger("WORKBENCH_EXPORT_MAX_INPUT_BYTES", 50 * 1024 * 1024, 512 * 1024 * 1024),
    maximumOutputBytes: positiveInteger("WORKBENCH_EXPORT_MAX_OUTPUT_BYTES", 50 * 1024 * 1024, 512 * 1024 * 1024),
    browserTimeoutMs: positiveInteger("WORKBENCH_EXPORT_BROWSER_TIMEOUT_MS", 20_000, 120_000),
    reconciliationIntervalMs: positiveInteger("WORKBENCH_EXPORT_RECONCILE_INTERVAL_MS", 60_000, 60 * 60 * 1_000),
    staleRunningMs,
    chromiumExecutablePath: optional("WORKBENCH_EXPORT_CHROMIUM_PATH") ?? "/usr/bin/chromium",
    s3Bucket: required("WORKBENCH_S3_BUCKET"),
    s3Region: optional("WORKBENCH_S3_REGION") ?? "us-east-1",
    s3InternalEndpoint,
    s3ForcePathStyle: booleanValue(
      "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE",
      Boolean(s3InternalEndpoint),
    ),
    s3ConditionalCreateMode: parseConditionalObjectCreateMode(
      optional("WORKBENCH_S3_CONDITIONAL_CREATE_MODE"),
    ),
    exportS3AccessKeyId,
    exportS3SecretAccessKey,
    pendingBlobPrefix: cleanPrefix(optional("WORKBENCH_EXPORT_PENDING_BLOB_PREFIX") ?? "pending/exports"),
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
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
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
  if (!cleaned || cleaned.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Blob prefixes must be non-empty relative object key prefixes");
  }
  return cleaned;
}
