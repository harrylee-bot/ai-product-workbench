import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL(
  "../packages/workbench-db/prisma/migrations/",
  import.meta.url,
);
const exportDeliveryMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260718020000_export_delivery_matrix/migration.sql",
  import.meta.url,
), "utf8");
const canvasSnapshotDigestMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260719010000_canvas_grant_snapshot_digest/migration.sql",
  import.meta.url,
), "utf8");
const canvasStateAckDigestMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260719030000_canvas_state_ack_digest/migration.sql",
  import.meta.url,
), "utf8");
const runtimeAttemptStatusMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260719015000_runtime_attempt_submission_unknown_status/migration.sql",
  import.meta.url,
), "utf8");
const runtimeExecutionDurabilityMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260719020000_runtime_execution_durability/migration.sql",
  import.meta.url,
), "utf8");
const triggerSearchPathMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260719050000_trigger_function_search_path_hardening/migration.sql",
  import.meta.url,
), "utf8");
const runCancellationReceiptMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260719060000_run_cancellation_receipts/migration.sql",
  import.meta.url,
), "utf8");
const runEventAppendOnlyMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260720010000_run_event_append_only_source_identity/migration.sql",
  import.meta.url,
), "utf8");
const canvasVisualLifecycleMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260720020000_canvas_visual_lifecycle_gc/migration.sql",
  import.meta.url,
), "utf8");
const readyObjectIntegrityMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260720030000_ready_object_integrity_incidents/migration.sql",
  import.meta.url,
), "utf8");
const extensionProvisioning = await readFile(new URL(
  "../deploy/workbench-postgres-extensions.sql",
  import.meta.url,
), "utf8");
const migratorEntrypoint = await readFile(new URL(
  "../deploy/workbench-migrate.sh",
  import.meta.url,
), "utf8");
const databaseRoleProvisioning = await readFile(new URL(
  "./provision-workbench-database-roles.mjs",
  import.meta.url,
), "utf8");
const readyObjectIntegrityReleaseOperator = await readFile(new URL(
  "./release-ready-object-integrity-retention.mjs",
  import.meta.url,
), "utf8");

test("export packaging backfill restores the mutation guard", () => {
  const disableGuard = exportDeliveryMigration.indexOf(
    'DISABLE TRIGGER "export_jobs_mutation_guard"',
  );
  const backfill = exportDeliveryMigration.indexOf('UPDATE "export_jobs"');
  const enableGuard = exportDeliveryMigration.indexOf(
    'ENABLE TRIGGER "export_jobs_mutation_guard"',
  );

  assert(disableGuard >= 0, "migration must disable the guard before schema backfill");
  assert(backfill > disableGuard, "schema backfill must run after the guard is disabled");
  assert(enableGuard > backfill, "migration must restore the guard after schema backfill");
});

