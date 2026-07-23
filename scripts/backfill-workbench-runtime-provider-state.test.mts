import assert from "node:assert/strict";
import test from "node:test";
import {
  migratorDatabaseUrl,
  parseOptions,
} from "./backfill-workbench-runtime-provider-state.mjs";

test("parses bounded keyset backfill modes", () => {
  assert.deepEqual(parseOptions([
    "--expected-database=workbench_test",
    "--batch-size=25",
    "--after-attempt-id=attempt_opaque",
    "--dry-run",
  ]), {
    expectedDatabase: "workbench_test",
    batchSize: 25,
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
