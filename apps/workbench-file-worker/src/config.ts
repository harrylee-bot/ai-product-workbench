import { isAbsolute } from "node:path";

import { maximumUserUploadByteSize } from "@workbench/workbench-contracts";

export type FileWorkerConfig = ReturnType<typeof loadFileWorkerConfig>;

export const canonicalBlobPrefix = "blobs";
export const pendingBlobPrefix = "pending/blobs";
export const quarantineBlobPrefix = "quarantine/blobs";
export const doclingImageDigest = "sha256:7e07522e0240c1db3ff5b837ffa969c2ecd5a71664c0e0369f5a69fc169e30ba";

const MEBIBYTE = 1024 ** 2;

export function loadFileWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = required(environment, "WORKBENCH_DATABASE_URL");
  const s3InternalEndpoint = optionalUrl(environment, "WORKBENCH_S3_INTERNAL_ENDPOINT");
  const filePipelineS3AccessKeyId = required(environment, "WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID");
  const filePipelineS3SecretAccessKey = required(environment, "WORKBENCH_FILE_PIPELINE_S3_SECRET_ACCESS_KEY");

  const scanMode = optional(environment, "WORKBENCH_FILE_SCAN_MODE") ?? "fail-closed";
  if (scanMode !== "fail-closed" && scanMode !== "clamav") {
    throw new Error("WORKBENCH_FILE_SCAN_MODE must be fail-closed or clamav");
  }

  return {
    databaseUrl,
    queueConnectionString: pgConnectionString(databaseUrl),
    concurrency: positiveInteger(environment, "WORKBENCH_FILE_VERIFY_CONCURRENCY", 2),
    extractionConcurrency: positiveInteger(environment, "WORKBENCH_FILE_EXTRACT_CONCURRENCY", 1),
    knowledgeConcurrency: positiveInteger(environment, "WORKBENCH_KNOWLEDGE_BUILD_CONCURRENCY", 1),
    blobGcConcurrency: positiveInteger(environment, "WORKBENCH_BLOB_GC_CONCURRENCY", 1),
    blobGcGraceMs: boundedInteger(
      environment,
      "WORKBENCH_BLOB_GC_GRACE_MS",
      7 * 24 * 60 * 60_000,
      60 * 60_000,
      90 * 24 * 60 * 60_000,
    ),
    blobGcReconciliationIntervalMs: boundedInteger(
      environment,
      "WORKBENCH_BLOB_GC_RECONCILIATION_INTERVAL_MS",
      5 * 60_000,
      10_000,
      24 * 60 * 60_000,
    ),
    blobGcBatchSize: boundedInteger(
      environment,
      "WORKBENCH_BLOB_GC_BATCH_SIZE",
      100,
      1,
      1_000,
    ),
    maximumUploadByteSize: maximumUserUploadByteSize,
    maximumNormalizedOutputByteSize: 64 * MEBIBYTE,
    canonicalBlobPrefix,
    pendingBlobPrefix,
    quarantineBlobPrefix,
    s3Bucket: required(environment, "WORKBENCH_S3_BUCKET"),
    s3Region: optional(environment, "WORKBENCH_S3_REGION") ?? "us-east-1",
    s3InternalEndpoint,
    s3ForcePathStyle: booleanValue(
      environment,
      "WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE",
      Boolean(s3InternalEndpoint),
    ),
    filePipelineS3AccessKeyId,
    filePipelineS3SecretAccessKey,
    scanMode,
    clamAvHost: scanMode === "clamav" ? required(environment, "WORKBENCH_CLAMAV_HOST") : undefined,
    clamAvPort: positiveInteger(environment, "WORKBENCH_CLAMAV_PORT", 3310),
    clamAvTimeoutMs: positiveInteger(environment, "WORKBENCH_CLAMAV_TIMEOUT_MS", 120_000),
    clamAvSignatureMaxAgeMs: boundedInteger(
      environment,
      "WORKBENCH_CLAMAV_SIGNATURE_MAX_AGE_MS",
      48 * 60 * 60_000,
      60 * 60_000,
      7 * 24 * 60 * 60_000,
    ),
    clamAvStreamMaxBytes: exactInteger(
      environment,
      "WORKBENCH_CLAMAV_STREAM_MAX_BYTES",
      maximumUserUploadByteSize,
    ),
    verificationMaxAttempts: 6,
    extractionMaxAttempts: 6,
    knowledgeMaxAttempts: 6,
    attemptHeartbeatMs: 30_000,
    reconciliationIntervalMs: 60_000,
    reconciliationStaleMs: 5 * 60_000,
    reconciliationBatchSize: 100,
    extractionLeaseMs: 15 * 60_000,
    extractionReconciliationStaleMs: 16 * 60_000,
    extractionTimeoutMs: 10 * 60_000,
    knowledgeLeaseMs: 20 * 60_000,
    knowledgeHeartbeatMs: 30_000,
    knowledgeReconciliationStaleMs: 21 * 60_000,
    knowledgeEmbeddingProfileId: required(environment, "WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID"),
    knowledgeEmbeddingProfileSpecSha256: sha256(environment, "WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256"),
    teiUrl: serviceUrl(environment, "WORKBENCH_TEI_URL"),
    teiApiKey: optional(environment, "WORKBENCH_TEI_API_KEY"),
    teiImageDigest: imageDigest(environment, "WORKBENCH_TEI_IMAGE_DIGEST"),
    teiRequestTimeoutMs: boundedInteger(
      environment,
      "WORKBENCH_TEI_REQUEST_TIMEOUT_MS",
      30_000,
      500,
      120_000,
    ),
    teiMaximumRequestBytes: boundedInteger(
      environment,
      "WORKBENCH_TEI_MAX_REQUEST_BYTES",
      8 * MEBIBYTE,
      64 * 1024,
      64 * MEBIBYTE,
    ),
    teiMaximumResponseBytes: boundedInteger(
      environment,
      "WORKBENCH_TEI_MAX_RESPONSE_BYTES",
      32 * MEBIBYTE,
      64 * 1024,
      256 * MEBIBYTE,
    ),
    knowledgeVaultRoot: optional(environment, "WORKBENCH_KNOWLEDGE_VAULT_ROOT") ?? "/workspace/knowledge-vault",
    knowledgeStorageRoot: optional(environment, "WORKBENCH_KNOWLEDGE_STORAGE_ROOT") ?? "/workspace/storage",
    knowledgeMaximumFileBytes: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_FILE_BYTES",
      4 * MEBIBYTE,
      1_024,
      32 * MEBIBYTE,
    ),
    knowledgeMaximumTotalBytes: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_TOTAL_BYTES",
      256 * MEBIBYTE,
      1 * MEBIBYTE,
      2 * 1_024 * MEBIBYTE,
    ),
    knowledgeMaximumMarkdownFiles: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_MARKDOWN_FILES",
      10_000,
      1,
      100_000,
    ),
    knowledgeMaximumEntries: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_ENTRIES",
      50_000,
      1,
      500_000,
    ),
    knowledgeMaximumAssetFileBytes: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_ASSET_FILE_BYTES",
      512 * MEBIBYTE,
      1 * MEBIBYTE,
      2 * 1_024 * MEBIBYTE,
    ),
    knowledgeMaximumAssetTotalBytes: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_ASSET_TOTAL_BYTES",
      2 * 1_024 * MEBIBYTE,
      1 * MEBIBYTE,
      16 * 1_024 * MEBIBYTE,
    ),
    knowledgeMaximumAssets: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_MAX_ASSETS",
      10_000,
      1,
      100_000,
    ),
    knowledgeTokenizerJsonPath: absolutePath(
      environment,
      "WORKBENCH_KNOWLEDGE_TOKENIZER_JSON_PATH",
    ),
    knowledgeTokenizerConfigJsonPath: absolutePath(
      environment,
      "WORKBENCH_KNOWLEDGE_TOKENIZER_CONFIG_JSON_PATH",
    ),
    knowledgeTokenizerMaximumFileBytes: boundedInteger(
      environment,
      "WORKBENCH_KNOWLEDGE_TOKENIZER_MAX_FILE_BYTES",
      128 * MEBIBYTE,
      1_024,
      512 * MEBIBYTE,
    ),
    doclingUrl: serviceUrl(environment, "WORKBENCH_DOCLING_URL"),
    doclingApiKey: required(environment, "WORKBENCH_DOCLING_API_KEY"),
    doclingSubmitTimeoutMs: boundedInteger(
      environment,
      "WORKBENCH_DOCLING_SUBMIT_TIMEOUT_MS",
      120_000,
      5_000,
      5 * 60_000,
    ),
    doclingPollTimeoutMs: boundedInteger(
      environment,
      "WORKBENCH_DOCLING_POLL_TIMEOUT_MS",
      15_000,
      2_000,
      60_000,
    ),
    doclingImageDigest: exactString(
      environment,
      "WORKBENCH_DOCLING_IMAGE_DIGEST",
      doclingImageDigest,
    ),
    doclingResultsReplayable: requiredTrue(environment, "WORKBENCH_DOCLING_RESULTS_REPLAYABLE"),
    doclingResultRetentionSeconds: boundedInteger(
      environment,
      "WORKBENCH_DOCLING_RESULT_RETENTION_SECONDS",
      86_400,
      2 * 60 * 60,
      30 * 24 * 60 * 60,
    ),
    doclingReaperIntervalMs: boundedInteger(
      environment,
      "WORKBENCH_DOCLING_REAPER_INTERVAL_MS",
      60 * 60_000,
      60_000,
      24 * 60 * 60_000,
    ),
  } as const;
}