test("Canvas grant snapshot digest migration is append-only and fences legacy grants", async () => {
  const migrationEntries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrationCount = migrationEntries.filter((entry) => entry.isDirectory()).length;
  assert.equal(migrationCount, 66, "candidate migration inventory must be updated explicitly");
  assert(migrationEntries.some((entry) => (
    entry.isDirectory()
    && entry.name === "20260719010000_canvas_grant_snapshot_digest"
  )));

  const sessionColumn = canvasSnapshotDigestMigration.indexOf(
    'ALTER TABLE "canvas_agent_sessions"\nADD COLUMN "snapshot_sha256" CHAR(64) NOT NULL DEFAULT repeat(\'0\', 64)',
  );
  const grantColumn = canvasSnapshotDigestMigration.indexOf(
    'ALTER TABLE "canvas_tool_grants"\nADD COLUMN "snapshot_sha256" CHAR(64) NOT NULL DEFAULT repeat(\'0\', 64)',
  );
  const revokeLegacy = canvasSnapshotDigestMigration.indexOf(
    'UPDATE "canvas_tool_grants"\nSET "revoked_at"',
  );
  const cancelLegacy = canvasSnapshotDigestMigration.indexOf(
    'UPDATE "canvas_agent_sessions"\nSET "status" = \'cancelled\'',
  );
  const removeLegacyDefault = canvasSnapshotDigestMigration.indexOf(
    'ALTER COLUMN "snapshot_sha256" DROP DEFAULT',
  );

  assert(sessionColumn >= 0 && grantColumn >= 0, "session and grant must both persist the digest");
  assert(revokeLegacy > grantColumn, "legacy grants must be revoked after adding the digest columns");
  assert(cancelLegacy > revokeLegacy, "legacy sessions must be cancelled after grant revocation");
  assert(
    removeLegacyDefault > cancelLegacy,
    "legacy authorization must be fenced before removing the one-time backfill default",
  );
  assert.match(
    canvasSnapshotDigestMigration,
    /UPDATE "canvas_tool_grants"[\s\S]*WHERE "revoked_at" IS NULL;/u,
    "the migration must leave already-revoked immutable grants untouched",
  );
  assert.doesNotMatch(
    canvasSnapshotDigestMigration,
    /SET "snapshot_sha256"/u,
    "legacy digests must be backfilled by ADD COLUMN defaults without firing immutable row guards",
  );
  assert.match(canvasSnapshotDigestMigration, /canvas_agent_sessions_snapshot_sha256_check/u);
  assert.match(canvasSnapshotDigestMigration, /CANVAS_AGENT_SESSION_SNAPSHOT_IMMUTABLE/u);
  assert.match(canvasSnapshotDigestMigration, /CANVAS_TOOL_GRANT_SNAPSHOT_IMMUTABLE/u);
  assert.match(canvasSnapshotDigestMigration, /CANVAS_TOOL_GRANT_SNAPSHOT_SCOPE_INVALID/u);
});

test("Canvas visual cleanup has a bounded lifecycle candidate index", () => {
  assert.match(
    canvasVisualLifecycleMigration,
    /CREATE INDEX "canvas_visual_capabilities_status_storage_deleted_expires_idx"/u,
  );
  assert.match(
    canvasVisualLifecycleMigration,
    /\("status", "storage_deleted_at", "expires_at"\)/u,
  );
});

