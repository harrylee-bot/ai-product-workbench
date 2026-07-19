import { randomUUID } from "node:crypto";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import {
  createAndAssertRuntimeQueues,
  runtimeCancelQueue,
  runtimeExecuteQueue,
  type RuntimeCancelJob,
  type RuntimeExecuteJob,
} from "@workbench/workbench-contracts";
import {
  initializeTelemetry,
  queuePayload,
  traceQueueConsume,
} from "@workbench/workbench-telemetry";
import { loadWorkerConfig } from "./config.js";
import { db } from "./db.js";
import { DeerFlowRuntimeAdapter } from "./runtime/deerflow-runtime.adapter.js";
import { PrismaKnowledgeToolGrantIssuer } from "./runtime/knowledge-tool-grant.service.js";
import { PrismaCanvasToolGrantIssuer } from "./runtime/canvas-tool-grant.service.js";
import { RunProcessor } from "./runs/run-processor.js";
import { RuntimeCancellationReconciler } from "./runs/runtime-cancellation-reconciler.js";
import { RuntimeExecutionReconciler } from "./runs/runtime-execution-reconciler.js";
import { S3RuntimeReadyBlobReader } from "./storage/s3-runtime-ready-blob-reader.js";

const telemetry = initializeTelemetry({ serviceName: "workbench-runtime-worker" });

async function main() {
  const config = loadWorkerConfig();
  await db.$connect();
  const storage = new S3RuntimeReadyBlobReader(config);
  const runtime = new DeerFlowRuntimeAdapter(config, storage);
  const knowledgeToolGrants = new PrismaKnowledgeToolGrantIssuer(db, config.knowledgeTool);
  const canvasToolGrants = new PrismaCanvasToolGrantIssuer(db, config.canvasTool);
  const processor = new RunProcessor(
    db,
    runtime,
    knowledgeToolGrants,
    canvasToolGrants,
    undefined,
    config.runtimeCancelRecoveryWindowMs,
    {
      ownerPrefix: `runtime-worker:${process.pid}:${randomUUID()}`,
      leaseMs: config.runtimeExecutionLeaseMs,
      heartbeatMs: config.runtimeExecutionHeartbeatMs,
    },
  );
  const boss = new PgBoss({
    connectionString: config.queueConnectionString,
    schema: "workbench_jobs",
    application_name: "workbench-runtime-worker",
    schedule: false,
    supervise: true,
    useListenNotify: true,
  });
  boss.on("error", (error) => console.error("[pg-boss]", error));
  boss.on("warning", (warning) => console.warn("[pg-boss]", warning));
  await boss.start();
  await createQueues(boss);

  await boss.work<RuntimeExecuteJob>(runtimeExecuteQueue, {
    includeMetadata: true,
    localConcurrency: config.concurrency,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<RuntimeExecuteJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: runtimeExecuteQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const command = queuePayload<RuntimeExecuteJob>(job.data);
      return processor.execute(command.runId, command.approvalIds ?? [], job.signal, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    });
  });

  await boss.work<RuntimeCancelJob>(runtimeCancelQueue, {
    includeMetadata: true,
    localConcurrency: Math.max(1, config.concurrency),
    pollingIntervalSeconds: 1,
    notifyPollingIntervalSeconds: 15,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<RuntimeCancelJob> | undefined;
    if (!job) return;
    return traceQueueConsume({
      destination: runtimeCancelQueue,
      messageId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    }, job.data, () => {
      const command = queuePayload<RuntimeCancelJob>(job.data);
      return processor.cancel(command.runId, job.signal, {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
    });
  });

  const cancellationReconciler = new RuntimeCancellationReconciler(
    db,
    boss,
    config.runtimeCancelReconcileStaleMs,
    config.runtimeCancelReconcileBatchSize,
    config.runtimeCancelReconcileIntervalMs,
    (error) => console.error("[runtime-cancellation-reconciler]", error),
  );
  await cancellationReconciler.runOnce();
  cancellationReconciler.start();
  const executionReconciler = new RuntimeExecutionReconciler(
    db,
    boss,
    config.runtimeExecutionReconcileBatchSize,
    config.runtimeExecutionReconcileIntervalMs,
    (error) => console.error("[runtime-execution-reconciler]", error),
  );
  await executionReconciler.runOnce();
  executionReconciler.start();

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}`);
    cancellationReconciler.stop();
    executionReconciler.stop();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.$disconnect();
    await telemetry.shutdown();
  };
  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
  console.log(`[worker] listening on ${runtimeExecuteQueue}, ${runtimeCancelQueue}`);
}

async function createQueues(boss: PgBoss) {
  await createAndAssertRuntimeQueues(boss);
}

void main().catch(async (error) => {
  console.error("[worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});
