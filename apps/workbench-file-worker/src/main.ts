import { PgBoss, type JobWithMetadata } from "pg-boss";
import {
  ClamAvScanAdapter,
  FailClosedScanAdapter,
  prismaReadyObjectIntegrityRecorder,
} from "@workbench/workbench-content-security";
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
  type BlobGcJob,
  type FileExtractJob,
  type FileVerifyJob,
  type KnowledgeReleaseBuildJob,
} from "@workbench/workbench-contracts";
import {
  initializeTelemetry,
  queuePayload,
  traceQueueConsume,
  traceQueuePublish,
  tracedFetch,
} from "@workbench/workbench-telemetry";
import { loadFileWorkerConfig } from "./config.js";
import { db } from "./db.js";
import { BlobGcProcessor } from "./gc/blob-gc.processor.js";
import { BlobGcReconciler } from "./gc/blob-gc.reconciler.js";
import { PrismaBlobGcStore } from "./gc/prisma-blob-gc.store.js";
import { DoclingParserAdapter } from "./extraction/docling-parser.adapter.js";
import { DoclingResultReaper } from "./extraction/docling-result.reaper.js";
import { ExtractionDeliveryRunner } from "./extraction/extraction-delivery.runner.js";
import { ExtractionReconciler } from "./extraction/extraction-reconciler.js";
import { FileExtractionProcessor } from "./extraction/file-extraction.processor.js";
import { PrismaExtractionStore } from "./extraction/prisma-extraction.store.js";
import { JiebaSegmenterAdapter, knowledgeDefaultDictionaryChecksum, knowledgeSegmenterId, knowledgeSegmenterVersion } from "./knowledge/jieba-segmenter.adapter.js";
import { HuggingFaceTokenizerAdapter } from "./knowledge/huggingface-tokenizer.adapter.js";
import { KnowledgeDeliveryRunner } from "./knowledge/knowledge-delivery.runner.js";
import { KnowledgeReconciler } from "./knowledge/knowledge-reconciler.js";
import { KnowledgeReleaseProcessor } from "./knowledge/knowledge-release.processor.js";
import { PrismaKnowledgeBuildStore } from "./knowledge/prisma-knowledge-build.store.js";
import { SafeKnowledgeVaultReader } from "./knowledge/safe-vault-reader.js";
import { TeiEmbeddingAdapter } from "./knowledge/tei-embedding.adapter.js";
import {
  blobGcQueueOptions,
  blobGcRetryLimit,
  fileExtractQueueOptions,
  fileExtractRetryLimit,
  fileVerifyQueueOptions,
  fileVerifyRetryLimit,
  knowledgeReleaseBuildQueueOptions,
  knowledgeReleaseBuildRetryLimit,
} from "./queue.js";
import { S3FileStorageAdapter } from "./storage/s3-file-storage.adapter.js";
import { FileVerificationProcessor } from "./verification/file-verification.processor.js";
import { PrismaVerificationStore } from "./verification/prisma-verification.store.js";
import { VerificationDeliveryRunner } from "./verification/verification-delivery.runner.js";
import { VerificationReconciler } from "./verification/verification-reconciler.js";

const telemetry = initializeTelemetry({ serviceName: "workbench-file-worker" });

