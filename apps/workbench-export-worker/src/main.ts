import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { hostname } from "node:os";
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
  const container = await dockerIncarnation();
  const workerId = container
    ? `export-worker:${container.id}:${container.incarnation}:${randomUUID()}`
    : `export-worker:${randomUUID()}`;
  await boss.work<ExportBuildJob>(exportBuildQueue, {
    includeMetadata: true,
    localConcurrency: config.concurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<ExportBuildJob> | undefined;
    if (!job) return;
    const payload = exportBuildJobSchema.parse(queuePayload(job.data));
    return traceQueueConsume({
      destination: exportBuildQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => processor.process(payload.exportJobId, job.signal, {
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, workerId));
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
      const acknowledged = await store.acknowledgeCancellation(payload.exportJobId);
      if (acknowledged === "pending") throw new Error("EXPORT_CANCELLATION_ACK_PENDING");
      return { status: acknowledged };
    });
  });

  const reconcileOnce = async () => {
    if (container) await store.retirePreviousContainerRuns(container.id, container.incarnation);
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

async function dockerIncarnation() {
  const id = hostname();
  if (process.platform !== "linux" || !/^[a-f0-9]{12}$/.test(id)) return null;
  try {
    await access("/.dockerenv");
    const [boot, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile("/proc/1/stat", "utf8"),
    ]);
    // Field 22 is the start time in clock ticks. The command name may contain spaces.
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (!/^[0-9a-f-]{36}$/.test(boot.trim()) || !started || !/^\d+$/.test(started)) return null;
    return { id, incarnation: boot.trim() + "." + started };
  } catch {
    return null;
  }
}

void main().catch(async (error) => {
  console.error("[export-worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});
