import {
  exportBuildJobSchema,
  exportBuildQueue,
  exportBuildQueueOptions,
  type ExportBuildJob,
} from "@workbench/workbench-contracts";
import {
  initializeTelemetry,
  queuePayload,
  traceQueueConsume,
  traceQueuePublish,
} from "@workbench/workbench-telemetry";
import { prismaReadyObjectIntegrityRecorder } from "@workbench/workbench-content-security";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { BrowserExportService } from "./browser/browser-export.service.js";
import { loadExportWorkerConfig } from "./config.js";
import { db } from "./db.js";
import { ExportProcessor } from "./export/export.processor.js";
import { PrismaExportStore } from "./export/export.store.js";
import { ExportSourceLoader } from "./export/source-loader.js";
import { S3ExportStorageAdapter } from "./storage/s3-export-storage.adapter.js";

const telemetry = initializeTelemetry({ serviceName: "workbench-export-worker" });

async function main() {
  const config = loadExportWorkerConfig();
  await db.$connect();
  const boss = new PgBoss({
    connectionString: config.queueConnectionString,
    schema: "workbench_jobs",
    application_name: "workbench-export-worker",
    schedule: false,
    supervise: true,
    migrate: false,
    createSchema: false,
    useListenNotify: true,
  });
  boss.on("error", (error) => console.error("[export-worker:pg-boss]", error));
  boss.on("warning", (warning) => console.warn("[export-worker:pg-boss]", warning));
  await boss.start();
  await boss.createQueue(exportBuildQueue, exportBuildQueueOptions);

  const storage = new S3ExportStorageAdapter(
    config,
    prismaReadyObjectIntegrityRecorder(db),
  );
  const store = new PrismaExportStore(db, config);
  const loader = new ExportSourceLoader(storage, config);
  const browser = new BrowserExportService(config);
  const processor = new ExportProcessor(store, loader, storage, browser, config);
  await boss.work<ExportBuildJob>(exportBuildQueue, {
    includeMetadata: true,
    localConcurrency: config.concurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<ExportBuildJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: exportBuildQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const payload = exportBuildJobSchema.parse(queuePayload(job.data));
      return processor.process(payload.exportJobId, job.signal, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    });
  });

  const reconcileOnce = async () => {
    const candidates = await store.reconciliationCandidates(new Date(Date.now() - config.staleRunningMs));
    for (const candidate of candidates) {
      try {
        const data = exportBuildJobSchema.parse({ exportJobId: candidate.id });
        await traceQueuePublish(exportBuildQueue, data, (tracedData) => boss.send(exportBuildQueue, tracedData, {
          singletonKey: candidate.id,
          retryLimit: exportBuildQueueOptions.retryLimit,
          retryDelay: exportBuildQueueOptions.retryDelay,
          retryBackoff: exportBuildQueueOptions.retryBackoff,
          retryDelayMax: exportBuildQueueOptions.retryDelayMax,
          expireInSeconds: exportBuildQueueOptions.expireInSeconds,
        }));
      } catch (error) {
        console.error(`[export-worker:reconciler:${exportBuildQueue}:${candidate.id}]`, error);
      }
    }
  };
  let reconciliationInFlight: Promise<void> | null = null;
  const reconcile = () => {
    if (reconciliationInFlight) return reconciliationInFlight;
    const run = reconcileOnce().finally(() => {
      if (reconciliationInFlight === run) reconciliationInFlight = null;
    });
    reconciliationInFlight = run;
    return run;
  };
  await reconcile();
  const reconciliationTimer = setInterval(() => void reconcile().catch((error) => {
    console.error("[export-worker:reconciler]", error);
  }), config.reconciliationIntervalMs);
  reconciliationTimer.unref();

  let shutdownInFlight: Promise<void> | null = null;
  const shutdown = (signal: string) => shutdownInFlight ??= (async () => {
    console.log(`[export-worker] received ${signal}`);
    clearInterval(reconciliationTimer);
    await reconciliationInFlight?.catch(() => undefined);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.$disconnect();
    await telemetry.shutdown();
  })();
  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
  console.log(`[export-worker] listening on ${exportBuildQueue}`);
}

void main().catch(async (error) => {
  console.error("[export-worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});
