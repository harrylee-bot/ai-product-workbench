import type { Job, JobWithMetadata } from "pg-boss";
import {
  runtimeExecuteQueue,
  type RuntimeExecuteJob,
} from "@workbench/workbench-contracts";
import {
  queuePayload,
  recordRuntimeLivenessMetric,
  traceQueueConsume,
} from "@workbench/workbench-telemetry";
import type { RuntimeWorkerExecutionSigner } from "../runtime/runtime-worker-execution-attestation.js";
import { runtimeExecutionErrorCode, type RunProcessor } from "./run-processor.js";

type RuntimeExecuteHandlerDependencies = Readonly<{
  processor: Pick<RunProcessor, "execute">;
  executionSigner: RuntimeWorkerExecutionSigner;
  recordQueueAge: (job: Pick<JobWithMetadata, "createdOn" | "startedOn">) => void;
  recordTerminalRunDrift: (runId: string) => Promise<void>;
}>;

export function createRuntimeExecuteJobHandler({
  processor,
  executionSigner,
  recordQueueAge,
  recordTerminalRunDrift,
}: RuntimeExecuteHandlerDependencies) {
  return async (jobs: Job<RuntimeExecuteJob>[]) => {
    const job = jobs[0] as JobWithMetadata<RuntimeExecuteJob> | undefined;
    if (!job) return;
    const command = queuePayload<RuntimeExecuteJob>(job.data);
    recordQueueAge(job);
    try {
      let resolvedRuntimeAttemptId: string | null = null;
      const rawResult = await traceQueueConsume({
        destination: runtimeExecuteQueue,
        messageId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      }, job.data, () => (
        processor.execute(command.runId, command.approvalIds ?? [], job.signal, {
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        }, {
          onRuntimeAttemptResolved: (runtimeAttemptId) => {
            resolvedRuntimeAttemptId = runtimeAttemptId;
          },
        })
      ));
      const result = assertRuntimeExecuteResult(rawResult, command.runId);
      if (Object.prototype.hasOwnProperty.call(result, "artifactCount")) {
        if (resolvedRuntimeAttemptId === null) {
          throw new Error("RUNTIME_WORKER_EXECUTION_RESULT_INVALID");
        }
        await recordTerminalRunDrift(command.runId);
      }
      return executionSigner.attest(result, {
        jobId: job.id,
        runtimeAttemptId: resolvedRuntimeAttemptId,
      });
    } catch (error) {
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
      throw new Error(runtimeExecutionErrorCode(
        error,
        job.signal.aborted ? "RUNTIME_QUEUE_ABORTED" : "RUNTIME_EXECUTE_JOB_FAILED",
      ));
    }
  };
}

function assertRuntimeExecuteResult(value: unknown, runId: string): Record<string, unknown> {
  if (!isRecord(value) || value.runId !== runId) {
    throw new Error("RUNTIME_WORKER_EXECUTION_RESULT_INVALID");
  }
  const keys = Object.keys(value).sort().join("\u0000");
  const valid = (
    keys === "artifactCount\u0000runId"
      && Number.isSafeInteger(value.artifactCount)
      && Number(value.artifactCount) >= 0
  ) || (
    keys === "approvalCount\u0000runId\u0000waitingInput"
      && Number.isSafeInteger(value.approvalCount)
      && Number(value.approvalCount) >= 0
      && value.waitingInput === true
  ) || (
    keys === "cancellationPending\u0000runId"
      && typeof value.cancellationPending === "boolean"
  ) || (
    keys === "runId\u0000skipped" && value.skipped === true
  ) || (
    keys === "runId\u0000submissionUnknown" && value.submissionUnknown === true
  );
  if (!valid) throw new Error("RUNTIME_WORKER_EXECUTION_RESULT_INVALID");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
