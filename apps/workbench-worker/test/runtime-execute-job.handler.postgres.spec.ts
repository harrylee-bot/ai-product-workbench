import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import { PgBoss } from "pg-boss";
import { createRuntimeExecuteJobHandler } from "../src/runs/runtime-execute-job.handler.js";
import { createRuntimeWorkerExecutionSigner } from "../src/runtime/runtime-worker-execution-attestation.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Runtime execute handler PostgreSQL persistence", () => {
  it("persists a signed successful result and cannot persist a malformed result as completed", async () => {
    const boss = runtimeBoss(databaseUrl!);
    const queueName = `runtime.signed-result.${randomUUID()}`;
    const keys = generateKeyPairSync("ed25519");
    const signer = createRuntimeWorkerExecutionSigner({
      privateKey: keys.privateKey,
      signerId: "runtime-worker",
      environmentId: "production",
      candidateCommit: "a".repeat(40),
      runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
    });
    const processor = {
      execute: vi.fn(async (
        runId: string,
        _approvalIds: string[],
        _signal: AbortSignal,
        _retry: unknown,
        hooks: { onRuntimeAttemptResolved?: (runtimeAttemptId: string) => void },
      ) => {
        hooks.onRuntimeAttemptResolved?.(`attempt-${runId}`);
        return runId === "valid"
          ? { runId, artifactCount: 1 }
          : { runId, artifactCount: 1, untrusted: true };
      }),
    };
    const handler = createRuntimeExecuteJobHandler({
      processor,
      executionSigner: signer,
      recordQueueAge: vi.fn(),
      recordTerminalRunDrift: vi.fn(async () => undefined),
    });

    try {
      await boss.start();
      await boss.createQueue(queueName, { policy: "standard", retryLimit: 0 });
      await boss.work(queueName, {
        includeMetadata: true,
        pollingIntervalSeconds: 1,
      }, handler);
      const validJobId = await boss.send(queueName, { runId: "valid", approvalIds: [] });
      const invalidJobId = await boss.send(queueName, { runId: "invalid", approvalIds: [] });
      expect(validJobId).toBeTruthy();
      expect(invalidJobId).toBeTruthy();

      const [validJob, invalidJob] = await waitForJobs(
        boss,
        queueName,
        validJobId!,
        invalidJobId!,
      );
      expect(validJob).toMatchObject({
        state: "completed",
        output: {
          runId: "valid",
          artifactCount: 1,
          workerExecution: {
            protocol: "workbench.runtime-worker-execution.v2",
            statement: {
              jobId: validJobId,
              runtimeAttemptId: "attempt-valid",
              resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
            signature: {
              algorithm: "Ed25519",
              keyId: signer.keyId,
              value: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/u),
            },
          },
        },
      });
      const receipt = (validJob?.output as {
        workerExecution: {
          protocol: string;
          statement: Record<string, unknown>;
          signature: { value: string };
        };
      }).workerExecution;
      expect(verify(
        null,
        Buffer.from(canonicalJson({ protocol: receipt.protocol, statement: receipt.statement })),
        keys.publicKey,
        Buffer.from(receipt.signature.value, "base64url"),
      )).toBe(true);
      expect(invalidJob?.state).toBe("failed");
      expect(isSuccessfulResult(invalidJob?.output, "invalid")).toBe(false);
    } finally {
      await boss.offWork(queueName).catch(() => undefined);
      await boss.deleteQueue(queueName).catch(() => undefined);
      await boss.stop({ graceful: false }).catch(() => undefined);
    }
  }, 30_000);
});

async function waitForJobs(
  boss: PgBoss,
  queueName: string,
  validJobId: string,
  invalidJobId: string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const jobs = await Promise.all([
      boss.getJobById(queueName, validJobId),
      boss.getJobById(queueName, invalidJobId),
    ]);
    if (jobs[0]?.state === "completed" && jobs[1]?.state === "failed") return jobs;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("RUNTIME_SIGNED_RESULT_PERSISTENCE_TIMEOUT");
}

function isSuccessfulResult(value: unknown, runId: string) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).runId === runId
    && (value as Record<string, unknown>).artifactCount === 1,
  );
}

function runtimeBoss(connectionString: string) {
  const url = new URL(connectionString);
  url.searchParams.delete("schema");
  return new PgBoss({
    connectionString: url.toString(),
    schema: "workbench_jobs",
    application_name: "runtime-signed-result-test",
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
    useListenNotify: false,
  });
}
