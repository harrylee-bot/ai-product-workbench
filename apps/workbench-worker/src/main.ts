import { randomUUID } from "node:crypto";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import {
  createAndAssertRuntimeQueues,
  runtimeCancelQueue,
  runtimeExecuteQueue,
  type RuntimeCancelJob,
  type RuntimeExecuteJob,
} from "@workbench/workbench-contracts";
import { prismaReadyObjectIntegrityRecorder } from "@workbench/workbench-content-security";
import {
  initializeTelemetry,
  queuePayload,
  recordRuntimeLivenessMetric,
  traceQueueConsume,
} from "@workbench/workbench-telemetry";
import { loadWorkerConfig } from "./config.js";
import { db } from "./db.js";
import { DeerFlowRuntimeAdapter } from "./runtime/deerflow-runtime.adapter.js";
import { RuntimeLivenessError } from "./runtime/runtime-liveness.js";
import { PrismaKnowledgeToolGrantIssuer } from "./runtime/knowledge-tool-grant.service.js";
import { PrismaCanvasToolGrantIssuer } from "./runtime/canvas-tool-grant.service.js";
import { RunProcessor } from "./runs/run-processor.js";
import { loadRuntimeWorkerExecutionSignerFromEnvironment } from "./runtime/runtime-worker-execution-attestation.js";
import { createRuntimeExecuteJobHandler } from "./runs/runtime-execute-job.handler.js";
import { RuntimeCancellationReconciler } from "./runs/runtime-cancellation-reconciler.js";
import { RuntimeExecutionReconciler } from "./runs/runtime-execution-reconciler.js";
import { S3RuntimeReadyBlobReader } from "./storage/s3-runtime-ready-blob-reader.js";
import { shutdownWorkerWithExitCode } from "./shutdown.js";

const telemetry = initializeTelemetry({ serviceName: "workbench-runtime-worker" });

async function main() {
  const config = loadWorkerConfig();
  const executionSigner = await loadRuntimeWorkerExecutionSignerFromEnvironment();
  await db.$connect();
  const storage = new S3RuntimeReadyBlobReader(
    config,
    prismaReadyObjectIntegrityRecorder(db),
  );
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
      maximumWallClockMs: config.runtimeExecutionMaximumWallClockMs,
      deadlineCancelMs: config.runtimeExecutionDeadlineCancelMs,
      cancellationPollIntervalMs: config.runtimeCancellationPollIntervalMs,
      cancellationQueryBatchSize: config.runtimeCancellationQueryBatchSize,
      providerStateMode: config.runtimeProviderStateMode,
      providerStateShadowReporter: (finding) => {
        console.error("[runtime-provider-state-shadow]", JSON.stringify(finding));
      },
    },
  );
  const boss = new PgBoss({
    connectionString: config.queueConnectionString,
    schema: "workbench_jobs",
    application_name: "workbench-runtime-worker",
    schedule: false,
    supervise: true,
    migrate: false,
    createSchema: false,
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
  }, createRuntimeExecuteJobHandler({
    processor,
    executionSigner,
    recordQueueAge,
    recordTerminalRunDrift,
  }));

  await boss.work<RuntimeCancelJob>(runtimeCancelQueue, {
    includeMetadata: true,
    localConcurrency: Math.max(1, config.concurrency),
    pollingIntervalSeconds: 1,
    notifyPollingIntervalSeconds: 15,
  }, async (jobs) => {
    const job = jobs[0] as JobWithMetadata<RuntimeCancelJob> | undefined;
    if (!job) return;
    const command = queuePayload<RuntimeCancelJob>(job.data);
    const startedAt = performance.now();
    recordQueueAge(job);
    try {
      const result = await traceQueueConsume({
        destination: runtimeCancelQueue,
        messageId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }, job.data, () => (
        processor.cancel(command.runId, job.signal)
      ));
      recordRuntimeLivenessMetric({
        operation: "cancel",
        outcome: result.cancelled ? "cancelled" : "ok",
        durationMs: performance.now() - startedAt,
      });
      if (result.cancelled) await recordTerminalRunDrift(command.runId);
      return result;
    } catch (error) {
      const providerCancelTimedOut = error instanceof RuntimeLivenessError
        && error.code === "RUNTIME_PROVIDER_CANCEL_TIMEOUT";
      recordRuntimeLivenessMetric({
        operation: "cancel",
        outcome: providerCancelTimedOut ? "timeout" : job.signal.aborted ? "cancelled" : "error",
        durationMs: performance.now() - startedAt,
        errorCode: providerCancelTimedOut
          ? error.code
          : job.signal.aborted ? "RUNTIME_QUEUE_ABORTED" : "RUNTIME_CANCEL_JOB_FAILED",
      });
      if (job.signal.aborted) {
        recordRuntimeLivenessMetric({
          operation: "abort",
          outcome: "cancelled",
          errorCode: "RUNTIME_QUEUE_ABORTED",
        });
      }
      if (job.retryCount >= job.retryLimit) {
        await recordTerminalRunDrift(command.runId);
      }
      throw new Error(
        providerCancelTimedOut
          ? error.code
          : job.signal.aborted ? "RUNTIME_QUEUE_ABORTED" : "RUNTIME_CANCEL_JOB_FAILED",
      );
    }
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

  const shutdownDependencies = {
    log: (message: string) => console.log(message),
    logError: (message: string, error: unknown) => console.error(message, error),
    stopReconcilers: async () => {
      await Promise.all([cancellationReconciler.stop(), executionReconciler.stop()]);
    },
    stopQueue: () => boss.stop({ graceful: true, timeout: 30_000 }),
    disconnectDatabase: () => db.$disconnect(),
    shutdownTelemetry: () => telemetry.shutdown(),
  };
  const handleShutdown = (signal: string) => {
    void shutdownWorkerWithExitCode(signal, shutdownDependencies)
      .then((exitCode) => process.exit(exitCode));
  };
  process.once("SIGINT", () => handleShutdown("SIGINT"));
  process.once("SIGTERM", () => handleShutdown("SIGTERM"));
  console.log(`[worker] listening on ${runtimeExecuteQueue}, ${runtimeCancelQueue}`);
}

async function createQueues(boss: PgBoss) {
  await createAndAssertRuntimeQueues(boss);
}

function recordQueueAge(job: Pick<JobWithMetadata, "createdOn" | "startedOn">) {
  recordRuntimeLivenessMetric({
    operation: "queue-age",
    outcome: "ok",
    durationMs: Math.max(0, job.startedOn.getTime() - job.createdOn.getTime()),
  });
}

async function recordTerminalRunDrift(runId: string) {
  try {
    const run = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
    const converged = run !== null && terminalRunStatuses.has(run.status);
    recordRuntimeLivenessMetric({
      operation: "terminal-drift",
      outcome: converged ? "ok" : "error",
      ...(converged
        ? {}
        : { errorCode: run ? "RUNTIME_TERMINAL_STATE_ACTIVE" : "RUNTIME_TERMINAL_STATE_MISSING" }),
    });
  } catch {
    recordRuntimeLivenessMetric({
      operation: "terminal-drift",
      outcome: "error",
      errorCode: "RUNTIME_TERMINAL_STATE_CHECK_FAILED",
    });
  }
}

const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled"]);

void main().catch(async (error) => {
  console.error("[worker] fatal", error);
  await db.$disconnect().catch(() => undefined);
  await telemetry.shutdown().catch(() => undefined);
  process.exit(1);
});
