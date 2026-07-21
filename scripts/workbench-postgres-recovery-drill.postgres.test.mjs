import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  collectCandidateMigrationManifest,
  createPostgresRecoveryDriver,
  performRecoveryDrill,
  prepareRecoveryPlan,
  validateExecutionEnvironment,
} from "./workbench-postgres-recovery-drill.mjs";

const { Client } = pg;
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
  const seeded = new Client({ connectionString: databaseUrl(configuredAdminUrl, sourceDatabase), application_name: "workbench-g5-integration-seed" });
  await seeded.connect();
  try {
    await seeded.query(`
      INSERT INTO workbench.principals (
        id, issuer, subject, email, display_name, updated_at
      ) VALUES ($1, 'g5-integration', $1, 'g5@example.test', 'G5 integration seed', clock_timestamp())
    `, [`g5-principal-${suffix}`]);
  } finally {
    await seeded.end();
  }

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
  const result = await performRecoveryDrill({
    plan,
    repositoryBinding: {
      sourceCommit: plan.sourceCommit,
      signedTag: plan.signedTag,
      tagObject: "8".repeat(40),
      tagPayloadSha256: "9".repeat(64),
      gitVersion: "integration-fixture",
    },
    driver: createPostgresRecoveryDriver({ plan, connections }),
  });

  assert.equal(result.status, "PASS", result.receiptJson);
  assert.equal(result.receipt.payload.migrations.sourceMatchesCandidate, true);
  assert.equal(result.receipt.payload.migrations.restoredMatchesCandidate, true);
  assert.equal(result.receipt.payload.data.restoredMatchesSource, true);
  assert.equal(result.receipt.payload.cleanup.status, "PASS");
  assert.equal(result.receipt.payload.archive.deleted, true);
  const targetCheck = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [restoreDatabase]);
  assert.equal(targetCheck.rowCount, 0);
});

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
