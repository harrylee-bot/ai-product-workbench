import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

const { Client } = pg;
const adminBaseUrl = process.env.WORKBENCH_POSTGRES_ADMIN_URL?.trim();
const testWithAdmin = adminBaseUrl ? test : test.skip;

testWithAdmin("transfers existing schema ownership and keeps runtime append-only", async () => {
  const suffix = randomBytes(6).toString("hex");
  const database = `wb_role_${suffix}`;
  const migratorRole = `wb_migrator_${suffix}`;
  const runtimeRole = `wb_runtime_${suffix}`;
  const migratorPassword = randomBytes(24).toString("base64url");
  const runtimePassword = randomBytes(24).toString("base64url");
  const admin = new Client({ connectionString: adminBaseUrl });
  const databaseUrl = databaseConnection(adminBaseUrl, database);

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${identifier(database)}`);
    await createAdminOwnedFixture(databaseUrl);
    runProvisioner(databaseUrl, {
      migratorRole,
      migratorPassword,
      runtimeRole,
      runtimePassword,
      phase: "bootstrap",
    });
    await assertFixtureOwnership(databaseUrl, migratorRole);

    const migrator = new Client({
      connectionString: roleConnection(databaseUrl, migratorRole, migratorPassword),
    });
    await migrator.connect();
    try {
      await migrator.query(`
        CREATE TABLE workbench.run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          source_id VARCHAR(128)
        )
      `);
      await migrator.query("INSERT INTO workbench.run_events VALUES ('event_1', 'run_1', 'source:1')");
      await migrator.query(`
        INSERT INTO workbench.blobs
          (id, storage_key, status, gc_eligible_at)
        VALUES
          ('blob_integrity_1', 'blobs/integrity/g1', 'ready', CURRENT_TIMESTAMP);
        INSERT INTO workbench.file_assets
          (id, blob_id, status, failure_code, failure_detail, revision)
        VALUES
          ('file_integrity_1', 'blob_integrity_1', 'ready', NULL, NULL, 0);
        INSERT INTO workbench.canvas_visual_capabilities
          (id, storage_key, status, failure_code, storage_deleted_at)
        VALUES
          ('00000000-0000-4000-8000-000000000001', 'canvas-visuals/integrity.webp', 'ready', NULL, NULL);
      `);
    } finally {
      await migrator.end();
    }

    runProvisioner(databaseUrl, {
      migratorRole,
      migratorPassword,
      runtimeRole,
      runtimePassword,
      phase: "grant",
    });

    const postGrantMigrator = new Client({
      connectionString: roleConnection(databaseUrl, migratorRole, migratorPassword),
    });
    await postGrantMigrator.connect();
    try {
      await postGrantMigrator.query(`
        CREATE TABLE workbench.post_grant_default_privilege_fixture (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    } finally {
      await postGrantMigrator.end();
    }

    const runtime = new Client({
      connectionString: roleConnection(databaseUrl, runtimeRole, runtimePassword),
    });
    await runtime.connect();
    try {
      const privileges = await runtime.query(`
        SELECT
          has_schema_privilege(current_user, 'workbench', 'CREATE') AS "canCreate",
          has_table_privilege(current_user, 'workbench.run_events', 'SELECT') AS "canSelect",
          has_table_privilege(current_user, 'workbench.run_events', 'INSERT') AS "canInsert",
          has_table_privilege(current_user, 'workbench.run_events', 'UPDATE') AS "canUpdate",
          has_table_privilege(current_user, 'workbench.run_events', 'DELETE') AS "canDelete",
          has_table_privilege(current_user, 'workbench.run_events', 'TRUNCATE') AS "canTruncate"
      `);
      assert.deepEqual(privileges.rows[0], {
        canCreate: false,
        canSelect: true,
        canInsert: true,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
      });
      await assert.rejects(
        runtime.query("UPDATE workbench.run_events SET source_id = 'tampered'"),
        /permission denied/u,
      );
      await assert.rejects(runtime.query("DELETE FROM workbench.run_events"), /permission denied/u);
      await assert.rejects(runtime.query("TRUNCATE workbench.run_events"), /permission denied/u);
      const providerStatePrivileges = await runtime.query(`
        SELECT
          has_table_privilege(current_user, 'workbench.runtime_provider_states', 'SELECT') AS "canSelect",
          has_table_privilege(current_user, 'workbench.runtime_provider_states', 'INSERT') AS "canInsert",
          has_table_privilege(current_user, 'workbench.runtime_provider_states', 'UPDATE') AS "canUpdate",
          has_table_privilege(current_user, 'workbench.runtime_provider_states', 'DELETE') AS "canDelete",
          has_table_privilege(current_user, 'workbench.runtime_provider_states', 'TRUNCATE') AS "canTruncate"
      `);
      assert.deepEqual(providerStatePrivileges.rows[0], {
        canSelect: true,
        canInsert: true,
        canUpdate: true,
        canDelete: false,
        canTruncate: false,
      });
      await runtime.query(`
        INSERT INTO workbench.runtime_provider_states (runtime_attempt_id, state_sha256)
        VALUES ('attempt_role_1', '${"a".repeat(64)}')
      `);
      await runtime.query(`
        UPDATE workbench.runtime_provider_states
        SET state_sha256 = '${"b".repeat(64)}'
        WHERE runtime_attempt_id = 'attempt_role_1'
      `);
      await assert.rejects(
        runtime.query("DELETE FROM workbench.runtime_provider_states"),
        /permission denied/u,
      );
      await assert.rejects(
        runtime.query("TRUNCATE workbench.runtime_provider_states"),
        /permission denied/u,
      );
      const cancellationResolutionPrivileges = await runtime.query(`
        SELECT
          has_table_privilege(current_user, 'workbench.runtime_provider_cancellation_resolutions', 'SELECT') AS "canSelect",
          has_table_privilege(current_user, 'workbench.runtime_provider_cancellation_resolutions', 'INSERT') AS "canInsert",
          has_table_privilege(current_user, 'workbench.runtime_provider_cancellation_resolutions', 'UPDATE') AS "canUpdate",
          has_table_privilege(current_user, 'workbench.runtime_provider_cancellation_resolutions', 'DELETE') AS "canDelete",
          has_table_privilege(current_user, 'workbench.runtime_provider_cancellation_resolutions', 'TRUNCATE') AS "canTruncate"
      `);
      assert.deepEqual(cancellationResolutionPrivileges.rows[0], {
        canSelect: true,
        canInsert: true,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
      });
      await runtime.query(`
        INSERT INTO workbench.runtime_provider_cancellation_resolutions
          (runtime_attempt_id, run_id, failure_code, outcome)
        VALUES
          ('attempt_resolution_role_1', 'run_resolution_role_1', 'RUNTIME_TIMEOUT', 'cancelled')
      `);
      await assert.rejects(
        runtime.query(`
          UPDATE workbench.runtime_provider_cancellation_resolutions
          SET outcome = 'already_terminal'
          WHERE runtime_attempt_id = 'attempt_resolution_role_1'
        `),
        /permission denied/u,
      );
      await assert.rejects(
        runtime.query("DELETE FROM workbench.runtime_provider_cancellation_resolutions"),
        /permission denied/u,
      );
      await assert.rejects(
        runtime.query("TRUNCATE workbench.runtime_provider_cancellation_resolutions"),
        /permission denied/u,
      );
      const cancellationResolution = await runtime.query(`
        SELECT run_id AS "runId", failure_code AS "failureCode", outcome
        FROM workbench.runtime_provider_cancellation_resolutions
        WHERE runtime_attempt_id = 'attempt_resolution_role_1'
      `);
      assert.deepEqual(cancellationResolution.rows, [{
        runId: "run_resolution_role_1",
        failureCode: "RUNTIME_TIMEOUT",
        outcome: "cancelled",
      }]);

      const defaultPrivileges = await runtime.query(`
        SELECT
          has_table_privilege(current_user, 'workbench.post_grant_default_privilege_fixture', 'SELECT') AS "canSelect",
          has_table_privilege(current_user, 'workbench.post_grant_default_privilege_fixture', 'INSERT') AS "canInsert",
          has_table_privilege(current_user, 'workbench.post_grant_default_privilege_fixture', 'UPDATE') AS "canUpdate",
          has_table_privilege(current_user, 'workbench.post_grant_default_privilege_fixture', 'DELETE') AS "canDelete",
          has_table_privilege(current_user, 'workbench.post_grant_default_privilege_fixture', 'TRUNCATE') AS "canTruncate"
      `);
      assert.deepEqual(defaultPrivileges.rows[0], {
        canSelect: true,
        canInsert: true,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
      });
      await runtime.query(`
        INSERT INTO workbench.post_grant_default_privilege_fixture (id, value)
        VALUES ('default_role_1', 'append-only')
      `);
      await assert.rejects(
        runtime.query(`
          UPDATE workbench.post_grant_default_privilege_fixture
          SET value = 'tampered'
          WHERE id = 'default_role_1'
        `),
        /permission denied/u,
      );
      await assert.rejects(
        runtime.query("DELETE FROM workbench.post_grant_default_privilege_fixture"),
        /permission denied/u,
      );
      await assert.rejects(
        runtime.query("TRUNCATE workbench.post_grant_default_privilege_fixture"),
        /permission denied/u,
      );
      await assert.rejects(runtime.query("CREATE SCHEMA runtime_escape"), /permission denied/u);

      const incidentValues = [
        "incident_role_1",
        "f".repeat(64),
        "blobs/integrity/g1",
        "OBJECT_STORAGE_SHA256_MISMATCH",
        "a".repeat(64),
        10,
        "application/octet-stream",
        "b".repeat(64),
        10,
        "application/octet-stream",
      ];
      await runtime.query("BEGIN");
      try {
        await runtime.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          ["workbench:ready-object-integrity:v1:blobs/integrity/g1"],
        );
        await runtime.query(`
          INSERT INTO workbench.ready_object_integrity_incidents (
            id, fingerprint, storage_key, failure_code,
            expected_sha256, expected_byte_size, expected_media_type,
            observed_sha256, observed_byte_size, observed_media_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, incidentValues);
        await runtime.query(`
          INSERT INTO workbench.ready_object_integrity_incidents (
            id, fingerprint, storage_key, failure_code,
            expected_sha256, expected_byte_size, expected_media_type,
            observed_sha256, observed_byte_size, observed_media_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (fingerprint) DO UPDATE
          SET occurrence_count = workbench.ready_object_integrity_incidents.occurrence_count + 1,
              last_detected_at = CURRENT_TIMESTAMP
        `, incidentValues);
        await runtime.query(`
          UPDATE workbench.blobs
          SET status = 'quarantined', gc_eligible_at = NULL
          WHERE id = 'blob_integrity_1';
          UPDATE workbench.file_assets
          SET status = 'quarantined',
              failure_code = 'READY_OBJECT_INTEGRITY_FAILURE',
              failure_detail = 'Object bytes failed immutable manifest verification',
              revision = revision + 1
          WHERE id = 'file_integrity_1';
          UPDATE workbench.canvas_visual_capabilities
          SET status = 'failed', failure_code = 'READY_OBJECT_INTEGRITY_FAILURE'
          WHERE id = '00000000-0000-4000-8000-000000000001';
        `);
        await runtime.query("COMMIT");
      } catch (error) {
        await runtime.query("ROLLBACK");
        throw error;
      }
      const quarantined = await runtime.query(`
        SELECT
          (SELECT occurrence_count FROM workbench.ready_object_integrity_incidents
            WHERE id = 'incident_role_1') AS "occurrenceCount",
          (SELECT status FROM workbench.blobs WHERE id = 'blob_integrity_1') AS "blobStatus",
          (SELECT status FROM workbench.file_assets WHERE id = 'file_integrity_1') AS "fileStatus",
          (SELECT status FROM workbench.canvas_visual_capabilities
            WHERE id = '00000000-0000-4000-8000-000000000001') AS "visualStatus"
      `);
      assert.deepEqual(quarantined.rows[0], {
        occurrenceCount: 2,
        blobStatus: "quarantined",
        fileStatus: "quarantined",
        visualStatus: "failed",
      });
      await assert.rejects(
        runtime.query("DELETE FROM workbench.ready_object_integrity_incidents"),
        /permission denied/u,
      );
      await assert.rejects(
        runtime.query("TRUNCATE workbench.ready_object_integrity_incidents"),
        /permission denied/u,
      );
      await assert.rejects(runtime.query(`
        INSERT INTO workbench.ready_object_integrity_retention_releases
          (id, incident_id, released_occurrence_count, release_reference)
        VALUES ('release_runtime_1', 'incident_role_1', 2, 'RUNTIME-MUST-NOT-RELEASE')
      `), /permission denied/u);
    } finally {
      await runtime.end();
    }

    const releaseMigrator = new Client({
      connectionString: roleConnection(databaseUrl, migratorRole, migratorPassword),
    });
    await releaseMigrator.connect();
    try {
      await releaseMigrator.query(`
        INSERT INTO workbench.ready_object_integrity_retention_releases
          (id, incident_id, released_occurrence_count, release_reference)
        VALUES ('release_migrator_1', 'incident_role_1', 2, 'D020-ROLE-BOUNDARY')
      `);
      const release = await releaseMigrator.query(`
        SELECT released_occurrence_count AS "releasedOccurrenceCount",
               release_reference AS "releaseReference"
        FROM workbench.ready_object_integrity_retention_releases
        WHERE id = 'release_migrator_1'
      `);
      assert.deepEqual(release.rows, [{
        releasedOccurrenceCount: 2,
        releaseReference: "D020-ROLE-BOUNDARY",
      }]);
    } finally {
      await releaseMigrator.end();
    }
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${identifier(runtimeRole)}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${identifier(migratorRole)}`).catch(() => undefined);
    await admin.end();
  }
}, 120_000);

