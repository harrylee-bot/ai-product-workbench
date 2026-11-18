import {
  exportCancelQueue,
  exportCancelQueueOptions,
  exportCancelJobSchema,
  exportBuildJobSchema,
  exportBuildQueue,
  exportBuildQueueOptions,
  type ExportBuildJob,
  type ExportCancelJob,
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
  await boss.createQueue(exportCancelQueue, exportCancelQueueOptions);

  const storage = new S3ExportStorageAdapter(
    config,
    prismaReadyObjectIntegrityRecorder(db),
  );
  const store = new PrismaExportStore(db, config);
  const loader = new ExportSourceLoader(storage, config);
  const browser = new BrowserExportService(config);
  const processor = new ExportProcessor(store, loader, storage, browser, config);
  const activeExports = new Map<string, Set<ActiveExportRun>>();
  await boss.work<ExportBuildJob>(exportBuildQueue, {
    includeMetadata: true,
    localConcurrency: config.concurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<ExportBuildJob> | undefined;
    if (!job) return;
    const payload = exportBuildJobSchema.parse(queuePayload(job.data));
    const controller = new AbortController();
    let resolveDone!: () => void;
    const activeRun: ActiveExportRun = {
      controller,
      done: new Promise<void>((resolve) => { resolveDone = resolve; }),
    };
    const runs = activeExports.get(payload.exportJobId) ?? new Set<ActiveExportRun>();
    runs.add(activeRun);
    activeExports.set(payload.exportJobId, runs);
    const abortFromQueue = () => {
      if (!controller.signal.aborted) controller.abort(job.signal.reason ?? new Error("EXPORT_QUEUE_ABORTED"));
    };
    if (job.signal.aborted) abortFromQueue();
    else job.signal.addEventListener("abort", abortFromQueue, { once: true });
    try {
      return await traceQueueConsume({
        destination: exportBuildQueue,
        messageId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }, job.data, () => processor.process(payload.exportJobId, controller.signal, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }));
    } finally {
      job.signal.removeEventListener("abort", abortFromQueue);
      runs.delete(activeRun);
      if (runs.size === 0) activeExports.delete(payload.exportJobId);
      resolveDone();
    }
  });

  await boss.work<ExportCancelJob>(exportCancelQueue, {
    includeMetadata: true,
    localConcurrency: Math.max(1, config.concurrency),
    pollingIntervalSeconds: 1,
    notifyPollingIntervalSeconds: 15,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<ExportCancelJob> | undefined;
    if (!job) return;
    const payload = exportCancelJobSchema.parse(queuePayload(job.data));
    return traceQueueConsume({
      destination: exportCancelQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, async () => {
      const runs = activeExports.get(payload.exportJobId);
      if (runs && runs.size > 0) {
        for (const run of runs) run.controller.abort(new Error("EXPORT_CANCEL_REQUESTED"));
        await Promise.all([...runs].map((run) => run.done));
      }
      const acknowledged = await store.acknowledgeCancellation(payload.exportJobId);
      if (acknowledged === "pending") throw new Error("EXPORT_CANCELLATION_ACK_PENDING");
      return { status: "cancelled" as const };
    });
  });

  const reconcileOnce = async () => {
    const candidates = await store.reconciliationCandidates(new Date(Date.now() - config.staleRunningMs));
    for (const candidate of candidates) {
      try {
        const data = exportBuildJobSchema.parse({ exportJobId: candidate.id });
        const queue = candidate.status === "cancelling" ? exportCancelQueue : exportBuildQueue;
        const queueOptions = candidate.status === "cancelling" ? exportCancelQueueOptions : exportBuildQueueOptions;
        await traceQueuePublish(queue, data, (tracedData) => boss.send(queue, tracedData, {
          singletonKey: candidate.id,
          retryLimit: queueOptions.retryLimit,
          retryDelay: queueOptions.retryDelay,
          retryBackoff: queueOptions.retryBackoff,
          retryDelayMax: queueOptions.retryDelayMax,
          expireInSeconds: queueOptions.expireInSeconds,
        }));
      } catch (error) {
        const queue = candidate.status === "cancelling" ? exportCancelQueue : exportBuildQueue;
        console.error(`[export-worker:reconciler:${queue}:${candidate.id}]`, error);
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

type ActiveExportRun = {
  controller: AbortController;
  done: Promise<void>;
};

void main().catch(async (error) => {
  console.error("[export-worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});
