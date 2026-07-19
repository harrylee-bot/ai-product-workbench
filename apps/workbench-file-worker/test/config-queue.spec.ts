import {
  assertBlobGcQueueConfiguration,
  assertKnowledgeReleaseBuildQueueConfiguration,
  blobGcJobSchema,
  blobGcQueue,
  fileExtractJobSchema,
  fileExtractQueue,
  fileVerifyJobSchema,
  fileVerifyQueue,
  knowledgeReleaseBuildJobSchema,
  knowledgeReleaseBuildQueue,
} from "@workbench/workbench-contracts";
import { doclingImageDigest, loadFileWorkerConfig } from "../src/config.js";
import {
  blobGcQueueOptions,
  blobGcRetryLimit,
  fileExtractQueueOptions,
  fileVerifyQueueOptions,
  knowledgeReleaseBuildQueueOptions,
  knowledgeReleaseBuildRetryLimit,
} from "../src/queue.js";

const base = {
  WORKBENCH_DATABASE_URL: "postgresql://user:pass@db:5432/workbench?schema=workbench",
  WORKBENCH_S3_BUCKET: "workbench",
  WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID: "file-pipeline-access",
  WORKBENCH_FILE_PIPELINE_S3_SECRET_ACCESS_KEY: "file-pipeline-secret",
  WORKBENCH_DOCLING_URL: "http://docling:5001",
  WORKBENCH_DOCLING_API_KEY: "test-docling-key",
  WORKBENCH_DOCLING_RESULTS_REPLAYABLE: "true",
  WORKBENCH_DOCLING_IMAGE_DIGEST: doclingImageDigest,
  WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_ID: "qwen3-embedding-0.6b-1024-r1",
  WORKBENCH_KNOWLEDGE_EMBEDDING_PROFILE_SPEC_SHA256: "a".repeat(64),
  WORKBENCH_KNOWLEDGE_TOKENIZER_JSON_PATH: "/models/embedding-tokenizer/tokenizer.json",
  WORKBENCH_KNOWLEDGE_TOKENIZER_CONFIG_JSON_PATH: "/models/embedding-tokenizer/tokenizer_config.json",
  WORKBENCH_TEI_URL: "http://tei:8080",
  WORKBENCH_TEI_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
};

