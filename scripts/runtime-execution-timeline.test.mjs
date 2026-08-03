import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildRuntimeExecutionTimeline } from "./runtime-execution-timeline.mjs";

const root = new URL("../", import.meta.url);

test("the real-stack E2E entrypoint is valid executable JavaScript", () => {
  const entrypoint = fileURLToPath(new URL("scripts/workbench-postgres-http-e2e.mjs", root));
  const result = spawnSync(process.execPath, ["--check", entrypoint], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("pins the 900-second root cause and the independent application liveness budgets", async () => {
  const [
    packageJson,
    lockfile,
    queues,
    main,
    executeHandler,
    processor,
    liveness,
    manager,
    plans,
  ] = await Promise.all([
    read("package.json"),
    read("package-lock.json"),
    read("packages/workbench-contracts/src/queues.ts"),
    read("apps/workbench-worker/src/main.ts"),
    read("apps/workbench-worker/src/runs/runtime-execute-job.handler.ts"),
    read("apps/workbench-worker/src/runs/run-processor.ts"),
    read("apps/workbench-worker/src/runtime/runtime-liveness.ts"),
    read("node_modules/pg-boss/dist/manager.js"),
    read("node_modules/pg-boss/dist/plans.js"),
  ]);

  assert.match(packageJson, /"pg-boss": "12\.26\.0"/u);
  assert.match(lockfile, /node_modules\/pg-boss[\s\S]*?"version": "12\.26\.0"/u);
  assert.match(queues, /runtimeExecuteQueueOptions[\s\S]*?expireInSeconds: 35 \* 60/u);
  assert.match(manager, /jobs\.forEach\(job => \{ job\.signal = ac\.signal; \}\)/u);
  assert.match(manager, /resolveWithinSeconds\(callback\(jobs\), maxExpiration/u);
  assert.match(manager, /handler execution exceeded \$\{maxExpiration\}s/u);
  assert.match(plans, /started_on \+ expire_seconds \* interval '1s'/u);
  assert.match(main, /createRuntimeExecuteJobHandler\(\{[\s\S]*?processor,[\s\S]*?executionSigner/u);
  assert.match(executeHandler, /processor\.execute\([\s\S]*?job\.signal/u);
  assert.match(processor, /controller\.signal,[\s\S]*?wallClock\.signal/u);
  assert.match(processor, /raceWithAbort\(this\.runtime\.execute/u);
  assert.match(
    liveness,
    /export type RuntimeLivenessCode =\s*\| "RUNTIME_PROVIDER_SUBMISSION_TIMEOUT"\s*\| "RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT"\s*\| "RUNTIME_PROVIDER_CANCEL_TIMEOUT"\s*\| "RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED";/u,
  );
  assert.match(
    processor,
    /function finalRuntimeProviderLivenessError\([\s\S]*?candidate instanceof RuntimeLivenessError\s*&& candidate\.code !== "RUNTIME_PROVIDER_CANCEL_TIMEOUT"/u,
  );

  const cleanup = processor.indexOf("const cleanup = await this.cancelLivenessExceededProvider({");
  const reconcileKnownRun = processor.indexOf("await this.attempts.recordRetryableError(claim, {", cleanup);
  const reconcileUnknownSubmission = processor.indexOf("await this.attempts.markSubmissionUnknown(claim);", cleanup);
  const unresolvedTerminalize = processor.indexOf(
    "await this.failRun(runId, runtimeAttemptId, failure, retryable, claim, failureContext);",
    cleanup,
  );
  const terminalize = processor.indexOf("await this.failRun(runId, runtimeAttemptId, failure, retryable, claim);", cleanup);
  assert(cleanup >= 0, "terminal provider liveness errors must enter the shared cancellation path");
  assert(unresolvedTerminalize > cleanup, "unconfirmed cleanup must become a durable terminal failure");
  assert(terminalize > cleanup, "local terminalization must follow provider cancellation cleanup");
  assert(cleanup < reconcileKnownRun && cleanup < reconcileUnknownSubmission);
  assert(unresolvedTerminalize < terminalize);
  assert(reconcileKnownRun < terminalize && reconcileUnknownSubmission < terminalize);
  const cleanupPath = processor.slice(cleanup, terminalize);
  assert.match(cleanupPath, /if \(runtimeProviderCleanupConverged\(cleanup\.result\)\)/u);
  assert.match(
    cleanupPath,
    /failureContext = \{[\s\S]*?code: runtimeProviderCancellationUnconfirmedCode,[\s\S]*?submissionUnknown: !externalRunId/u,
  );
  assert.match(
    cleanupPath,
    /error instanceof RuntimeSubmissionUnknownError[\s\S]*?!providerCleanupConverged[\s\S]*?!failureContext[\s\S]*?this\.attempts\.markSubmissionUnknown/u,
  );
  assert.match(
    processor,
    /private async cancelLivenessExceededProvider\([\s\S]*?new RuntimeProviderCancellationBudget\(this\.executionDeadlineCancelMs\)[\s\S]*?raceWithAbort\(this\.runtime\.cancel\([\s\S]*?this\.attempts\.attachExternalRunForCleanup\([\s\S]*?input\.runtimeAttemptId,[\s\S]*?candidateExternalRunId,[\s\S]*?cancellationBudget\.signal\), cancellationBudget\.signal\)/u,
  );
});

test("builds a strict content-free runtime execution timeline", () => {
  const input = validTimeline();
  const timeline = buildRuntimeExecutionTimeline(input);
  const serialized = JSON.stringify(timeline);

  assert.equal(timeline.protocol, "workbench.runtime-execution-timeline.v1");
  assert.match(timeline.jobIdSha256, /^[0-9a-f]{64}$/u);
  assert.match(timeline.runIdSha256, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(serialized, /job-sensitive-id|run-sensitive-id/u);
  assert.deepEqual(Object.keys(timeline.timestamps).sort(), [
    "abortAtUtc",
    "claimAtUtc",
    "completedAtUtc",
    "createdAtUtc",
    "expiredAtUtc",
    "failedAtUtc",
    "heartbeatAtUtc",
    "leaseExpiresAtUtc",
    "providerFirstByteAtUtc",
    "providerLastEventAtUtc",
    "providerSubmittedAtUtc",
    "reconciledAtUtc",
    "startedAtUtc",
  ]);
});

test("rejects content fields and unstable status detail", () => {
  assert.throws(
    () => buildRuntimeExecutionTimeline({ ...validTimeline(), prompt: "forbidden" }),
    /RUNTIME_TIMELINE_INPUT_KEYS_INVALID/u,
  );
  assert.throws(
    () => buildRuntimeExecutionTimeline({ ...validTimeline(), providerOutcome: "provider returned user text" }),
    /RUNTIME_TIMELINE_PROVIDEROUTCOME_INVALID/u,
  );
});

function validTimeline() {
  return {
    jobId: "job-sensitive-id",
    runId: "run-sensitive-id",
    candidateSha: "e7deb65d8b6e03f8a9e73787afeaaca7a70750e6",
    imageDigest: `sha256:${"a".repeat(64)}`,
    retryCount: 0,
    pgBossState: "expired",
    runStatus: "active",
    attemptStatus: "active",
    providerOutcome: "STREAM_IDLE",
    reconcilerOutcome: null,
    createdAtUtc: "2026-07-23T00:00:00.000Z",
    startedAtUtc: "2026-07-23T00:00:01.000Z",
    expiredAtUtc: "2026-07-23T00:15:01.000Z",
    completedAtUtc: null,
    failedAtUtc: null,
    claimAtUtc: "2026-07-23T00:00:01.000Z",
    heartbeatAtUtc: "2026-07-23T00:15:00.000Z",
    leaseExpiresAtUtc: "2026-07-23T00:15:45.000Z",
    providerSubmittedAtUtc: "2026-07-23T00:00:02.000Z",
    providerFirstByteAtUtc: null,
    providerLastEventAtUtc: null,
    abortAtUtc: "2026-07-23T00:15:01.000Z",
    reconciledAtUtc: null,
  };
}

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}
