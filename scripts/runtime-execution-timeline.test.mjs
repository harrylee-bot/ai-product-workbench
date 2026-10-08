import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRuntimeExecutionTimeline } from "./runtime-execution-timeline.mjs";

const root = new URL("../", import.meta.url);

test("pins the 900-second root cause and the independent application liveness budgets", async () => {
  const [packageJson, lockfile, queues, main, executeHandler, processor, liveness, manager, plans] = await Promise.all([
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
  assert.match(liveness, /RUNTIME_PROVIDER_SUBMISSION_TIMEOUT/u);
  assert.match(liveness, /RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT/u);
  assert.match(liveness, /RUNTIME_PROVIDER_CANCEL_TIMEOUT/u);
  assert.match(liveness, /RUNTIME_EXECUTION_WALL_CLOCK_EXCEEDED/u);
  assert.match(
    processor,
    /function finalRuntimeProviderLivenessError\([\s\S]*?candidate instanceof RuntimeLivenessError\s*&& candidate\.code !== "RUNTIME_PROVIDER_CANCEL_TIMEOUT"/u,
  );
  const providerMayExist = processor.indexOf("const providerMayExist = Boolean(");
  const terminalize = processor.indexOf("const terminalization = await this.failRun(", providerMayExist);
  const cleanup = processor.indexOf("await this.reconcileTerminalLivenessProvider({", terminalize);
  const markSubmissionUnknown = processor.indexOf(
    "await this.attempts.markSubmissionUnknown(claim);",
    cleanup,
  );
  assert(providerMayExist >= 0, "terminal liveness handling must classify provider side effects");
  assert(terminalize > providerMayExist, "provider cleanup intent must be durable before side effects");
  assert(cleanup > terminalize, "provider cleanup must follow local terminalization");
  assert(markSubmissionUnknown > cleanup, "submission retry handling must remain outside terminal cleanup");
  assert.match(
    processor.slice(providerMayExist, markSubmissionUnknown),
    /code: runtimeProviderCancellationUnconfirmedCode,[\s\S]*?detailCode: terminalLivenessError\.code,[\s\S]*?if \(terminalization === "terminalized"\)[\s\S]*?reconcileTerminalLivenessProvider/u,
  );
  assert.match(
    processor,
    /const remainingOperationMs = operation\.monotonicDeadlineAtMs - performance\.now\(\)[\s\S]*?this\.runtime\.cancel\([\s\S]*?externalRunId: operation\.externalRunId,[\s\S]*?this\.attempts\.attachExternalRunForCleanup\([\s\S]*?operation\.epoch,[\s\S]*?externalRunId[\s\S]*?operationBudget\.signal/u,
  );
  assert.doesNotMatch(
    processor,
    /operation\.deadlineAt\.getTime\(\) - Date\.now\(\)/u,
    "provider cancellation timers must not mix the database and host wall clocks",
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