describe("file worker boundary configuration", () => {
  it("owns file verification and extraction with bounded retries and strict payloads", () => {
    expect(fileVerifyQueue).toBe("file.verify");
    expect(fileVerifyQueueOptions).toMatchObject({
      policy: "short",
      retryLimit: 5,
      retryBackoff: true,
      expireInSeconds: 600,
      heartbeatSeconds: 30,
    });
    expect(fileVerifyJobSchema.parse({ uploadSessionId: "upload_1" })).toEqual({ uploadSessionId: "upload_1" });
    expect(() => fileVerifyJobSchema.parse({ uploadSessionId: "upload_1", storageKey: "private/key" })).toThrow();
    expect(fileExtractQueue).toBe("file.extract");
    expect(fileExtractQueueOptions).toMatchObject({
      policy: "short",
      retryLimit: 5,
      retryBackoff: true,
      expireInSeconds: 720,
      heartbeatSeconds: 30,
    });
    expect(fileExtractJobSchema.parse({ extractionId: "extraction_1" })).toEqual({ extractionId: "extraction_1" });
    expect(() => fileExtractJobSchema.parse({ extractionId: "extraction_1", taskId: "forged" })).toThrow();
  });

  it("defaults to fail-closed and strips Prisma schema from pg-boss connection", () => {
    const config = loadFileWorkerConfig(base);
    expect(config.scanMode).toBe("fail-closed");
    expect(config.queueConnectionString).toBe("postgresql://user:pass@db:5432/workbench");
    expect(config.maximumUploadByteSize).toBe(25 * 1024 ** 2);
    expect(config.clamAvStreamMaxBytes).toBe(config.maximumUploadByteSize);
    expect(config.canonicalBlobPrefix).toBe("blobs");
    expect(config.quarantineBlobPrefix).toBe("quarantine/blobs");
    expect(config.doclingUrl).toBe("http://docling:5001");
    expect(config.doclingImageDigest).toBe(doclingImageDigest);
    expect(config.doclingResultsReplayable).toBe(true);
    expect(config.knowledgeVaultRoot).toBe("/workspace/knowledge-vault");
    expect(config.knowledgeStorageRoot).toBe("/workspace/storage");
    expect(config.teiUrl).toBe("http://tei:8080");
    expect(config.knowledgeEmbeddingProfileId).toBe("qwen3-embedding-0.6b-1024-r1");
    expect(config.knowledgeTokenizerJsonPath).toBe("/models/embedding-tokenizer/tokenizer.json");
    expect(config.knowledgeTokenizerConfigJsonPath).toBe("/models/embedding-tokenizer/tokenizer_config.json");
    expect(config.knowledgeTokenizerMaximumFileBytes).toBe(128 * 1024 ** 2);
    expect(config.knowledgeMaximumAssetFileBytes).toBe(512 * 1024 ** 2);
    expect(config.knowledgeMaximumAssetTotalBytes).toBe(2 * 1024 ** 3);
    expect(config.blobGcConcurrency).toBe(1);
    expect(config.blobGcGraceMs).toBe(7 * 24 * 60 * 60_000);
    expect(config.blobGcReconciliationIntervalMs).toBe(5 * 60_000);
    expect(config.blobGcBatchSize).toBe(100);
    expect(config.filePipelineS3AccessKeyId).toBe("file-pipeline-access");
  });

  it("fails closed instead of accepting generic or ambient S3 credentials", () => {
    expect(() => loadFileWorkerConfig({
      ...base,
      WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID: "",
      WORKBENCH_FILE_PIPELINE_S3_SECRET_ACCESS_KEY: "",
      AWS_ACCESS_KEY_ID: "ambient-access",
      AWS_SECRET_ACCESS_KEY: "ambient-secret",
    })).toThrow("Missing WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID");
  });

  it("consumes the strict shared Blob GC queue contract", () => {
    expect(blobGcQueue).toBe("blob.gc");
    expect(blobGcRetryLimit).toBe(5);
    expect(blobGcQueueOptions).toMatchObject({
      policy: "short",
      retryLimit: 5,
      expireInSeconds: 300,
      heartbeatSeconds: 30,
    });
    expect(blobGcJobSchema.parse({ blobId: "blob_1" })).toEqual({ blobId: "blob_1" });
    expect(() => blobGcJobSchema.parse({ blobId: "blob_1", storageKey: "private/key" })).toThrow();
    expect(() => assertBlobGcQueueConfiguration({
      name: blobGcQueue,
      ...blobGcQueueOptions,
    })).not.toThrow();
    expect(() => assertBlobGcQueueConfiguration({
      name: blobGcQueue,
      ...blobGcQueueOptions,
      retryLimit: 99,
    })).toThrow("BLOB_GC_QUEUE_CONFIGURATION_MISMATCH:retryLimit");
  });

  it("bounds Blob GC operator settings", () => {
    expect(loadFileWorkerConfig({
      ...base,
      WORKBENCH_BLOB_GC_CONCURRENCY: "3",
      WORKBENCH_BLOB_GC_GRACE_MS: String(24 * 60 * 60_000),
      WORKBENCH_BLOB_GC_RECONCILIATION_INTERVAL_MS: "60000",
      WORKBENCH_BLOB_GC_BATCH_SIZE: "250",
    })).toMatchObject({
      blobGcConcurrency: 3,
      blobGcGraceMs: 24 * 60 * 60_000,
      blobGcReconciliationIntervalMs: 60_000,
      blobGcBatchSize: 250,
    });
    expect(() => loadFileWorkerConfig({
      ...base,
      WORKBENCH_BLOB_GC_GRACE_MS: "1000",
    })).toThrow("WORKBENCH_BLOB_GC_GRACE_MS");
  });

  it("consumes the strict shared Knowledge release queue contract", () => {
    expect(knowledgeReleaseBuildQueue).toBe("knowledge.release.build");
    expect(knowledgeReleaseBuildRetryLimit).toBe(5);
    expect(knowledgeReleaseBuildQueueOptions).toMatchObject({
      policy: "exclusive",
      retryLimit: 5,
      expireInSeconds: 1_200,
      heartbeatSeconds: 30,
    });
    expect(knowledgeReleaseBuildJobSchema.parse({ releaseId: "release_1" }))
      .toEqual({ releaseId: "release_1" });
    expect(() => assertKnowledgeReleaseBuildQueueConfiguration({
      name: knowledgeReleaseBuildQueue,
      ...knowledgeReleaseBuildQueueOptions,
    })).not.toThrow();
  });

  it("requires a ClamAV host when scanning is enabled", () => {
    expect(() => loadFileWorkerConfig({ ...base, WORKBENCH_FILE_SCAN_MODE: "clamav" }))
      .toThrow("Missing WORKBENCH_CLAMAV_HOST");
    expect(loadFileWorkerConfig({
      ...base,
      WORKBENCH_FILE_SCAN_MODE: "clamav",
      WORKBENCH_CLAMAV_HOST: "clamav.internal",
    })).toMatchObject({
      clamAvHost: "clamav.internal",
      clamAvSignatureMaxAgeMs: 48 * 60 * 60_000,
    });
    expect(() => loadFileWorkerConfig({
      ...base,
      WORKBENCH_FILE_SCAN_MODE: "clamav",
      WORKBENCH_CLAMAV_HOST: "clamav.internal",
      WORKBENCH_CLAMAV_SIGNATURE_MAX_AGE_MS: String(8 * 24 * 60 * 60_000),
    })).toThrow("WORKBENCH_CLAMAV_SIGNATURE_MAX_AGE_MS");
  });

  it("requires explicit absolute paths for the pinned model tokenizer", () => {
    expect(() => loadFileWorkerConfig({
      ...base,
      WORKBENCH_KNOWLEDGE_TOKENIZER_JSON_PATH: "tokenizer.json",
    })).toThrow("WORKBENCH_KNOWLEDGE_TOKENIZER_JSON_PATH must be an absolute path");
    expect(() => loadFileWorkerConfig({
      ...base,
      WORKBENCH_KNOWLEDGE_TOKENIZER_CONFIG_JSON_PATH: "",
    })).toThrow("Missing WORKBENCH_KNOWLEDGE_TOKENIZER_CONFIG_JSON_PATH");
  });

  it("rejects a declared clamd StreamMaxLength that diverges from the product contract", () => {
    expect(() => loadFileWorkerConfig({
      ...base,
      WORKBENCH_CLAMAV_STREAM_MAX_BYTES: String(10 * 1024 ** 2),
    })).toThrow("must equal the product upload ceiling");
  });

  it("fails closed unless Docling result replay and the pinned image are explicit", () => {
    expect(() => loadFileWorkerConfig({ ...base, WORKBENCH_DOCLING_RESULTS_REPLAYABLE: "false" }))
      .toThrow("result replay must be enabled");
    expect(() => loadFileWorkerConfig({ ...base, WORKBENCH_DOCLING_IMAGE_DIGEST: "sha256:wrong" }))
      .toThrow("pinned Docling image digest");
    expect(() => loadFileWorkerConfig({ ...base, WORKBENCH_DOCLING_API_KEY: "" }))
      .toThrow("Missing WORKBENCH_DOCLING_API_KEY");
  });
});
