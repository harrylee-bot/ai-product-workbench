import { PgBoss, type JobWithMetadata } from "pg-boss";
import { fromPrisma } from "pg-boss";
import type { Prisma } from "@workbench/workbench-db";
import {
  assertImportSourceProcessQueueConfiguration,
  importSourceProcessJobOptions,
  importSourceProcessJobSchema,
  importSourceProcessQueue,
  importSourceProcessQueueOptions,
  type ImportSourceProcessJob,
} from "@workbench/workbench-contracts";
import { ClamAvScanAdapter, FailClosedScanAdapter } from "@workbench/workbench-content-security";
import { initializeTelemetry, queuePayload, traceQueueConsume, traceQueuePublish } from "@workbench/workbench-telemetry";
import { loadImportWorkerConfig } from "./config.js";
import { db } from "./db.js";
import { SafeHttpClient } from "./fetch/safe-http-client.js";
import { FigmaImportProvider } from "./import/figma.provider.js";
import { GithubImportProvider } from "./import/github.provider.js";
import { ImportSourceProcessor } from "./import/import-source.processor.js";
import { PrismaImportSourceStore } from "./import/import-source.store.js";
import { ImportProviderRegistry } from "./import/provider-registry.js";
import { UrlImportProvider } from "./import/url.provider.js";
import { S3ImportStorageAdapter } from "./storage/s3-import-storage.adapter.js";

const telemetry = initializeTelemetry({ serviceName: "workbench-import-worker" });

async function main() {
  const config = loadImportWorkerConfig();
  if (process.env.NODE_ENV === "production" && config.scanMode !== "clamav") {
    throw new Error("Production import verification requires WORKBENCH_FILE_SCAN_MODE=clamav");
  }
  await db.$connect();
  const boss = new PgBoss({
    connectionString: config.queueConnectionString,
    schema: "workbench_jobs",
    application_name: "workbench-import-worker",
    schedule: false,
    supervise: true,
    migrate: false,
    createSchema: false,
    useListenNotify: true,
  });
  boss.on("error", (error) => console.error("[import-worker:pg-boss]", error));
  boss.on("warning", (warning) => console.warn("[import-worker:pg-boss]", warning));
  await boss.start();
  await boss.createQueue(importSourceProcessQueue, importSourceProcessQueueOptions);
  assertImportSourceProcessQueueConfiguration(await boss.getQueue(importSourceProcessQueue));

  const store = new PrismaImportSourceStore(db, {
    pending: config.pendingBlobPrefix,
    canonical: config.canonicalBlobPrefix,
  });
  const clamAvScanner = config.scanMode === "clamav"
    ? new ClamAvScanAdapter(config.clamAvHost, config.clamAvPort, config.clamAvTimeoutMs, config.clamAvStreamMaxBytes, config.clamAvSignatureMaxAgeMs)
    : null;
  const scanner = clamAvScanner ?? new FailClosedScanAdapter();
  if (clamAvScanner) await clamAvScanner.assertReady(config.maximumImportBlobBytes);
  const client = new SafeHttpClient();
  const providers = new ImportProviderRegistry([
    new UrlImportProvider(client, { maximumBytes: config.maximumUrlBytes, timeoutMs: config.requestTimeoutMs, maximumRedirects: config.maximumRedirects }),
    new GithubImportProvider(client, { maximumBytes: config.maximumGithubBytes, maximumFiles: config.maximumGithubFiles, timeoutMs: config.requestTimeoutMs, maximumRedirects: config.maximumRedirects, token: config.githubToken }),
    new FigmaImportProvider(client, { maximumBytes: config.maximumFigmaBytes, timeoutMs: config.requestTimeoutMs, maximumRedirects: config.maximumRedirects, token: config.figmaToken }),
  ]);
  const processor = new ImportSourceProcessor(store, providers, scanner, new S3ImportStorageAdapter(config), config.maximumSourceBytes);

  await boss.work<ImportSourceProcessJob>(importSourceProcessQueue, {
    includeMetadata: true,
    localConcurrency: config.concurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<ImportSourceProcessJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: importSourceProcessQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const payload = importSourceProcessJobSchema.parse(queuePayload(job.data));
      return processor.process(payload.sourceId, job.id, importSourceProcessQueueOptions.expireInSeconds * 1000, config.maximumAttempts, job.signal);
    });
  });

  const enqueueRetry = async (tx: Prisma.TransactionClient, payload: ImportSourceProcessJob) => {
    const jobId = await traceQueuePublish(importSourceProcessQueue, payload, (tracedPayload) => boss.send(importSourceProcessQueue, tracedPayload, {
      ...importSourceProcessJobOptions(payload),
      retryLimit: importSourceProcessQueueOptions.retryLimit,
      retryDelay: importSourceProcessQueueOptions.retryDelay,
      retryBackoff: importSourceProcessQueueOptions.retryBackoff,
      retryDelayMax: importSourceProcessQueueOptions.retryDelayMax,
      expireInSeconds: importSourceProcessQueueOptions.expireInSeconds,
      db: fromPrisma(tx),
    }));
    if (!jobId) throw new Error("IMPORT_QUEUE_PUBLISH_REJECTED");
    return jobId;
  };

  const reconcileOnce = async () => {
    await store.expireStaleAttempts(new Date(Date.now() - config.staleRunningMs), config.maximumAttempts, 50);
    const candidates = await store.reconciliationCandidates(new Date(Date.now() - config.staleRunningMs), config.maximumAttempts, 50);
    for (const candidate of candidates) {
      await store.scheduleRetry(candidate, enqueueRetry).catch((error) => console.error("[import-worker:reconcile]", error));
    }
  };
  await reconcileOnce();
  const timer = setInterval(() => void reconcileOnce().catch((error) => console.error("[import-worker:reconcile]", error)), config.reconciliationIntervalMs);
  timer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.$disconnect();
    await telemetry.shutdown();
    console.log(`[import-worker] stopped after ${signal}`);
  };
  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
  console.log(`[import-worker] listening on ${importSourceProcessQueue}`);
}

void main().catch(async (error) => {
  console.error("[import-worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});
