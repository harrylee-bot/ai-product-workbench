import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import canonicalizeModule from "canonicalize";
import pg from "pg";
import { PrismaClient } from "@workbench/workbench-db";

import {
  collectCandidateMigrationManifest,
  createPostgresRecoveryDriver,
  performRecoveryDrill,
  prepareRecoveryPlan,
  validateExecutionEnvironment,
} from "./workbench-postgres-recovery-drill.mjs";

const { Client } = pg;
const canonicalize = canonicalizeModule;
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredAdminUrl = process.env.WORKBENCH_G5_DRILL_TEST_ADMIN_URL?.trim();
const testWithAdmin = configuredAdminUrl ? test : test.skip;

testWithAdmin("runs a real isolated PostgreSQL backup/restore and forward-repair drill", async (t) => {
  const suffix = `${process.pid}_${Math.random().toString(16).slice(2, 10)}`
    .replace(/[^a-z0-9]/giu, "")
    .slice(0, 24);
  const sourceDatabase = `wb_g5_source_test_${suffix}`.slice(0, 63);
  const restoreDatabase = `wb_g5_restore_test_${suffix}`.slice(0, 63);
  const adminUrl = databaseUrl(configuredAdminUrl, "postgres");
  const sourceUrl = databaseUrl(configuredAdminUrl, sourceDatabase, "workbench");
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-g5-postgres-"));
  const output = path.join(outputRoot, "receipt.json");
  const admin = new Client({ connectionString: adminUrl, application_name: "workbench-g5-integration-admin" });
  let sourceCreated = false;

  t.after(async () => {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [restoreDatabase]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(restoreDatabase)}`).catch(() => undefined);
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [sourceDatabase]).catch(() => undefined);
    if (sourceCreated) {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(sourceDatabase)}`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    await rm(outputRoot, { recursive: true, force: true });
  });

  await admin.connect();
  await admin.query(`CREATE DATABASE ${identifier(sourceDatabase)} TEMPLATE template0`);
  sourceCreated = true;
  const source = new Client({ connectionString: databaseUrl(configuredAdminUrl, sourceDatabase), application_name: "workbench-g5-integration-source" });
  await source.connect();
  try {
    await source.query("CREATE SCHEMA IF NOT EXISTS workbench");
    await source.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await source.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await source.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
  } finally {
    await source.end();
  }

  await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["--workspace", "@workbench/workbench-db", "run", "migrate:deploy"],
    {
      cwd: repoRoot,
      env: { ...process.env, WORKBENCH_DATABASE_URL: sourceUrl },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const runtimeFixture = await seedRuntimeRecoveryFixture(sourceUrl, suffix);
  const migrationManifest = await collectCandidateMigrationManifest(repoRoot);
  const plan = await prepareRecoveryPlan({
    execute: true,
    repoRoot,
    candidateId: `sha256:${"6".repeat(64)}`,
    sourceCommit: "7".repeat(40),
    signedTag: "workbench-g5-integration",
    environmentId: `g5-integration-${suffix}`,
    environmentKind: "isolated",
    sourceDatabase,
    restoreDatabase,
    confirmRestoreDatabase: restoreDatabase,
    expectedMigrationCount: String(migrationManifest.count),
    maxRpoSeconds: "600",
    maxRtoSeconds: "1800",
    output,
  });
  const connections = validateExecutionEnvironment(plan, {
    WORKBENCH_G5_SOURCE_DATABASE_URL: sourceUrl,
    WORKBENCH_G5_ADMIN_DATABASE_URL: adminUrl,
    WORKBENCH_G5_DRILL_CONFIRM: plan.requiredConfirmation,
  });
  const driver = createPostgresRecoveryDriver({ plan, connections });
  const collectDataManifest = driver.collectDataManifest.bind(driver);
  let restoredIntegrityError;
  driver.collectDataManifest = async (scope) => {
    const manifest = await collectDataManifest(scope);
    if (scope === "restore") {
      try {
        await assertRestoredRuntimeIntegrity(
          databaseUrl(configuredAdminUrl, restoreDatabase),
          runtimeFixture,
        );
      } catch (error) {
        restoredIntegrityError = error;
        throw error;
      }
    }
    return manifest;
  };
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: {
      sourceCommit: plan.sourceCommit,
      signedTag: plan.signedTag,
      tagObject: "8".repeat(40),
      tagPayloadSha256: "9".repeat(64),
      gitVersion: "integration-fixture",
    },
    driver,
  });

  if (restoredIntegrityError) throw restoredIntegrityError;
  assert.equal(result.status, "PASS", result.receiptJson);
  assert.equal(result.receipt.payload.migrations.sourceMatchesCandidate, true);
  assert.equal(result.receipt.payload.migrations.restoredMatchesCandidate, true);
  assert.equal(result.receipt.payload.data.restoredMatchesSource, true);
  assert.equal(result.receipt.payload.cleanup.status, "PASS");
  assert.equal(result.receipt.payload.archive.deleted, true);
  const targetCheck = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [restoreDatabase]);
  assert.equal(targetCheck.rowCount, 0);
});