async function main() {
  const config = loadFileWorkerConfig();
  const knowledgeTokenizer = await HuggingFaceTokenizerAdapter.load({
    tokenizerJsonPath: config.knowledgeTokenizerJsonPath,
    tokenizerConfigJsonPath: config.knowledgeTokenizerConfigJsonPath,
    maximumArtifactBytes: config.knowledgeTokenizerMaximumFileBytes,
  });
  await db.$connect();
  const storage = new S3FileStorageAdapter(
    config,
    prismaReadyObjectIntegrityRecorder(db),
  );
  const blobGcStore = new PrismaBlobGcStore(db);
  const blobGcProcessor = new BlobGcProcessor(
    blobGcStore,
    storage,
    blobGcRetryLimit + 1,
  );
  const scanner = config.scanMode === "clamav"
    ? new ClamAvScanAdapter(
        requireClamAvHost(config.clamAvHost),
        config.clamAvPort,
        config.clamAvTimeoutMs,
        config.clamAvStreamMaxBytes,
        config.clamAvSignatureMaxAgeMs,
      )
    : new FailClosedScanAdapter();
  const store = new PrismaVerificationStore(db, {
    pending: config.pendingBlobPrefix,
    canonical: config.canonicalBlobPrefix,
    quarantine: config.quarantineBlobPrefix,
  });
  const processor = new FileVerificationProcessor(store, storage, scanner, config.maximumUploadByteSize);
  const runner = new VerificationDeliveryRunner(
    store,
    processor,
    config.verificationMaxAttempts,
    config.attemptHeartbeatMs,
  );
  const parser = new DoclingParserAdapter(config, tracedFetch);
  await parser.assertContract();
  const extractionStore = new PrismaExtractionStore(db, {
    canonicalBlobPrefix: config.canonicalBlobPrefix,
    pendingBlobPrefix: config.pendingBlobPrefix,
    doclingImageDigest: config.doclingImageDigest,
    parserOptionsSha256: parser.optionsSha256,
    parserComponents: parser.parserComponents,
  });
  const extractionProcessor = new FileExtractionProcessor(
    extractionStore,
    storage,
    parser,
    config.maximumNormalizedOutputByteSize,
    config.extractionTimeoutMs,
  );
  const extractionRunner = new ExtractionDeliveryRunner(
    extractionStore,
    extractionProcessor,
    config.extractionMaxAttempts,
    config.extractionLeaseMs,
  );
  const knowledgeStore = new PrismaKnowledgeBuildStore(db);
  const knowledgeReader = new SafeKnowledgeVaultReader(config.knowledgeVaultRoot, config.knowledgeStorageRoot, {
    maximumFileBytes: config.knowledgeMaximumFileBytes,
    maximumTotalBytes: config.knowledgeMaximumTotalBytes,
    maximumMarkdownFiles: config.knowledgeMaximumMarkdownFiles,
    maximumEntries: config.knowledgeMaximumEntries,
    maximumAssetFileBytes: config.knowledgeMaximumAssetFileBytes,
    maximumAssetTotalBytes: config.knowledgeMaximumAssetTotalBytes,
    maximumAssets: config.knowledgeMaximumAssets,
  });
  const knowledgeSegmenter = new JiebaSegmenterAdapter();
  const knowledgeEmbedding = new TeiEmbeddingAdapter({
    origin: config.teiUrl,
    apiKey: config.teiApiKey,
    requestTimeoutMs: config.teiRequestTimeoutMs,
    maximumRequestBytes: config.teiMaximumRequestBytes,
    maximumResponseBytes: config.teiMaximumResponseBytes,
    imageDigest: config.teiImageDigest,
    profileId: config.knowledgeEmbeddingProfileId,
    profileSpecSha256: config.knowledgeEmbeddingProfileSpecSha256,
  }, tracedFetch);
  const knowledgeProcessor = new KnowledgeReleaseProcessor(
    knowledgeStore,
    knowledgeReader,
    knowledgeTokenizer,
    knowledgeSegmenter,
    {
      segmenter: {
        id: knowledgeSegmenterId,
        version: knowledgeSegmenterVersion,
        dictionaryChecksum: knowledgeDefaultDictionaryChecksum,
        stopwordsChecksum: knowledgeSegmenter.stopwordsChecksum,
      },
    },
    knowledgeEmbedding,
  );
  const knowledgeRunner = new KnowledgeDeliveryRunner(
    knowledgeStore,
    knowledgeProcessor,
    config.knowledgeMaxAttempts,
    config.knowledgeLeaseMs,
    config.knowledgeHeartbeatMs,
  );
  const doclingResultReaper = new DoclingResultReaper(
    parser,
    config.doclingResultRetentionSeconds,
    config.doclingReaperIntervalMs,
    (error) => console.error("[file-worker:docling-result-reaper]", error),
  );
  const boss = new PgBoss({
    connectionString: config.queueConnectionString,
    schema: "workbench_jobs",
    application_name: "workbench-file-worker",
    schedule: false,
    supervise: true,
    migrate: false,
    createSchema: false,
    useListenNotify: true,
  });
  boss.on("error", (error) => console.error("[file-worker:pg-boss]", error));
  boss.on("warning", (warning) => console.warn("[file-worker:pg-boss]", warning));
  await boss.start();
  await boss.createQueue(fileVerifyQueue, fileVerifyQueueOptions);
  await boss.createQueue(fileExtractQueue, fileExtractQueueOptions);
  await boss.createQueue(knowledgeReleaseBuildQueue, knowledgeReleaseBuildQueueOptions);
  await boss.createQueue(blobGcQueue, blobGcQueueOptions);
  assertKnowledgeReleaseBuildQueueConfiguration(await boss.getQueue(knowledgeReleaseBuildQueue));
  assertBlobGcQueueConfiguration(await boss.getQueue(blobGcQueue));
  if (config.verificationMaxAttempts !== fileVerifyRetryLimit + 1) {
    throw new Error("File verification attempt budget must equal pg-boss retryLimit + 1");
  }
  if (config.extractionMaxAttempts !== fileExtractRetryLimit + 1) {
    throw new Error("File extraction attempt budget must equal pg-boss retryLimit + 1");
  }
  if (config.knowledgeMaxAttempts !== knowledgeReleaseBuildRetryLimit + 1) {
    throw new Error("Knowledge release attempt budget must equal pg-boss retryLimit + 1");
  }
  const blobGcMaximumAttempts = blobGcRetryLimit + 1;
  const tracedQueue = {
    send(name: string, data: object, options: { singletonKey: string }) {
      return traceQueuePublish(name, data, (tracedData) => boss.send(name, tracedData, options));
    },
  };

  const reconciler = new VerificationReconciler(
    store,
    tracedQueue,
    config.verificationMaxAttempts,
    config.reconciliationStaleMs,
    config.reconciliationBatchSize,
    config.reconciliationIntervalMs,
    (error) => console.error("[file-worker:reconciler]", error),
  );
  const extractionReconciler = new ExtractionReconciler(
    extractionStore,
    tracedQueue,
    config.extractionMaxAttempts,
    config.extractionReconciliationStaleMs,
    config.reconciliationBatchSize,
    config.reconciliationIntervalMs,
    (error) => console.error("[file-worker:extraction-reconciler]", error),
  );
  const knowledgeReconciler = new KnowledgeReconciler(
    knowledgeStore,
    tracedQueue,
    config.knowledgeMaxAttempts,
    config.knowledgeReconciliationStaleMs,
    config.reconciliationBatchSize,
    config.reconciliationIntervalMs,
    (error) => console.error("[file-worker:knowledge-reconciler]", error),
  );
  const blobGcReconciler = new BlobGcReconciler(
    blobGcStore,
    tracedQueue,
    config.blobGcGraceMs,
    blobGcMaximumAttempts,
    config.blobGcBatchSize,
    config.blobGcReconciliationIntervalMs,
    (error) => console.error("[file-worker:blob-gc-reconciler]", error),
  );

  await boss.work<FileVerifyJob>(fileVerifyQueue, {
    includeMetadata: true,
    localConcurrency: config.concurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<FileVerifyJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: fileVerifyQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const command = fileVerifyJobSchema.parse(queuePayload(job.data));
      return runner.run(command.uploadSessionId, {
        queueJobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }, job.signal);
    });
  });

  await boss.work<FileExtractJob>(fileExtractQueue, {
    includeMetadata: true,
    localConcurrency: config.extractionConcurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<FileExtractJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: fileExtractQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const command = fileExtractJobSchema.parse(queuePayload(job.data));
      return extractionRunner.run(command.extractionId, {
        queueJobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }, job.signal);
    });
  });

  await boss.work<KnowledgeReleaseBuildJob>(knowledgeReleaseBuildQueue, {
    includeMetadata: true,
    localConcurrency: config.knowledgeConcurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<KnowledgeReleaseBuildJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: knowledgeReleaseBuildQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const command = knowledgeReleaseBuildJobSchema.parse(queuePayload(job.data));
      return knowledgeRunner.run(command.releaseId, {
        queueJobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }, job.signal);
    });
  });

  await boss.work<BlobGcJob>(blobGcQueue, {
    includeMetadata: true,
    localConcurrency: config.blobGcConcurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<BlobGcJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: blobGcQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const command = blobGcJobSchema.parse(queuePayload(job.data));
      return blobGcProcessor.run(command.blobId, job.signal);
    });
  });

  await reconciler.runOnce();
  reconciler.start();
  await extractionReconciler.runOnce();
  extractionReconciler.start();
  await knowledgeReconciler.runOnce();
  knowledgeReconciler.start();
  await blobGcReconciler.runOnce();
  blobGcReconciler.start();
  await doclingResultReaper.runOnce().catch((error) => console.error("[file-worker:docling-result-reaper]", error));
  doclingResultReaper.start();

  const shutdown = async (signal: string) => {
    console.log(`[file-worker] received ${signal}`);
    reconciler.stop();
    extractionReconciler.stop();
    knowledgeReconciler.stop();
    blobGcReconciler.stop();
    doclingResultReaper.stop();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.$disconnect();
    await telemetry.shutdown();
  };
  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
  console.log(`[file-worker] listening on ${fileVerifyQueue}, ${fileExtractQueue}, ${knowledgeReleaseBuildQueue}, and ${blobGcQueue} with ${config.scanMode} scanner`);
}

void main().catch(async (error) => {
  console.error("[file-worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});

function requireClamAvHost(value: string | undefined) {
  if (!value) throw new Error("Missing WORKBENCH_CLAMAV_HOST");
  return value;
}