async function createAdminOwnedFixture(databaseUrl) {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(`
      CREATE SCHEMA workbench;
      CREATE SCHEMA workbench_jobs;
      CREATE TYPE workbench.fixture_status AS ENUM ('ready');
      CREATE DOMAIN workbench.fixture_key AS TEXT CHECK (VALUE <> '');
      CREATE SEQUENCE workbench.fixture_sequence;
      CREATE TABLE workbench.fixture_table (
        id workbench.fixture_key PRIMARY KEY,
        status workbench.fixture_status NOT NULL DEFAULT 'ready'
      );
      CREATE VIEW workbench.fixture_view AS
        SELECT id FROM workbench.fixture_table;
      CREATE MATERIALIZED VIEW workbench.fixture_materialized AS
        SELECT count(*)::bigint AS row_count FROM workbench.fixture_table;
      CREATE FUNCTION workbench.fixture_function(input text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT input $$;
      CREATE TABLE workbench_jobs.fixture_job (id TEXT PRIMARY KEY);
      CREATE TABLE workbench.blobs (
        id TEXT PRIMARY KEY,
        storage_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        gc_eligible_at TIMESTAMPTZ
      );
      CREATE TABLE workbench.file_assets (
        id TEXT PRIMARY KEY,
        blob_id TEXT NOT NULL REFERENCES workbench.blobs(id),
        status TEXT NOT NULL,
        failure_code TEXT,
        failure_detail TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE workbench.canvas_visual_capabilities (
        id UUID PRIMARY KEY,
        storage_key TEXT UNIQUE,
        status TEXT NOT NULL,
        failure_code TEXT,
        storage_deleted_at TIMESTAMPTZ
      );
      CREATE TABLE workbench.runtime_provider_states (
        runtime_attempt_id TEXT PRIMARY KEY,
        state_sha256 CHAR(64) NOT NULL
      );
      CREATE TABLE workbench.runtime_provider_cancellation_resolutions (
        runtime_attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        failure_code VARCHAR(120) NOT NULL,
        outcome VARCHAR(32) NOT NULL
      );
    `);
    await admin.query("SET search_path TO workbench");
    await admin.query(readFileSync(
      "packages/workbench-db/prisma/migrations/20260720030000_ready_object_integrity_incidents/migration.sql",
      "utf8",
    ));
    await admin.query("SET search_path TO public");
  } finally {
    await admin.end();
  }
}