async function seedRuntimeRecoveryFixture(sourceUrl, suffix) {
  const db = new PrismaClient({ datasourceUrl: sourceUrl });
  const fixture = {
    principalId: `g5_principal_${suffix}`,
    workspaceId: `g5_workspace_${suffix}`,
    projectId: `g5_project_${suffix}`,
    threadId: `g5_thread_${suffix}`,
    runId: `g5_run_${suffix}`,
    bindingId: `g5_binding_${suffix}`,
    attemptId: `g5_attempt_${suffix}`,
    externalThreadId: `g5_external_thread_${suffix}`,
    externalRunId: `g5_external_run_${suffix}`,
  };
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
  const visibleFinalEffect = { type: "text.final", text: terminalSnapshot.visibleAssistantText };
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
  const messagePayload = { role: "assistant", content: incompleteSnapshot.rawAssistantText };
  fixture.events = [
    {
      id: `g5_event_message_${suffix}`,
      externalEventId: `g5_external_event_message_${suffix}`,
      sequence: 1,
      event: "messages",
      payload: messagePayload,
      payloadSha256: sha256Canonical(messagePayload),
      receivedAt: new Date("2026-07-27T08:01:00.000Z"),
      processedAt: new Date("2026-07-27T08:01:01.000Z"),
    },
    {
      id: `g5_event_finalization_${suffix}`,
      externalEventId: `g5_external_event_finalization_${suffix}`,
      sequence: 2,
      event: "workbench.runtime.finalization.v2",
      payload: finalizationPayload,
      payloadSha256: sha256Canonical(finalizationPayload),
      receivedAt: new Date("2026-07-27T08:02:00.000Z"),
      processedAt: new Date("2026-07-27T08:02:01.000Z"),
    },
  ];
  fixture.projection = {
    runtimeAttemptId: fixture.attemptId,
    runId: fixture.runId,
    projectionVersion: 2,
    lastAppliedSequence: 2,
    lastExternalEventId: fixture.events[0].externalEventId,
    ...terminalSnapshot,
    finalizationExternalEventId: fixture.events[1].externalEventId,
    finalizationPayloadSha256: fixture.events[1].payloadSha256,
  };
  fixture.projection.stateSha256 = providerStateSha256(fixture.projection);
  try {
    await db.$transaction(async (tx) => {
      await tx.principal.create({
        data: { id: fixture.principalId, issuer: "g5-integration", subject: fixture.principalId },
      });
      await tx.workspace.create({
        data: {
          id: fixture.workspaceId,
          slug: `g5-recovery-${suffix}`,
          name: "G5 recovery fixture",
          createdById: fixture.principalId,
        },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: fixture.workspaceId, principalId: fixture.principalId, role: "owner" },
      });
      await tx.project.create({
        data: {
          id: fixture.projectId,
          workspaceId: fixture.workspaceId,
          createdById: fixture.principalId,
          title: "G5 recovery fixture",
        },
      });
      await tx.projectMember.create({
        data: {
          projectId: fixture.projectId,
          workspaceId: fixture.workspaceId,
          principalId: fixture.principalId,
          role: "owner",
        },
      });
      await tx.thread.create({
        data: {
          id: fixture.threadId,
          projectId: fixture.projectId,
          createdById: fixture.principalId,
          title: "G5 recovery fixture",
        },
      });
      await tx.runtimeBinding.create({
        data: {
          id: fixture.bindingId,
          threadId: fixture.threadId,
          adapter: "deerflow",
          externalThreadId: fixture.externalThreadId,
          metadata: { recoveryFixture: true },
        },
      });
      await tx.run.create({
        data: {
          id: fixture.runId,
          projectId: fixture.projectId,
          threadId: fixture.threadId,
          createdById: fixture.principalId,
          idempotencyKey: `g5-recovery-${suffix}`,
          requestHash: "b".repeat(64),
          requestId: `g5_request_${suffix}`,
          request: {
            prompt: "Verify recovery",
            modelId: "quality",
            workflow: "generate",
            targetSurface: "app",
            designStyle: { kind: "automatic" },
            sourceIds: [],
            artifactTargets: [],
            requestedArtifactKinds: [],
          },
          modelId: "quality",
          traceId: `g5_trace_${suffix}`,
          status: "running",
          attempt: 1,
          startedAt: new Date(),
        },
      });
      await tx.runtimeAttempt.create({
        data: {
          id: fixture.attemptId,
          runId: fixture.runId,
          runtimeBindingId: fixture.bindingId,
          attempt: 1,
          adapter: "deerflow",
          externalThreadId: fixture.externalThreadId,
        },
      });
      await tx.runtimeAttempt.update({
        where: { id: fixture.attemptId },
        data: {
          status: "submitting",
          providerIdempotencyKey: `wbrt:${"c".repeat(64)}`,
          startedAt: new Date("2026-07-27T08:00:00.000Z"),
        },
      });
      await tx.runtimeAttempt.update({
        where: { id: fixture.attemptId },
        data: {
          status: "running",
          externalRunId: fixture.externalRunId,
          externalEventSequence: fixture.events.length,
        },
      });
      for (const event of fixture.events) {
        await tx.runtimeExternalEvent.create({
          data: {
            id: event.id,
            runtimeAttemptId: fixture.attemptId,
            runId: fixture.runId,
            externalRunId: fixture.externalRunId,
            externalEventId: event.externalEventId,
            sequence: event.sequence,
            event: event.event,
            payload: event.payload,
            payloadSha256: event.payloadSha256,
            receivedAt: event.receivedAt,
          },
        });
        await tx.runtimeExternalEvent.update({
          where: { id: event.id },
          data: { status: "processed", processedAt: event.processedAt },
        });
      }
      await tx.runtimeProviderState.create({
        data: {
          ...fixture.projection,
        },
      });
      await tx.runtimeAttempt.update({
        where: { id: fixture.attemptId },
        data: {
          status: "succeeded",
          lastExternalEventId: fixture.events.at(-1).externalEventId,
          finishedAt: new Date("2026-07-27T08:03:00.000Z"),
        },
      });
    });
  } finally {
    await db.$disconnect();
  }
  return fixture;
}

