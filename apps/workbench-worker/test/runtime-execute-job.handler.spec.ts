import { generateKeyPairSync } from "node:crypto";
import type { Job } from "pg-boss";
import type { RuntimeExecuteJob } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeExecuteJobHandler } from "../src/runs/runtime-execute-job.handler.js";
import { createRuntimeWorkerExecutionSigner } from "../src/runtime/runtime-worker-execution-attestation.js";

const signer = createRuntimeWorkerExecutionSigner({
  privateKey: generateKeyPairSync("ed25519").privateKey,
  signerId: "runtime-worker",
  environmentId: "production",
  candidateCommit: "a".repeat(40),
  runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
});

describe("Runtime execute queue handler", () => {
  it("returns only a signed result bound to the claimed RuntimeAttempt", async () => {
    const recordTerminalRunDrift = vi.fn(async () => undefined);
    const processor = {
      execute: vi.fn(async (
        runId: string,
        _approvalIds: string[],
        _signal: AbortSignal,
        _retry: unknown,
        hooks: { onRuntimeAttemptResolved?: (runtimeAttemptId: string) => void },
      ) => {
        hooks.onRuntimeAttemptResolved?.("attempt-1");
        return { runId, artifactCount: 2 };
      }),
    };
    const handler = createRuntimeExecuteJobHandler({
      processor,
      executionSigner: signer,
      recordQueueAge: vi.fn(),
      recordTerminalRunDrift,
    });

    const result = await handler([queueJob("job-1", "run-1")]);

    expect(result).toMatchObject({
      runId: "run-1",
      artifactCount: 2,
      workerExecution: {
        protocol: "workbench.runtime-worker-execution.v2",
        statement: {
          jobId: "job-1",
          runtimeAttemptId: "attempt-1",
          candidateCommit: "a".repeat(40),
          runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
        },
        signature: { algorithm: "Ed25519", keyId: signer.keyId },
      },
    });
    expect(recordTerminalRunDrift).toHaveBeenCalledExactlyOnceWith("run-1");
  });

  it("signs non-terminal completion results and rejects unknown result shapes", async () => {
    const skippedHandler = createRuntimeExecuteJobHandler({
      processor: { execute: vi.fn(async (runId: string) => ({ runId, skipped: true })) },
      executionSigner: signer,
      recordQueueAge: vi.fn(),
      recordTerminalRunDrift: vi.fn(async () => undefined),
    });
    await expect(skippedHandler([queueJob("job-2", "run-2")])).resolves.toMatchObject({
      runId: "run-2",
      skipped: true,
      workerExecution: { statement: { runtimeAttemptId: null } },
    });

    const invalidHandler = createRuntimeExecuteJobHandler({
      processor: { execute: vi.fn(async (runId: string) => ({ runId, artifactCount: 1, unsigned: true })) },
      executionSigner: signer,
      recordQueueAge: vi.fn(),
      recordTerminalRunDrift: vi.fn(async () => undefined),
    });
    await expect(invalidHandler([queueJob("job-3", "run-3", 0, 1)]))
      .rejects.toThrow("RUNTIME_EXECUTE_JOB_FAILED");
  });

  it("signs the recovered terminal result after publication committed before queue output", async () => {
    const processor = {
      execute: vi.fn(async (
        runId: string,
        _approvalIds: string[],
        _signal: AbortSignal,
        _retry: unknown,
        hooks: { onRuntimeAttemptResolved?: (runtimeAttemptId: string) => void },
      ) => {
        hooks.onRuntimeAttemptResolved?.("attempt-published");
        return { runId, artifactCount: 3 };
      }),
    };
    const recordTerminalRunDrift = vi.fn()
      .mockRejectedValueOnce(new Error("process exited before pg-boss output persistence"))
      .mockResolvedValueOnce(undefined);
    const handler = createRuntimeExecuteJobHandler({
      processor,
      executionSigner: signer,
      recordQueueAge: vi.fn(),
      recordTerminalRunDrift,
    });

    await expect(handler([queueJob("job-retry", "run-published", 0, 1)]))
      .rejects.toThrow("RUNTIME_EXECUTE_JOB_FAILED");
    await expect(handler([queueJob("job-retry", "run-published", 1, 1)]))
      .resolves.toMatchObject({
        runId: "run-published",
        artifactCount: 3,
        workerExecution: {
          statement: {
            jobId: "job-retry",
            runtimeAttemptId: "attempt-published",
          },
        },
      });
    expect(processor.execute).toHaveBeenCalledTimes(2);
  });
});

function queueJob(
  id: string,
  runId: string,
  retryCount = 0,
  retryLimit = 0,
): Job<RuntimeExecuteJob> {
  const now = new Date();
  return {
    id,
    data: { runId, approvalIds: [] },
    retryCount,
    retryLimit,
    signal: new AbortController().signal,
    createdOn: now,
    startedOn: now,
  } as unknown as Job<RuntimeExecuteJob>;
}