export function pgConnectionString(value: string) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url.toString();
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = optional(environment, name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string) {
  return environment[name]?.trim() || undefined;
}

function absolutePath(environment: NodeJS.ProcessEnv, name: string) {
  const value = required(environment, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function optionalUrl(environment: NodeJS.ProcessEnv, name: string) {
  const value = optional(environment, name);
  if (!value) return undefined;
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials or a fragment`);
  }
  return value.replace(/\/+$/, "");
}

function serviceUrl(environment: NodeJS.ProcessEnv, name: string) {
  const value = required(environment, name);
  const url = new URL(value);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || url.search
    || !["", "/"].includes(url.pathname)
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, a path, query, or fragment`);
  }
  return value.replace(/\/+$/, "");
}

function booleanValue(environment: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const value = optional(environment, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = optional(environment, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boundedInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = optional(environment, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requiredTrue(environment: NodeJS.ProcessEnv, name: string) {
  const value = optional(environment, name);
  if (value !== "true") {
    throw new Error(`${name}=true is required because extraction result replay must be enabled`);
  }
  return true as const;
}

function exactString(environment: NodeJS.ProcessEnv, name: string, expected: string) {
  const value = required(environment, name);
  if (value !== expected) throw new Error(`${name} must equal the pinned Docling image digest`);
  return value;
}

function sha256(environment: NodeJS.ProcessEnv, name: string) {
  const value = required(environment, name);
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function imageDigest(environment: NodeJS.ProcessEnv, name: string) {
  const value = required(environment, name);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a pinned sha256 image digest`);
  return value;
}

function exactInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  expected: number,
) {
  const value = optional(environment, name);
  if (value === undefined) return expected;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed !== expected) {
    throw new Error(`${name} must equal the product upload ceiling (${expected})`);
  }
  return parsed;
}
