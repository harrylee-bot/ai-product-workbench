import assert from "node:assert/strict";
import test from "node:test";
import {
  backfillFailureMessage,
  migratorDatabaseUrl,
  parseOptions,
  runBackfill,
  runtimeProviderStateBackfillExitCodes,
} from "./backfill-workbench-runtime-provider-state.mjs";

test("redacts unexpected database and payload failures from operator stderr", () => {
  assert.equal(
    backfillFailureMessage(new Error("connection failed for postgresql://operator:secret@example.test/db")),
    "RUNTIME_PROVIDER_STATE_BACKFILL_FAILED",
  );
  assert.equal(
    backfillFailureMessage(new Error("RUNTIME_PROVIDER_STATE_BACKFILL_SEQUENCE_GAP")),
    "RUNTIME_PROVIDER_STATE_BACKFILL_SEQUENCE_GAP",
  );
});

test("parses bounded keyset backfill modes", () => {
  assert.deepEqual(parseOptions([
    "--expected-database=workbench_test",
    "--batch-size=25",
    "--max-batches=7",
    "--after-attempt-id=attempt_opaque",
    "--dry-run",
  ]), {
    expectedDatabase: "workbench_test",
    batchSize: 25,
    maxBatches: 7,
    afterAttemptId: "attempt_opaque",
    mode: "dry-run",
  });
  assert.throws(
    () => parseOptions(["--expected-database=workbench", "--dry-run", "--verify-only"]),
    /RUNTIME_PROVIDER_STATE_BACKFILL_MODE_INVALID/u,
  );
  assert.throws(
    () => parseOptions(["--expected-database=workbench", "--batch-size=1001"]),
    /RUNTIME_PROVIDER_STATE_BACKFILL_BATCH_SIZE_INVALID/u,
  );
  assert.throws(
    () => parseOptions(["--expected-database=workbench", "--max-batches=0"]),
    /RUNTIME_PROVIDER_STATE_BACKFILL_MAX_BATCHES_INVALID/u,
  );
  assert.throws(
    () => parseOptions(["--expected-database=workbench", "--after-attempt-id=not/a/cursor"]),
    /RUNTIME_PROVIDER_STATE_BACKFILL_CURSOR_INVALID/u,
  );
});

test("runs bounded keyset pages to an explicit completed terminal state", async () => {
  const calls: Array<string | undefined> = [];
  const emitted: unknown[] = [];
  const pages = [
    {
      checkpoints: [{ status: "created", attemptIdSha256: "a".repeat(64) }],
      nextAfterAttemptId: "attempt_1",
      hasMore: true,
    },
    {
      checkpoints: [{ status: "verified", attemptIdSha256: "b".repeat(64) }],
      nextAfterAttemptId: "attempt_2",
      hasMore: false,
    },
  ];
  const operator = {
    processPage: async (input: { afterAttemptId?: string }) => {
      calls.push(input.afterAttemptId);
      return pages.shift()!;
    },
    coverage: async () => completeCoverage(),
  };

  const result = await runBackfill(operator as never, {
    candidateSha: "a".repeat(40),
    mode: "apply",
    batchSize: 1,
    maxBatches: 3,
  }, (checkpoint) => emitted.push(checkpoint));

  assert.deepEqual(calls, [undefined, "attempt_1"]);
  assert.equal(emitted.length, 2);
  assert.deepEqual(result, {
    terminalStatus: "completed",
    batchesProcessed: 2,
    attemptsProcessed: 2,
    resumeAfterAttemptId: null,
    coverage: completeCoverage(),
    exitCode: runtimeProviderStateBackfillExitCodes.completed,
  });
});

test("stops at the batch bound with a resumable cursor and distinct exit code", async () => {
  const operator = {
    processPage: async () => ({
      checkpoints: [{ status: "created", attemptIdSha256: "a".repeat(64) }],
      nextAfterAttemptId: "attempt_resume",
      hasMore: true,
    }),
    coverage: async () => completeCoverage({ missing: 1, terminalMissing: 1, rolloutBlocked: true }),
  };

  const result = await runBackfill(operator as never, {
    candidateSha: "a".repeat(40),
    mode: "apply",
    batchSize: 1,
    maxBatches: 1,
  });

  assert.equal(result.terminalStatus, "resume-required");
  assert.equal(result.resumeAfterAttemptId, "attempt_resume");
  assert.equal(result.exitCode, runtimeProviderStateBackfillExitCodes.resumeRequired);
});

test("distinguishes an exhausted scan whose coverage still blocks rollout", async () => {
  const operator = {
    processPage: async () => ({ checkpoints: [], nextAfterAttemptId: null, hasMore: false }),
    coverage: async () => completeCoverage({ missing: 1, terminalMissing: 1, rolloutBlocked: true }),
  };

  const result = await runBackfill(operator as never, {
    candidateSha: "a".repeat(40),
    mode: "verify-only",
    batchSize: 10,
    maxBatches: 2,
  });

  assert.equal(result.terminalStatus, "coverage-blocked");
  assert.equal(result.resumeAfterAttemptId, null);
  assert.equal(result.exitCode, runtimeProviderStateBackfillExitCodes.coverageBlocked);
});

test("rejects an unbounded programmatic run before querying the operator", async () => {
  const operator = {
    processPage: async () => ({ checkpoints: [], nextAfterAttemptId: null, hasMore: false }),
    coverage: async () => completeCoverage(),
  };

  await assert.rejects(() => runBackfill(operator as never, {
    candidateSha: "a".repeat(40),
    mode: "apply",
    batchSize: 10,
    maxBatches: Number.POSITIVE_INFINITY,
  }), /RUNTIME_PROVIDER_STATE_BACKFILL_MAX_BATCHES_INVALID/u);
});

test("requires the explicit migrator role and exact PostgreSQL database target", () => {
  const previous = { ...process.env };
  try {
    process.env.WORKBENCH_POSTGRES_MIGRATOR_USER = "workbench_migrator";
    process.env.WORKBENCH_MIGRATOR_DATABASE_URL =
      "postgresql://workbench_migrator:synthetic@localhost/workbench_target";
    assert.equal(
      migratorDatabaseUrl("workbench_target"),
      process.env.WORKBENCH_MIGRATOR_DATABASE_URL,
    );
    assert.throws(
      () => migratorDatabaseUrl("another_database"),
      /RUNTIME_PROVIDER_STATE_BACKFILL_DATABASE_TARGET_INVALID/u,
    );
    process.env.WORKBENCH_MIGRATOR_DATABASE_URL =
      "postgresql://workbench_runtime:synthetic@localhost/workbench_target";
    assert.throws(
      () => migratorDatabaseUrl("workbench_target"),
      /RUNTIME_PROVIDER_STATE_BACKFILL_DATABASE_TARGET_INVALID/u,
    );
  } finally {
    process.env = previous;
  }
});

function completeCoverage(overrides: Record<string, number | boolean> = {}) {
  return {
    totalAttempts: 2,
    expectedProjections: 2,
    built: 2,
    verified: 2,
    missing: 0,
    conflicts: 0,
    lagging: 0,
    versionMismatch: 0,
    hashMismatch: 0,
    activeMissing: 0,
    terminalMissing: 0,
    rolloutBlocked: false,
    ...overrides,
  };
}