async function assertFixtureOwnership(databaseUrl, migratorRole) {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const result = await admin.query(`
      SELECT 'schema:' || nspname AS object_name, pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace
      WHERE nspname IN ('workbench', 'workbench_jobs')
      UNION ALL
      SELECT 'relation:' || relname, pg_get_userbyid(relowner)
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('workbench', 'workbench_jobs')
        AND relation.relname IN (
          'fixture_table', 'fixture_view', 'fixture_materialized',
          'fixture_sequence', 'fixture_job', 'runtime_provider_states',
          'runtime_provider_cancellation_resolutions'
        )
      UNION ALL
      SELECT 'function:' || proname, pg_get_userbyid(proowner)
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'workbench' AND proname = 'fixture_function'
      UNION ALL
      SELECT 'type:' || typname, pg_get_userbyid(type.typowner)
      FROM pg_type AS type
      JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = 'workbench' AND typname IN ('fixture_key', 'fixture_status')
      ORDER BY object_name
    `);
    const expectedNames = [
      "function:fixture_function",
      "relation:fixture_job",
      "relation:fixture_materialized",
      "relation:fixture_sequence",
      "relation:fixture_table",
      "relation:fixture_view",
      "relation:runtime_provider_cancellation_resolutions",
      "relation:runtime_provider_states",
      "schema:workbench",
      "schema:workbench_jobs",
      "type:fixture_key",
      "type:fixture_status",
    ];
    assert.deepEqual(result.rows.map((row) => row.object_name), expectedNames);
    assert.deepEqual([...new Set(result.rows.map((row) => row.owner))], [migratorRole]);
  } finally {
    await admin.end();
  }
}

function runProvisioner(adminUrl, { migratorRole, migratorPassword, runtimeRole, runtimePassword, phase }) {
  const result = spawnSync(process.execPath, ["scripts/provision-workbench-database-roles.mjs", `--phase=${phase}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      WORKBENCH_POSTGRES_ADMIN_URL: adminUrl,
      WORKBENCH_POSTGRES_MIGRATOR_USER: migratorRole,
      WORKBENCH_POSTGRES_MIGRATOR_PASSWORD: migratorPassword,
      WORKBENCH_POSTGRES_RUNTIME_USER: runtimeRole,
      WORKBENCH_POSTGRES_RUNTIME_PASSWORD: runtimePassword,
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

function databaseConnection(value, database) {
  const url = new URL(value);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

function roleConnection(value, role, password) {
  const url = new URL(value);
  url.username = role;
  url.password = password;
  return url.toString();
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error("invalid test identifier");
  return `"${value}"`;
}
