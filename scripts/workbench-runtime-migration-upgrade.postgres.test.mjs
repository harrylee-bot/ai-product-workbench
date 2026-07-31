import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import canonicalizeModule from "canonicalize";
import pg from "pg";

const { Client } = pg;
const canonicalize = canonicalizeModule;
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const prismaRoot = path.join(repoRoot, "packages/workbench-db/prisma");
const migrationsRoot = path.join(prismaRoot, "migrations");
const providerStateMigration = "20260723010000_runtime_provider_state_v2";
const subprocessTimeoutMs = 120_000;
const testTimeoutMs = 600_000;
const configuredAdminUrl =
  process.env.WORKBENCH_RUNTIME_MIGRATION_UPGRADE_TEST_ADMIN_URL?.trim();
const testWithAdmin = configuredAdminUrl ? test : test.skip;

testWithAdmin(
  "upgrades legacy runtime events and backfills provider-state v2 in PostgreSQL",
  { timeout: testTimeoutMs },
  async (t) => {
    const suffix = `${process.pid}_${Math.random().toString(16).slice(2, 10)}`
      .replace(/[^a-z0-9]/giu, "")
      .toLowerCase()
      .slice(0, 24);
    const database = `wb_runtime_upgrade_test_${suffix}`.slice(0, 63);
    const adminUrl = databaseUrl(configuredAdminUrl, "postgres");
    const databaseConnectionUrl = databaseUrl(configuredAdminUrl, database);
    const prismaDatabaseUrl = databaseUrl(
      configuredAdminUrl,
      database,
      "workbench",
    );
    const admin = new Client({
      connectionString: adminUrl,
      application_name: "workbench-runtime-upgrade-admin",
    });
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "workbench-runtime-upgrade-"),
    );
    let adminConnected = false;
    let databaseCreated = false;

    t.after(async () => {
      const failures = [];
      if (databaseCreated) {
        try {
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
            [database],
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
        } catch (error) {
          failures.push(error);
        }
        try {
          const remaining = await admin.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [database],
          );
          assert.equal(
            remaining.rowCount,
            0,
            `upgrade test database was not removed: ${database}`,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      if (adminConnected) {
        try {
          await admin.end();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "runtime migration upgrade cleanup failed",
        );
      }
    });

    await admin.connect();
    adminConnected = true;
    await admin.query(
      `CREATE DATABASE ${identifier(database)} TEMPLATE template0`,
    );
    databaseCreated = true;
    await provisionExtensions(databaseConnectionUrl);

    const migrationNames = (
      await readdir(migrationsRoot, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const providerStateMigrationIndex = migrationNames.indexOf(
      providerStateMigration,
    );
    assert.ok(
      providerStateMigrationIndex > 0,
      "provider-state v2 migration must have a predecessor",
    );
    const legacyMigrationNames = migrationNames.slice(
      0,
      providerStateMigrationIndex,
    );
    const legacySchemaPath = await createLegacyMigrationBundle(
      temporaryRoot,
      legacyMigrationNames,
    );

    await migrateDeploy(legacySchemaPath, prismaDatabaseUrl);

    const fixture = runtimeFixture(suffix);
    const legacy = new Client({
      connectionString: databaseConnectionUrl,
      application_name: "workbench-runtime-upgrade-legacy-seed",
    });
    await legacy.connect();
    try {
      await legacy.query("SET search_path TO workbench, public");
      const migrationLedger = await appliedMigrations(legacy);
      assert.deepEqual(migrationLedger, legacyMigrationNames);
      assert.equal(
        await relationExists(legacy, "runtime_provider_states"),
        false,
      );
      await seedLegacyRuntimeHistory(legacy, fixture);
    } finally {
      await legacy.end();
    }

    await migrateDeploy(
      path.join(prismaRoot, "schema.prisma"),
      prismaDatabaseUrl,
    );

    const upgraded = new Client({
      connectionString: databaseConnectionUrl,
      application_name: "workbench-runtime-upgrade-verification",
    });
    await upgraded.connect();
    try {
      await upgraded.query("SET search_path TO workbench, public");
      assert.deepEqual(await appliedMigrations(upgraded), migrationNames);
      assert.equal(
        await relationExists(upgraded, "runtime_provider_states"),
        true,
      );
      await assertLegacyHistoryPreserved(upgraded, fixture);
      assert.equal(await providerStateCount(upgraded), 0);
    } finally {
      await upgraded.end();
    }

    const interruptedBackfill = await executeBackfill({
      database,
      prismaDatabaseUrl,
      batchSize: 1,
      maxBatches: 1,
      expectedExitCode: 3,
    });
    const expectedProjection = projectionFixture(fixture);
    assert.equal(interruptedBackfill.checkpoint.status, "created");
    assert.equal(interruptedBackfill.checkpoint.eventCount, 2);
    assert.equal(interruptedBackfill.checkpoint.lastSequence, 2);
    assert.equal(
      interruptedBackfill.checkpoint.stateSha256,
      expectedProjection.stateSha256,
    );
    assert.equal(interruptedBackfill.result.terminalStatus, "resume-required");
    assert.equal(
      interruptedBackfill.result.resumeAfterAttemptId,
      fixture.attemptId,
    );
    assert.equal(interruptedBackfill.result.attemptsProcessed, 1);
    assert.equal(interruptedBackfill.result.totalAttempts, 2);
    assert.equal(interruptedBackfill.result.built, 1);
    assert.equal(interruptedBackfill.result.missing, 1);
    assert.equal(interruptedBackfill.result.rolloutBlocked, true);

    const backfill = await executeBackfill({
      database,
      prismaDatabaseUrl,
      batchSize: 1,
      maxBatches: 2,
      afterAttemptId: interruptedBackfill.result.resumeAfterAttemptId,
      expectedExitCode: 0,
    });
    const expectedSecondProjection = secondProjectionFixture(fixture);
    assert.equal(backfill.checkpoint.status, "created");
    assert.equal(backfill.checkpoint.eventCount, 0);
    assert.equal(backfill.checkpoint.lastSequence, 0);
    assert.equal(
      backfill.checkpoint.stateSha256,
      expectedSecondProjection.stateSha256,
    );
    assert.equal(backfill.result.terminalStatus, "completed");
    assert.equal(backfill.result.attemptsProcessed, 1);
    assert.equal(backfill.result.resumeAfterAttemptId, null);
    assert.equal(backfill.result.totalAttempts, 2);
    assert.equal(backfill.result.expectedProjections, 2);
    assert.equal(backfill.result.built, 2);
    assert.equal(backfill.result.verified, 2);
    assert.equal(backfill.result.missing, 0);
    assert.equal(backfill.result.hashMismatch, 0);
    assert.equal(backfill.result.rolloutBlocked, false);

    const verified = new Client({
      connectionString: databaseConnectionUrl,
      application_name: "workbench-runtime-upgrade-constraint-verification",
    });
    await verified.connect();
    try {
      await verified.query("SET search_path TO workbench, public");
      await assertLegacyHistoryPreserved(verified, fixture);
      const projections = await verified.query(
        `
      SELECT
        state."runtime_attempt_id" AS "runtimeAttemptId",
        state."run_id" AS "runId",
        state."projection_version" AS "projectionVersion",
        state."last_applied_sequence" AS "lastAppliedSequence",
        state."last_external_event_id" AS "lastExternalEventId",
        state."raw_assistant_text" AS "rawAssistantText",
        state."visible_assistant_text" AS "visibleAssistantText",
        state."redaction_buffer" AS "redactionBuffer",
        state."finalization_external_event_id" AS "finalizationExternalEventId",
        state."finalization_payload_sha256" AS "finalizationPayloadSha256",
        state."state_sha256" AS "stateSha256"
      FROM workbench.runtime_provider_states AS state
      INNER JOIN workbench.runtime_attempts AS attempt
        ON attempt."id" = state."runtime_attempt_id"
      WHERE state."runtime_attempt_id" = ANY($1::text[])
      ORDER BY attempt."attempt"
    `,
        [[fixture.attemptId, fixture.secondAttemptId]],
      );
      const { protocol: projectionProtocol, ...expectedProjectionRow } =
        expectedProjection;
      const {
        protocol: secondProjectionProtocol,
        ...expectedSecondProjectionRow
      } = expectedSecondProjection;
      assert.equal(projectionProtocol, "workbench.runtime-provider-state.v2");
      assert.equal(
        secondProjectionProtocol,
        "workbench.runtime-provider-state.v2",
      );
      assert.deepEqual(projections.rows, [
        expectedProjectionRow,
        expectedSecondProjectionRow,
      ]);

      await assertRejectsPostgresCode(
        verified.query(
          `
        UPDATE workbench.runtime_provider_states
        SET "run_id" = $2
        WHERE "runtime_attempt_id" = $1
      `,
          [fixture.attemptId, `wrong-run-${suffix}`],
        ),
        "RUNTIME_PROVIDER_STATE_SCOPE_INVALID",
      );
      await assertRejectsPostgresCode(
        verified.query(
          `
        UPDATE workbench.runtime_provider_states
        SET "last_applied_sequence" = 1
        WHERE "runtime_attempt_id" = $1
      `,
          [fixture.attemptId],
        ),
        "RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID",
      );
      await assertRejectsPostgresCode(
        verified.query(
          `
        UPDATE workbench.runtime_provider_states
        SET "finalization_payload_sha256" = $2
        WHERE "runtime_attempt_id" = $1
      `,
          [fixture.attemptId, "f".repeat(64)],
        ),
        "RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID",
      );
      await assertRejectsPostgresCode(
        verified.query(
          `
        UPDATE workbench.runtime_provider_states
        SET "state_sha256" = $2
        WHERE "runtime_attempt_id" = $1
      `,
          [fixture.attemptId, "e".repeat(64)],
        ),
        "RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT",
      );

      const invalidAttemptId = `runtime-attempt-3-${suffix}`;
      await verified.query(
        `
      INSERT INTO workbench.runtime_attempts (
        "id", "run_id", "runtime_binding_id", "attempt", "adapter",
        "external_thread_id", "status", "updated_at"
      ) VALUES ($1, $2, $3, 3, 'deerflow', $4, 'pending', clock_timestamp())
    `,
        [
          invalidAttemptId,
          fixture.runId,
          fixture.runtimeBindingId,
          fixture.externalThreadId,
        ],
      );
      await assert.rejects(
        verified.query(
          `
        INSERT INTO workbench.runtime_provider_states (
          "runtime_attempt_id", "run_id", "projection_version", "state_sha256"
        ) VALUES ($1, $2, 2, $3)
      `,
          [invalidAttemptId, fixture.runId, "not-a-sha256"],
        ),
        (error) => {
          assert.equal(error?.code, "23514");
          assert.equal(
            error?.constraint,
            "runtime_provider_states_hash_shape_check",
          );
          return true;
        },
      );
    } finally {
      await verified.end();
    }
  },
);

async function createLegacyMigrationBundle(temporaryRoot, migrationNames) {
  const targetRoot = path.join(temporaryRoot, "prisma");
  const targetMigrationsRoot = path.join(targetRoot, "migrations");
  await mkdir(targetMigrationsRoot, { recursive: true });
  await cp(
    path.join(prismaRoot, "schema.prisma"),
    path.join(targetRoot, "schema.prisma"),
  );
  for (const migrationName of migrationNames) {
    await cp(
      path.join(migrationsRoot, migrationName),
      path.join(targetMigrationsRoot, migrationName),
      { recursive: true },
    );
  }
  return path.join(targetRoot, "schema.prisma");
}

async function migrateDeploy(schemaPath, databaseUrlValue) {
  await execFileAsync(
    path.join(repoRoot, "node_modules/.bin/prisma"),
    ["migrate", "deploy", "--schema", schemaPath],
    {
      cwd: repoRoot,
      env: { ...process.env, WORKBENCH_DATABASE_URL: databaseUrlValue },
      encoding: "utf8",
      timeout: subprocessTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

async function provisionExtensions(connectionString) {
  const client = new Client({
    connectionString,
    application_name: "workbench-runtime-upgrade-extension-provisioning",
  });
  await client.connect();
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS workbench");
    await client.query(
      "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
    );
    await client.query(
      "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public",
    );
    await client.query(
      "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
    );
  } finally {
    await client.end();
  }
}

async function seedLegacyRuntimeHistory(client, fixture) {
  await client.query("BEGIN");
  try {
    await client.query(
      `
      INSERT INTO workbench.principals (
        "id", "issuer", "subject", "email", "display_name", "updated_at"
      ) VALUES ($1, 'runtime-upgrade-test', $1, 'runtime-upgrade@example.test', 'Runtime upgrade test', clock_timestamp())
    `,
      [fixture.principalId],
    );
    await client.query(
      `
      INSERT INTO workbench.workspaces (
        "id", "slug", "name", "created_by_id", "updated_at"
      ) VALUES ($1, $2, 'Runtime upgrade workspace', $3, clock_timestamp())
    `,
      [fixture.workspaceId, fixture.workspaceSlug, fixture.principalId],
    );
    await client.query(
      `
      INSERT INTO workbench.workspace_members (
        "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES ($1, $2, 'owner', clock_timestamp())
    `,
      [fixture.workspaceId, fixture.principalId],
    );
    await client.query(
      `
      INSERT INTO workbench.projects (
        "id", "workspace_id", "created_by_id", "title", "updated_at"
      ) VALUES ($1, $2, $3, 'Runtime upgrade project', clock_timestamp())
    `,
      [fixture.projectId, fixture.workspaceId, fixture.principalId],
    );
    await client.query(
      `
      INSERT INTO workbench.project_members (
        "project_id", "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES ($1, $2, $3, 'owner', clock_timestamp())
    `,
      [fixture.projectId, fixture.workspaceId, fixture.principalId],
    );
    await client.query(
      `
      INSERT INTO workbench.threads (
        "id", "project_id", "title", "created_by_id", "updated_at"
      ) VALUES ($1, $2, 'Runtime upgrade thread', $3, clock_timestamp())
    `,
      [fixture.threadId, fixture.projectId, fixture.principalId],
    );
    await client.query(
      `
      INSERT INTO workbench.runs (
        "id", "project_id", "thread_id", "created_by_id", "idempotency_key",
        "request_hash", "request_id", "request", "status", "model_id",
        "trace_id", "attempt", "started_at", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'running', 'runtime-upgrade-model',
        $9, 1, clock_timestamp(), clock_timestamp()
      )
    `,
      [
        fixture.runId,
        fixture.projectId,
        fixture.threadId,
        fixture.principalId,
        fixture.runIdempotencyKey,
        "a".repeat(64),
        fixture.requestId,
        JSON.stringify({
          modelId: "runtime-upgrade-model",
          workflow: "generate",
          targetSurface: "web",
          designStyle: { kind: "automatic" },
          sourceIds: [],
        }),
        fixture.traceId,
      ],
    );
    await client.query(
      `
      INSERT INTO workbench.runtime_bindings (
        "id", "thread_id", "adapter", "external_thread_id", "metadata", "updated_at"
      ) VALUES ($1, $2, 'deerflow', $3, '{}'::jsonb, clock_timestamp())
    `,
      [fixture.runtimeBindingId, fixture.threadId, fixture.externalThreadId],
    );
    await client.query(
      `
      INSERT INTO workbench.runtime_attempts (
        "id", "run_id", "runtime_binding_id", "attempt", "adapter",
        "external_thread_id", "status", "updated_at"
      ) VALUES ($1, $2, $3, 1, 'deerflow', $4, 'pending', clock_timestamp())
    `,
      [
        fixture.attemptId,
        fixture.runId,
        fixture.runtimeBindingId,
        fixture.externalThreadId,
      ],
    );
    await client.query(
      `
      UPDATE workbench.runtime_attempts
      SET
        "status" = 'submitting',
        "provider_idempotency_key" = $2,
        "started_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
      WHERE "id" = $1
    `,
      [fixture.attemptId, fixture.providerIdempotencyKey],
    );
    await client.query(
      `
      UPDATE workbench.runtime_attempts
      SET
        "status" = 'running',
        "external_run_id" = $2,
        "external_event_sequence" = 2,
        "updated_at" = clock_timestamp()
      WHERE "id" = $1
    `,
      [fixture.attemptId, fixture.externalRunId],
    );

    for (const event of fixture.events) {
      await client.query(
        `
        INSERT INTO workbench.runtime_external_events (
          "id", "runtime_attempt_id", "run_id", "external_run_id",
          "external_event_id", "sequence", "event", "payload", "payload_sha256"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      `,
        [
          event.id,
          fixture.attemptId,
          fixture.runId,
          fixture.externalRunId,
          event.externalEventId,
          event.sequence,
          event.event,
          JSON.stringify(event.payload),
          event.payloadSha256,
        ],
      );
      await client.query(
        `
        UPDATE workbench.runtime_external_events
        SET "status" = 'processed', "processed_at" = clock_timestamp()
        WHERE "id" = $1
      `,
        [event.id],
      );
    }
    await client.query(
      `
      UPDATE workbench.runtime_attempts
      SET
        "status" = 'succeeded',
        "last_external_event_id" = $2,
        "finished_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
      WHERE "id" = $1
    `,
      [fixture.attemptId, fixture.events.at(-1).externalEventId],
    );
    await client.query(
      `
      INSERT INTO workbench.runtime_attempts (
        "id", "run_id", "runtime_binding_id", "attempt", "adapter",
        "external_thread_id", "status", "updated_at"
      ) VALUES ($1, $2, $3, 2, 'deerflow', $4, 'pending', clock_timestamp())
    `,
      [
        fixture.secondAttemptId,
        fixture.runId,
        fixture.runtimeBindingId,
        fixture.externalThreadId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function executeBackfill({
  database,
  prismaDatabaseUrl,
  batchSize,
  maxBatches,
  afterAttemptId = null,
  expectedExitCode,
}) {
  const adminRole = decodeURIComponent(new URL(configuredAdminUrl).username);
  assert.ok(adminRole, "upgrade test admin URL must include a username");
  const args = [
    "scripts/backfill-workbench-runtime-provider-state.mts",
    `--expected-database=${database}`,
    `--batch-size=${batchSize}`,
    `--max-batches=${maxBatches}`,
  ];
  if (afterAttemptId) args.push(`--after-attempt-id=${afterAttemptId}`);
  const options = {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      OTEL_SDK_DISABLED: "true",
      WORKBENCH_CANDIDATE_SHA: "c".repeat(40),
      WORKBENCH_MIGRATOR_DATABASE_URL: prismaDatabaseUrl,
      WORKBENCH_POSTGRES_MIGRATOR_USER: adminRole,
    },
    encoding: "utf8",
    timeout: subprocessTimeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  };
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      path.join(repoRoot, "node_modules/.bin/tsx"),
      args,
      options,
    ));
    assert.equal(
      expectedExitCode,
      0,
      "backfill unexpectedly completed successfully",
    );
  } catch (error) {
    assert.equal(error?.code, expectedExitCode);
    assert.equal(typeof error?.stdout, "string");
    stdout = error.stdout;
  }
  const records = stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const checkpoint = records.find(
    (record) =>
      record.protocol ===
      "workbench.runtime-provider-state-backfill-checkpoint.v1",
  );
  const result = records.find(
    (record) =>
      record.protocol === "workbench.runtime-provider-state-backfill-result.v2",
  );
  assert.ok(checkpoint, `backfill checkpoint missing from stdout: ${stdout}`);
  assert.ok(result, `backfill result missing from stdout: ${stdout}`);
  return { checkpoint, result };
}

async function assertLegacyHistoryPreserved(client, fixture) {
  const attempt = await client.query(
    `
    SELECT
      "id", "run_id" AS "runId", "runtime_binding_id" AS "runtimeBindingId",
      "attempt", "adapter", "external_thread_id" AS "externalThreadId",
      "external_run_id" AS "externalRunId", "provider_idempotency_key" AS "providerIdempotencyKey",
      "status"::text, "last_external_event_id" AS "lastExternalEventId",
      "external_event_sequence" AS "externalEventSequence"
    FROM workbench.runtime_attempts
    WHERE "id" = $1
  `,
    [fixture.attemptId],
  );
  assert.deepEqual(attempt.rows, [
    {
      id: fixture.attemptId,
      runId: fixture.runId,
      runtimeBindingId: fixture.runtimeBindingId,
      attempt: 1,
      adapter: "deerflow",
      externalThreadId: fixture.externalThreadId,
      externalRunId: fixture.externalRunId,
      providerIdempotencyKey: fixture.providerIdempotencyKey,
      status: "succeeded",
      lastExternalEventId: fixture.events.at(-1).externalEventId,
      externalEventSequence: 2,
    },
  ]);

  const events = await client.query(
    `
    SELECT
      "id", "external_event_id" AS "externalEventId", "sequence", "event",
      "payload", "payload_sha256" AS "payloadSha256", "status"::text
    FROM workbench.runtime_external_events
    WHERE "runtime_attempt_id" = $1
    ORDER BY "sequence"
  `,
    [fixture.attemptId],
  );
  assert.deepEqual(
    events.rows,
    fixture.events.map((event) => ({
      id: event.id,
      externalEventId: event.externalEventId,
      sequence: event.sequence,
      event: event.event,
      payload: event.payload,
      payloadSha256: event.payloadSha256,
      status: "processed",
    })),
  );
}

function runtimeFixture(suffix) {
  const incompleteSnapshot = {
    rawAssistantText: "Hello wbkg",
    visibleAssistantText: "Hello ",
    redactionBuffer: "wbkg",
  };
  const terminalSnapshot = {
    rawAssistantText: "Hello wbkg1.super-secret done",
    visibleAssistantText: "Hello [knowledge capability redacted] done",
    redactionBuffer: "",
  };
  const providerTextCheckpoint = {
    protocol: "workbench.runtime-provider-text-checkpoint.v1",
    before: incompleteSnapshot,
    terminal: terminalSnapshot,
  };
  const effects = [];
  const visibleFinalEffect = {
    type: "text.final",
    text: terminalSnapshot.visibleAssistantText,
  };
  const finalizationPayload = {
    protocol: "workbench.runtime-finalization.v2",
    messagesSha256: "1".repeat(64),
    outcomeSha256: "2".repeat(64),
    effects,
    visibleFinalEffect,
    effectsSha256: sha256Canonical({ effects, visibleFinalEffect }),
    providerTextCheckpoint,
    providerTextCheckpointSha256: sha256Canonical(providerTextCheckpoint),
  };
  const firstPayload = {
    role: "assistant",
    content: incompleteSnapshot.rawAssistantText,
  };
  return {
    principalId: `principal-${suffix}`,
    workspaceId: `workspace-${suffix}`,
    workspaceSlug: `runtime-upgrade-${suffix}`,
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    runId: `run-${suffix}`,
    runIdempotencyKey: `runtime-upgrade-${suffix}`,
    requestId: `runtime-upgrade-request-${suffix}`,
    traceId: `runtime-upgrade-trace-${suffix}`,
    runtimeBindingId: `runtime-binding-${suffix}`,
    attemptId: `runtime-attempt-${suffix}`,
    secondAttemptId: `runtime-attempt-2-${suffix}`,
    externalThreadId: `external-thread-${suffix}`,
    externalRunId: `external-run-${suffix}`,
    providerIdempotencyKey: `wbrt:${"3".repeat(64)}`,
    incompleteSnapshot,
    terminalSnapshot,
    events: [
      {
        id: `runtime-event-1-${suffix}`,
        externalEventId: `external-event-1-${suffix}`,
        sequence: 1,
        event: "messages",
        payload: firstPayload,
        payloadSha256: sha256Canonical(firstPayload),
      },
      {
        id: `runtime-event-2-${suffix}`,
        externalEventId: `external-event-2-${suffix}`,
        sequence: 2,
        event: "workbench.runtime.finalization.v2",
        payload: finalizationPayload,
        payloadSha256: sha256Canonical(finalizationPayload),
      },
    ],
  };
}

function projectionFixture(fixture) {
  const state = {
    protocol: "workbench.runtime-provider-state.v2",
    runtimeAttemptId: fixture.attemptId,
    runId: fixture.runId,
    projectionVersion: 2,
    lastAppliedSequence: 2,
    lastExternalEventId: fixture.events[0].externalEventId,
    ...fixture.terminalSnapshot,
    finalizationExternalEventId: fixture.events[1].externalEventId,
    finalizationPayloadSha256: fixture.events[1].payloadSha256,
  };
  return { ...state, stateSha256: sha256Canonical(state) };
}

function secondProjectionFixture(fixture) {
  const state = {
    protocol: "workbench.runtime-provider-state.v2",
    runtimeAttemptId: fixture.secondAttemptId,
    runId: fixture.runId,
    projectionVersion: 2,
    lastAppliedSequence: 0,
    lastExternalEventId: null,
    ...fixture.terminalSnapshot,
    finalizationExternalEventId: null,
    finalizationPayloadSha256: null,
  };
  return { ...state, stateSha256: sha256Canonical(state) };
}

function sha256Canonical(value) {
  const serialized = canonicalize(value);
  assert.equal(typeof serialized, "string", "fixture must be canonical JSON");
  return createHash("sha256").update(serialized).digest("hex");
}

async function appliedMigrations(client) {
  const result = await client.query(`
    SELECT "migration_name"
    FROM workbench."_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    ORDER BY "migration_name"
  `);
  return result.rows.map((row) => row.migration_name);
}

async function relationExists(client, relation) {
  const result = await client.query("SELECT to_regclass($1) AS relation", [
    `workbench.${relation}`,
  ]);
  return Boolean(result.rows[0]?.relation);
}

async function providerStateCount(client) {
  const result = await client.query(
    "SELECT count(*)::integer AS count FROM workbench.runtime_provider_states",
  );
  return result.rows[0]?.count;
}

async function assertRejectsPostgresCode(operation, message) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, "23514");
    assert.match(error?.message ?? "", new RegExp(message, "u"));
    return true;
  });
}

function databaseUrl(value, database, schema = null) {
  const url = new URL(value);
  if (!url.username)
    throw new Error("upgrade test admin URL must include a username");
  url.pathname = `/${encodeURIComponent(database)}`;
  if (schema) url.searchParams.set("schema", schema);
  else url.searchParams.delete("schema");
  return url.toString();
}

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/u.test(value)) {
    throw new Error("unsafe runtime migration upgrade database identifier");
  }
  return `"${value}"`;
}