async function assertRestoredRuntimeIntegrity(restoreUrl, fixture) {
  const restored = new Client({
    connectionString: restoreUrl,
    application_name: "workbench-g5-integration-verify",
  });
  await restored.connect();
  try {
    const coverage = await restored.query(`
      SELECT
        (SELECT count(*)::integer FROM workbench.runtime_attempts) AS attempts,
        (SELECT count(*)::integer FROM workbench.runtime_external_events) AS events,
        (SELECT count(*)::integer FROM workbench.runtime_provider_states) AS projections
    `);
    assert.deepEqual(coverage.rows[0], { attempts: 1, events: 2, projections: 1 });

    const inbox = await restored.query(`
      SELECT
        id, runtime_attempt_id, run_id, external_run_id, external_event_id,
        sequence, event, payload, payload_sha256, status, received_at, processed_at
      FROM workbench.runtime_external_events
      WHERE runtime_attempt_id = $1
      ORDER BY sequence
    `, [fixture.attemptId]);
    assert.deepEqual(inbox.rows, fixture.events.map((event) => ({
      id: event.id,
      runtime_attempt_id: fixture.attemptId,
      run_id: fixture.runId,
      external_run_id: fixture.externalRunId,
      external_event_id: event.externalEventId,
      sequence: event.sequence,
      event: event.event,
      payload: event.payload,
      payload_sha256: event.payloadSha256,
      status: "processed",
      received_at: event.receivedAt,
      processed_at: event.processedAt,
    })));
    for (const row of inbox.rows) {
      assert.equal(sha256Canonical(row.payload), row.payload_sha256);
    }

    const state = await restored.query(`
      SELECT
        runtime_attempt_id, run_id, projection_version, last_applied_sequence,
        last_external_event_id, raw_assistant_text, visible_assistant_text,
        redaction_buffer, finalization_external_event_id,
        finalization_payload_sha256, state_sha256, built_at, updated_at
      FROM workbench.runtime_provider_states
      WHERE runtime_attempt_id = $1
    `, [fixture.attemptId]);
    assert.equal(state.rowCount, 1);
    const {
      built_at: builtAt,
      updated_at: updatedAt,
      ...restoredState
    } = state.rows[0];
    assert(builtAt instanceof Date);
    assert(updatedAt instanceof Date);
    assert.equal(updatedAt.getTime(), builtAt.getTime());
    assert.deepEqual(restoredState, {
      runtime_attempt_id: fixture.projection.runtimeAttemptId,
      run_id: fixture.projection.runId,
      projection_version: fixture.projection.projectionVersion,
      last_applied_sequence: fixture.projection.lastAppliedSequence,
      last_external_event_id: fixture.projection.lastExternalEventId,
      raw_assistant_text: fixture.projection.rawAssistantText,
      visible_assistant_text: fixture.projection.visibleAssistantText,
      redaction_buffer: fixture.projection.redactionBuffer,
      finalization_external_event_id: fixture.projection.finalizationExternalEventId,
      finalization_payload_sha256: fixture.projection.finalizationPayloadSha256,
      state_sha256: fixture.projection.stateSha256,
    });
    assert.equal(providerStateSha256({
      runtimeAttemptId: restoredState.runtime_attempt_id,
      runId: restoredState.run_id,
      projectionVersion: restoredState.projection_version,
      lastAppliedSequence: restoredState.last_applied_sequence,
      lastExternalEventId: restoredState.last_external_event_id,
      rawAssistantText: restoredState.raw_assistant_text,
      visibleAssistantText: restoredState.visible_assistant_text,
      redactionBuffer: restoredState.redaction_buffer,
      finalizationExternalEventId: restoredState.finalization_external_event_id,
      finalizationPayloadSha256: restoredState.finalization_payload_sha256,
    }), restoredState.state_sha256);

    const triggers = await restored.query(`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE event_object_schema = 'workbench'
        AND event_object_table IN ('runtime_external_events', 'runtime_provider_states')
      ORDER BY trigger_name
    `);
    const triggerNames = new Set(triggers.rows.map(({ trigger_name: name }) => name));
    assert(triggerNames.has("runtime_external_event_guard"));
    assert(triggerNames.has("runtime_provider_state_guard"));

    const constraints = await restored.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid IN (
        'workbench.runtime_external_events'::regclass,
        'workbench.runtime_provider_states'::regclass
      )
    `);
    const constraintNames = new Set(constraints.rows.map(({ conname: name }) => name));
    for (const name of [
      "runtime_external_events_payload_sha256_check",
      "runtime_provider_states_attempt_scope_fkey",
      "runtime_provider_states_hash_shape_check",
      "runtime_provider_states_last_applied_sequence_nonnegative_check",
    ]) {
      assert(constraintNames.has(name), `restored runtime constraint is missing: ${name}`);
    }

    await assert.rejects(
      restored.query(`
        UPDATE workbench.runtime_provider_states
        SET state_sha256 = 'invalid'
        WHERE runtime_attempt_id = $1
      `, [fixture.attemptId]),
      /RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT/u,
    );
  } finally {
    await restored.end();
  }
}

function providerStateSha256({
  runtimeAttemptId,
  runId,
  projectionVersion,
  lastAppliedSequence,
  lastExternalEventId,
  rawAssistantText,
  visibleAssistantText,
  redactionBuffer,
  finalizationExternalEventId,
  finalizationPayloadSha256,
}) {
  return sha256Canonical({
    protocol: "workbench.runtime-provider-state.v2",
    runtimeAttemptId,
    runId,
    projectionVersion,
    lastAppliedSequence,
    lastExternalEventId,
    rawAssistantText,
    visibleAssistantText,
    redactionBuffer,
    finalizationExternalEventId,
    finalizationPayloadSha256,
  });
}

function sha256Canonical(value) {
  const serialized = canonicalize(value);
  assert.equal(typeof serialized, "string");
  return createHash("sha256").update(serialized).digest("hex");
}

function databaseUrl(value, database, schema = null) {
  const url = new URL(value);
  url.pathname = `/${encodeURIComponent(database)}`;
  if (schema) url.searchParams.set("schema", schema);
  else url.searchParams.delete("schema");
  return url.toString();
}

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{2,62}$/u.test(value)) throw new Error("unsafe integration database identifier");
  return `"${value}"`;
}