test("ready object integrity incidents are constrained and deduplicated audit evidence", () => {
  assert.match(readyObjectIntegrityMigration, /^BEGIN;/u);
  assert.match(readyObjectIntegrityMigration, /ready_object_integrity_incidents_fingerprint_key/u);
  assert.match(readyObjectIntegrityMigration, /OBJECT_STORAGE_SHA256_MISMATCH/u);
  assert.match(readyObjectIntegrityMigration, /READY_OBJECT_INTEGRITY_INCIDENT_IMMUTABLE/u);
  assert.match(readyObjectIntegrityMigration, /READY_OBJECT_INTEGRITY_INCIDENT_DELETE_FORBIDDEN/u);
  assert.match(readyObjectIntegrityMigration, /BEFORE UPDATE OR DELETE ON "ready_object_integrity_incidents"/u);
  assert.match(readyObjectIntegrityMigration, /READY_OBJECT_INTEGRITY_AUDIT_TRUNCATE_FORBIDDEN/u);
  assert.match(readyObjectIntegrityMigration, /BEFORE TRUNCATE ON "ready_object_integrity_incidents"/u);
  assert.match(readyObjectIntegrityMigration, /occurrence_count" <> OLD\."occurrence_count" \+ 1/u);
  assert.match(readyObjectIntegrityMigration, /ready_object_integrity_retention_releases/u);
  assert.match(readyObjectIntegrityMigration, /READY_OBJECT_INTEGRITY_RELEASE_REQUIRES_OWNER/u);
  assert.match(readyObjectIntegrityMigration, /READY_OBJECT_INTEGRITY_RELEASE_APPEND_ONLY/u);
  assert.match(readyObjectIntegrityMigration, /SET search_path = pg_catalog/u);
  assert.match(readyObjectIntegrityMigration, /COMMIT;\s*$/u);
  assert.match(readyObjectIntegrityReleaseOperator, /WORKBENCH_MIGRATOR_DATABASE_URL/u);
  assert.doesNotMatch(readyObjectIntegrityReleaseOperator, /WORKBENCH_DATABASE_URL\?\.trim/u);
});

test("Run cancellation receipts are scoped, immutable, and lifecycle-bound to their Run", () => {
  assert.match(runCancellationReceiptMigration, /^BEGIN;/u);
  assert.match(
    runCancellationReceiptMigration,
    /run_cancellation_receipts_principal_id_idempotency_key_key/u,
  );
  assert.match(runCancellationReceiptMigration, /run_cancellation_receipts_response_shape_check/u);
  assert.match(
    runCancellationReceiptMigration,
    /FOREIGN KEY \("run_id"\) REFERENCES "runs"\("id"\)\s+ON DELETE CASCADE/u,
  );
  assert.match(runCancellationReceiptMigration, /RUN_CANCELLATION_RECEIPT_IMMUTABLE/u);
  assert.match(
    runCancellationReceiptMigration,
    /LANGUAGE plpgsql\s+SET search_path = pg_catalog/u,
  );
  assert.match(
    runCancellationReceiptMigration,
    /BEFORE UPDATE ON "run_cancellation_receipts"/u,
  );
  assert.match(runCancellationReceiptMigration, /COMMIT;\s*$/u);
});

test("RunEvent is append-only and shares the application source-id language", () => {
  assert.match(runEventAppendOnlyMigration, /^BEGIN;/u);
  assert.match(runEventAppendOnlyMigration, /RUN_EVENT_SOURCE_ID_BACKFILL_REQUIRED/u);
  assert.match(runEventAppendOnlyMigration, /ALTER COLUMN "source_id" TYPE VARCHAR\(128\)/u);
  assert.match(runEventAppendOnlyMigration, /run_events_source_id_format_check/u);
  assert.match(runEventAppendOnlyMigration, /\^\[A-Za-z0-9\._:-\]\+\$/u);
  assert.match(runEventAppendOnlyMigration, /RUN_EVENT_APPEND_ONLY/u);
  assert.match(runEventAppendOnlyMigration, /BEFORE UPDATE OR DELETE ON "run_events"/u);
  assert.match(runEventAppendOnlyMigration, /BEFORE TRUNCATE ON "run_events"/u);
  assert.match(runEventAppendOnlyMigration, /pg_trigger_depth\(\) > 1/u);
  assert.match(
    runEventAppendOnlyMigration,
    /SET search_path = pg_catalog, public/u,
  );
  assert.match(runEventAppendOnlyMigration, /COMMIT;\s*$/u);
});

test("Canvas command ACKs bind canonical state digests before and after execution", () => {
  assert.match(canvasStateAckDigestMigration, /canvas_state_sha256_before/u);
  assert.match(canvasStateAckDigestMigration, /canvas_state_sha256_after/u);
  assert.match(canvasStateAckDigestMigration, /expected_canvas_state_sha256/u);
  assert.match(canvasStateAckDigestMigration, /acknowledged_canvas_state_sha256/u);
  assert.match(canvasStateAckDigestMigration, /canvas_tool_invocations_state_digest_check/u);
  assert.match(canvasStateAckDigestMigration, /canvas_client_commands_state_digest_check/u);
  assert.match(canvasStateAckDigestMigration, /CANVAS_TOOL_INVOCATION_STATE_BEFORE_IMMUTABLE/u);
  assert.match(canvasStateAckDigestMigration, /CANVAS_TOOL_INVOCATION_STATE_AFTER_IMMUTABLE/u);
  assert.match(canvasStateAckDigestMigration, /CANVAS_CLIENT_COMMAND_EXPECTED_STATE_INVALID/u);
  assert(
    canvasStateAckDigestMigration.indexOf('UPDATE "canvas_tool_invocations"')
      < canvasStateAckDigestMigration.indexOf('canvas_tool_invocations_state_digest_check'),
    "legacy terminal invocations must be backfilled before the lifecycle constraint is installed",
  );
});

test("Runtime execution durability fences owners, submissions, and external event effects", () => {
  assert.equal(
    runtimeAttemptStatusMigration.trim(),
    "ALTER TYPE \"RuntimeAttemptStatus\" ADD VALUE 'submission_unknown' AFTER 'submitting';",
    "the new enum value must have its own committed Prisma migration",
  );
  assert.doesNotMatch(runtimeExecutionDurabilityMigration, /ALTER TYPE "RuntimeAttemptStatus"/u);
  assert.match(runtimeExecutionDurabilityMigration, /^BEGIN;/u);
  assert.match(runtimeExecutionDurabilityMigration, /execution_owner_id/u);
  assert.match(runtimeExecutionDurabilityMigration, /execution_epoch/u);
  assert.match(runtimeExecutionDurabilityMigration, /execution_lease_expires_at/u);
  assert.match(runtimeExecutionDurabilityMigration, /\^wbrt:\[0-9a-f\]\{64\}\$/u);
  assert.match(runtimeExecutionDurabilityMigration, /public\.digest\("id", 'sha256'\)/u);
  assert.match(runtimeExecutionDurabilityMigration, /runtime_attempts_provider_idempotency_state_check/u);
  assert.match(runtimeExecutionDurabilityMigration, /runtime_external_events_attempt_event_key/u);
  assert.match(runtimeExecutionDurabilityMigration, /runtime_external_events_attempt_sequence_key/u);
  assert.match(runtimeExecutionDurabilityMigration, /RUNTIME_EXTERNAL_EVENT_IMMUTABLE/u);
});

test("all application trigger functions use a fixed trusted search path", () => {
  assert.match(triggerSearchPathMigration, /FROM pg_trigger AS trigger/u);
  assert.match(triggerSearchPathMigration, /trigger\."tgisinternal" = FALSE/u);
  assert.match(triggerSearchPathMigration, /dependency\."deptype" = 'e'/u);
  assert.match(
    triggerSearchPathMigration,
    /ALTER FUNCTION %I\.%I\(%s\) SET search_path TO pg_catalog, public/u,
  );
  assert.match(triggerSearchPathMigration, /TRIGGER_FUNCTION_SEARCH_PATH_NOT_HARDENED/u);
});

test("database extensions are provisioned outside least-privilege application migrations", async () => {
  const migrationEntries = await readdir(migrationsDirectory, { withFileTypes: true });
  for (const entry of migrationEntries) {
    if (!entry.isDirectory()) continue;
    const migration = await readFile(new URL(
      `${entry.name}/migration.sql`,
      migrationsDirectory,
    ), "utf8");
    assert.doesNotMatch(
      migration,
      /\bCREATE\s+EXTENSION\b/iu,
      `${entry.name} must not require infrastructure-admin privileges`,
    );
  }

  for (const extension of ["vector", "pg_trgm", "pgcrypto"]) {
    assert.match(
      extensionProvisioning,
      new RegExp(`CREATE\\s+EXTENSION\\s+IF\\s+NOT\\s+EXISTS\\s+${extension}\\b`, "iu"),
    );
  }
  assert(
    migratorEntrypoint.indexOf("assert-workbench-postgres-extensions.mjs --check")
      < migratorEntrypoint.indexOf("migrate:deploy"),
    "the migrator must fail closed on missing or unsupported extensions before Prisma runs",
  );
});

test("database roles keep migrations separate from runtime DML", () => {
  assert.match(databaseRoleProvisioning, /WORKBENCH_POSTGRES_ADMIN_URL/u);
  assert.match(databaseRoleProvisioning, /WORKBENCH_POSTGRES_MIGRATOR_USER/u);
  assert.match(databaseRoleProvisioning, /WORKBENCH_POSTGRES_RUNTIME_USER/u);
  assert.match(databaseRoleProvisioning, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE .*run_events/u);
  assert.match(databaseRoleProvisioning, /REVOKE DELETE, TRUNCATE ON TABLE .*ready_object_integrity_incidents/u);
  assert.match(databaseRoleProvisioning, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE .*ready_object_integrity_retention_releases/u);
  assert.match(databaseRoleProvisioning, /schemaIdentifier\("workbench_jobs"\)/u);
  assert.match(databaseRoleProvisioning, /REVOKE CREATE ON SCHEMA \$\{jobsSchema\}/u);
  assert.match(migratorEntrypoint, /--phase=bootstrap/u);
  assert.match(migratorEntrypoint, /--phase=grant/u);
});
