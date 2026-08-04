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
const runtimeProviderStateMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260723010000_runtime_provider_state_v2/migration.sql",
  import.meta.url,
), "utf8");
const runtimeProviderCancellationResolutionMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260803010000_runtime_provider_cancellation_resolution/migration.sql",
  import.meta.url,
), "utf8");
const runtimeProviderCancellationOperationMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260804010000_runtime_provider_cancellation_operation/migration.sql",
  import.meta.url,
), "utf8");
const prdV2ArtifactVersionGuardsMigration = await readFile(new URL(
  "../packages/workbench-db/prisma/migrations/20260723020000_prd_v2_artifact_version_guards/migration.sql",
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
  assert.equal(migrationCount, 70, "candidate migration inventory must be updated explicitly");
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

test("Runtime provider state v2 is scoped, monotonic, bounded, and finalization-bound", () => {
  assert.match(runtimeProviderStateMigration, /^BEGIN;/u);
  assert.match(runtimeProviderStateMigration, /CREATE TABLE "runtime_provider_states"/u);
  assert.match(runtimeProviderStateMigration, /runtime_provider_states_attempt_scope_fkey/u);
  assert.match(runtimeProviderStateMigration, /FOREIGN KEY \("runtime_attempt_id", "run_id"\)/u);
  assert.match(runtimeProviderStateMigration, /last_applied_sequence_nonnegative_check/u);
  assert.match(runtimeProviderStateMigration, /char_length\("redaction_buffer"\) <= 4096/u);
  assert.match(runtimeProviderStateMigration, /RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID/u);
  assert.match(runtimeProviderStateMigration, /RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT/u);
  assert.match(runtimeProviderStateMigration, /RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID/u);
  assert.match(runtimeProviderStateMigration, /event\."payload_sha256"/u);
  assert.match(runtimeProviderStateMigration, /SET search_path = pg_catalog\s+AS/u);
  assert.match(runtimeProviderStateMigration, /FROM %I\."runtime_attempts"/u);
  assert.match(runtimeProviderStateMigration, /FROM %I\."runtime_external_events"/u);
  assert.match(runtimeProviderStateMigration, /TG_TABLE_SCHEMA/u);
  assert.doesNotMatch(runtimeProviderStateMigration, /public\."runtime_(?:attempts|external_events)"/u);
  assert.match(runtimeProviderStateMigration, /COMMIT;\s*$/u);
  assert.doesNotMatch(runtimeProviderStateMigration, /DELETE FROM "runtime_external_events"/u);
  assert.doesNotMatch(runtimeProviderStateMigration, /UPDATE "runtime_external_events"/u);
});

test("Runtime provider cancellation resolution is append-only and Run-lifecycle-bound", () => {
  assert.match(runtimeProviderCancellationResolutionMigration, /^BEGIN;/u);
  assert.match(
    runtimeProviderCancellationResolutionMigration,
    /FOREIGN KEY \("runtime_attempt_id", "run_id"\)[\s\S]*ON DELETE CASCADE/u,
  );
  assert.match(
    runtimeProviderCancellationResolutionMigration,
    /IF TG_OP = 'DELETE' AND pg_trigger_depth\(\) > 1 THEN/u,
  );
  assert.match(
    runtimeProviderCancellationResolutionMigration,
    /SELECT EXISTS \(SELECT 1 FROM %I\."runs" WHERE "id" = \$1\)/u,
  );
  assert.match(runtimeProviderCancellationResolutionMigration, /TG_TABLE_SCHEMA/u);
  assert.match(runtimeProviderCancellationResolutionMigration, /IF NOT owning_run_exists THEN/u);
  assert.match(
    runtimeProviderCancellationResolutionMigration,
    /RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_APPEND_ONLY/u,
  );
  assert.match(
    runtimeProviderCancellationResolutionMigration,
    /BEFORE UPDATE OR DELETE ON "runtime_provider_cancellation_resolutions"/u,
  );
  assert.match(
    runtimeProviderCancellationResolutionMigration,
    /BEFORE TRUNCATE ON "runtime_provider_cancellation_resolutions"/u,
  );
  assert.match(runtimeProviderCancellationResolutionMigration, /COMMIT;\s*$/u);
});

test("Runtime provider cancellation operations are epoch-fenced and resolution-bound", () => {
  assert.match(runtimeProviderCancellationOperationMigration, /^BEGIN;/u);
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /provider_cancellation_operation_epoch.*INTEGER NOT NULL DEFAULT 0/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /provider_cancellation_operation_started_at.*TIMESTAMPTZ/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /provider_cancellation_operation_deadline_at.*TIMESTAMPTZ/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /runtime_attempts_provider_cancellation_operation_insert_guard/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /BEFORE INSERT ON "runtime_attempts"/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /runtime_attempts_provider_cancellation_operation_update_guard/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /RUNTIME_PROVIDER_CANCELLATION_OPERATION_TAKEOVER_INVALID/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_SCOPE_INVALID/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /RUNTIME_PROVIDER_CANCELLATION_OPERATION_NOT_ACTIVE/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /ADD COLUMN "operation_epoch" INTEGER NOT NULL/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /ADD COLUMN "external_run_id" VARCHAR\(512\) NOT NULL/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /FOREIGN KEY \("runtime_attempt_id", "run_id", "operation_epoch"\)/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /fresh_now := clock_timestamp\(\)/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /NEW\."updated_at" := GREATEST\(\s*clock_timestamp\(\),\s*OLD\."updated_at",\s*NEW\."built_at"\s*\)/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /CREATE CONSTRAINT TRIGGER "runtime_provider_cancellation_resolutions_cleared_guard"/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /DEFERRABLE INITIALLY DEFERRED/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /run_error_code IS NOT DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'/u,
  );
  assert.match(
    runtimeProviderCancellationOperationMigration,
    /attempt_error_code IS DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'/u,
  );
  assert.doesNotMatch(
    runtimeProviderCancellationOperationMigration,
    /(?:run_error_code|attempt_error_code|(?:OLD|NEW)\."error_code")\s*(?:=|<>)\s*'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'/u,
  );
  assert.match(runtimeProviderCancellationOperationMigration, /COMMIT;\s*$/u);
});

test("PRD ArtifactVersion guards bind v1 and v2 schemas to their exact protocols", () => {
  assert.match(prdV2ArtifactVersionGuardsMigration, /^BEGIN;/u);
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /CREATE OR REPLACE FUNCTION "guard_artifact_version_update"\(\)/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /CREATE OR REPLACE FUNCTION "guard_artifact_version_edit_receipt"\(\)/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /NEW\."schema_version" IS DISTINCT FROM 1\s+AND NEW\."schema_version" IS DISTINCT FROM 2/u,
  );
  assert.match(prdV2ArtifactVersionGuardsMigration, /CASE NEW\."schema_version"/u);
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /WHEN 1 THEN NEW\."content"->>'protocol' IS DISTINCT FROM 'workbench\.prd\.v1'/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /WHEN 2 THEN NEW\."content"->>'protocol' IS DISTINCT FROM 'workbench\.prd\.v2'/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /jsonb_typeof\(NEW\."content"\) IS DISTINCT FROM 'object'/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /NEW\."content"->'citations' IS DISTINCT FROM NEW\."citations"/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /artifact_kind IN \('prototype', 'design_system'\)[\s\S]*NEW\."schema_version" IS DISTINCT FROM 1/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /artifact_kind = 'prd'::"ArtifactKind"[\s\S]*base_schema_version IS DISTINCT FROM result_schema_version[\s\S]*result_schema_version IS DISTINCT FROM 1[\s\S]*result_schema_version IS DISTINCT FROM 2/u,
  );
  assert.match(
    prdV2ArtifactVersionGuardsMigration,
    /ALTER FUNCTION %I\.%I\(\) SET search_path TO %s/u,
  );
  assert.match(prdV2ArtifactVersionGuardsMigration, /COMMIT;\s*$/u);
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
  assert.match(databaseRoleProvisioning, /REVOKE DELETE, TRUNCATE ON TABLE .*runtime_provider_states/u);
  assert.match(databaseRoleProvisioning, /GRANT SELECT, INSERT, UPDATE ON TABLE .*runtime_provider_states/u);
  assert.match(databaseRoleProvisioning, /REVOKE DELETE, TRUNCATE ON TABLE .*ready_object_integrity_incidents/u);
  assert.match(databaseRoleProvisioning, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE .*ready_object_integrity_retention_releases/u);
  assert.match(databaseRoleProvisioning, /schemaIdentifier\("workbench_jobs"\)/u);
  assert.match(databaseRoleProvisioning, /REVOKE CREATE ON SCHEMA \$\{jobsSchema\}/u);
  assert.match(migratorEntrypoint, /--phase=bootstrap/u);
  assert.match(migratorEntrypoint, /--phase=grant/u);
});
