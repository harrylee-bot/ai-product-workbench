#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import pg from "pg";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = testDatabaseUrl(process.env.WORKBENCH_TEST_DATABASE_URL);
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
assertSchemaResetConfirmation(databaseName);
const commandTimeoutMs = positiveInteger("WORKBENCH_CONSTRAINT_COMMAND_TIMEOUT_MS", 180_000);
const verbose = process.env.WORKBENCH_CONSTRAINT_VERBOSE === "1";

const checks = [];
let savepointSequence = 0;
let client;
let transactionOpen = false;

try {
  console.log(`[constraints] target database: ${databaseName}`);
  await rebuildSchemas();
  await migrateDatabase();

  client = new Client({
    connectionString: pgConnectionUrl(databaseUrl),
    application_name: "workbench-constraint-tests",
  });
  await client.connect();
  await client.query('SET search_path TO "workbench", public');
  await client.query("BEGIN");
  transactionOpen = true;

  await seedMinimumGraph(client);
  await runConstraintChecks(client);

  const migrations = await client.query(`
    SELECT "migration_name"
    FROM "_prisma_migrations"
    WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    ORDER BY "finished_at", "migration_name"
  `);
  await client.query("ROLLBACK");
  transactionOpen = false;

  console.log(JSON.stringify({
    ok: true,
    database: databaseName,
    migrations: migrations.rows.map((row) => row.migration_name),
    passed: checks.length,
    checks,
  }, null, 2));
} catch (error) {
  if (client && transactionOpen) {
    await client.query("ROLLBACK").catch(() => undefined);
    transactionOpen = false;
  }
  console.error(
    "[constraints] FAILED",
    error instanceof Error ? error.stack ?? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}

async function rebuildSchemas() {
  const resetClient = new Client({
    connectionString: pgConnectionUrl(databaseUrl),
    application_name: "workbench-constraint-reset",
  });
  await resetClient.connect();
  try {
    const result = await resetClient.query("SELECT current_database() AS name");
    const actualName = result.rows[0]?.name;
    if (typeof actualName !== "string" || !isTestDatabaseName(actualName)) {
      throw new Error(`Refusing to reset non-test database reported by PostgreSQL: ${String(actualName)}`);
    }
    if (actualName !== databaseName) {
      throw new Error(`Database URL resolved to ${actualName}, expected ${databaseName}`);
    }

    console.log("[constraints] rebuilding workbench schemas");
    await resetClient.query('DROP SCHEMA IF EXISTS "workbench_jobs" CASCADE');
    await resetClient.query('DROP SCHEMA IF EXISTS "workbench" CASCADE');
    await resetClient.query('CREATE SCHEMA "workbench"');
  } finally {
    await resetClient.end();
  }
}

async function migrateDatabase() {
  console.log("[constraints] applying current Workbench migrations");
  await runCommand(
    npm,
    ["--workspace", "@workbench/workbench-db", "run", "migrate:deploy"],
    { WORKBENCH_DATABASE_URL: databaseUrl },
  );
}

async function seedMinimumGraph(db) {
  console.log("[constraints] seeding minimal valid ownership graph");
  await db.query(`
    INSERT INTO "principals" (
      "id", "issuer", "subject", "email", "display_name", "updated_at"
    ) VALUES
      ('principal-a', 'constraint-test', 'principal-a', 'a@test.local', 'Principal A', clock_timestamp()),
      ('principal-b', 'constraint-test', 'principal-b', 'b@test.local', 'Principal B', clock_timestamp());

    INSERT INTO "knowledge_profile_operator_events" (
      "principal_id", "action", "authorized_by", "change_reference"
    ) VALUES (
      'principal-a', 'grant', 'constraint.approver', 'CONSTRAINT-SEED-OPERATOR'
    );

    INSERT INTO "workspaces" (
      "id", "slug", "name", "created_by_id", "updated_at"
    ) VALUES
      ('workspace-a', 'constraint-workspace-a', 'Workspace A', 'principal-a', clock_timestamp()),
      ('workspace-b', 'constraint-workspace-b', 'Workspace B', 'principal-b', clock_timestamp());

    INSERT INTO "workspace_members" (
      "workspace_id", "principal_id", "role", "updated_at"
    ) VALUES
      ('workspace-a', 'principal-a', 'owner', clock_timestamp()),
      ('workspace-b', 'principal-b', 'owner', clock_timestamp());

    INSERT INTO "projects" (
      "id", "workspace_id", "created_by_id", "title", "updated_at"
    ) VALUES
      ('project-a', 'workspace-a', 'principal-a', 'Project A', clock_timestamp()),
      ('project-b', 'workspace-b', 'principal-b', 'Project B', clock_timestamp()),
      ('project-board-test', 'workspace-a', 'principal-a', 'Board Revision Test', clock_timestamp());

    INSERT INTO "project_members" (
      "project_id", "workspace_id", "principal_id", "role", "updated_at"
    ) VALUES
      ('project-a', 'workspace-a', 'principal-a', 'owner', clock_timestamp()),
      ('project-b', 'workspace-b', 'principal-b', 'owner', clock_timestamp()),
      ('project-board-test', 'workspace-a', 'principal-a', 'owner', clock_timestamp());

    INSERT INTO "project_duplicates" (
      "target_project_id", "source_project_id", "workspace_id", "created_by_id",
      "idempotency_key", "request_hash"
    ) VALUES (
      'project-board-test', 'project-a', 'workspace-a', 'principal-a',
      'duplicate-seed-key', repeat('9', 64)
    );

    INSERT INTO "embedding_profiles" (
      "id", "spec", "spec_sha256", "dimension", "status"
    ) VALUES (
      'constraint-embedding-3-r1',
      '{
        "schema":"workbench.embedding-profile.v1",
        "id":"constraint-embedding-3-r1",
        "protocol":"tei.embed.v1",
        "engine":{"id":"constraint-tei","version":"1.0.0"},
        "model":{"id":"constraint/model","revision":"revision-1","artifactSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "tokenizer":{"id":"constraint/tokenizer","revision":"revision-1","artifactSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","modelMaximumTokens":64,"chunkMaximumTokens":32,"overflow":"reject"},
        "input":{"queryPrefix":"","documentPrefix":"","normalization":"utf8-nfc-lf-v1"},
        "output":{"dimension":3,"dtype":"float32","pooling":"cls","normalization":"l2","distance":"cosine"},
        "batch":{"maximumInputs":2,"maximumTokens":64},
        "conformanceProbeSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }'::jsonb,
      repeat('d', 64),
      3,
      'candidate'
    );
    UPDATE "embedding_profiles" SET "status" = 'poc' WHERE "id" = 'constraint-embedding-3-r1';
    UPDATE "embedding_profiles" SET "status" = 'adopted' WHERE "id" = 'constraint-embedding-3-r1';
    INSERT INTO "knowledge_profile_adoption_receipts" (
      "id", "profile_kind", "profile_version", "embedding_profile_id",
      "embedding_profile_spec_sha256", "actor_principal_id", "scope"
    ) VALUES (
      'adoption-constraint-embedding-3-r1', 'embedding', 1,
      'constraint-embedding-3-r1', repeat('d', 64), 'principal-a', 'global'
    );

    INSERT INTO "retrieval_profiles" (
      "id", "spec", "spec_sha256",
      "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension",
      "status"
    ) VALUES (
      'constraint-retrieval-r1',
      '{
        "schema":"workbench.retrieval-profile.v1",
        "id":"constraint-retrieval-r1",
        "embedding":{"profileId":"constraint-embedding-3-r1","profileSpecSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","dimension":3},
        "segmenter":{"implementationId":"jieba-wasm","version":"1.0.0","artifactSha256":"1111111111111111111111111111111111111111111111111111111111111111","algorithm":"cut_for_search","hmm":false,"dictionarySha256":"2222222222222222222222222222222222222222222222222222222222222222","stopwordsSha256":"3333333333333333333333333333333333333333333333333333333333333333","normalization":"utf8-nfc-lf-v1"},
        "recall":{"lexical":{"algorithm":"plainto_tsquery-simple-ts_rank_cd-32-v1","limit":20},"dense":{"distance":"cosine","limit":20},"fusion":{"algorithm":"rrf","k":60,"tieBreak":"workbench-rrf-v1"}},
        "reranker":{"protocol":"tei.rerank.v1","engine":{"id":"constraint-tei-reranker","version":"1.0.0","imageDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444"},"model":{"id":"constraint/reranker","revision":"revision-1","artifactSha256":"5555555555555555555555555555555555555555555555555555555555555555"},"tokenizer":{"id":"constraint/reranker-tokenizer","revision":"revision-1","artifactSha256":"6666666666666666666666666666666666666666666666666666666666666666","maximumInputTokens":512,"overflow":"reject"},"candidateLimit":20,"finalResultLimit":8,"failurePolicy":"degrade_to_rrf","conformanceProbeSha256":"7777777777777777777777777777777777777777777777777777777777777777"},
        "routingPolicy":"workbench-knowledge-route-v1",
        "citationSchema":"workbench.knowledge-citation.v1"
      }'::jsonb,
      repeat('e', 64),
      'constraint-embedding-3-r1', repeat('d', 64), 3,
      'candidate'
    );
    UPDATE "retrieval_profiles" SET "status" = 'poc' WHERE "id" = 'constraint-retrieval-r1';
    UPDATE "retrieval_profiles" SET "status" = 'adopted' WHERE "id" = 'constraint-retrieval-r1';
    INSERT INTO "knowledge_profile_adoption_receipts" (
      "id", "profile_kind", "profile_version", "retrieval_profile_id",
      "retrieval_profile_spec_sha256", "actor_principal_id", "scope"
    ) VALUES (
      'adoption-constraint-retrieval-r1', 'retrieval', 1,
      'constraint-retrieval-r1', repeat('e', 64), 'principal-a', 'global'
    );

    INSERT INTO "knowledge_releases" (
      "id", "key", "workspace_id", "version", "status",
      "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension",
      "retrieval_profile_id", "retrieval_profile_spec_sha256",
      "manifest_sha256", "manifest", "chunks_ready_at", "ready_at"
    ) VALUES
      ('release-ready-a', 'constraint-ready-a', 'workspace-a', 1, 'ready', 'constraint-embedding-3-r1', repeat('d', 64), 3, 'constraint-retrieval-r1', repeat('e', 64), repeat('1', 64), '{}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('release-artifact-a', 'constraint-artifact-a', 'workspace-a', 1, 'ready', 'constraint-embedding-3-r1', repeat('d', 64), 3, 'constraint-retrieval-r1', repeat('e', 64), repeat('2', 64), '{}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('release-building-a', 'constraint-building-a', 'workspace-a', 1, 'building', 'constraint-embedding-3-r1', repeat('d', 64), 3, 'constraint-retrieval-r1', repeat('e', 64), repeat('3', 64), '{}'::jsonb, NULL, NULL),
      ('release-ready-b', 'constraint-ready-b', 'workspace-b', 1, 'ready', 'constraint-embedding-3-r1', repeat('d', 64), 3, 'constraint-retrieval-r1', repeat('e', 64), repeat('4', 64), '{}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('release-global', 'constraint-global', NULL, 1, 'ready', 'constraint-embedding-3-r1', repeat('d', 64), 3, 'constraint-retrieval-r1', repeat('e', 64), repeat('5', 64), '{}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('release-retired-a', 'constraint-retired-a', 'workspace-a', 1, 'retired', 'constraint-embedding-3-r1', repeat('d', 64), 3, 'constraint-retrieval-r1', repeat('e', 64), repeat('0', 64), '{}'::jsonb, clock_timestamp(), clock_timestamp());

    INSERT INTO "threads" (
      "id", "project_id", "created_by_id", "title", "updated_at"
    ) VALUES
      ('thread-a', 'project-a', 'principal-a', 'Thread A', clock_timestamp()),
      ('thread-retry-a', 'project-a', 'principal-a', 'Retry Thread A', clock_timestamp()),
      ('thread-b', 'project-b', 'principal-b', 'Thread B', clock_timestamp());

    INSERT INTO "runtime_bindings" (
      "id", "thread_id", "adapter", "external_thread_id", "metadata", "updated_at"
    ) VALUES
      (
        'runtime-binding-a', 'thread-a', 'deerflow', 'external-thread-a',
        '{"workbenchThreadId":"thread-a"}'::jsonb, clock_timestamp()
      ),
      (
        'runtime-binding-b', 'thread-b', 'deerflow', 'external-thread-b',
        '{"workbenchThreadId":"thread-b"}'::jsonb, clock_timestamp()
      );

    INSERT INTO "runs" (
      "id", "project_id", "thread_id", "created_by_id", "knowledge_release_id",
      "idempotency_key", "request_hash", "request_id", "request", "model_id",
      "trace_id", "status", "error_code", "error_detail", "error_retryable",
      "finished_at", "updated_at"
    ) VALUES
      (
        'run-a', 'project-a', 'thread-a', 'principal-a', 'release-ready-a',
        'run-a-key', repeat('a', 64), 'run-a-request',
        '{"prompt":"Run A","modelId":"test-model","workflow":"generate","targetSurface":"app","designStyle":{"kind":"automatic"},"sourceIds":["source-attachment-a"],"requestedArtifactKinds":[]}'::jsonb,
        'test-model',
        'run-a-trace', 'queued', NULL, NULL, NULL, NULL, clock_timestamp()
      ),
      (
        'run-b', 'project-b', 'thread-b', 'principal-b', 'release-ready-b',
        'run-b-key', repeat('b', 64), 'run-b-request',
        '{"prompt":"Run B","modelId":"test-model","workflow":"generate","targetSurface":"web","designStyle":{"kind":"automatic"},"sourceIds":[],"requestedArtifactKinds":[]}'::jsonb,
        'test-model',
        'run-b-trace', 'queued', NULL, NULL, NULL, NULL, clock_timestamp()
      ),
      (
        'run-retry-source', 'project-a', 'thread-retry-a', 'principal-a', 'release-ready-a',
        'run-retry-source-key', repeat('c', 64), 'run-retry-source-request',
        '{"prompt":"Retry source","modelId":"test-model","workflow":"generate","targetSurface":"app","designStyle":{"kind":"automatic"},"sourceIds":[],"requestedArtifactKinds":[]}'::jsonb,
        'test-model',
        'run-retry-source-trace', 'failed', 'TEMPORARY_FAILURE',
        'Retryable constraint source', TRUE, clock_timestamp(), clock_timestamp()
      ),
      (
        'run-nonretry-source', 'project-a', 'thread-retry-a', 'principal-a', 'release-ready-a',
        'run-nonretry-source-key', repeat('d', 64), 'run-nonretry-source-request',
        '{"prompt":"Non-retry source","modelId":"test-model","workflow":"generate","targetSurface":"app","designStyle":{"kind":"automatic"},"sourceIds":[],"requestedArtifactKinds":[]}'::jsonb,
        'test-model',
        'run-nonretry-source-trace', 'failed', 'TERMINAL_FAILURE',
        'Non-retryable constraint source', FALSE, clock_timestamp(), clock_timestamp()
      );

    INSERT INTO "blobs" (
      "id", "sha256", "storage_key", "media_type", "byte_size", "status",
      "verified_at", "updated_at"
    ) VALUES
      ('blob-ready', repeat('6', 64), 'constraint/blob-ready', 'application/json', 16, 'ready', clock_timestamp(), clock_timestamp()),
      ('blob-pending', repeat('7', 64), 'constraint/blob-pending', 'application/json', 16, 'pending', NULL, clock_timestamp()),
      ('blob-empty', repeat('8', 64), 'constraint/blob-empty', 'application/json', 0, 'ready', clock_timestamp(), clock_timestamp()),
      ('blob-file-only', repeat('a', 64), 'constraint/blob-file-only', 'text/plain', 32, 'pending', NULL, clock_timestamp()),
      ('blob-extraction-source', repeat('b', 64), 'constraint/blob-extraction-source', 'application/pdf', 64, 'pending', NULL, clock_timestamp()),
      ('blob-extraction-output', repeat('c', 64), 'constraint/blob-extraction-output', 'text/markdown', 48, 'ready', clock_timestamp(), clock_timestamp()),
      ('blob-attachment', repeat('d', 64), 'constraint/blob-attachment', 'image/png', 96, 'pending', NULL, clock_timestamp()),
      ('blob-knowledge', repeat('e', 64), 'constraint/blob-knowledge', 'text/markdown', 80, 'pending', NULL, clock_timestamp()),
      ('blob-file-b', repeat('f', 64), 'constraint/blob-file-b', 'text/plain', 24, 'pending', NULL, clock_timestamp()),
      ('blob-unscanned-ready', repeat('01', 32), 'constraint/blob-unscanned-ready', 'text/plain', 20, 'ready', clock_timestamp(), clock_timestamp()),
      ('blob-output-pending', repeat('02', 32), 'constraint/blob-output-pending', 'text/plain', 20, 'pending', NULL, clock_timestamp()),
      ('blob-infected-candidate', repeat('03', 32), 'constraint/blob-infected-candidate', 'application/octet-stream', 20, 'pending', NULL, clock_timestamp()),
      ('blob-scan-candidate', repeat('04', 32), 'constraint/blob-scan-candidate', 'application/octet-stream', 20, 'pending', NULL, clock_timestamp()),
      ('blob-prototype-image', repeat('ab', 32), 'constraint/blob-prototype-image', 'image/png', 128, 'ready', clock_timestamp(), clock_timestamp());

    INSERT INTO "blob_scans" (
      "id", "blob_id", "attempt", "status", "scanner", "scanner_version",
      "signature_version", "evidence", "finished_at", "updated_at"
    ) VALUES
      ('scan-file-only', 'blob-file-only', 1, 'clean', 'constraint-scanner', '1.0.0', 'test-signatures', '{"verdict":"clean"}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('scan-extraction-source', 'blob-extraction-source', 1, 'clean', 'constraint-scanner', '1.0.0', 'test-signatures', '{"verdict":"clean"}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('scan-attachment', 'blob-attachment', 1, 'clean', 'constraint-scanner', '1.0.0', 'test-signatures', '{"verdict":"clean"}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('scan-knowledge', 'blob-knowledge', 1, 'clean', 'constraint-scanner', '1.0.0', 'test-signatures', '{"verdict":"clean"}'::jsonb, clock_timestamp(), clock_timestamp()),
      ('scan-file-b', 'blob-file-b', 1, 'clean', 'constraint-scanner', '1.0.0', 'test-signatures', '{"verdict":"clean"}'::jsonb, clock_timestamp(), clock_timestamp());

    UPDATE "blobs"
    SET "status" = 'ready', "verified_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" IN (
      'blob-file-only',
      'blob-extraction-source',
      'blob-attachment',
      'blob-knowledge',
      'blob-file-b'
    );

    INSERT INTO "file_assets" (
      "id", "project_id", "blob_id", "uploaded_by_id", "original_name",
      "declared_media_type", "detected_media_type", "byte_size", "status",
      "verified_at", "updated_at"
    ) VALUES
      ('file-only-a', 'project-a', 'blob-file-only', 'principal-a', 'plain.txt', 'text/plain', 'text/plain', 32, 'ready', clock_timestamp(), clock_timestamp()),
      ('file-extraction-a', 'project-a', 'blob-extraction-source', 'principal-a', 'source.pdf', 'application/pdf', 'application/pdf', 64, 'ready', clock_timestamp(), clock_timestamp()),
      ('file-attachment-a', 'project-a', 'blob-attachment', 'principal-a', 'screen.png', 'image/png', 'image/png', 96, 'ready', clock_timestamp(), clock_timestamp()),
      ('file-b', 'project-b', 'blob-file-b', 'principal-b', 'other.txt', 'text/plain', 'text/plain', 24, 'ready', clock_timestamp(), clock_timestamp()),
      ('file-unscanned-a', 'project-a', 'blob-unscanned-ready', 'principal-a', 'unscanned.txt', 'text/plain', 'text/plain', 20, 'verifying', NULL, clock_timestamp());

    INSERT INTO "file_extractions" (
      "id", "file_asset_id", "source_blob_id", "attempt", "status", "parser",
      "parser_version", "output_schema_version", "idempotency_key", "request_hash",
      "updated_at"
    ) VALUES (
      'extraction-ready-a', 'file-extraction-a', 'blob-extraction-source', 1,
      'queued', 'docling', '1.0.0', 1, 'extract-ready-a', repeat('1', 64),
      clock_timestamp()
    );

    UPDATE "file_extractions"
    SET "status" = 'running', "started_at" = clock_timestamp(),
        "processing_attempts" = 1, "submission_generation" = 1,
        "submission_started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" = 'extraction-ready-a';

    INSERT INTO "file_extraction_outputs" (
      "extraction_id", "kind", "position", "blob_id", "metadata"
    ) VALUES (
      'extraction-ready-a', 'markdown', 0, 'blob-extraction-output', '{"format":"markdown"}'::jsonb
    );

    UPDATE "file_extractions"
    SET "status" = 'ready',
        "content_sha256" = repeat('5', 64),
        "finished_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE "id" = 'extraction-ready-a';

    UPDATE "file_assets"
    SET "current_extraction_id" = 'extraction-ready-a',
        "revision" = "revision" + 1,
        "updated_at" = clock_timestamp()
    WHERE "id" = 'file-extraction-a';

    INSERT INTO "import_sources" (
      "id", "project_id", "created_by_id", "kind", "status", "label",
      "descriptor", "request", "request_hash", "idempotency_key", "checksum",
      "revision", "updated_at"
    ) VALUES (
      'source-attachment-a', 'project-a', 'principal-a', 'file', 'pending',
      'screen.png', NULL, '{"kind":"file","fileAssetId":"file-attachment-a"}'::jsonb,
      repeat('d1', 32), 'constraint-source-attachment-a', NULL, 0,
      clock_timestamp()
    );

    INSERT INTO "import_source_blobs" (
      "id", "import_source_id", "project_id", "position", "blob_id",
      "file_asset_id", "role", "path", "media_type", "byte_size", "sha256"
    ) VALUES (
      'source-blob-attachment-a', 'source-attachment-a', 'project-a', 0,
      'blob-attachment', 'file-attachment-a', 'primary', 'screen.png',
      'image/png', 96, repeat('d', 64)
    );

    UPDATE "import_sources"
    SET "status" = 'ready',
        "descriptor" = '{"kind":"file","fileAssetId":"file-attachment-a","originalName":"screen.png","mediaType":"image/png"}'::jsonb,
        "checksum" = repeat('d', 64),
        "revision" = 1,
        "updated_at" = clock_timestamp()
    WHERE "id" = 'source-attachment-a';

    INSERT INTO "run_source_snapshots" (
      "id", "run_id", "project_id", "position", "source_id", "kind", "label",
      "checksum", "descriptor", "snapshot"
    ) VALUES (
      'run-source-attachment-a', 'run-a', 'project-a', 0,
      'source-attachment-a', 'file', 'screen.png', repeat('d', 64),
      '{"kind":"file","fileAssetId":"file-attachment-a","originalName":"screen.png","mediaType":"image/png"}'::jsonb,
      jsonb_build_object(
        'protocol', 'workbench.import-source-snapshot.v1',
        'sourceRevision', 1,
        'checksum', repeat('d', 64),
        'blobs', jsonb_build_array(jsonb_build_object(
          'position', 0,
          'blobId', 'blob-attachment',
          'role', 'primary',
          'path', 'screen.png',
          'mediaType', 'image/png',
          'byteSize', 96,
          'sha256', repeat('d', 64)
        ))
      )
    );

    INSERT INTO "knowledge_documents" (
      "id", "release_id", "source_kind", "source_path", "title", "checksum",
      "route", "source_blob_id", "metadata"
    ) VALUES (
      'knowledge-doc-building', 'release-building-a', 'project_upload',
      'uploads/source.md', 'Uploaded source', repeat('6', 64), 'production',
      'blob-knowledge', '{}'::jsonb
    );

    INSERT INTO "knowledge_chunks" (
      "id", "document_id", "release_id", "sequence", "heading_path", "content", "token_count"
    ) VALUES (
      'knowledge-chunk-building', 'knowledge-doc-building', 'release-building-a', 0,
      '["Uploaded source"]'::jsonb, 'Constraint knowledge content', 3
    );

    INSERT INTO "knowledge_releases" (
      "id", "key", "workspace_id", "version", "status",
      "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension",
      "retrieval_profile_id", "retrieval_profile_spec_sha256",
      "manifest_sha256", "manifest"
    ) VALUES (
      'release-content-a', 'constraint-content', 'workspace-a', 1, 'building',
      'constraint-embedding-3-r1', repeat('d', 64), 3,
      'constraint-retrieval-r1', repeat('e', 64),
      repeat('7', 64), '{"documents":1}'::jsonb
    );

    INSERT INTO "knowledge_documents" (
      "id", "release_id", "source_kind", "source_path", "title", "checksum",
      "route", "source_blob_id", "metadata"
    ) VALUES (
      'knowledge-doc-ready', 'release-content-a', 'vault_markdown',
      '00-ready.md', 'Ready knowledge', repeat('8', 64), 'production', NULL, '{}'::jsonb
    );

    INSERT INTO "knowledge_chunks" (
      "id", "document_id", "release_id", "sequence", "heading_path", "content", "token_count"
    ) VALUES (
      'knowledge-chunk-ready', 'knowledge-doc-ready', 'release-content-a', 0,
      '["Ready knowledge"]'::jsonb, 'Immutable knowledge content', 3
    );

    INSERT INTO "knowledge_chunk_embeddings" (
      "chunk_id", "release_id", "profile_id", "profile_spec_sha256", "dimension", "embedding", "embedding_sha256"
    ) VALUES (
      'knowledge-chunk-ready', 'release-content-a', 'constraint-embedding-3-r1',
      repeat('d', 64), 3, '[1,0,0]'::public.vector, repeat('e', 64)
    );

    INSERT INTO "knowledge_embedding_batches" (
      "id", "release_id", "profile_id", "profile_spec_sha256", "dimension", "sequence",
      "chunk_ids", "input_count", "input_sha256"
    ) VALUES (
      'constraint-ready-batch', 'release-content-a', 'constraint-embedding-3-r1', repeat('d', 64), 3, 0,
      ARRAY['knowledge-chunk-ready'], 1, repeat('f', 64)
    );
    UPDATE "knowledge_embedding_batches"
    SET "status" = 'running', "attempt_count" = 1, "lease_token" = 'constraint-batch-lease',
        "queue_job_id" = 'constraint-batch-job', "queue_retry_count" = 0,
        "started_at" = clock_timestamp()
    WHERE "id" = 'constraint-ready-batch';
    UPDATE "knowledge_embedding_batches"
    SET "status" = 'ready', "lease_token" = NULL, "token_count" = 3,
        "output_sha256" = repeat('a', 64), "finished_at" = clock_timestamp()
    WHERE "id" = 'constraint-ready-batch';

    UPDATE "knowledge_releases"
    SET "status" = 'ready', "chunks_ready_at" = clock_timestamp(), "ready_at" = clock_timestamp()
    WHERE "id" = 'release-content-a';

    INSERT INTO "artifacts" (
      "id", "project_id", "kind", "title", "updated_at"
    ) VALUES
      ('artifact-a', 'project-a', 'prd', 'Artifact A', clock_timestamp()),
      ('artifact-a-other', 'project-a', 'prd', 'Artifact A Other', clock_timestamp()),
      ('artifact-b', 'project-b', 'prd', 'Artifact B', clock_timestamp()),
      ('artifact-prototype', 'project-a', 'prototype', 'Prototype Artifact', clock_timestamp()),
      ('artifact-design-a', 'project-a', 'design_system', 'Design System A', clock_timestamp()),
      ('artifact-design-b', 'project-b', 'design_system', 'Design System B', clock_timestamp()),
      (
        'artifact-design-import-target', 'project-board-test', 'design_system',
        'Imported Design System', clock_timestamp()
      );

    INSERT INTO "artifact_versions" (
      "id", "artifact_id", "project_id", "version", "schema_version", "status",
      "content", "content_blob_id", "checksum", "citations", "created_by_run_id",
      "knowledge_release_id"
    ) VALUES
      (
        'version-a-ready', 'artifact-a', 'project-a', 1, 1, 'ready',
        '{"protocol":"workbench.prd.v1","citations":[]}'::jsonb, NULL,
        repeat('a', 64), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-a-staging', 'artifact-a', 'project-a', 2, 1, 'staging',
        '{"protocol":"workbench.prd.v1","citations":[]}'::jsonb, NULL,
        repeat('b', 64), '[]'::jsonb, 'run-a', NULL
      ),
      (
        'version-a-rejected', 'artifact-a', 'project-a', 3, 1, 'rejected',
        '{"protocol":"workbench.prd.v1","citations":[]}'::jsonb, NULL,
        repeat('c', 64), '[]'::jsonb, 'run-a', NULL
      ),
      (
        'version-a-blob', 'artifact-a', 'project-a', 4, 1, 'ready',
        NULL, 'blob-ready', repeat('d', 64), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-a-release', 'artifact-a', 'project-a', 5, 1, 'ready',
        '{"protocol":"workbench.prd.v1","citations":[]}'::jsonb, NULL,
        repeat('e', 64), '[]'::jsonb, NULL, 'release-artifact-a'
      ),
      (
        'version-a-other-ready', 'artifact-a-other', 'project-a', 1, 1, 'ready',
        '{"protocol":"workbench.prd.v1","citations":[]}'::jsonb, NULL,
        repeat('f', 64), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-b-ready', 'artifact-b', 'project-b', 1, 1, 'ready',
        '{"protocol":"workbench.prd.v1","citations":[]}'::jsonb, NULL,
        repeat('9', 64), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-design-a-ready', 'artifact-design-a', 'project-a', 1, 1, 'ready',
        '{"protocol":"workbench.design-system.v1","documentId":"constraint-design-a","title":"Design System A","tokens":[],"assets":[],"principles":[],"guidelines":[],"components":[]}'::jsonb,
        NULL, repeat('1c', 32), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-design-a-staging', 'artifact-design-a', 'project-a', 2, 1, 'staging',
        '{"protocol":"workbench.design-system.v1","documentId":"constraint-design-a-staging","title":"Design System A staging","tokens":[],"assets":[],"principles":[],"guidelines":[],"components":[]}'::jsonb,
        NULL, repeat('2c', 32), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-design-b-ready', 'artifact-design-b', 'project-b', 1, 1, 'ready',
        '{"protocol":"workbench.design-system.v1","documentId":"constraint-design-b","title":"Design System B","tokens":[],"assets":[],"principles":[],"guidelines":[],"components":[]}'::jsonb,
        NULL, repeat('3c', 32), '[]'::jsonb, NULL, NULL
      ),
      (
        'version-design-import-target-ready', 'artifact-design-import-target',
        'project-board-test', 1, 1, 'ready',
        '{"protocol":"workbench.design-system.v1","documentId":"constraint-design-a","title":"Design System A","tokens":[],"assets":[],"principles":[],"guidelines":[],"components":[]}'::jsonb,
        NULL, repeat('1c', 32), '[]'::jsonb, NULL, NULL
      );

    INSERT INTO "artifact_versions" (
      "id", "artifact_id", "project_id", "version", "schema_version", "status",
      "content", "content_blob_id", "checksum", "citations", "created_by_run_id",
      "knowledge_release_id"
    ) VALUES (
      'version-prototype-ready', 'artifact-prototype', 'project-a', 1, 1, 'staging',
      '{"protocol":"workbench.prototype.v1","screens":[{"id":"screen-home"}],"assets":[{"id":"hero-image","kind":"image","name":"Hero","blobId":"blob-prototype-image","mediaType":"image/png","byteSize":128,"sha256":"abababababababababababababababababababababababababababababababab","width":320,"height":180}]}'::jsonb,
      NULL, repeat('8a', 32), '[]'::jsonb, NULL, NULL
    );

    INSERT INTO "artifact_version_assets" (
      "artifact_version_id", "artifact_id", "project_id", "asset_id", "kind",
      "blob_id", "media_type", "byte_size", "sha256", "metadata"
    ) VALUES (
      'version-prototype-ready', 'artifact-prototype', 'project-a', 'hero-image', 'image',
      'blob-prototype-image', 'image/png', 128, repeat('ab', 32),
      '{"id":"hero-image","kind":"image","name":"Hero","blobId":"blob-prototype-image","mediaType":"image/png","byteSize":128,"sha256":"abababababababababababababababababababababababababababababababab","width":320,"height":180}'::jsonb
    );

    UPDATE "artifact_versions"
    SET "status" = 'ready'
    WHERE "id" = 'version-prototype-ready';

    UPDATE "artifacts" SET "current_version_id" = 'version-a-ready' WHERE "id" = 'artifact-a';
    UPDATE "artifacts" SET "current_version_id" = 'version-a-other-ready' WHERE "id" = 'artifact-a-other';
    UPDATE "artifacts" SET "current_version_id" = 'version-b-ready' WHERE "id" = 'artifact-b';
    UPDATE "artifacts" SET "current_version_id" = 'version-prototype-ready' WHERE "id" = 'artifact-prototype';
    UPDATE "artifacts" SET "current_version_id" = 'version-design-a-ready' WHERE "id" = 'artifact-design-a';
    UPDATE "artifacts" SET "current_version_id" = 'version-design-b-ready' WHERE "id" = 'artifact-design-b';
    UPDATE "artifacts"
    SET "current_version_id" = 'version-design-import-target-ready'
    WHERE "id" = 'artifact-design-import-target';

    INSERT INTO "design_system_creations" (
      "id", "project_id", "artifact_id", "artifact_version_id", "checksum",
      "created_by_id", "idempotency_key", "request_hash"
    ) VALUES (
      'design-creation-a', 'project-a', 'artifact-design-a', 'version-design-a-ready',
      repeat('1c', 32), 'principal-a', 'constraint-design-create-a', repeat('4c', 32)
    );

    INSERT INTO "design_system_imports" (
      "id", "target_project_id", "target_artifact_id", "target_artifact_version_id",
      "source_project_id", "source_artifact_id", "source_artifact_version_id",
      "source_checksum", "created_by_id", "idempotency_key", "request_hash"
    ) VALUES (
      'design-import-a', 'project-board-test', 'artifact-design-import-target',
      'version-design-import-target-ready', 'project-a', 'artifact-design-a',
      'version-design-a-ready', repeat('1c', 32), 'principal-a',
      'constraint-design-import-a', repeat('5c', 32)
    );

    INSERT INTO "boards" (
      "id", "project_id", "revision", "viewport", "updated_at"
    ) VALUES
      ('board-a', 'project-a', 0, '{"x":0,"y":0,"zoom":1}'::jsonb, clock_timestamp()),
      ('board-b', 'project-b', 0, '{"x":0,"y":0,"zoom":1}'::jsonb, clock_timestamp());

    INSERT INTO "board_nodes" (
      "id", "board_id", "project_id", "node_key", "sort_order", "kind", "position", "size",
      "artifact_id", "artifact_version_id", "data"
    ) VALUES
      (
        'node-a-left', 'board-a', 'project-a', 'left', 0, 'frame', '{"x":0,"y":0}'::jsonb,
        '{"width":120,"height":100}'::jsonb, NULL, NULL,
        '{"protocol":"workbench.board-node.v1","nodeType":"frame","title":"Left frame","fill":null,"stroke":"#5f6368"}'::jsonb
      ),
      (
        'node-a-right', 'board-a', 'project-a', 'right', 1, 'artifact', '{"x":200,"y":0}'::jsonb,
        NULL, 'artifact-a', 'version-a-ready',
        '{"protocol":"workbench.board-node.v1","nodeType":"artifact","title":"Ready artifact","artifactKind":"data"}'::jsonb
      ),
      (
        'node-b-left', 'board-b', 'project-b', 'left', 0, 'frame', '{"x":0,"y":0}'::jsonb,
        '{"width":120,"height":100}'::jsonb, NULL, NULL,
        '{"protocol":"workbench.board-node.v1","nodeType":"frame","title":"Left frame","fill":null,"stroke":"#5f6368"}'::jsonb
      );

    INSERT INTO "board_edges" (
      "id", "board_id", "edge_key", "source_node_key", "target_node_key", "kind", "data"
    ) VALUES
      ('edge-a', 'board-a', 'left-to-right', 'left', 'right', 'flow', '{}'::jsonb);

    INSERT INTO "project_releases" (
      "id", "project_id", "version", "status", "created_by_id", "idempotency_key", "request_hash", "board_id",
      "board_revision", "board_snapshot", "board_checksum", "manifest",
      "manifest_sha256", "updated_at"
    ) VALUES
      (
        'project-release-ready-a', 'project-a', 1, 'building', 'principal-a', 'constraint-release-ready-a', repeat('a1', 32), 'board-a',
        (SELECT "revision" FROM "boards" WHERE "id" = 'board-a'),
        '{"protocol":"workbench.board-snapshot.v1","nodes":2,"edges":1}'::jsonb,
        repeat('1a', 32),
        '{"protocol":"workbench.project-release.v1","artifactCount":1}'::jsonb,
        repeat('2a', 32), clock_timestamp()
      ),
      (
        'project-release-building-a', 'project-a', 2, 'building', 'principal-a', 'constraint-release-building-a', repeat('a2', 32), 'board-a',
        (SELECT "revision" FROM "boards" WHERE "id" = 'board-a'),
        '{"protocol":"workbench.board-snapshot.v1","nodes":2,"edges":1}'::jsonb,
        repeat('3a', 32),
        '{"protocol":"workbench.project-release.v1","artifactCount":0}'::jsonb,
        repeat('4a', 32), clock_timestamp()
      ),
      (
        'project-release-ready-b', 'project-b', 1, 'building', 'principal-b', 'constraint-release-ready-b', repeat('b1', 32), 'board-b',
        (SELECT "revision" FROM "boards" WHERE "id" = 'board-b'),
        '{"protocol":"workbench.board-snapshot.v1","nodes":1,"edges":0}'::jsonb,
        repeat('1b', 32),
        '{"protocol":"workbench.project-release.v1","artifactCount":1}'::jsonb,
        repeat('2b', 32), clock_timestamp()
      );

    INSERT INTO "release_artifact_versions" (
      "release_id", "project_id", "position", "artifact_id", "artifact_version_id", "title", "kind"
    ) VALUES
      ('project-release-ready-a', 'project-a', 0, 'artifact-a', 'version-a-ready', 'Artifact A', 'prd'),
      ('project-release-ready-a', 'project-a', 1, 'artifact-prototype', 'version-prototype-ready', 'Prototype Artifact', 'prototype'),
      ('project-release-building-a', 'project-a', 0, 'artifact-prototype', 'version-prototype-ready', 'Prototype Artifact', 'prototype'),
      ('project-release-ready-b', 'project-b', 0, 'artifact-b', 'version-b-ready', 'Artifact B', 'prd');

    UPDATE "project_releases"
    SET "status" = 'ready', "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" IN ('project-release-ready-a', 'project-release-ready-b');

    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
  `);
}

async function runConstraintChecks(db) {
  console.log("[constraints] exercising PostgreSQL rejection paths");

  await expectReject(db, "Project member cannot cross Workspace identity", async () => {
    await db.query(`
      INSERT INTO "project_members" (
        "project_id", "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES ('project-a', 'workspace-b', 'principal-b', 'viewer', clock_timestamp())
    `);
  }, constraint("23503", "project_members_project_id_workspace_id_fkey"));

  await expectReject(db, "Project member cannot move the last owner to another Project", async () => {
    await db.query(`
      INSERT INTO "workspace_members" (
        "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES ('workspace-a', 'principal-b', 'member', clock_timestamp());
      INSERT INTO "projects" (
        "id", "workspace_id", "created_by_id", "title", "updated_at"
      ) VALUES (
        'project-owner-move-target', 'workspace-a', 'principal-b',
        'Owner move target', clock_timestamp()
      );
      INSERT INTO "project_members" (
        "project_id", "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES (
        'project-owner-move-target', 'workspace-a', 'principal-b', 'owner', clock_timestamp()
      );
      UPDATE "project_members"
      SET "project_id" = 'project-owner-move-target', "updated_at" = clock_timestamp()
      WHERE "project_id" = 'project-a' AND "principal_id" = 'principal-a'
    `);
  }, trigger("23514", "PROJECT_MEMBER_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Project member Workspace identity is immutable", async () => {
    await db.query(`
      UPDATE "project_members"
      SET "workspace_id" = 'workspace-b', "updated_at" = clock_timestamp()
      WHERE "project_id" = 'project-a' AND "principal_id" = 'principal-a'
    `);
  }, trigger("23514", "PROJECT_MEMBER_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Project cannot lose its last owner", async () => {
    await db.query(`
      DELETE FROM "project_members"
      WHERE "project_id" = 'project-a' AND "principal_id" = 'principal-a'
    `);
  }, trigger("23514", "PROJECT_OWNER_REQUIRED"));

  await expectReject(db, "Project creation requires an owner in the same transaction", async () => {
    await db.query(`
      INSERT INTO "projects" (
        "id", "workspace_id", "created_by_id", "title", "updated_at"
      ) VALUES (
        'candidate-ownerless-project', 'workspace-a', 'principal-a',
        'Ownerless candidate', clock_timestamp()
      )
    `);
  }, trigger("23514", "PROJECT_OWNER_REQUIRED"));

  await expectAccept(db, "Project ownership can transfer atomically", async () => {
    await db.query(`
      INSERT INTO "workspace_members" (
        "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES ('workspace-a', 'principal-b', 'member', clock_timestamp());
      INSERT INTO "project_members" (
        "project_id", "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES ('project-a', 'workspace-a', 'principal-b', 'owner', clock_timestamp());
      UPDATE "project_members"
      SET "role" = 'viewer', "updated_at" = clock_timestamp()
      WHERE "project_id" = 'project-a' AND "principal_id" = 'principal-a';
    `);
  });

  await expectReject(db, "Project duplicate actor must belong to the receipt Workspace", async () => {
    await db.query(`
      INSERT INTO "project_duplicates" (
        "target_project_id", "source_project_id", "workspace_id", "created_by_id",
        "idempotency_key", "request_hash"
      ) VALUES (
        'project-a', 'project-board-test', 'workspace-a', 'principal-b',
        'duplicate-invalid-actor', repeat('8', 64)
      )
    `);
  }, trigger("23503", "PROJECT_DUPLICATE_ACTOR_NOT_WORKSPACE_MEMBER"));

  await expectAccept(db, "Project duplicate receipt does not block later Workspace departure", async () => {
    await db.query(`
      INSERT INTO "principals" (
        "id", "issuer", "subject", "updated_at"
      ) VALUES (
        'principal-duplicate-actor', 'constraint-test',
        'principal-duplicate-actor', clock_timestamp()
      );
      INSERT INTO "workspace_members" (
        "workspace_id", "principal_id", "role", "updated_at"
      ) VALUES (
        'workspace-a', 'principal-duplicate-actor', 'member', clock_timestamp()
      );
      INSERT INTO "project_duplicates" (
        "target_project_id", "source_project_id", "workspace_id", "created_by_id",
        "idempotency_key", "request_hash"
      ) VALUES (
        'project-a', 'project-board-test', 'workspace-a', 'principal-duplicate-actor',
        'duplicate-departed-actor', repeat('6', 64)
      );
      DELETE FROM "workspace_members"
      WHERE "workspace_id" = 'workspace-a'
        AND "principal_id" = 'principal-duplicate-actor';
    `);
  });

  await expectReject(db, "Project duplicate receipt is immutable", async () => {
    await db.query(`
      UPDATE "project_duplicates"
      SET "request_hash" = repeat('7', 64)
      WHERE "target_project_id" = 'project-board-test'
    `);
  }, trigger("23514", "PROJECT_DUPLICATE_RECEIPT_IMMUTABLE"));

  await expectReject(db, "Artifact currentVersion cannot cross Artifact identity", async () => {
    await db.query(`UPDATE "artifacts" SET "current_version_id" = 'version-a-other-ready' WHERE "id" = 'artifact-a'`);
  }, trigger("23514", "ARTIFACT_CURRENT_VERSION_NOT_READY"));

  await expectReject(db, "Artifact currentVersion must be ready", async () => {
    await db.query(`UPDATE "artifacts" SET "current_version_id" = 'version-a-staging' WHERE "id" = 'artifact-a'`);
  }, trigger("23514", "ARTIFACT_CURRENT_VERSION_NOT_READY"));

  await expectReject(db, "Artifact currentVersion cannot point to a rejected version", async () => {
    await db.query(`UPDATE "artifacts" SET "current_version_id" = 'version-a-rejected' WHERE "id" = 'artifact-a'`);
  }, trigger("23514", "ARTIFACT_CURRENT_VERSION_NOT_READY"));

  await expectReject(db, "ArtifactVersion cannot have neither inline content nor Blob", async () => {
    await insertVersion(db, { content: null, contentBlobId: null });
  }, constraint("23514", "artifact_versions_content_xor_blob_check"));

  await expectReject(db, "ArtifactVersion cannot have both inline content and Blob", async () => {
    await insertVersion(db, { contentBlobId: "blob-ready" });
  }, constraint("23514", "artifact_versions_content_xor_blob_check"));

  await expectReject(db, "ArtifactVersion version must be positive", async () => {
    await insertVersion(db, { version: 0 });
  }, constraint("23514", "artifact_versions_version_positive_check"));

  await expectAccept(db, "ArtifactVersion accepts the PRD v1 schema and protocol pair", async () => {
    await insertVersion(db);
  });

  await expectAccept(db, "ArtifactVersion accepts the PRD v2 schema and protocol pair", async () => {
    await insertVersion(db, {
      schemaVersion: 2,
      content: { protocol: "workbench.prd.v2", citations: [] },
    });
  });

  await expectReject(db, "ArtifactVersion rejects PRD schema v1 with protocol v2", async () => {
    await insertVersion(db, {
      content: { protocol: "workbench.prd.v2", citations: [] },
    });
  }, trigger("23514", "ARTIFACT_INLINE_IR_ENVELOPE_INVALID"));

  await expectReject(db, "ArtifactVersion rejects PRD schema v2 with protocol v1", async () => {
    await insertVersion(db, { schemaVersion: 2 });
  }, trigger("23514", "ARTIFACT_INLINE_IR_ENVELOPE_INVALID"));

  await expectReject(db, "ArtifactVersion rejects an unsupported PRD schema version", async () => {
    await insertVersion(db, {
      schemaVersion: 3,
      content: { protocol: "workbench.prd.v2", citations: [] },
    });
  }, trigger("23514", "ARTIFACT_SCHEMA_VERSION_INVALID"));

  await expectReject(db, "ArtifactVersion rejects a PRD document with a missing protocol", async () => {
    await insertVersion(db, {
      schemaVersion: 2,
      content: { citations: [] },
    });
  }, trigger("23514", "ARTIFACT_INLINE_IR_ENVELOPE_INVALID"));

  await expectReject(db, "ArtifactVersion rejects a PRD document with a null protocol", async () => {
    await insertVersion(db, {
      schemaVersion: 2,
      content: { protocol: null, citations: [] },
    });
  }, trigger("23514", "ARTIFACT_INLINE_IR_ENVELOPE_INVALID"));

  await expectReject(db, "ArtifactVersion rejects a scalar PRD document", async () => {
    await insertVersion(db, {
      schemaVersion: 2,
      content: "workbench.prd.v2",
    });
  }, trigger("23514", "ARTIFACT_INLINE_IR_ENVELOPE_INVALID"));

  await expectReject(db, "Prototype ArtifactVersion remains schema v1 only", async () => {
    await insertVersion(db, {
      artifactId: "artifact-prototype",
      schemaVersion: 2,
      content: { protocol: "workbench.prototype.v1", assets: [] },
    });
  }, trigger("23514", "ARTIFACT_SCHEMA_VERSION_INVALID"));

  await expectReject(db, "Design System ArtifactVersion remains schema v1 only", async () => {
    await insertVersion(db, {
      artifactId: "artifact-design-a",
      schemaVersion: 2,
      content: designSystemDocumentFixture(),
      createdByRunId: null,
    });
  }, trigger("23514", "ARTIFACT_SCHEMA_VERSION_INVALID"));

  await expectAccept(db, "ArtifactVersion edit receipt accepts PRD v1 continuity", async () => {
    await insertPrdEditReceiptCandidate(db, {
      baseSchemaVersion: 1,
      resultSchemaVersion: 1,
    });
  });

  await expectAccept(db, "ArtifactVersion edit receipt accepts PRD v2 continuity", async () => {
    await insertPrdEditReceiptCandidate(db, {
      baseSchemaVersion: 2,
      resultSchemaVersion: 2,
    });
  });

  await expectReject(db, "ArtifactVersion edit receipt rejects PRD v1 to v2 conversion", async () => {
    await insertPrdEditReceiptCandidate(db, {
      baseSchemaVersion: 1,
      resultSchemaVersion: 2,
    });
  }, trigger("23514", "ARTIFACT_VERSION_EDIT_RECEIPT_RESULT_INVALID"));

  await expectReject(db, "ArtifactVersion edit receipt rejects PRD v2 to v1 conversion", async () => {
    await insertPrdEditReceiptCandidate(db, {
      baseSchemaVersion: 2,
      resultSchemaVersion: 1,
    });
  }, trigger("23514", "ARTIFACT_VERSION_EDIT_RECEIPT_RESULT_INVALID"));

  await expectReject(db, "ArtifactVersion checksum must be lowercase SHA-256", async () => {
    await insertVersion(db, { checksum: "not-a-sha256" });
  }, constraint("23514", "artifact_versions_checksum_format_check"));

  await expectReject(db, "ArtifactVersion citations must satisfy the citation envelope", async () => {
    await insertVersion(db, {
      content: { protocol: "workbench.prd.v1", citations: {} },
      citations: {},
    });
  }, constraint("23514", "artifact_versions_citations_check"));

  await expectReject(db, "ArtifactVersion inline protocol must match Artifact kind", async () => {
    await insertVersion(db, {
      content: { protocol: "workbench.prototype.v1", citations: [] },
    });
  }, trigger("23514", "ARTIFACT_INLINE_IR_ENVELOPE_INVALID"));

  await expectReject(db, "ArtifactVersion project must match its Artifact", async () => {
    await insertVersion(db, {
      artifactId: "artifact-a",
      projectId: "project-b",
      createdByRunId: null,
    });
  }, trigger("23503", "ARTIFACT_VERSION_OWNER_INVALID"));

  await expectReject(db, "ArtifactVersion createdByRun must belong to the same Project", async () => {
    await insertVersion(db, { createdByRunId: "run-b" });
  }, constraint("23503", "artifact_versions_created_by_run_id_project_id_fkey"));

  await expectReject(db, "ready ArtifactVersion is immutable", async () => {
    await db.query(`UPDATE "artifact_versions" SET "checksum" = repeat('0', 64) WHERE "id" = 'version-a-ready'`);
  }, trigger("23514", "ARTIFACT_TERMINAL_VERSION_IMMUTABLE"));

  await expectReject(db, "rejected ArtifactVersion is immutable", async () => {
    await db.query(`UPDATE "artifact_versions" SET "status" = 'staging' WHERE "id" = 'version-a-rejected'`);
  }, trigger("23514", "ARTIFACT_TERMINAL_VERSION_IMMUTABLE"));

  await expectReject(db, "ready ArtifactVersion cannot use a pending Blob", async () => {
    await insertVersion(db, {
      status: "ready",
      content: null,
      contentBlobId: "blob-pending",
    });
  }, trigger("23514", "ARTIFACT_READY_CONTENT_BLOB_INVALID"));

  await expectReject(db, "ready ArtifactVersion cannot use an empty Blob", async () => {
    await insertVersion(db, {
      status: "ready",
      content: null,
      contentBlobId: "blob-empty",
    });
  }, trigger("23514", "ARTIFACT_READY_CONTENT_BLOB_INVALID"));

  await expectReject(db, "published Blob cannot be soft-deleted", async () => {
    await db.query(`
      UPDATE "blobs"
      SET "status" = 'deleted', "deleted_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'blob-ready'
    `);
  }, trigger("23503", "BLOB_REFERENCED_BY_READY_ARTIFACT"));

  await expectReject(db, "published Blob cannot be hard-deleted", async () => {
    await db.query(`DELETE FROM "blobs" WHERE "id" = 'blob-ready'`);
  }, constraint("23503", "artifact_versions_content_blob_id_fkey"));

  await expectAccept(db, "Prototype ArtifactVersion publishes only after pinning its exact binary assets", async () => {
    await insertPrototypeCandidate(db);
    const result = await db.query(`
      SELECT version."status", pin."asset_id", pin."blob_id"
      FROM "artifact_versions" AS version
      JOIN "artifact_version_assets" AS pin ON pin."artifact_version_id" = version."id"
      WHERE version."id" = 'candidate-prototype-version'
    `);
    assert.deepEqual(result.rows[0], {
      status: "ready",
      asset_id: "candidate-image",
      blob_id: "blob-prototype-image",
    });
  });

  await expectReject(db, "ready Prototype ArtifactVersion cannot omit a binary asset pin", async () => {
    await insertPrototypeCandidate(db, { pin: false });
  }, trigger("23514", "PROTOTYPE_ASSET_PIN_MISMATCH"));

  await expectReject(db, "ready Prototype ArtifactVersion rejects asset metadata drift", async () => {
    await insertPrototypeCandidate(db, {
      metadata: {
        id: "candidate-image",
        kind: "image",
        name: "Tampered image",
        blobId: "blob-prototype-image",
        mediaType: "image/png",
        byteSize: 128,
        sha256: "ab".repeat(32),
        width: 320,
        height: 180,
      },
    });
  }, trigger("23514", "PROTOTYPE_ASSET_PIN_MISMATCH"));

  await expectReject(db, "Prototype asset pin cannot reference a pending Blob", async () => {
    await insertPrototypeCandidate(db, {
      pinBlobId: "blob-pending",
      pinMediaType: "application/json",
      pinByteSize: 16,
      pinSha256: "7".repeat(64),
      finalize: false,
    });
  }, trigger("23514", "ARTIFACT_VERSION_ASSET_BLOB_NOT_READY"));

  await expectReject(db, "ready Prototype ArtifactVersion cannot accept another asset pin", async () => {
    await db.query(`
      INSERT INTO "artifact_version_assets" (
        "artifact_version_id", "artifact_id", "project_id", "asset_id", "kind",
        "blob_id", "media_type", "byte_size", "sha256", "metadata"
      ) VALUES (
        'version-prototype-ready', 'artifact-prototype', 'project-a', 'late-image', 'image',
        'blob-prototype-image', 'image/png', 128, repeat('ab', 32), '{}'::jsonb
      )
    `);
  }, trigger("23514", "ARTIFACT_VERSION_ASSET_OWNER_NOT_STAGING"));

  await expectReject(db, "ready Prototype asset pin cannot be updated", async () => {
    await db.query(`
      UPDATE "artifact_version_assets" SET "asset_id" = 'changed-image'
      WHERE "artifact_version_id" = 'version-prototype-ready' AND "asset_id" = 'hero-image'
    `);
  }, trigger("23514", "ARTIFACT_VERSION_ASSET_IMMUTABLE"));

  await expectReject(db, "ready Prototype asset pin cannot be deleted", async () => {
    await db.query(`
      DELETE FROM "artifact_version_assets"
      WHERE "artifact_version_id" = 'version-prototype-ready' AND "asset_id" = 'hero-image'
    `);
  }, trigger("23514", "ARTIFACT_VERSION_ASSET_OWNER_NOT_STAGING"));

  await expectReject(db, "published Prototype asset Blob cannot be soft-deleted", async () => {
    await softDeleteBlob(db, "blob-prototype-image");
  }, trigger("23503", "BLOB_REFERENCED_BY_READY_ARTIFACT"));

  await expectReject(db, "published Prototype asset Blob cannot be hard-deleted", async () => {
    await db.query(`DELETE FROM "blobs" WHERE "id" = 'blob-prototype-image'`);
  }, constraint("23503", "artifact_version_assets_blob_fkey"));

  await expectReject(db, "ready Design System requires an assets array", async () => {
    await insertDesignSystemCandidate(db, {
      document: designSystemDocumentFixture({ assets: { forged: true } }),
    });
  }, trigger("23514", "DESIGN_SYSTEM_ASSET_MANIFEST_INVALID"));

  await expectReject(db, "ready Design System rejects scalar asset entries", async () => {
    await insertDesignSystemCandidate(db, {
      document: designSystemDocumentFixture({ assets: ["forged"] }),
    });
  }, trigger("23514", "DESIGN_SYSTEM_ASSET_PIN_MISMATCH"));

  await expectReject(db, "ready Design System rejects unknown asset kinds", async () => {
    await insertDesignSystemCandidate(db, {
      document: designSystemDocumentFixture({
        assets: [{ id: "forged-asset", kind: "scalar" }],
      }),
    });
  }, trigger("23514", "DESIGN_SYSTEM_ASSET_PIN_MISMATCH"));

  await expectReject(db, "ready Design System image assets require exact binary pins", async () => {
    await insertDesignSystemCandidate(db, {
      document: designSystemDocumentFixture({
        assets: [{
          id: "design-image",
          kind: "image",
          name: "Design image",
          blobId: "blob-prototype-image",
          mediaType: "image/png",
          byteSize: 128,
          sha256: "ab".repeat(32),
          width: 320,
          height: 180,
        }],
      }),
    });
  }, trigger("23514", "DESIGN_SYSTEM_ASSET_PIN_MISMATCH"));

  await expectReject(db, "ready Design System font assets require exact binary pins", async () => {
    await insertDesignSystemCandidate(db, {
      document: designSystemDocumentFixture({
        assets: [{
          id: "design-font",
          kind: "font",
          name: "Design font",
          blobId: "blob-ready",
          mediaType: "font/woff2",
          byteSize: 16,
          sha256: "6".repeat(64),
          family: "Constraint Sans",
          weight: 400,
          style: "normal",
        }],
      }),
    });
  }, trigger("23514", "DESIGN_SYSTEM_ASSET_PIN_MISMATCH"));

  await expectReject(db, "Design System creation receipt cannot be updated", async () => {
    await db.query(`
      UPDATE "design_system_creations"
      SET "checksum" = repeat('f', 64)
      WHERE "id" = 'design-creation-a'
    `);
  }, trigger("23514", "DESIGN_SYSTEM_CREATION_RECEIPT_IMMUTABLE"));

  await expectReject(db, "Design System creation receipt cannot be deleted", async () => {
    await db.query(`DELETE FROM "design_system_creations" WHERE "id" = 'design-creation-a'`);
  }, trigger("23514", "DESIGN_SYSTEM_CREATION_RECEIPT_IMMUTABLE"));

  await expectReject(db, "Design System import receipt cannot be updated", async () => {
    await db.query(`
      UPDATE "design_system_imports"
      SET "source_checksum" = repeat('f', 64)
      WHERE "id" = 'design-import-a'
    `);
  }, trigger("23514", "DESIGN_SYSTEM_IMPORT_RECEIPT_IMMUTABLE"));

  await expectReject(db, "Design System import receipt cannot be deleted", async () => {
    await db.query(`DELETE FROM "design_system_imports" WHERE "id" = 'design-import-a'`);
  }, trigger("23514", "DESIGN_SYSTEM_IMPORT_RECEIPT_IMMUTABLE"));

  await expectReject(db, "ready ArtifactVersion cannot use a building KnowledgeRelease", async () => {
    await insertVersion(db, {
      status: "ready",
      knowledgeReleaseId: "release-building-a",
    });
  }, trigger("23514", "ARTIFACT_READY_KNOWLEDGE_RELEASE_INVALID"));

  await expectReject(db, "ready ArtifactVersion cannot use another Workspace KnowledgeRelease", async () => {
    await insertVersion(db, {
      status: "ready",
      knowledgeReleaseId: "release-ready-b",
    });
  }, trigger("23514", "ARTIFACT_READY_KNOWLEDGE_RELEASE_INVALID"));

  await expectAccept(db, "ready ArtifactVersion may use a global KnowledgeRelease", async () => {
    await insertVersion(db, {
      status: "ready",
      knowledgeReleaseId: "release-global",
    });
  });

  await expectAccept(db, "ready ArtifactVersion may preserve a retired KnowledgeRelease snapshot", async () => {
    await insertVersion(db, {
      status: "ready",
      knowledgeReleaseId: "release-retired-a",
    });
  });

  await expectAccept(db, "published KnowledgeRelease may retire without losing provenance", async () => {
    await db.query(`UPDATE "knowledge_releases" SET "status" = 'retired' WHERE "id" = 'release-artifact-a'`);
  });

  await expectReject(db, "published KnowledgeRelease cannot become invalid", async () => {
    await db.query(`UPDATE "knowledge_releases" SET "status" = 'failed' WHERE "id" = 'release-artifact-a'`);
  }, trigger("23503", "KNOWLEDGE_RELEASE_REFERENCED_BY_READY_ARTIFACT"));

  await expectReject(db, "published KnowledgeRelease Workspace scope cannot change", async () => {
    await db.query(`UPDATE "knowledge_releases" SET "workspace_id" = 'workspace-b' WHERE "id" = 'release-artifact-a'`);
  }, trigger("23503", "KNOWLEDGE_RELEASE_REFERENCED_BY_READY_ARTIFACT"));

  await expectReject(db, "published KnowledgeRelease cannot be hard-deleted", async () => {
    await db.query(`DELETE FROM "knowledge_releases" WHERE "id" = 'release-artifact-a'`);
  }, trigger("23514", "KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE"));

  await expectReject(db, "Run Project must match its Thread", async () => {
    await insertRun(db, { projectId: "project-a", threadId: "thread-b" });
  }, constraint("23503", "runs_thread_id_project_id_fkey"));

  await expectReject(db, "Run cannot use a building KnowledgeRelease", async () => {
    await insertRun(db, { knowledgeReleaseId: "release-building-a" });
  }, trigger("23514", "RUN_KNOWLEDGE_SCOPE_INVALID"));

  await expectReject(db, "Run cannot use another Workspace KnowledgeRelease", async () => {
    await insertRun(db, { knowledgeReleaseId: "release-ready-b" });
  }, trigger("23514", "RUN_KNOWLEDGE_RELEASE_INVALID"));

  await expectReject(db, "New Run cannot select a retired KnowledgeRelease", async () => {
    await insertRun(db, { knowledgeReleaseId: "release-retired-a" });
  }, trigger("23514", "RUN_KNOWLEDGE_SCOPE_INVALID"));

  await expectReject(db, "New Run requires a KnowledgeRelease", async () => {
    await insertRun(db, { knowledgeReleaseId: null });
  }, trigger("23514", "KNOWLEDGE_RELEASE_REQUIRED"));

  await expectReject(db, "New Run cannot skip retrieval by starting succeeded", async () => {
    await insertRun(db, { status: "succeeded" });
  }, trigger("23514", "KNOWLEDGE_RETRIEVAL_REQUIRED"));

  await expectReject(db, "Run request model must match the normalized model column", async () => {
    await insertRun(db, { request: typedRunRequest({ modelId: "forged-model" }) });
  }, constraint("23514", "runs_typed_options_check"));

  await expectReject(db, "Run requires a typed workflow", async () => {
    await insertRun(db, { request: typedRunRequest({ workflow: "unknown" }) });
  }, constraint("23514", "runs_typed_options_check"));

  await expectReject(db, "Redesign Run requires an Import Source", async () => {
    await insertRun(db, { request: typedRunRequest({ workflow: "redesign" }) });
  }, constraint("23514", "runs_typed_options_check"));

  await expectAccept(db, "Run persists an exact authoritative preset snapshot", async () => {
    const preset = designPresetSnapshotFixture();
    await insertRun(db, {
      designStyleSnapshot: preset.snapshot,
      designStyleSnapshotSha256: "5c".repeat(32),
      request: typedRunRequest({ designStyle: preset.reference }),
    });
  });

  await expectReject(db, "Run rejects the obsolete presetId-only style shape", async () => {
    await insertRun(db, {
      request: typedRunRequest({ designStyle: { kind: "preset", presetId: "workbench.bauhaus" } }),
    });
  }, constraint("23514", "runs_typed_options_check"));

  await expectReject(db, "Run rejects a preset snapshot that does not match its request reference", async () => {
    const preset = designPresetSnapshotFixture();
    await insertRun(db, {
      designStyleSnapshot: {
        ...preset.snapshot,
        source: { ...preset.snapshot.source, checksum: "0".repeat(64) },
      },
      designStyleSnapshotSha256: "5d".repeat(32),
      request: typedRunRequest({ designStyle: preset.reference }),
    });
  }, constraint("23514", "runs_typed_options_check"));

  await expectAccept(db, "Run pins a ready same-Project design-system version", async () => {
    await insertRun(db, {
      designStyleArtifactVersionId: "version-design-a-ready",
      designStyleSnapshot: designStyleSnapshotFixture({
        artifactId: "artifact-design-a",
        artifactVersionId: "version-design-a-ready",
        checksum: "1c".repeat(32),
      }),
      designStyleSnapshotSha256: "6c".repeat(32),
      request: typedRunRequest({
        designStyle: { kind: "artifact", artifactVersionId: "version-design-a-ready" },
      }),
    });
  });

  await expectReject(db, "Run rejects a staging design-system version", async () => {
    await insertRun(db, {
      designStyleArtifactVersionId: "version-design-a-staging",
      designStyleSnapshot: designStyleSnapshotFixture({
        artifactId: "artifact-design-a",
        artifactVersionId: "version-design-a-staging",
        checksum: "2c".repeat(32),
        documentId: "constraint-design-a-staging",
        title: "Design System A staging",
      }),
      designStyleSnapshotSha256: "7c".repeat(32),
      request: typedRunRequest({
        designStyle: { kind: "artifact", artifactVersionId: "version-design-a-staging" },
      }),
    });
  }, trigger("23514", "RUN_DESIGN_STYLE_INVALID"));

  await expectReject(db, "Run rejects another Project design-system version", async () => {
    await insertRun(db, {
      designStyleArtifactVersionId: "version-design-b-ready",
      designStyleSnapshot: designStyleSnapshotFixture({
        projectId: "project-b",
        artifactId: "artifact-design-b",
        artifactVersionId: "version-design-b-ready",
        checksum: "3c".repeat(32),
        documentId: "constraint-design-b",
        title: "Design System B",
      }),
      designStyleSnapshotSha256: "8c".repeat(32),
      request: typedRunRequest({
        designStyle: { kind: "artifact", artifactVersionId: "version-design-b-ready" },
      }),
    });
  }, trigger("23514", "RUN_DESIGN_STYLE_INVALID"));

  await expectReject(db, "Run rejects a forged Design System materialized snapshot", async () => {
    await insertRun(db, {
      designStyleArtifactVersionId: "version-design-a-ready",
      designStyleSnapshot: designStyleSnapshotFixture({
        artifactId: "artifact-design-a",
        artifactVersionId: "forged-version",
        checksum: "1c".repeat(32),
      }),
      designStyleSnapshotSha256: "9c".repeat(32),
      request: typedRunRequest({
        designStyle: { kind: "artifact", artifactVersionId: "version-design-a-ready" },
      }),
    });
  }, trigger("23514", "RUN_DESIGN_STYLE_INVALID"));

  await expectAccept(db, "Run may use a global ready KnowledgeRelease", async () => {
    await insertRun(db, { knowledgeReleaseId: "release-global" });
  });

  await expectAccept(db, "Run retry records same-Thread lineage from an exact retryable source request", async () => {
    await insertRun(db, {
      threadId: "thread-retry-a",
      retryOfRunId: "run-retry-source",
      request: typedRunRequest({ prompt: "Retry source" }),
      status: "queued",
    });
  });

  await expectReject(db, "Run retry rejects a source marked non-retryable", async () => {
    await insertRun(db, {
      threadId: "thread-retry-a",
      retryOfRunId: "run-nonretry-source",
      request: typedRunRequest({ prompt: "Non-retry source" }),
      status: "queued",
    });
  }, trigger("23514", "RUN_RETRY_SOURCE_INVALID"));

  await expectReject(db, "Run retry rejects request drift from its source", async () => {
    await insertRun(db, {
      threadId: "thread-retry-a",
      retryOfRunId: "run-retry-source",
      request: typedRunRequest({ prompt: "Changed client prompt" }),
      status: "queued",
    });
  }, trigger("23514", "RUN_RETRY_SOURCE_INVALID"));

  await expectReject(db, "Run retry cannot cross Thread ownership", async () => {
    await insertRun(db, {
      retryOfRunId: "run-retry-source",
      request: typedRunRequest({ prompt: "Retry source" }),
      status: "queued",
    });
  }, trigger("23514", "RUN_RETRY_SOURCE_INVALID"));

  await expectReject(db, "Run retry lineage is immutable", async () => {
    await insertRun(db, {
      threadId: "thread-retry-a",
      retryOfRunId: "run-retry-source",
      request: typedRunRequest({ prompt: "Retry source" }),
      status: "queued",
    });
    await db.query(`UPDATE "runs" SET "retry_of_run_id" = NULL WHERE "id" = 'candidate-run'`);
  }, trigger("23514", "RUN_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Run identity is immutable", async () => {
    await db.query(`UPDATE "runs" SET "model_id" = 'changed-model' WHERE "id" = 'run-a'`);
  }, trigger("23514", "RUN_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Run KnowledgeRelease snapshot is immutable", async () => {
    await db.query(`UPDATE "runs" SET "knowledge_release_id" = 'release-global' WHERE "id" = 'run-a'`);
  }, trigger("23514", "RUN_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Run design-style snapshot is immutable", async () => {
    await db.query(`UPDATE "runs" SET "design_style_snapshot" = '{}'::jsonb WHERE "id" = 'run-a'`);
  }, trigger("23514", "RUN_IDENTITY_IMMUTABLE"));

  await expectAccept(db, "RuntimeAttempt follows the durable submission lifecycle", async () => {
    await insertRuntimeAttempt(db);
    await beginRuntimeSubmission(db, "candidate-runtime-attempt");
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'running', "external_run_id" = 'external-run-a', "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "last_external_event_id" = 'event-42', "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'succeeded', "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
    const result = await db.query(`
      SELECT "status", "external_run_id", "last_external_event_id"
      FROM "runtime_attempts" WHERE "id" = 'candidate-runtime-attempt'
    `);
    assert.deepEqual(result.rows[0], {
      status: "succeeded",
      external_run_id: "external-run-a",
      last_external_event_id: "event-42",
    });
  });

  await expectReject(db, "RuntimeAttempt must start pending without an external Run", async () => {
    await insertRuntimeAttempt(db, {
      status: "running",
      externalRunId: "forged-external-run",
      startedAt: new Date(),
    });
  }, trigger("23514", "RUNTIME_ATTEMPT_MUST_START_PENDING"));

  await expectReject(db, "RuntimeAttempt must use its Run Thread binding", async () => {
    await insertRuntimeAttempt(db, {
      runtimeBindingId: "runtime-binding-b",
      externalThreadId: "external-thread-b",
    });
  }, trigger("23514", "RUNTIME_ATTEMPT_BINDING_INVALID"));

  await expectReject(db, "RuntimeAttempt cannot skip the submitting fence", async () => {
    await insertRuntimeAttempt(db);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'running', "external_run_id" = 'external-run-a',
          "started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
  }, trigger("23514", "RUNTIME_ATTEMPT_STATUS_TRANSITION_INVALID"));

  await expectReject(db, "RuntimeAttempt submitting state requires a provider idempotency key", async () => {
    await insertRuntimeAttempt(db);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'submitting', "started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
  }, constraint("23514", "runtime_attempts_provider_idempotency_state_check"));

  await expectReject(db, "RuntimeAttempt external Run binding is immutable", async () => {
    await insertRunningRuntimeAttempt(db);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "external_run_id" = 'external-run-forged', "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
  }, trigger("23514", "RUNTIME_ATTEMPT_EXTERNAL_RUN_IMMUTABLE"));

  await expectReject(db, "One external Run cannot bind two RuntimeAttempts", async () => {
    await insertRunningRuntimeAttempt(db, { externalRunId: "external-run-shared" });
    await insertRuntimeAttempt(db, {
      id: "candidate-runtime-attempt-b",
      runId: "run-b",
      runtimeBindingId: "runtime-binding-b",
      externalThreadId: "external-thread-b",
    });
    await beginRuntimeSubmission(db, "candidate-runtime-attempt-b");
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'running', "external_run_id" = 'external-run-shared', "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt-b'
    `);
  }, constraint("23505", "runtime_attempts_adapter_external_run_id_key"));

  await expectReject(db, "Terminal RuntimeAttempt cannot return to running", async () => {
    await insertRunningRuntimeAttempt(db);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'succeeded', "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
    await db.query(`
      UPDATE "runtime_attempts"
      SET "status" = 'running', "finished_at" = NULL, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-runtime-attempt'
    `);
  }, trigger("23514", "RUNTIME_ATTEMPT_TERMINAL_IMMUTABLE"));

  await expectReject(db, "Canvas tool invocation start time is immutable", async () => {
    await insertCanvasToolInvocation(db);
    await db.query(`
      UPDATE "canvas_tool_invocations"
      SET "started_at" = "started_at" - interval '1 minute',
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-canvas-tool-invocation'
    `);
  }, trigger("23514", "CANVAS_TOOL_INVOCATION_SCOPE_IMMUTABLE"));

  await expectReject(db, "Canvas Agent session snapshot digest is immutable", async () => {
    await insertCanvasToolInvocation(db);
    await db.query(`
      UPDATE "canvas_agent_sessions"
      SET "snapshot_sha256" = repeat('f', 64), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-canvas-agent-session'
    `);
  }, trigger("23514", "CANVAS_AGENT_SESSION_SNAPSHOT_IMMUTABLE"));

  await expectReject(db, "Canvas tool grant snapshot digest is immutable", async () => {
    await insertCanvasToolInvocation(db);
    await db.query(`
      UPDATE "canvas_tool_grants"
      SET "snapshot_sha256" = repeat('f', 64)
      WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid
    `);
  }, trigger("23514", "CANVAS_TOOL_GRANT_SNAPSHOT_IMMUTABLE"));

  await expectAccept(db, "Knowledge tool budget and grant ledger bind the current RuntimeAttempt", async () => {
    await prepareKnowledgeToolScope(db);
    await insertKnowledgeToolBudget(db);
    await insertKnowledgeToolGrant(db);
  });

  await expectReject(db, "Knowledge tool budget must start with empty counters", async () => {
    await prepareKnowledgeToolScope(db);
    await insertKnowledgeToolBudget(db, { windowStarts: 1, totalStarts: 1 });
  }, trigger("23514", "KNOWLEDGE_TOOL_BUDGET_MUST_START_EMPTY"));

  await expectReject(db, "Knowledge tool budget policy is immutable", async () => {
    await prepareKnowledgeToolScope(db);
    await insertKnowledgeToolBudget(db);
    await db.query(`
      UPDATE "knowledge_tool_budgets"
      SET "max_successful_calls" = 13, "updated_at" = clock_timestamp()
      WHERE "runtime_attempt_id" = 'candidate-runtime-attempt'
    `);
  }, trigger("23514", "KNOWLEDGE_TOOL_BUDGET_POLICY_IMMUTABLE"));

  await expectReject(db, "Knowledge tool grant cannot forge its Project scope", async () => {
    await prepareKnowledgeToolScope(db);
    await insertKnowledgeToolBudget(db);
    await insertKnowledgeToolGrant(db, { projectId: "project-b", id: "candidate-knowledge-grant-forged" });
  }, trigger("23514", "KNOWLEDGE_TOOL_GRANT_SCOPE_INVALID"));

  await expectReject(db, "Knowledge invocation cannot bypass the durable start counter", async () => {
    await prepareKnowledgeToolScope(db);
    await insertKnowledgeToolBudget(db);
    await insertKnowledgeToolGrant(db);
    await insertKnowledgeInvocation(db);
  }, trigger("23514", "KNOWLEDGE_RETRIEVAL_START_LEDGER_MISMATCH"));

  await expectReject(db, "Succeeded Knowledge invocation receipt is terminal and immutable", async () => {
    await prepareKnowledgeToolScope(db);
    await insertKnowledgeToolBudget(db);
    await insertKnowledgeToolGrant(db);
    await db.query(`
      UPDATE "knowledge_tool_budgets"
      SET "window_starts" = 1, "total_starts" = 1, "updated_at" = clock_timestamp()
      WHERE "runtime_attempt_id" = 'candidate-runtime-attempt'
    `);
    await insertKnowledgeInvocation(db);
    await db.query(`
      UPDATE "knowledge_retrieval_invocations"
      SET "status" = 'succeeded',
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "response" = '{"protocol":"workbench.knowledge-retrieval-result.v1"}'::jsonb,
          "response_sha256" = repeat('9', 64),
          "finished_at" = "last_started_at",
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-invocation'
    `);
    await db.query(`
      UPDATE "knowledge_retrieval_invocations"
      SET "response_sha256" = repeat('8', 64), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-invocation'
    `);
  }, trigger("23514", "KNOWLEDGE_RETRIEVAL_INVOCATION_TERMINAL_IMMUTABLE"));

  await expectReject(db, "Run cannot finish after an empty successful retrieval", async () => {
    await prepareSuccessfulKnowledgeRetrieval(db, []);
    await db.query(`UPDATE "runs" SET "status" = 'succeeded', "progress" = 1 WHERE "id" = 'run-a'`);
  }, trigger("23514", "KNOWLEDGE_RETRIEVAL_REQUIRED"));

  await expectAccept(db, "Pinned Run can finish after its KnowledgeRelease retires", async () => {
    await prepareSuccessfulKnowledgeRetrieval(db);
    await db.query(`UPDATE "knowledge_releases" SET "status" = 'retired' WHERE "id" = 'release-ready-a'`);
    await db.query(`UPDATE "runs" SET "status" = 'succeeded', "progress" = 1 WHERE "id" = 'run-a'`);
    await insertVersion(db, {
      status: "ready",
      knowledgeReleaseId: "release-ready-a",
    });
  });

  await expectReject(db, "Run progress cannot be negative", async () => {
    await db.query(`UPDATE "runs" SET "progress" = -0.01 WHERE "id" = 'run-a'`);
  }, constraint("23514", "runs_progress_range_check"));

  await expectReject(db, "Run progress cannot exceed one", async () => {
    await db.query(`UPDATE "runs" SET "progress" = 1.01 WHERE "id" = 'run-a'`);
  }, constraint("23514", "runs_progress_range_check"));

  await expectReject(db, "BoardNode Project must match its Board", async () => {
    await insertBoardNode(db, {
      boardId: "board-a",
      projectId: "project-b",
      kind: "frame",
      size: { width: 100, height: 100 },
      artifactId: null,
      artifactVersionId: null,
      data: frameBoardNodeData("Cross-project Frame"),
    });
  }, constraint("23503", "board_nodes_board_id_project_id_fkey"));

  await expectReject(db, "BoardNode cannot carry only an Artifact id", async () => {
    await insertBoardNode(db, { artifactId: "artifact-a", artifactVersionId: null });
  }, constraint("23514", "board_nodes_artifact_pair_check"));

  await expectReject(db, "BoardNode cannot carry only an ArtifactVersion id", async () => {
    await insertBoardNode(db, { artifactId: null, artifactVersionId: "version-a-ready" });
  }, constraint("23514", "board_nodes_artifact_pair_check"));

  await expectReject(db, "BoardNode cannot pin a staging ArtifactVersion", async () => {
    await insertBoardNode(db, {
      artifactId: "artifact-a",
      artifactVersionId: "version-a-staging",
    });
  }, trigger("23514", "BOARD_NODE_ARTIFACT_VERSION_NOT_READY"));

  await expectReject(db, "BoardNode cannot pin a rejected ArtifactVersion", async () => {
    await insertBoardNode(db, {
      artifactId: "artifact-a",
      artifactVersionId: "version-a-rejected",
    });
  }, trigger("23514", "BOARD_NODE_ARTIFACT_VERSION_NOT_READY"));

  await expectReject(db, "BoardNode cannot pin another Project ArtifactVersion", async () => {
    await insertBoardNode(db, {
      artifactId: "artifact-b",
      artifactVersionId: "version-b-ready",
    });
  }, trigger("23514", "BOARD_NODE_ARTIFACT_VERSION_NOT_READY"));

  await expectReject(db, "BoardNode rejects an unversioned data payload", async () => {
    await insertBoardNode(db, { data: { title: "legacy" } });
  }, constraint("23514", "board_nodes_data_protocol_check"));

  await expectReject(db, "BoardNode rejects an unknown node kind", async () => {
    await insertBoardNode(db, {
      kind: "note",
      artifactId: null,
      artifactVersionId: null,
      data: { protocol: "workbench.board-node.v1", nodeType: "note", title: "Note" },
    });
  }, constraint("23514", "board_nodes_kind_check"));

  await expectReject(db, "BoardNode sibling order cannot be negative", async () => {
    await insertBoardNode(db, { sortOrder: -1 });
  }, constraint("23514", "board_nodes_sort_order_check"));

  await expectReject(db, "Root BoardNode sibling order must be unique", async () => {
    await insertBoardNode(db);
    await insertBoardNode(db, { id: "candidate-root-sibling", nodeKey: "candidate-root-sibling" });
  }, constraint("23505", "board_nodes_root_sort_order_key"));

  await expectReject(db, "Child BoardNode sibling order must be unique", async () => {
    await insertBoardNode(db, {
      id: "candidate-order-parent",
      nodeKey: "candidate-order-parent",
      kind: "frame",
      size: { width: 200, height: 200 },
      artifactId: null,
      artifactVersionId: null,
      data: frameBoardNodeData("Order Parent"),
    });
    await insertBoardNode(db, {
      id: "candidate-order-child-a",
      nodeKey: "candidate-order-child-a",
      parentNodeKey: "candidate-order-parent",
      kind: "drawing",
      size: { width: 40, height: 40 },
      artifactId: null,
      artifactVersionId: null,
      data: drawingBoardNodeData(),
    });
    await insertBoardNode(db, {
      id: "candidate-order-child-b",
      nodeKey: "candidate-order-child-b",
      parentNodeKey: "candidate-order-parent",
      kind: "drawing",
      size: { width: 40, height: 40 },
      artifactId: null,
      artifactVersionId: null,
      data: drawingBoardNodeData(),
    });
  }, constraint("23505", "board_nodes_child_sort_order_key"));

  await expectReject(db, "Board Frame requires an explicit size", async () => {
    await insertBoardNode(db, {
      kind: "frame",
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: "workbench.board-node.v1",
        nodeType: "frame",
        title: "Frame",
        fill: null,
        stroke: "#5f6368",
      },
    });
  }, constraint("23514", "board_nodes_sized_content_check"));

  await expectReject(db, "BoardNode parent must be a Frame", async () => {
    await insertBoardNode(db, { id: "candidate-parent", nodeKey: "candidate-parent" });
    await insertBoardNode(db, {
      id: "candidate-child",
      nodeKey: "candidate-child",
      parentNodeKey: "candidate-parent",
      kind: "drawing",
      size: { width: 40, height: 40 },
      artifactId: null,
      artifactVersionId: null,
      data: drawingBoardNodeData(),
    });
  }, trigger("23514", "BOARD_NODE_PARENT_NOT_FRAME"));

  await expectReject(db, "Board Frame with children cannot change to a non-Frame kind", async () => {
    await insertBoardNode(db, {
      id: "candidate-parent-frame",
      nodeKey: "candidate-parent-frame",
      kind: "frame",
      size: { width: 200, height: 200 },
      artifactId: null,
      artifactVersionId: null,
      data: frameBoardNodeData("Parent Frame"),
    });
    await insertBoardNode(db, {
      id: "candidate-frame-child",
      nodeKey: "candidate-frame-child",
      parentNodeKey: "candidate-parent-frame",
      kind: "drawing",
      size: { width: 40, height: 40 },
      artifactId: null,
      artifactVersionId: null,
      data: drawingBoardNodeData(),
    });
    await db.query(`
      UPDATE "board_nodes"
      SET "kind" = 'drawing', "data" = $1::jsonb
      WHERE "id" = 'candidate-parent-frame'
    `, [JSON.stringify(drawingBoardNodeData())]);
  }, trigger("23514", "BOARD_NODE_PARENT_NOT_FRAME"));

  await expectReject(db, "Board Frame hierarchy cannot contain a cycle", async () => {
    await insertBoardNode(db, {
      id: "candidate-frame-a",
      nodeKey: "candidate-frame-a",
      parentNodeKey: "candidate-frame-b",
      kind: "frame",
      size: { width: 200, height: 200 },
      artifactId: null,
      artifactVersionId: null,
      data: frameBoardNodeData("Frame A"),
    });
    await insertBoardNode(db, {
      id: "candidate-frame-b",
      nodeKey: "candidate-frame-b",
      parentNodeKey: "candidate-frame-a",
      kind: "frame",
      size: { width: 100, height: 100 },
      artifactId: null,
      artifactVersionId: null,
      data: frameBoardNodeData("Frame B"),
    });
  }, trigger("23514", "BOARD_NODE_PARENT_CYCLE"));

  await expectReject(db, "ProjectRelease must start building", async () => {
    await insertProjectRelease(db, {
      status: "ready",
      finishedAt: new Date(),
    });
  }, trigger("23514", "PROJECT_RELEASE_MUST_START_BUILDING"));

  await expectReject(db, "ProjectRelease must pin the current Board revision", async () => {
    await insertProjectRelease(db, {
      boardRevision: (await boardRevision(db, "board-a")) - 1,
    });
  }, trigger("23514", "PROJECT_RELEASE_BOARD_REVISION_STALE"));

  await expectReject(db, "ProjectRelease cannot pin a staging ArtifactVersion", async () => {
    await insertReleaseArtifactVersion(db, {
      artifactVersionId: "version-a-staging",
    });
  }, trigger("23514", "RELEASE_ARTIFACT_VERSION_NOT_READY"));

  await expectReject(db, "ProjectRelease ArtifactVersion must belong to its Project", async () => {
    await insertReleaseArtifactVersion(db, {
      projectId: "project-b",
      position: 1,
      artifactId: "artifact-b",
      artifactVersionId: "version-b-ready",
    });
  }, constraint("23503", "release_artifact_versions_release_id_project_id_fkey"));

  await expectReject(db, "ProjectRelease rejects a stale Artifact title snapshot", async () => {
    await insertReleaseArtifactVersion(db, { title: "Forged title" });
  }, trigger("23514", "RELEASE_ARTIFACT_SNAPSHOT_FIELDS_STALE"));

  await expectReject(db, "ProjectRelease rejects a stale Artifact kind snapshot", async () => {
    await insertReleaseArtifactVersion(db, { kind: "prototype" });
  }, trigger("23514", "RELEASE_ARTIFACT_SNAPSHOT_FIELDS_STALE"));

  await expectAccept(db, "ProjectRelease freezes a ready ArtifactVersion and becomes ready", async () => {
    await insertProjectRelease(db);
    await insertReleaseArtifactVersion(db, { releaseId: "candidate-project-release" });
    await db.query(`
      UPDATE "project_releases"
      SET "status" = 'ready', "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-project-release'
    `);
    const result = await db.query(`
      SELECT release."status", pin."artifact_version_id"
      FROM "project_releases" AS release
      JOIN "release_artifact_versions" AS pin ON pin."release_id" = release."id"
      WHERE release."id" = 'candidate-project-release'
    `);
    assert.deepEqual(result.rows[0], {
      status: "ready",
      artifact_version_id: "version-a-ready",
    });
  });

  await expectReject(db, "Ready ProjectRelease Board snapshot is immutable", async () => {
    await db.query(`
      UPDATE "project_releases"
      SET "board_snapshot" = '{"tampered":true}'::jsonb, "updated_at" = clock_timestamp()
      WHERE "id" = 'project-release-ready-a'
    `);
  }, trigger("23514", "PROJECT_RELEASE_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Ready ProjectRelease manifest is immutable", async () => {
    await db.query(`
      UPDATE "project_releases"
      SET "manifest" = '{"tampered":true}'::jsonb, "updated_at" = clock_timestamp()
      WHERE "id" = 'project-release-ready-a'
    `);
  }, trigger("23514", "PROJECT_RELEASE_IDENTITY_IMMUTABLE"));

  await expectReject(db, "Ready ProjectRelease cannot be deleted", async () => {
    await db.query(`DELETE FROM "project_releases" WHERE "id" = 'project-release-ready-a'`);
  }, trigger("23514", "PROJECT_RELEASE_TERMINAL_IMMUTABLE"));

  await expectReject(db, "Failed ProjectRelease cannot be deleted", async () => {
    await insertProjectRelease(db);
    await db.query(`
      UPDATE "project_releases"
      SET "status" = 'failed', "failure_code" = 'BUILD_FAILED',
          "failure_detail" = 'Constraint probe', "finished_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-project-release'
    `);
    await db.query(`DELETE FROM "project_releases" WHERE "id" = 'candidate-project-release'`);
  }, trigger("23514", "PROJECT_RELEASE_TERMINAL_IMMUTABLE"));

  await expectReject(db, "Ready ProjectRelease cannot accept another ArtifactVersion", async () => {
    await insertReleaseArtifactVersion(db, {
      releaseId: "project-release-ready-a",
      position: 1,
      artifactId: "artifact-a-other",
      artifactVersionId: "version-a-other-ready",
    });
  }, trigger("23514", "RELEASE_ARTIFACT_VERSION_OWNER_NOT_BUILDING"));

  await expectReject(db, "Ready ProjectRelease ArtifactVersion pin cannot be updated", async () => {
    await db.query(`
      UPDATE "release_artifact_versions"
      SET "position" = 1
      WHERE "release_id" = 'project-release-ready-a' AND "position" = 0
    `);
  }, trigger("23514", "RELEASE_ARTIFACT_VERSION_IMMUTABLE"));

  await expectReject(db, "Ready ProjectRelease ArtifactVersion pin cannot be deleted", async () => {
    await db.query(`
      DELETE FROM "release_artifact_versions"
      WHERE "release_id" = 'project-release-ready-a' AND "position" = 0
    `);
  }, trigger("23514", "RELEASE_ARTIFACT_VERSION_OWNER_NOT_BUILDING"));

  await expectAccept(db, "Ready ProjectRelease keeps its Artifact title and kind snapshot after a live title rename", async () => {
    await db.query(`UPDATE "artifacts" SET "title" = 'Artifact A Renamed' WHERE "id" = 'artifact-a'`);
    const result = await db.query(`
      SELECT pin."title", pin."kind", artifact."title" AS "live_title"
      FROM "release_artifact_versions" AS pin
      JOIN "artifacts" AS artifact ON artifact."id" = pin."artifact_id"
      WHERE pin."release_id" = 'project-release-ready-a' AND pin."position" = 0
    `);
    assert.deepEqual(result.rows[0], {
      title: "Artifact A",
      kind: "prd",
      live_title: "Artifact A Renamed",
    });
  });

  await expectReject(db, "Artifact kind remains immutable after a Release pins its kind snapshot", async () => {
    await db.query(`UPDATE "artifacts" SET "kind" = 'prototype' WHERE "id" = 'artifact-a'`);
  }, trigger("23514", "ARTIFACT_IDENTITY_IMMUTABLE"));

  await expectReject(db, "ShareGrant cannot reference a building ProjectRelease", async () => {
    await insertShareGrant(db, { releaseId: "project-release-building-a" });
  }, trigger("23514", "SHARE_GRANT_RELEASE_NOT_READY"));

  await expectReject(db, "ShareGrant stores only a SHA-256 token hash", async () => {
    await insertShareGrant(db, { tokenHash: "raw-share-token" });
  }, constraint("23514", "share_grants_token_hash_format_check"));

  await expectAccept(db, "ShareGrant schema contains no raw token column", async () => {
    const result = await db.query(`
      SELECT "column_name"
      FROM information_schema.columns
      WHERE "table_schema" = current_schema()
        AND "table_name" = 'share_grants'
        AND "column_name" LIKE '%token%'
      ORDER BY "column_name"
    `);
    assert.deepEqual(result.rows, [{ column_name: "token_hash" }]);
  });

  await expectAccept(db, "ShareGrant accepts a ready ProjectRelease and token hash", async () => {
    await insertShareGrant(db);
  });

  await expectReject(db, "ShareGrant requires one pinned Prototype version", async () => {
    await insertShareGrant(db, { artifactVersionId: null });
  }, trigger("23514", "PROTOTYPE_SHARE_PIN_REQUIRED"));

  await expectReject(db, "ShareGrant cannot expose a PRD instead of a Prototype", async () => {
    await insertShareGrant(db, { artifactVersionId: "version-a-ready" });
  }, trigger("23514", "PROTOTYPE_SHARE_PIN_REQUIRED"));

  await expectReject(db, "Prototype ShareGrant must be read-only", async () => {
    await insertShareGrant(db, { scope: "remix" });
  }, trigger("23514", "PROTOTYPE_SHARE_PIN_REQUIRED"));

  await expectReject(db, "ShareGrant cannot change its pinned Prototype version", async () => {
    await insertShareGrant(db);
    await db.query(`
      UPDATE "share_grants"
      SET "artifact_version_id" = 'version-a-ready', "revision" = "revision" + 1
      WHERE "id" = 'candidate-share'
    `);
  }, trigger("23514", "SHARE_VERSION_PIN_IMMUTABLE"));

  await expectReject(db, "A Project cannot retain two active ShareGrants", async () => {
    await insertShareGrant(db);
    await insertShareGrant(db, {
      id: "candidate-share-second",
      idempotencyKey: "candidate-share-second-key",
      tokenHash: "6".repeat(64),
    });
  }, constraint("23505", "share_grants_one_active_per_project_key"));

  await expectReject(db, "ShareGrant rotation receipts are immutable", async () => {
    await insertShareGrant(db);
    await db.query(`
      UPDATE "share_grants"
      SET "request_hash" = repeat('6', 64), "revision" = "revision" + 1,
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-share'
    `);
  }, trigger("23514", "SHARE_ROTATION_RECEIPT_IMMUTABLE"));

  await expectReject(db, "Active ShareGrant cannot be physically deleted", async () => {
    await insertShareGrant(db);
    await db.query(`DELETE FROM "share_grants" WHERE "id" = 'candidate-share'`);
  }, trigger("23514", "SHARE_GRANT_DELETE_NOT_ALLOWED"));

  await expectReject(db, "Revoked ShareGrant cannot be physically deleted", async () => {
    await insertShareGrant(db);
    await db.query(`
      UPDATE "share_grants"
      SET "status" = 'revoked', "revoked_at" = clock_timestamp(),
          "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-share'
    `);
    await db.query(`DELETE FROM "share_grants" WHERE "id" = 'candidate-share'`);
  }, trigger("23514", "SHARE_GRANT_DELETE_NOT_ALLOWED"));

  await expectReject(db, "Expired ShareGrant cannot be physically deleted", async () => {
    await insertShareGrant(db);
    await db.query(`
      UPDATE "share_grants"
      SET "status" = 'expired', "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-share'
    `);
    await db.query(`DELETE FROM "share_grants" WHERE "id" = 'candidate-share'`);
  }, trigger("23514", "SHARE_GRANT_DELETE_NOT_ALLOWED"));

  await expectReject(db, "ShareGrant token hash identity is immutable", async () => {
    await insertShareGrant(db);
    await db.query(`
      UPDATE "share_grants"
      SET "token_hash" = repeat('6', 64), "revision" = "revision" + 1,
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-share'
    `);
  }, trigger("23514", "SHARE_GRANT_IDENTITY_IMMUTABLE"));

  await expectReject(db, "ExportJob cannot reference a building ProjectRelease", async () => {
    await insertExportJob(db, { releaseId: "project-release-building-a" });
  }, trigger("23514", "EXPORT_JOB_RELEASE_NOT_READY"));

  await expectReject(db, "Public ExportJob always requires a ProjectRelease", async () => {
    await insertExportJob(db, { releaseId: null });
  }, trigger("23514", "EXPORT_JOB_RELEASE_NOT_READY"));

  await expectReject(db, "Private Preview ExportJob cannot reference a ProjectRelease", async () => {
    await insertExportJob(db, { purpose: "preview" });
  }, constraint("23514", "export_jobs_purpose_release_check"));

  await expectReject(db, "Private Preview ExportJob must use HTML", async () => {
    await insertExportJob(db, { purpose: "preview", releaseId: null, format: "react" });
  }, trigger("23514", "PREVIEW_JOB_MUST_BE_HTML"));

  await expectReject(db, "Private Preview ExportJob requires a ProjectPreview receipt", async () => {
    await insertPreviewExportJob(db);
  }, trigger("23514", "PREVIEW_EXPORT_JOB_RECEIPT_MISSING"));

  await expectAccept(db, "Private Preview snapshot does not require a ProjectRelease", async () => {
    await insertProjectPreview(db);
  });

  await expectAccept(db, "ProjectPreview accepts an initial screen from its selected Prototype", async () => {
    await insertProjectPreview(db, {
      artifactPin: prototypePreviewArtifactPin(),
      exportJobOverrides: {
        selectionKind: "artifact",
        selectionArtifactId: "artifact-prototype",
        selectionArtifactVersionId: "version-prototype-ready",
      },
      initialScreenId: "screen-home",
    });
  });

  await expectReject(db, "ProjectPreview initial screen must exist in its selected Prototype", async () => {
    await insertProjectPreview(db, {
      artifactPin: prototypePreviewArtifactPin(),
      exportJobOverrides: {
        selectionKind: "artifact",
        selectionArtifactId: "artifact-prototype",
        selectionArtifactVersionId: "version-prototype-ready",
      },
      initialScreenId: "screen-missing",
    });
  }, trigger("23514", "PROJECT_PREVIEW_INITIAL_SCREEN_INVALID"));

  await expectReject(db, "ProjectPreview initial screen requires a Prototype Artifact", async () => {
    await insertProjectPreview(db, {
      artifactPin: previewArtifactPin(),
      exportJobOverrides: {
        selectionKind: "artifact",
        selectionArtifactId: "artifact-a",
        selectionArtifactVersionId: "version-a-ready",
      },
      initialScreenId: "screen-home",
    });
  }, trigger("23514", "PROJECT_PREVIEW_INITIAL_SCREEN_INVALID"));

  await expectReject(db, "ProjectPreview initial screen requires an Artifact selection", async () => {
    await insertProjectPreview(db, { initialScreenId: "screen-home" });
  }, trigger("23514", "PROJECT_PREVIEW_INITIAL_SCREEN_SELECTION_INVALID"));

  await expectReject(db, "ProjectPreview selection cannot crop the selected Prototype", async () => {
    await insertProjectPreview(db, {
      artifactPin: prototypePreviewArtifactPin(),
      exportJobOverrides: {
        selectionKind: "artifact",
        selectionArtifactId: "artifact-prototype",
        selectionArtifactVersionId: "version-prototype-ready",
        selectionScreenId: "screen-home",
      },
    });
  }, trigger("23514", "PROJECT_PREVIEW_SELECTION_SCREEN_CROP_FORBIDDEN"));

  await expectReject(db, "ProjectPreview cannot attach to a public ExportJob", async () => {
    await insertExportJob(db);
    await insertProjectPreviewRecord(db, { exportJobId: "candidate-export" });
  }, trigger("23514", "PROJECT_PREVIEW_EXPORT_JOB_MISMATCH"));

  await expectReject(db, "ProjectPreview creator must remain an active Project member at creation", async () => {
    await insertPreviewExportJob(db, { createdById: "principal-b" });
    await insertProjectPreviewRecord(db, { createdById: "principal-b" });
  }, trigger("23514", "PROJECT_PREVIEW_CREATOR_NOT_AUTHORIZED"));

  await expectReject(db, "ProjectPreview Artifact selection must belong to its immutable pins", async () => {
    await insertPreviewExportJob(db, {
      selectionKind: "artifact",
      selectionArtifactId: "artifact-a",
      selectionArtifactVersionId: "version-a-ready",
    });
    await insertProjectPreviewRecord(db);
  }, trigger("23514", "PROJECT_PREVIEW_SELECTION_NOT_PINNED"));

  await expectReject(db, "ProjectPreview pinned snapshot is immutable", async () => {
    await insertProjectPreview(db);
    await db.query(`
      UPDATE "project_previews"
      SET "board_snapshot" = jsonb_set("board_snapshot", '{viewport,x}', '1'::jsonb),
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-preview'
    `);
  }, trigger("23514", "PROJECT_PREVIEW_IMMUTABLE"));

  await expectReject(db, "ProjectPreview ArtifactVersion pins are immutable", async () => {
    await insertProjectPreview(db, { artifactPin: previewArtifactPin() });
    await db.query(`
      UPDATE "project_preview_artifact_versions"
      SET "title" = 'Changed title'
      WHERE "preview_id" = 'candidate-preview' AND "position" = 0
    `);
  }, trigger("23514", "PROJECT_PREVIEW_ARTIFACT_VERSION_IMMUTABLE"));

  await expectReject(db, "ProjectPreview ArtifactVersion pins cannot cross Project identity", async () => {
    await insertPreviewExportJob(db);
    await insertProjectPreviewRecord(db, {
      artifactPins: [previewArtifactPin({
        artifactId: "artifact-b",
        artifactVersionId: "version-b-ready",
      })],
    });
    await insertProjectPreviewArtifactPin(db, previewArtifactPin({
      projectId: "project-b",
      artifactId: "artifact-b",
      artifactVersionId: "version-b-ready",
    }));
  }, trigger("23514", "PROJECT_PREVIEW_ARTIFACT_VERSION_MANIFEST_MISMATCH"));

  await expectReject(db, "ExportJob format is a closed enum", async () => {
    await insertExportJob(db, { format: "keynote" });
  }, trigger("22P02", "invalid input value for enum"));

  for (const { format, packaging, label } of [
    { format: "html", packaging: "single_file", label: "HTML single-file" },
    { format: "html", packaging: "zip", label: "HTML ZIP" },
    { format: "docx", packaging: "single_file", label: "Word document" },
    { format: "pdf", packaging: "single_file", label: "PDF document" },
    { format: "react", packaging: "zip", label: "React ZIP" },
    { format: "figma", packaging: "zip", label: "Figma ZIP" },
    { format: "mcp", packaging: "zip", label: "MCP ZIP" },
  ]) {
    await expectAccept(db, `ExportJob accepts ${label} packaging`, async () => {
      await insertExportJob(db, { format, packaging });
    });
  }

  for (const format of ["react", "figma", "mcp"]) {
    await expectReject(db, `ExportJob rejects ${format} single-file packaging`, async () => {
      await insertExportJob(db, { format, packaging: "single_file" });
    }, constraint("23514", "export_jobs_format_packaging_check"));
  }

  for (const format of ["docx", "pdf"]) {
    await expectReject(db, `ExportJob rejects ${format} ZIP packaging`, async () => {
      await insertExportJob(db, { format, packaging: "zip" });
    }, constraint("23514", "export_jobs_format_packaging_check"));
  }

  await expectReject(db, "ExportJob release selection cannot carry Artifact fields", async () => {
    await insertExportJob(db, {
      selectionArtifactId: "artifact-a",
      selectionArtifactVersionId: "version-a-ready",
    });
  }, constraint("23514", "export_jobs_selection_check"));

  await expectReject(db, "ExportJob release selection cannot carry screenId", async () => {
    await insertExportJob(db, { selectionScreenId: "screen-home" });
  }, constraint("23514", "export_jobs_selection_check"));

  await expectReject(db, "ExportJob Artifact selection must be pinned by its ProjectRelease", async () => {
    await insertExportJob(db, {
      selectionKind: "artifact",
      selectionArtifactId: "artifact-a-other",
      selectionArtifactVersionId: "version-a-other-ready",
    });
  }, constraint("23503", "export_jobs_selected_release_artifact_fkey"));

  await expectAccept(db, "ExportJob accepts an ArtifactVersion pinned by its ProjectRelease", async () => {
    await insertExportJob(db, {
      selectionKind: "artifact",
      selectionArtifactId: "artifact-a",
      selectionArtifactVersionId: "version-a-ready",
      selectionScreenId: "screen-home",
    });
  });

  await expectReject(db, "ExportJob screen selection identity is immutable", async () => {
    await insertExportJob(db, {
      selectionKind: "artifact",
      selectionArtifactId: "artifact-a",
      selectionArtifactVersionId: "version-a-ready",
      selectionScreenId: "screen-home",
    });
    await db.query(`
      UPDATE "export_jobs"
      SET "selection_screen_id" = 'screen-success',
          "revision" = "revision" + 1,
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-export'
    `);
  }, trigger("23514", "EXPORT_JOB_IDENTITY_IMMUTABLE"));

  await expectReject(db, "ExportJob idempotency key is unique within a ProjectRelease", async () => {
    await insertExportJob(db, { id: "candidate-export-one" });
    await insertExportJob(db, { id: "candidate-export-two" });
  }, constraint("23505", "export_jobs_release_id_idempotency_key_key"));

  await expectAccept(db, "ExportJob idempotency key is scoped to its ProjectRelease", async () => {
    await insertExportJob(db, { id: "candidate-export-a" });
    await insertExportJob(db, {
      id: "candidate-export-b",
      releaseId: "project-release-ready-b",
      createdById: "principal-b",
    });
  });

  await expectReject(db, "ExportJob request hash must be SHA-256", async () => {
    await insertExportJob(db, { requestHash: "not-a-sha256" });
  }, constraint("23514", "export_jobs_request_hash_format_check"));

  await expectReject(db, "ExportJob revision must increment exactly once", async () => {
    await insertExportJob(db);
    await db.query(`
      UPDATE "export_jobs"
      SET "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-export'
    `);
  }, trigger("23514", "EXPORT_JOB_REVISION_MUST_INCREMENT"));

  await expectReject(db, "Succeeded ExportJob requires a ready output Blob", async () => {
    await insertExportJob(db);
    await startExportJob(db, "candidate-export");
    await succeedExportJob(db, "candidate-export", "blob-output-pending");
  }, trigger("23514", "EXPORT_JOB_OUTPUT_BLOB_NOT_READY"));

  await expectReject(db, "Succeeded ExportJob requires a non-empty output Blob", async () => {
    await insertExportJob(db);
    await startExportJob(db, "candidate-export");
    await succeedExportJob(db, "candidate-export", "blob-empty");
  }, trigger("23514", "EXPORT_JOB_OUTPUT_BLOB_NOT_READY"));

  await expectAccept(db, "ExportJob can succeed with a ready non-empty output Blob", async () => {
    await insertExportJob(db);
    await startExportJob(db, "candidate-export");
    await succeedExportJob(db, "candidate-export", "blob-ready");
    const result = await db.query(`
      SELECT "status", "revision", "output_blob_id"
      FROM "export_jobs"
      WHERE "id" = 'candidate-export'
    `);
    assert.deepEqual(result.rows[0], {
      status: "succeeded",
      revision: 2,
      output_blob_id: "blob-ready",
    });
  });

  await expectReject(db, "Terminal ExportJob is immutable", async () => {
    await insertExportJob(db);
    await startExportJob(db, "candidate-export");
    await succeedExportJob(db, "candidate-export", "blob-ready");
    await db.query(`
      UPDATE "export_jobs"
      SET "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-export'
    `);
  }, trigger("23514", "EXPORT_JOB_TERMINAL_IMMUTABLE"));

  await expectReject(db, "Terminal ExportJob cannot be deleted", async () => {
    await insertExportJob(db);
    await startExportJob(db, "candidate-export");
    await succeedExportJob(db, "candidate-export", "blob-ready");
    await db.query(`DELETE FROM "export_jobs" WHERE "id" = 'candidate-export'`);
  }, trigger("23514", "EXPORT_JOB_TERMINAL_IMMUTABLE"));

  const confirmedAt = new Date("2026-07-18T01:00:00.000Z");
  const startedAt = new Date("2026-07-18T01:01:00.000Z");
  const transferAuthorizedAt = new Date("2026-07-18T01:02:00.000Z");
  const finishedAt = new Date("2026-07-18T01:03:00.000Z");
  const leaseExpiresAt = new Date("2026-07-18T01:06:00.000Z");
  for (const { status, overrides } of [
    { status: "pending_confirmation", overrides: {} },
    { status: "queued", overrides: { confirmedAt } },
    {
      status: "running",
      overrides: {
        attempt: 1,
        confirmedAt,
        startedAt,
        leaseToken: "candidate-delivery-running-lease",
        leaseExpiresAt,
      },
    },
    {
      status: "cancelling",
      overrides: {
        attempt: 1,
        confirmedAt,
        startedAt,
        transferAuthorizedAt,
        remoteReference: "fake://netlify/candidate-delivery",
      },
    },
    {
      status: "succeeded",
      overrides: {
        attempt: 1,
        confirmedAt,
        startedAt,
        transferAuthorizedAt,
        remoteReference: "fake://netlify/candidate-delivery",
        finishedAt,
      },
    },
    {
      status: "failed",
      overrides: {
        attempt: 1,
        confirmedAt,
        startedAt,
        finishedAt,
        failureCode: "DELIVERY_FAILED",
        failureDetail: "The provider rejected the delivery",
      },
    },
    { status: "cancelled", overrides: { finishedAt } },
  ]) {
    await expectAccept(db, `ExternalExportDelivery accepts ${status} lifecycle evidence`, async () => {
      await insertSucceededExportJob(db);
      await insertExternalExportDelivery(db, { status, ...overrides });
    });
  }

  await expectReject(db, "ExternalExportDelivery request hash must be SHA-256", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { requestHash: "not-a-sha256" });
  }, constraint("23514", "external_export_deliveries_request_hash_check"));

  await expectReject(db, "ExternalExportDelivery revision cannot be negative", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { revision: -1 });
  }, constraint("23514", "external_export_deliveries_revision_check"));

  await expectReject(db, "ExternalExportDelivery attempt cannot be negative", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { attempt: -1 });
  }, constraint("23514", "external_export_deliveries_attempt_check"));

  await expectReject(db, "ExternalExportDelivery payload must be an object", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { payload: [] });
  }, constraint("23514", "external_export_deliveries_payload_check"));

  await expectReject(db, "pending ExternalExportDelivery cannot retain an attempt", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { attempt: 1 });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "queued ExternalExportDelivery requires confirmation", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { status: "queued" });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "running ExternalExportDelivery requires a worker lease", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "running",
      attempt: 1,
      confirmedAt,
      startedAt,
    });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "cancelling ExternalExportDelivery requires paired lease evidence", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "cancelling",
      attempt: 1,
      confirmedAt,
      startedAt,
      leaseToken: "candidate-delivery-incomplete-lease",
    });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "ExternalExportDelivery remote receipt requires transfer authorization", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "cancelling",
      attempt: 1,
      confirmedAt,
      startedAt,
      remoteReference: "fake://netlify/candidate-delivery",
    });
  }, constraint("23514", "external_export_deliveries_transfer_evidence_check"));

  await expectReject(db, "ExternalExportDelivery transfer authorization requires execution evidence", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "cancelled",
      transferAuthorizedAt,
      finishedAt,
    });
  }, constraint("23514", "external_export_deliveries_transfer_evidence_check"));

  await expectReject(db, "succeeded ExternalExportDelivery requires transfer authorization", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "succeeded",
      attempt: 1,
      confirmedAt,
      startedAt,
      remoteReference: "fake://netlify/candidate-delivery",
      finishedAt,
    });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "succeeded ExternalExportDelivery requires a remote receipt", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "succeeded",
      attempt: 1,
      confirmedAt,
      startedAt,
      transferAuthorizedAt,
      finishedAt,
    });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "failed ExternalExportDelivery requires failure evidence", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "failed",
      attempt: 1,
      confirmedAt,
      startedAt,
      finishedAt,
    });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "cancelled ExternalExportDelivery cannot retain a remote receipt", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, {
      status: "cancelled",
      attempt: 1,
      confirmedAt,
      startedAt,
      transferAuthorizedAt,
      remoteReference: "fake://netlify/candidate-delivery",
      finishedAt,
    });
  }, constraint("23514", "external_export_deliveries_state_check"));

  await expectReject(db, "ExternalExportDelivery requires an existing ExportJob", async () => {
    await insertExternalExportDelivery(db, { exportJobId: "missing-export-job" });
  }, constraint("23503", "external_export_deliveries_export_job_id_fkey"));

  await expectReject(db, "ExternalExportDelivery creator must be an existing Principal", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { createdById: "missing-principal" });
  }, constraint("23503", "external_export_deliveries_created_by_id_fkey"));

  await expectReject(db, "ExternalExportDelivery idempotency key is unique within an ExportJob", async () => {
    await insertSucceededExportJob(db);
    await insertExternalExportDelivery(db, { id: "candidate-delivery-one" });
    await insertExternalExportDelivery(db, { id: "candidate-delivery-two" });
  }, constraint("23505", "external_export_deliveries_export_job_id_idempotency_key_key"));

  await expectAccept(db, "ExternalExportDelivery idempotency key is scoped to its ExportJob", async () => {
    await insertSucceededExportJob(db, {
      id: "candidate-export-one",
      idempotencyKey: "candidate-export-one-key",
    });
    await insertSucceededExportJob(db, {
      id: "candidate-export-two",
      idempotencyKey: "candidate-export-two-key",
    });
    await insertExternalExportDelivery(db, {
      id: "candidate-delivery-one",
      exportJobId: "candidate-export-one",
    });
    await insertExternalExportDelivery(db, {
      id: "candidate-delivery-two",
      exportJobId: "candidate-export-two",
    });
  });

  await expectReject(db, "Board revision must start at zero", async () => {
    await db.query(`
      INSERT INTO "boards" (
        "id", "project_id", "revision", "viewport", "updated_at"
      ) VALUES (
        'candidate-board', 'project-board-test', 1,
        '{"x":0,"y":0,"zoom":1}'::jsonb, clock_timestamp()
      )
    `);
  }, trigger("23514", "BOARD_REVISION_MUST_START_AT_ZERO"));

  await expectReject(db, "Board revision must increment exactly once on update", async () => {
    await db.query(`
      UPDATE "boards"
      SET "viewport" = '{"x":10,"y":10,"zoom":1}'::jsonb,
          "updated_at" = clock_timestamp()
      WHERE "id" = 'board-a'
    `);
  }, trigger("23514", "BOARD_REVISION_MUST_INCREMENT"));

  await expectAccept(db, "Board accepts a single revision increment", async () => {
    await db.query(`
      UPDATE "boards"
      SET "revision" = "revision" + 1,
          "viewport" = '{"x":10,"y":10,"zoom":1}'::jsonb,
          "updated_at" = clock_timestamp()
      WHERE "id" = 'board-a'
    `);
  });

  await expectAccept(db, "BoardNode statement increments its Board revision once", async () => {
    const before = await boardRevision(db, "board-a");
    await db.query(`
      INSERT INTO "board_nodes" (
        "id", "board_id", "project_id", "node_key", "sort_order", "kind", "position", "size", "data"
      ) VALUES
        (
          'revision-node-one', 'board-a', 'project-a', 'revision-node-one', 2, 'frame',
          '{"x":0,"y":0}'::jsonb, '{"width":100,"height":100}'::jsonb,
          '{"protocol":"workbench.board-node.v1","nodeType":"frame","title":"Revision frame one","fill":null,"stroke":"#5f6368"}'::jsonb
        ),
        (
          'revision-node-two', 'board-a', 'project-a', 'revision-node-two', 3, 'frame',
          '{"x":10,"y":10}'::jsonb, '{"width":100,"height":100}'::jsonb,
          '{"protocol":"workbench.board-node.v1","nodeType":"frame","title":"Revision frame two","fill":null,"stroke":"#5f6368"}'::jsonb
        )
    `);
    assert.equal(await boardRevision(db, "board-a"), before + 1);
  });

  await expectAccept(db, "BoardEdge statement increments its Board revision once", async () => {
    const before = await boardRevision(db, "board-a");
    await insertBoardEdge(db, { edgeKey: "revision-edge", id: "revision-edge" });
    assert.equal(await boardRevision(db, "board-a"), before + 1);
  });

  await expectReject(db, "Board identity is immutable", async () => {
    await db.query(`
      UPDATE "boards"
      SET "project_id" = 'project-b', "revision" = "revision" + 1
      WHERE "id" = 'board-a'
    `);
  }, trigger("23514", "BOARD_IDENTITY_IMMUTABLE"));

  await expectReject(db, "BoardEdge source must be a node on the same Board", async () => {
    await insertBoardEdge(db, {
      edgeKey: "invalid-source",
      sourceNodeKey: "missing-on-board-a",
      targetNodeKey: "right",
    });
  }, constraint("23503", "board_edges_source_node_fkey"));

  await expectReject(db, "BoardEdge target must be a node on the same Board", async () => {
    await insertBoardEdge(db, {
      edgeKey: "invalid-target",
      sourceNodeKey: "left",
      targetNodeKey: "missing-on-board-a",
    });
  }, constraint("23503", "board_edges_target_node_fkey"));

  await expectAccept(db, "controlled ready Blob does not require upload scan evidence", async () => {
    const result = await db.query(`
      SELECT blob."status", count(scan."id")::INTEGER AS "scan_count"
      FROM "blobs" AS blob
      LEFT JOIN "blob_scans" AS scan ON scan."blob_id" = blob."id"
      WHERE blob."id" = 'blob-unscanned-ready'
      GROUP BY blob."status"
    `);
    assert.deepEqual(result.rows[0], { status: "ready", scan_count: 0 });
  });

  await expectReject(db, "only one active Blob generation may own a SHA-256", async () => {
    await insertBlob(db, {
      sha256: "6".repeat(64),
      generation: 2,
    });
  }, constraint("23505", "blobs_active_sha256_key"));

  await expectAccept(db, "deleted Blob SHA-256 may advance to a new generation", async () => {
    await insertBlob(db, {
      id: "candidate-blob-generation-one",
      sha256: "06".repeat(32),
      storageKey: "constraint/candidate-generation-one",
      generation: 1,
    });
    await softDeleteBlob(db, "candidate-blob-generation-one");
    await insertBlob(db, {
      id: "candidate-blob-generation-two",
      sha256: "06".repeat(32),
      storageKey: "constraint/candidate-generation-two",
      generation: 2,
    });
    const result = await db.query(`
      SELECT "generation", "status"
      FROM "blobs"
      WHERE "sha256" = repeat('06', 32)
      ORDER BY "generation"
    `);
    assert.deepEqual(result.rows, [
      { generation: 1, status: "deleted" },
      { generation: 2, status: "pending" },
    ]);
  });

  await expectReject(db, "Blob SHA-256 generation identity cannot repeat", async () => {
    await insertBlob(db, {
      id: "candidate-blob-generation-one",
      sha256: "06".repeat(32),
      storageKey: "constraint/candidate-generation-one",
      generation: 1,
    });
    await softDeleteBlob(db, "candidate-blob-generation-one");
    await insertBlob(db, {
      id: "candidate-blob-generation-repeat",
      sha256: "06".repeat(32),
      storageKey: "constraint/candidate-generation-repeat",
      generation: 1,
    });
  }, constraint("23505", "blobs_sha256_generation_key"));

  await expectReject(db, "Blob generation is immutable content identity", async () => {
    await db.query(`UPDATE "blobs" SET "generation" = 2 WHERE "id" = 'blob-ready'`);
  }, trigger("23514", "BLOB_CONTENT_IDENTITY_IMMUTABLE"));

  await expectReject(db, "clean BlobScan requires immutable terminal evidence", async () => {
    await insertBlobScan(db, {
      id: "candidate-scan-without-evidence",
      blobId: "blob-scan-candidate",
      status: "clean",
      evidence: null,
      finishedAt: new Date(),
    });
  }, constraint("23514", "blob_scans_terminal_evidence_check"));

  await expectReject(db, "BlobScan attempt is unique per Blob", async () => {
    await insertBlobScan(db, { id: "candidate-scan-one", blobId: "blob-scan-candidate" });
    await insertBlobScan(db, { id: "candidate-scan-two", blobId: "blob-scan-candidate" });
  }, constraint("23505", "blob_scans_blob_id_attempt_key"));

  await expectReject(db, "terminal BlobScan evidence is immutable", async () => {
    await db.query(`
      UPDATE "blob_scans"
      SET "evidence" = '{"verdict":"changed"}'::jsonb, "updated_at" = clock_timestamp()
      WHERE "id" = 'scan-file-only'
    `);
  }, trigger("23514", "BLOB_SCAN_TERMINAL_EVIDENCE_IMMUTABLE"));

  await expectReject(db, "terminal BlobScan evidence cannot be deleted", async () => {
    await db.query(`DELETE FROM "blob_scans" WHERE "id" = 'scan-file-only'`);
  }, trigger("23514", "BLOB_SCAN_TERMINAL_EVIDENCE_IMMUTABLE"));

  await expectReject(db, "Blob hard delete retains its scan audit trail", async () => {
    await insertBlobScan(db);
    await db.query(`DELETE FROM "blobs" WHERE "id" = 'blob-scan-candidate'`);
  }, constraint("23503", "blob_scans_blob_id_fkey"));

  await expectAccept(db, "a controlled ready Blob may receive later clean scan evidence", async () => {
    await insertBlobScan(db, {
      id: "candidate-ready-clean-scan",
      blobId: "blob-unscanned-ready",
      status: "clean",
      evidence: { verdict: "clean", signatureVersion: "later-signatures" },
      finishedAt: new Date(),
    });
    const result = await db.query(`
      SELECT "status" FROM "blob_scans"
      WHERE "id" = 'candidate-ready-clean-scan'
    `);
    assert.equal(result.rows[0]?.status, "clean");
  });

  await expectReject(db, "infected BlobScan requires an isolated storage locator", async () => {
    await insertBlobScan(db, {
      blobId: "blob-infected-candidate",
      status: "infected",
      evidence: { verdict: "infected", signature: "constraint-signature" },
      finishedAt: new Date(),
    });
  }, trigger("23514", "INFECTED_BLOB_STORAGE_NOT_ISOLATED"));

  await expectAccept(db, "infected BlobScan quarantines its pending Blob", async () => {
    await moveBlobToQuarantine(db, "blob-infected-candidate");
    await insertBlobScan(db, {
      blobId: "blob-infected-candidate",
      status: "infected",
      evidence: { verdict: "infected", signature: "constraint-signature" },
      finishedAt: new Date(),
    });
    assert.equal(await blobStatus(db, "blob-infected-candidate"), "quarantined");
  });

  await expectReject(db, "a quarantined Blob cannot begin another scan", async () => {
    await moveBlobToQuarantine(db, "blob-infected-candidate");
    await insertBlobScan(db, {
      id: "candidate-infected-first",
      blobId: "blob-infected-candidate",
      status: "infected",
      evidence: { verdict: "infected", signature: "constraint-signature" },
      finishedAt: new Date(),
    });
    await insertBlobScan(db, {
      id: "candidate-after-quarantine",
      blobId: "blob-infected-candidate",
      attempt: 2,
    });
  }, trigger("23514", "BLOB_SCAN_REQUIRES_SCANNABLE_BLOB"));

  await expectAccept(db, "later infection revokes ready Blob Files while retaining Artifact audit rows", async () => {
    await insertBlobScan(db, {
      id: "candidate-ready-initial-clean",
      blobId: "blob-ready",
      status: "clean",
      evidence: { verdict: "clean", signatureVersion: "initial-signatures" },
      finishedAt: new Date(),
    });
    await insertFileAsset(db, {
      id: "candidate-ready-file-revoked",
      blobId: "blob-ready",
      originalName: "generated.json",
      declaredMediaType: "application/json",
      detectedMediaType: "application/json",
      byteSize: 16,
      status: "ready",
      verifiedAt: new Date(),
    });
    await moveBlobToQuarantine(db, "blob-ready");
    const before = await db.query(`
      SELECT "revision" FROM "file_assets" WHERE "id" = 'candidate-ready-file-revoked'
    `);
    await insertBlobScan(db, {
      id: "candidate-ready-later-infected",
      blobId: "blob-ready",
      attempt: 2,
      status: "infected",
      evidence: { verdict: "infected", signature: "later-signature" },
      finishedAt: new Date(),
    });
    const revoked = await db.query(`
      SELECT
        blob."status" AS "blob_status",
        file."status" AS "file_status",
        file."failure_code" AS "failure_code",
        file."revision" AS "file_revision",
        version."status" AS "artifact_status",
        version."content_blob_id" AS "artifact_blob_id"
      FROM "blobs" AS blob
      JOIN "file_assets" AS file ON file."blob_id" = blob."id"
      JOIN "artifact_versions" AS version ON version."content_blob_id" = blob."id"
      WHERE blob."id" = 'blob-ready'
        AND file."id" = 'candidate-ready-file-revoked'
        AND version."id" = 'version-a-blob'
    `);
    assert.deepEqual(revoked.rows[0], {
      blob_status: "quarantined",
      file_status: "quarantined",
      failure_code: "FILE_MALWARE_DETECTED",
      file_revision: before.rows[0].revision + 1,
      artifact_status: "ready",
      artifact_blob_id: "blob-ready",
    });
  });

  await expectReject(db, "FileAsset byte size cannot be zero", async () => {
    await insertFileAsset(db, { byteSize: 0 });
  }, constraint("23514", "file_assets_byte_size_safe_integer_check"));

  await expectReject(db, "FileAsset cannot exceed the 25 MiB upload limit", async () => {
    await insertFileAsset(db, { byteSize: 26_214_401 });
  }, constraint("23514", "file_assets_byte_size_safe_integer_check"));

  await expectReject(db, "FileUploadSession cannot exceed the 25 MiB upload limit", async () => {
    await insertFileAsset(db, { id: "candidate-upload-file" });
    await insertFileUploadSession(db, { expectedByteSize: 26_214_401 });
  }, constraint("23514", "file_upload_sessions_byte_size_safe_integer_check"));

  await expectAccept(db, "25 MiB is accepted consistently across upload and Run snapshot constraints", async () => {
    const byteSize = 26_214_400;
    const sha256 = "05".repeat(32);
    await insertFileAsset(db, {
      id: "candidate-upload-file",
      originalName: "maximum-upload.bin",
      byteSize,
    });
    await insertFileUploadSession(db, { expectedByteSize: byteSize });
    await insertBlob(db, {
      id: "candidate-maximum-blob",
      sha256,
      storageKey: `blobs/05/05/${sha256}/g1`,
      byteSize,
    });
    await insertBlobScan(db, {
      id: "candidate-maximum-scan",
      blobId: "candidate-maximum-blob",
      status: "clean",
      evidence: { verdict: "clean", signatureVersion: "maximum-signatures" },
      finishedAt: new Date(),
    });
    await db.query(`
      UPDATE "blobs"
      SET "status" = 'ready', "verified_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-maximum-blob'
    `);
    await insertFileAsset(db, {
      id: "candidate-maximum-file",
      blobId: "candidate-maximum-blob",
      originalName: "maximum-ready.bin",
      detectedMediaType: "application/octet-stream",
      byteSize,
      status: "ready",
      verifiedAt: new Date(),
    });
    await insertImportSource(db, {
      id: "candidate-maximum-source",
      fileAssetId: "candidate-maximum-file",
      blobId: "candidate-maximum-blob",
      label: "maximum-ready.bin",
      path: "maximum-ready.bin",
      mediaType: "application/octet-stream",
      byteSize,
      sha256,
    });
  });

  await expectAccept(db, "FileVerificationAttempt records a successful delivery receipt", async () => {
    await insertVerificationUpload(db);
    await insertFileVerificationAttempt(db);
    await db.query(`
      UPDATE "file_verification_attempts"
      SET "status" = 'succeeded', "file_status" = 'ready',
          "finished_at" = "started_at", "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-file-verification-attempt'
    `);
    const result = await db.query(`
      SELECT "status", "file_status", "failure_code"
      FROM "file_verification_attempts"
      WHERE "id" = 'candidate-file-verification-attempt'
    `);
    assert.deepEqual(result.rows[0], {
      status: "succeeded",
      file_status: "ready",
      failure_code: null,
    });
  });

  await expectReject(db, "FileVerificationAttempt sequence is unique per upload", async () => {
    await insertVerificationUpload(db);
    await insertFileVerificationAttempt(db);
    await insertFileVerificationAttempt(db, {
      id: "candidate-file-verification-attempt-two",
      queueJobId: "constraint-file-verify-job-two",
    });
  }, constraint("23505", "file_verification_attempts_upload_session_id_sequence_key"));

  await expectReject(db, "FileVerificationAttempt delivery receipt is unique", async () => {
    await insertVerificationUpload(db);
    await insertFileVerificationAttempt(db);
    await insertFileVerificationAttempt(db, {
      id: "candidate-file-verification-attempt-two",
      sequence: 2,
    });
  }, constraint("23505", "file_verification_attempts_queue_job_id_queue_retry_count_key"));

  await expectReject(db, "FileVerificationAttempt terminal state requires matching evidence", async () => {
    await insertVerificationUpload(db);
    await insertFileVerificationAttempt(db);
    await db.query(`
      UPDATE "file_verification_attempts"
      SET "status" = 'terminal_failed', "file_status" = 'ready',
          "failure_code" = 'FILE_VERIFICATION_RETRY_EXHAUSTED',
          "finished_at" = "started_at", "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-file-verification-attempt'
    `);
  }, constraint("23514", "file_verification_attempts_state_check"));

  await expectReject(db, "FileVerificationAttempt identity is immutable", async () => {
    await insertVerificationUpload(db);
    await insertFileVerificationAttempt(db);
    await db.query(`
      UPDATE "file_verification_attempts"
      SET "queue_retry_count" = 1, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-file-verification-attempt'
    `);
  }, trigger("23514", "FILE_VERIFICATION_ATTEMPT_IDENTITY_IMMUTABLE"));

  await expectReject(db, "terminal FileVerificationAttempt is immutable", async () => {
    await insertVerificationUpload(db);
    await insertFileVerificationAttempt(db);
    await db.query(`
      UPDATE "file_verification_attempts"
      SET "status" = 'retryable_failed', "failure_code" = 'SCANNER_TIMEOUT',
          "finished_at" = "started_at", "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-file-verification-attempt'
    `);
    await db.query(`
      UPDATE "file_verification_attempts"
      SET "failure_detail" = 'changed', "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-file-verification-attempt'
    `);
  }, trigger("23514", "FILE_VERIFICATION_ATTEMPT_TERMINAL_IMMUTABLE"));

  await expectReject(db, "ready FileAsset requires latest clean scan evidence", async () => {
    await db.query(`
      UPDATE "file_assets"
      SET "status" = 'ready',
          "verified_at" = clock_timestamp(),
          "revision" = "revision" + 1,
          "updated_at" = clock_timestamp()
      WHERE "id" = 'file-unscanned-a'
    `);
  }, trigger("23514", "FILE_READY_BLOB_NOT_CLEAN"));

  await expectAccept(db, "clean-scanned Blob may become a ready FileAsset", async () => {
    await insertFileAsset(db, {
      id: "candidate-clean-file",
      blobId: "blob-file-only",
      originalName: "candidate.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      byteSize: 32,
      status: "ready",
      verifiedAt: new Date(),
    });
  });

  await expectReject(db, "FileExtraction request hash must be SHA-256", async () => {
    await insertExtraction(db, { requestHash: "invalid" });
  }, constraint("23514", "file_extractions_request_hash_format_check"));

  await expectReject(db, "FileExtraction processing attempts advance one delivery at a time", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "processing_attempts" = 2, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
  }, trigger("23514", "FILE_EXTRACTION_PROCESSING_ATTEMPTS_INVALID"));

  await expectReject(db, "queued FileExtraction cannot carry runtime state", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "processing_attempts" = 1, "submission_generation" = 1,
          "submission_started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
  }, constraint("23514", "file_extractions_runtime_status_check"));

  await expectReject(db, "running FileExtraction requires a single submission generation", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'running', "started_at" = clock_timestamp(),
          "processing_attempts" = 1, "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
  }, constraint("23514", "file_extractions_runtime_status_check"));

  await expectReject(db, "terminal FileExtraction cannot retain a worker lease", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'failed', "failure_code" = 'TEST_FAILURE',
          "finished_at" = clock_timestamp(), "lease_token" = 'job:0',
          "lease_expires_at" = clock_timestamp() + interval '1 minute',
          "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
  }, constraint("23514", "file_extractions_runtime_status_check"));

  await expectReject(db, "FileExtraction idempotency receipt is unique per File", async () => {
    await insertExtraction(db, {
      attempt: 2,
      idempotencyKey: "extract-ready-a",
    });
  }, constraint("23505", "file_extractions_file_asset_id_idempotency_key_key"));

  await expectReject(db, "FileExtraction requires a ready clean-scanned source", async () => {
    await insertExtraction(db, {
      fileAssetId: "file-unscanned-a",
      sourceBlobId: "blob-unscanned-ready",
    });
  }, trigger("23514", "FILE_EXTRACTION_SOURCE_NOT_READY"));

  await expectAccept(db, "FileExtraction mutations advance File revision", async () => {
    const before = await fileRevision(db, "file-only-a");
    await insertExtraction(db, {
      fileAssetId: "file-only-a",
      sourceBlobId: "blob-file-only",
    });
    assert.equal(await fileRevision(db, "file-only-a"), before + 1);

    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'running', "started_at" = clock_timestamp(),
          "processing_attempts" = 1, "submission_generation" = 1,
          "submission_started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
    assert.equal(await fileRevision(db, "file-only-a"), before + 2);

    await insertExtractionOutput(db);
    assert.equal(await fileRevision(db, "file-only-a"), before + 3);
  });

  await expectReject(db, "FileExtraction output requires ready non-empty Blob", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'running', "started_at" = clock_timestamp(),
          "processing_attempts" = 1, "submission_generation" = 1,
          "submission_started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
    await insertExtractionOutput(db, { blobId: "blob-output-pending" });
  }, trigger("23514", "FILE_EXTRACTION_OUTPUT_BLOB_NOT_READY"));

  await expectReject(db, "ready FileExtraction requires at least one normalized output", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'running', "started_at" = clock_timestamp(),
          "processing_attempts" = 1, "submission_generation" = 1,
          "submission_started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'ready', "content_sha256" = repeat('9', 64),
          "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
  }, trigger("23514", "FILE_EXTRACTION_READY_OUTPUT_INVALID"));

  await expectAccept(db, "ready FileExtraction accepts multiple normalized outputs", async () => {
    await insertExtraction(db);
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'running', "started_at" = clock_timestamp(),
          "processing_attempts" = 1, "submission_generation" = 1,
          "submission_started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
    await insertExtractionOutput(db, { kind: "markdown", position: 0 });
    await insertExtractionOutput(db, { kind: "markdown", position: 1 });
    await db.query(`
      UPDATE "file_extractions"
      SET "status" = 'ready', "content_sha256" = repeat('9', 64),
          "finished_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" = 'candidate-extraction'
    `);
  });

  await expectReject(db, "ready FileExtraction output is immutable", async () => {
    await db.query(`
      UPDATE "file_extraction_outputs"
      SET "metadata" = '{"changed":true}'::jsonb
      WHERE "extraction_id" = 'extraction-ready-a' AND "kind" = 'markdown' AND "position" = 0
    `);
  }, trigger("23514", "FILE_EXTRACTION_OUTPUT_IMMUTABLE"));

  await expectReject(db, "FileExtraction output identity cannot move between attempts", async () => {
    await db.query(`
      UPDATE "file_extraction_outputs"
      SET "position" = 1
      WHERE "extraction_id" = 'extraction-ready-a' AND "kind" = 'markdown' AND "position" = 0
    `);
  }, trigger("23514", "FILE_EXTRACTION_OUTPUT_IDENTITY_IMMUTABLE"));

  await expectReject(db, "terminal FileExtraction is immutable", async () => {
    await db.query(`
      UPDATE "file_extractions"
      SET "metadata" = '{"changed":true}'::jsonb, "updated_at" = clock_timestamp()
      WHERE "id" = 'extraction-ready-a'
    `);
  }, trigger("23514", "FILE_EXTRACTION_TERMINAL_STATE_IMMUTABLE"));

  await expectReject(db, "Import Source rejects a File that is not ready", async () => {
    await insertFileAsset(db, {
      id: "candidate-not-ready-file",
      blobId: "blob-file-only",
      originalName: "not-ready.txt",
      declaredMediaType: "text/plain",
      detectedMediaType: "text/plain",
      byteSize: 32,
      status: "verifying",
    });
    await insertImportSource(db, {
      fileAssetId: "candidate-not-ready-file",
      label: "not-ready.txt",
      path: "not-ready.txt",
    });
  }, trigger("23514", "IMPORT_SOURCE_FILE_NOT_READY"));

  await expectReject(db, "Import Source manifest cannot be appended after ready", async () => {
    await insertImportSourceBlob(db, {
      id: "candidate-source-blob-after-ready",
      importSourceId: "source-attachment-a",
      position: 1,
      fileAssetId: "file-only-a",
      blobId: "blob-file-only",
      path: "plain.txt",
      mediaType: "text/plain",
      byteSize: 32,
      sha256: "a".repeat(64),
    });
  }, trigger("23514", "IMPORT_SOURCE_MANIFEST_FROZEN"));

  await expectReject(db, "pending external Import Source requires a queued attempt receipt", async () => {
    await insertPendingExternalImportSource(db, {
      id: "candidate-external-no-attempt",
      idempotencyKey: "constraint-external-no-attempt",
    });
  }, trigger("23514", "IMPORT_SOURCE_ATTEMPT_RECEIPT_MISSING"));

  await expectReject(db, "local Import Source cannot create an external attempt", async () => {
    await insertImportSourceAttempt(db, {
      id: "candidate-local-source-attempt",
      importSourceId: "source-attachment-a",
      queueJobId: "candidate-local-source-attempt-job",
    });
  }, trigger("23514", "IMPORT_SOURCE_ATTEMPT_LOCAL_SOURCE_INVALID"));

  await expectReject(db, "external Import Source attempts must be contiguous", async () => {
    await insertPendingExternalImportSource(db, {
      id: "candidate-external-attempt-gap",
      idempotencyKey: "constraint-external-attempt-gap",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-external-attempt-gap-1",
      importSourceId: "candidate-external-attempt-gap",
      queueJobId: "candidate-external-attempt-gap-job-1",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-external-attempt-gap-3",
      importSourceId: "candidate-external-attempt-gap",
      attempt: 3,
      queueJobId: "candidate-external-attempt-gap-job-3",
    });
  }, trigger("23514", "IMPORT_SOURCE_ATTEMPT_SEQUENCE_INVALID"));

  await expectReject(db, "terminal external Import Source attempt is immutable", async () => {
    await insertPendingExternalImportSource(db, {
      id: "candidate-external-terminal-attempt",
      idempotencyKey: "constraint-external-terminal-attempt",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-external-terminal-attempt-1",
      importSourceId: "candidate-external-terminal-attempt",
      queueJobId: "candidate-external-terminal-attempt-job-1",
    });
    await succeedImportSourceAttempt(db, "candidate-external-terminal-attempt-1");
    await db.query(`
      UPDATE "import_source_attempts"
      SET "updated_at" = clock_timestamp() + interval '1 second'
      WHERE "id" = 'candidate-external-terminal-attempt-1'
    `);
  }, trigger("23514", "IMPORT_SOURCE_ATTEMPT_TERMINAL_IMMUTABLE"));

  await expectReject(db, "ready GitHub Import Source requires a pinned commit SHA", async () => {
    await insertPendingExternalImportSource(db, {
      id: "candidate-github-unpinned",
      kind: "github_snapshot",
      label: "owner/repository",
      request: { kind: "github_snapshot", repository: "owner/repository", ref: "main" },
      idempotencyKey: "constraint-github-unpinned",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-github-unpinned-attempt",
      importSourceId: "candidate-github-unpinned",
      queueJobId: "candidate-github-unpinned-job",
    });
    await succeedImportSourceAttempt(db, "candidate-github-unpinned-attempt");
    await insertExternalImportSourceBlob(db, "candidate-github-unpinned", "repository/index.html");
    await markExternalImportSourceReady(db, {
      id: "candidate-github-unpinned",
      descriptor: {
        kind: "github_snapshot",
        repository: "owner/repository",
        snapshotId: "candidate-github-snapshot",
      },
    });
  }, trigger("23514", "IMPORT_SOURCE_GITHUB_COMMIT_NOT_PINNED"));

  await expectReject(db, "ready Figma Import Source requires a pinned version", async () => {
    await insertPendingExternalImportSource(db, {
      id: "candidate-figma-unpinned",
      kind: "figma_snapshot",
      label: "Figma design",
      request: { kind: "figma_snapshot", fileKey: "figma-file-key" },
      idempotencyKey: "constraint-figma-unpinned",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-figma-unpinned-attempt",
      importSourceId: "candidate-figma-unpinned",
      queueJobId: "candidate-figma-unpinned-job",
    });
    await succeedImportSourceAttempt(db, "candidate-figma-unpinned-attempt");
    await insertExternalImportSourceBlob(db, "candidate-figma-unpinned", "figma.json");
    await markExternalImportSourceReady(db, {
      id: "candidate-figma-unpinned",
      descriptor: {
        kind: "figma_snapshot",
        fileKey: "figma-file-key",
        snapshotId: "candidate-figma-snapshot",
      },
    });
  }, trigger("23514", "IMPORT_SOURCE_FIGMA_VERSION_NOT_PINNED"));

  await expectReject(db, "ready external Import Source requires a succeeded attempt receipt", async () => {
    await insertPendingExternalImportSource(db, {
      id: "candidate-url-without-success",
      idempotencyKey: "constraint-url-without-success",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-url-without-success-attempt",
      importSourceId: "candidate-url-without-success",
      queueJobId: "candidate-url-without-success-job",
    });
    await insertExternalImportSourceBlob(db, "candidate-url-without-success", "snapshot.html");
    await markExternalImportSourceReady(db, {
      id: "candidate-url-without-success",
      descriptor: {
        kind: "url_snapshot",
        sourceUrl: "https://example.com/",
        resolvedUrl: "https://example.com/",
        snapshotId: "candidate-url-snapshot",
      },
    });
  }, trigger("23514", "IMPORT_SOURCE_SUCCESS_RECEIPT_MISSING"));

  await expectReject(db, "Run source snapshots cap the total materialized manifest at fifty blobs", async () => {
    await db.query(`
      INSERT INTO "blobs" (
        "id", "sha256", "storage_key", "media_type", "byte_size", "status",
        "verified_at", "updated_at"
      )
      SELECT
        'candidate-source-limit-blob-' || item,
        encode(public.digest('candidate-source-limit-' || item, 'sha256'), 'hex'),
        'constraint/candidate-source-limit/' || item,
        'text/plain', 10 + item, 'pending', NULL, clock_timestamp()
      FROM generate_series(0, 49) AS series(item)
    `);
    await db.query(`
      INSERT INTO "blob_scans" (
        "id", "blob_id", "attempt", "status", "scanner", "scanner_version",
        "signature_version", "evidence", "finished_at", "updated_at"
      )
      SELECT
        'candidate-source-limit-scan-' || item,
        'candidate-source-limit-blob-' || item,
        1, 'clean', 'constraint-scanner', '1.0.0', 'test-signatures',
        '{"verdict":"clean"}'::jsonb, clock_timestamp(), clock_timestamp()
      FROM generate_series(0, 49) AS series(item)
    `);
    await db.query(`
      UPDATE "blobs"
      SET "status" = 'ready', "verified_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE "id" LIKE 'candidate-source-limit-blob-%'
    `);
    await insertPendingExternalImportSource(db, {
      id: "candidate-source-limit",
      idempotencyKey: "constraint-source-limit",
    });
    await insertImportSourceAttempt(db, {
      id: "candidate-source-limit-attempt",
      importSourceId: "candidate-source-limit",
      queueJobId: "candidate-source-limit-job",
    });
    await succeedImportSourceAttempt(db, "candidate-source-limit-attempt");
    await db.query(`
      INSERT INTO "import_source_blobs" (
        "id", "import_source_id", "project_id", "position", "blob_id",
        "file_asset_id", "role", "path", "media_type", "byte_size", "sha256"
      )
      SELECT
        'candidate-source-limit-entry-' || item,
        'candidate-source-limit', 'project-a', item,
        'candidate-source-limit-blob-' || item,
        NULL, 'snapshot', 'snapshot/' || item || '.txt', 'text/plain',
        10 + item,
        encode(public.digest('candidate-source-limit-' || item, 'sha256'), 'hex')
      FROM generate_series(0, 49) AS series(item)
    `);
    await markExternalImportSourceReady(db, {
      id: "candidate-source-limit",
      descriptor: {
        kind: "url_snapshot",
        sourceUrl: "https://example.com/",
        resolvedUrl: "https://example.com/",
      },
    });
    await insertRun(db, {
      threadId: "thread-retry-a",
      status: "queued",
      request: typedRunRequest({ sourceIds: ["source-attachment-a", "candidate-source-limit"] }),
    });
    await insertRunSourceSnapshot(db);
    await db.query(`
      INSERT INTO "run_source_snapshots" (
        "id", "run_id", "project_id", "position", "source_id", "kind", "label",
        "checksum", "descriptor", "snapshot"
      )
      SELECT
        'candidate-run-source-limit', 'candidate-run', 'project-a', 1,
        source."id", source."kind", source."label", source."checksum", source."descriptor",
        jsonb_build_object(
          'protocol', 'workbench.import-source-snapshot.v1',
          'sourceRevision', source."revision",
          'checksum', source."checksum",
          'blobs', (
            SELECT jsonb_agg(jsonb_build_object(
              'position', blob."position",
              'blobId', blob."blob_id",
              'role', blob."role",
              'path', blob."path",
              'mediaType', blob."media_type",
              'byteSize', blob."byte_size",
              'sha256', blob."sha256"
            ) ORDER BY blob."position")
            FROM "import_source_blobs" AS blob
            WHERE blob."import_source_id" = source."id"
          )
        )
      FROM "import_sources" AS source
      WHERE source."id" = 'candidate-source-limit'
    `);
  }, trigger("23514", "RUN_SOURCE_SNAPSHOT_BLOB_LIMIT_EXCEEDED"));

  await expectReject(db, "Run source snapshot rejects forged metadata", async () => {
    await insertRun(db, {
      threadId: "thread-retry-a",
      status: "queued",
      request: typedRunRequest({ sourceIds: ["source-attachment-a"] }),
    });
    await insertRunSourceSnapshot(db, { runId: "candidate-run", label: "forged.png" });
  }, trigger("23514", "RUN_SOURCE_SNAPSHOT_SOURCE_MISMATCH"));

  await expectReject(db, "Run source snapshot cannot be appended after Run starts", async () => {
    await db.query(`UPDATE "runs" SET "status" = 'running' WHERE "id" = 'run-a'`);
    await insertRunSourceSnapshot(db, {
      id: "candidate-running-run-source",
      runId: "run-a",
      position: 1,
    });
  }, trigger("23514", "RUN_SOURCE_SNAPSHOT_RUN_NOT_QUEUED"));

  await expectAccept(db, "ready Import Source can be reused by another Run snapshot", async () => {
    await insertRun(db, {
      threadId: "thread-retry-a",
      status: "queued",
      request: typedRunRequest({ sourceIds: ["source-attachment-a"] }),
    });
    await insertRunSourceSnapshot(db);
  });

  await expectAccept(db, "soft-deleting an Import Source preserves its existing Run snapshot", async () => {
    await db.query(`
      UPDATE "import_sources"
      SET "status" = 'deleted', "deleted_at" = clock_timestamp(),
          "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = 'source-attachment-a'
    `);
    const snapshot = await db.query(`
      SELECT "source_id", "checksum", "snapshot"
      FROM "run_source_snapshots"
      WHERE "run_id" = 'run-a' AND "position" = 0
    `);
    assert.equal(snapshot.rowCount, 1);
    assert.equal(snapshot.rows[0].source_id, "source-attachment-a");
    assert.equal(snapshot.rows[0].checksum, "d".repeat(64));
    assert.equal(snapshot.rows[0].snapshot.protocol, "workbench.import-source-snapshot.v1");
  });

  await expectAccept(db, "Import Source freezes a verified File independently of Extraction state", async () => {
    await insertImportSource(db, {
      id: "candidate-extraction-source",
      fileAssetId: "file-extraction-a",
      blobId: "blob-extraction-source",
      label: "source.pdf",
      path: "source.pdf",
      mediaType: "application/pdf",
      byteSize: 64,
      sha256: "b".repeat(64),
    });
  });

  await expectReject(db, "Run source snapshot cannot be updated", async () => {
    await db.query(`
      UPDATE "run_source_snapshots" SET "label" = 'changed.png'
      WHERE "run_id" = 'run-a' AND "position" = 0
    `);
  }, trigger("23514", "RUN_SOURCE_SNAPSHOT_IMMUTABLE"));

  await expectReject(db, "Run source snapshot cannot be manually deleted", async () => {
    await db.query(`DELETE FROM "run_source_snapshots" WHERE "run_id" = 'run-a' AND "position" = 0`);
  }, trigger("23514", "RUN_SOURCE_SNAPSHOT_IMMUTABLE"));

  await expectReject(db, "GC cannot soft-delete a FileAsset Blob", async () => {
    await softDeleteBlob(db, "blob-file-only");
  }, trigger("23503", "BLOB_REFERENCED_BY_FILE_ASSET"));

  await expectReject(db, "GC cannot soft-delete a FileExtraction output Blob", async () => {
    await softDeleteBlob(db, "blob-extraction-output");
  }, trigger("23503", "BLOB_REFERENCED_BY_FILE_EXTRACTION"));

  await expectReject(db, "GC cannot soft-delete an Import Source Blob", async () => {
    await softDeleteBlob(db, "blob-attachment");
  }, trigger("23503", "BLOB_REFERENCED_BY_IMPORT_SOURCE"));

  await expectReject(db, "GC cannot soft-delete a KnowledgeDocument Blob", async () => {
    await softDeleteBlob(db, "blob-knowledge");
  }, trigger("23503", "BLOB_REFERENCED_BY_KNOWLEDGE_DOCUMENT"));

  await expectReject(db, "active FileAsset cannot skip soft-delete retention", async () => {
    await db.query(`DELETE FROM "file_assets" WHERE "id" = 'file-only-a'`);
  }, trigger("23514", "FILE_ASSET_MUST_BE_SOFT_DELETED"));

  await expectReject(db, "soft-deleted FileAsset retains Blob during delay window", async () => {
    await softDeleteFile(db, "file-only-a");
    await softDeleteBlob(db, "blob-file-only");
  }, trigger("23503", "BLOB_REFERENCED_BY_FILE_ASSET"));

  await expectAccept(db, "expired unreferenced FileAsset releases Blob for next generation", async () => {
    await softDeleteFile(db, "file-only-a");
    await db.query(`DELETE FROM "file_assets" WHERE "id" = 'file-only-a'`);
    await softDeleteBlob(db, "blob-file-only");
    await insertBlob(db, {
      id: "blob-file-only-next-generation",
      sha256: "a".repeat(64),
      storageKey: "constraint/blob-file-only-next-generation",
      mediaType: "text/plain",
      byteSize: 32,
      generation: 2,
    });
  });

  await expectAccept(db, "expired FileAsset purges terminal Extraction references", async () => {
    await softDeleteFile(db, "file-extraction-a");
    await db.query(`DELETE FROM "file_assets" WHERE "id" = 'file-extraction-a'`);
    const extraction = await db.query(`
      SELECT 1 FROM "file_extractions" WHERE "id" = 'extraction-ready-a'
    `);
    const output = await db.query(`
      SELECT 1 FROM "file_extraction_outputs" WHERE "extraction_id" = 'extraction-ready-a'
    `);
    assert.equal(extraction.rowCount, 0);
    assert.equal(output.rowCount, 0);
    await softDeleteBlob(db, "blob-extraction-source");
    await softDeleteBlob(db, "blob-extraction-output");
  });

  await expectReject(db, "Import Source prevents expired FileAsset purge", async () => {
    await softDeleteFile(db, "file-attachment-a");
    await db.query(`DELETE FROM "file_assets" WHERE "id" = 'file-attachment-a'`);
  }, constraint("23503", "import_source_blobs_file_asset_fkey"));

  await expectReject(db, "KnowledgeDocument source Blob uses RESTRICT on hard delete", async () => {
    await db.query(`
      INSERT INTO "blobs" (
        "id", "sha256", "storage_key", "media_type", "byte_size", "status",
        "verified_at", "updated_at"
      ) VALUES (
        'candidate-knowledge-blob', repeat('05', 32), 'constraint/candidate-knowledge-blob',
        'text/plain', 12, 'ready', clock_timestamp(), clock_timestamp()
      )
    `);
    await insertKnowledgeDocument(db, {
      sourceKind: "storage_asset",
      sourceBlobId: "candidate-knowledge-blob",
    });
    await db.query(`DELETE FROM "blobs" WHERE "id" = 'candidate-knowledge-blob'`);
  }, constraint("23503", "knowledge_documents_source_blob_id_fkey"));

  await expectReject(db, "project_upload KnowledgeDocument requires a source Blob", async () => {
    await insertKnowledgeDocument(db, { sourceBlobId: null });
  }, trigger("23514", "KNOWLEDGE_PROJECT_UPLOAD_BLOB_REQUIRED"));

  await expectReject(db, "project_upload KnowledgeDocument requires clean scan evidence", async () => {
    await insertKnowledgeDocument(db, { sourceBlobId: "blob-unscanned-ready" });
  }, trigger("23514", "KNOWLEDGE_PROJECT_UPLOAD_BLOB_NOT_CLEAN"));

  await expectAccept(db, "project_upload KnowledgeDocument accepts a clean-scanned Blob", async () => {
    await insertKnowledgeDocument(db);
  });

  await expectAccept(db, "non-upload KnowledgeDocument does not require scan evidence", async () => {
    await insertKnowledgeDocument(db, {
      sourceKind: "storage_asset",
      sourceBlobId: "blob-unscanned-ready",
    });
  });

  await expectAccept(db, "KnowledgeRelease logical key may advance to a new version", async () => {
    await insertKnowledgeRelease(db, { version: 2 });
  });

  await expectReject(db, "KnowledgeRelease logical key and version are unique", async () => {
    await insertKnowledgeRelease(db, { version: 1 });
  }, constraint("23505", "knowledge_releases_key_version_key"));

  await expectReject(db, "published KnowledgeRelease manifest is immutable", async () => {
    await db.query(`
      UPDATE "knowledge_releases"
      SET "manifest" = '{"changed":true}'::jsonb
      WHERE "id" = 'release-content-a'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE"));

  await expectReject(db, "published KnowledgeRelease cannot accept a new Document", async () => {
    await insertKnowledgeDocument(db, {
      releaseId: "release-content-a",
      sourceKind: "vault_markdown",
      sourceBlobId: null,
    });
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));

  await expectReject(db, "published KnowledgeDocument is immutable", async () => {
    await db.query(`
      UPDATE "knowledge_documents" SET "title" = 'Changed'
      WHERE "id" = 'knowledge-doc-ready'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));

  await expectReject(db, "published KnowledgeDocument cannot be deleted", async () => {
    await db.query(`DELETE FROM "knowledge_documents" WHERE "id" = 'knowledge-doc-ready'`);
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));

  await expectReject(db, "published KnowledgeChunk is immutable", async () => {
    await db.query(`
      UPDATE "knowledge_chunks" SET "content" = 'Changed'
      WHERE "id" = 'knowledge-chunk-ready'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));

  await expectReject(db, "published KnowledgeChunk cannot be deleted", async () => {
    await db.query(`DELETE FROM "knowledge_chunks" WHERE "id" = 'knowledge-chunk-ready'`);
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));

  await expectAccept(db, "KnowledgeChunk no longer contains provider-specific vector columns", async () => {
    const columns = await db.query(`
      SELECT "column_name"
      FROM information_schema.columns
      WHERE "table_schema" = 'workbench'
        AND "table_name" = 'knowledge_chunks'
        AND "column_name" IN ('embedding', 'embedding_model')
    `);
    assert.equal(columns.rowCount, 0);
  });

  await expectReject(db, "KnowledgeEmbeddingBatch must start pending with zero attempts", async () => {
    await insertKnowledgeEmbeddingBatch(db, {
      status: "running",
      attemptCount: 1,
      leaseToken: "constraint-initial-lease",
      queueJobId: "constraint-initial-job",
      queueRetryCount: 0,
      startedAt: new Date(),
    });
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_INITIAL_STATE_INVALID"));

  await expectAccept(db, "KnowledgeEmbeddingBatch follows the recoverable pending-running-ready lifecycle", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "status" = 'running', "attempt_count" = 1,
          "lease_token" = 'constraint-lifecycle-lease-1',
          "queue_job_id" = 'constraint-lifecycle-job-1', "queue_retry_count" = 0,
          "started_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "status" = 'pending', "lease_token" = NULL, "queue_job_id" = NULL,
          "queue_retry_count" = NULL, "started_at" = NULL
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "status" = 'running', "attempt_count" = 2,
          "lease_token" = 'constraint-lifecycle-lease-2',
          "queue_job_id" = 'constraint-lifecycle-job-2', "queue_retry_count" = 1,
          "started_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "status" = 'ready', "lease_token" = NULL, "token_count" = 3,
          "output_sha256" = repeat('8', 64), "finished_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
    const state = await db.query(`
      SELECT "status", "attempt_count" AS "attemptCount"
      FROM "knowledge_embedding_batches"
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
    assert.deepEqual(state.rows, [{ status: "ready", attemptCount: 2 }]);
  });

  await expectReject(db, "KnowledgeEmbeddingBatch cannot skip running", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "status" = 'ready', "queue_job_id" = 'constraint-skip-job',
          "queue_retry_count" = 0, "token_count" = 3,
          "output_sha256" = repeat('8', 64), "started_at" = clock_timestamp(),
          "finished_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_STATUS_TRANSITION_INVALID"));

  await expectReject(db, "KnowledgeEmbeddingBatch attempt increments exactly once per claim", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "status" = 'running', "attempt_count" = 2,
          "lease_token" = 'constraint-attempt-lease',
          "queue_job_id" = 'constraint-attempt-job', "queue_retry_count" = 0,
          "started_at" = clock_timestamp()
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_ATTEMPT_INVALID"));

  await expectReject(db, "KnowledgeEmbeddingBatch rejects duplicate chunk ids within one batch", async () => {
    await insertKnowledgeEmbeddingBatch(db, {
      chunkIds: ["knowledge-chunk-building", "knowledge-chunk-building"],
      inputCount: 2,
    });
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_CHUNKS_INVALID"));

  await expectReject(db, "KnowledgeEmbeddingBatch rejects a chunk already owned by another batch", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await insertKnowledgeEmbeddingBatch(db, {
      id: "candidate-overlapping-knowledge-embedding-batch",
      sequence: 1,
      inputSha256: "8".repeat(64),
    });
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_CHUNKS_INVALID"));

  await expectReject(db, "ready KnowledgeEmbeddingBatch is immutable", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await advanceKnowledgeEmbeddingBatchToReady(db);
    await db.query(`
      UPDATE "knowledge_embedding_batches"
      SET "token_count" = 4
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_READY_IMMUTABLE"));

  await expectReject(db, "ready KnowledgeEmbeddingBatch cannot be deleted", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await advanceKnowledgeEmbeddingBatchToReady(db);
    await db.query(`
      DELETE FROM "knowledge_embedding_batches"
      WHERE "id" = 'candidate-knowledge-embedding-batch'
    `);
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_BATCH_READY_IMMUTABLE"));

  await expectReject(db, "KnowledgeRelease cannot publish with an unfinished embedding batch", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await db.query(`
      UPDATE "knowledge_releases"
      SET "status" = 'ready', "chunks_ready_at" = clock_timestamp(),
          "ready_at" = clock_timestamp()
      WHERE "id" = 'release-building-a'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_EMBEDDING_BATCHES_INCOMPLETE"));

  await expectReject(db, "KnowledgeRelease finalizer requires one embedding for every batched chunk", async () => {
    await insertKnowledgeEmbeddingBatch(db);
    await advanceKnowledgeEmbeddingBatchToReady(db);
    await db.query(`
      UPDATE "knowledge_releases"
      SET "status" = 'ready', "chunks_ready_at" = clock_timestamp(),
          "ready_at" = clock_timestamp()
      WHERE "id" = 'release-building-a'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_EMBEDDING_INCOMPLETE"));

  await expectAccept(db, "KnowledgeChunkEmbedding stores a second profile dimension without a new table", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-embedding-4-r1",
      dimension: 4,
      specSha256: "1".repeat(64),
    });
    await insertRetrievalProfile(db, {
      id: "constraint-retrieval-4-r1",
      specSha256: "8".repeat(64),
      embeddingProfileId: "constraint-embedding-4-r1",
      embeddingProfileSpecSha256: "1".repeat(64),
      embeddingDimension: 4,
    });
    await insertKnowledgeRelease(db, {
      id: "constraint-embedding-4-release",
      key: "constraint-embedding-4-release",
      embeddingProfileId: "constraint-embedding-4-r1",
      embeddingProfileSpecSha256: "1".repeat(64),
      embeddingDimension: 4,
      retrievalProfileId: "constraint-retrieval-4-r1",
      retrievalProfileSpecSha256: "8".repeat(64),
    });
    await db.query(`
      INSERT INTO "knowledge_documents" (
        "id", "release_id", "source_kind", "source_path", "title", "checksum",
        "route", "source_blob_id", "metadata"
      ) VALUES (
        'knowledge-doc-embedding-4', 'constraint-embedding-4-release', 'vault_markdown',
        '00-embedding-4.md', 'Embedding 4', repeat('1', 64), 'production', NULL, '{}'::jsonb
      );
      INSERT INTO "knowledge_chunks" (
        "id", "document_id", "release_id", "sequence", "heading_path", "content", "token_count"
      ) VALUES (
        'knowledge-chunk-embedding-4', 'knowledge-doc-embedding-4', 'constraint-embedding-4-release',
        0, '[]'::jsonb, 'Embedding four', 2
      );
    `);
    await insertKnowledgeChunkEmbedding(db, {
      chunkId: "knowledge-chunk-embedding-4",
      releaseId: "constraint-embedding-4-release",
      profileId: "constraint-embedding-4-r1",
      profileSpecSha256: "1".repeat(64),
      dimension: 4,
      embedding: "[1,0,0,0]",
    });
  });

  await expectReject(db, "EmbeddingProfile spec id must match its row identity", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-profile-row-id",
      specId: "constraint-profile-other-id",
    });
  }, constraint("23514", "embedding_profiles_spec_id_check"));

  await expectReject(db, "EmbeddingProfile spec dimension must match its relational dimension", async () => {
    await insertEmbeddingProfile(db, { dimension: 4, specDimension: 3 });
  }, constraint("23514", "embedding_profiles_spec_dimension_check"));

  await expectReject(db, "EmbeddingProfile must start as a candidate", async () => {
    await insertEmbeddingProfile(db, { initialStatus: "adopted" });
  }, trigger("23514", "EMBEDDING_PROFILE_INITIAL_STATUS_INVALID"));

  await expectReject(db, "EmbeddingProfile spec is immutable", async () => {
    await db.query(`
      UPDATE "embedding_profiles"
      SET "spec" = jsonb_set("spec", '{model,revision}', '"revision-2"'::jsonb)
      WHERE "id" = 'constraint-embedding-3-r1'
    `);
  }, trigger("23514", "EMBEDDING_PROFILE_SPEC_IMMUTABLE"));

  await expectReject(db, "EmbeddingProfile lifecycle cannot regress", async () => {
    await db.query(`
      UPDATE "embedding_profiles"
      SET "status" = 'candidate'
      WHERE "id" = 'constraint-embedding-3-r1'
    `);
  }, trigger("23514", "EMBEDDING_PROFILE_STATUS_TRANSITION_INVALID"));

  await expectReject(db, "EmbeddingProfile cannot be deleted", async () => {
    await db.query(`DELETE FROM "embedding_profiles" WHERE "id" = 'constraint-embedding-3-r1'`);
  }, trigger("23514", "EMBEDDING_PROFILE_IMMUTABLE"));

  await expectReject(db, "Knowledge Profile operator audit events are immutable", async () => {
    await db.query(`
      UPDATE "knowledge_profile_operator_events"
      SET "authorized_by" = 'changed.approver'
      WHERE "change_reference" = 'CONSTRAINT-SEED-OPERATOR'
    `);
  }, trigger("23514", "KNOWLEDGE_PROFILE_OPERATOR_EVENT_IMMUTABLE"));

  await expectReject(db, "EmbeddingProfile adoption requires an atomic receipt", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-unreceipted-embedding-r1",
      specSha256: "6".repeat(64),
      status: "poc",
    });
    await db.query(`
      UPDATE "embedding_profiles"
      SET "status" = 'adopted'
      WHERE "id" = 'constraint-unreceipted-embedding-r1'
    `);
  }, trigger("23514", "EMBEDDING_PROFILE_ADOPTION_RECEIPT_REQUIRED"));

  await expectReject(db, "Knowledge Profile adoption receipt actor must be an active operator", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-unauthorized-adoption-r1",
      specSha256: "7".repeat(64),
      status: "poc",
    });
    await db.query(`
      UPDATE "embedding_profiles"
      SET "status" = 'adopted'
      WHERE "id" = 'constraint-unauthorized-adoption-r1';
      INSERT INTO "knowledge_profile_adoption_receipts" (
        "id", "profile_kind", "profile_version", "embedding_profile_id",
        "embedding_profile_spec_sha256", "actor_principal_id", "scope"
      ) VALUES (
        'adoption-unauthorized', 'embedding', 1,
        'constraint-unauthorized-adoption-r1', repeat('7', 64), 'principal-b', 'global'
      )
    `);
  }, trigger("23514", "KNOWLEDGE_PROFILE_ADOPTION_ACTOR_UNAUTHORIZED"));

  await expectReject(db, "Knowledge Profile adoption receipts cannot be updated", async () => {
    await db.query(`
      UPDATE "knowledge_profile_adoption_receipts"
      SET "actor_principal_id" = 'principal-b'
      WHERE "id" = 'adoption-constraint-embedding-3-r1'
    `);
  }, trigger("23514", "KNOWLEDGE_PROFILE_ADOPTION_RECEIPT_IMMUTABLE"));

  await expectReject(db, "Knowledge Profile adoption receipts cannot be deleted", async () => {
    await db.query(`
      DELETE FROM "knowledge_profile_adoption_receipts"
      WHERE "id" = 'adoption-constraint-retrieval-r1'
    `);
  }, trigger("23514", "KNOWLEDGE_PROFILE_ADOPTION_RECEIPT_IMMUTABLE"));

  await expectReject(db, "RetrievalProfile spec id must match its row identity", async () => {
    await insertRetrievalProfile(db, {
      id: "constraint-retrieval-row-id",
      specId: "constraint-retrieval-other-id",
    });
  }, constraint("23514", "retrieval_profiles_spec_id_check"));

  await expectReject(db, "RetrievalProfile spec embedding identity must match its relational pin", async () => {
    await insertRetrievalProfile(db, {
      specEmbeddingProfileId: "constraint-forged-embedding-r1",
    });
  }, constraint("23514", "retrieval_profiles_spec_embedding_profile_id_check"));

  await expectReject(db, "RetrievalProfile must start as a candidate", async () => {
    await insertRetrievalProfile(db, { initialStatus: "adopted" });
  }, trigger("23514", "RETRIEVAL_PROFILE_INITIAL_STATUS_INVALID"));

  await expectReject(db, "RetrievalProfile spec is immutable", async () => {
    await db.query(`
      UPDATE "retrieval_profiles"
      SET "spec" = jsonb_set("spec", '{recall,fusion,k}', '80'::jsonb)
      WHERE "id" = 'constraint-retrieval-r1'
    `);
  }, trigger("23514", "RETRIEVAL_PROFILE_SPEC_IMMUTABLE"));

  await expectReject(db, "RetrievalProfile lifecycle cannot regress", async () => {
    await db.query(`
      UPDATE "retrieval_profiles"
      SET "status" = 'candidate'
      WHERE "id" = 'constraint-retrieval-r1'
    `);
  }, trigger("23514", "RETRIEVAL_PROFILE_STATUS_TRANSITION_INVALID"));

  await expectReject(db, "RetrievalProfile cannot be deleted", async () => {
    await db.query(`DELETE FROM "retrieval_profiles" WHERE "id" = 'constraint-retrieval-r1'`);
  }, trigger("23514", "RETRIEVAL_PROFILE_IMMUTABLE"));

  await expectReject(db, "RetrievalProfile cannot retire while a release is building", async () => {
    await db.query(`
      UPDATE "retrieval_profiles"
      SET "status" = 'retired'
      WHERE "id" = 'constraint-retrieval-r1'
    `);
  }, trigger("23514", "RETRIEVAL_PROFILE_HAS_ACTIVE_RELEASE"));

  await expectReject(db, "RetrievalProfile adoption requires an adopted EmbeddingProfile", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-candidate-embedding-r1",
      specSha256: "8".repeat(64),
      status: "candidate",
    });
    await insertRetrievalProfile(db, {
      id: "constraint-candidate-retrieval-r1",
      specSha256: "9".repeat(64),
      embeddingProfileId: "constraint-candidate-embedding-r1",
      embeddingProfileSpecSha256: "8".repeat(64),
      status: "poc",
    });
    await db.query(`
      UPDATE "retrieval_profiles"
      SET "status" = 'adopted'
      WHERE "id" = 'constraint-candidate-retrieval-r1'
    `);
  }, trigger("23514", "RETRIEVAL_PROFILE_EMBEDDING_NOT_ADOPTED"));

  await expectReject(db, "KnowledgeRelease requires an adopted RetrievalProfile", async () => {
    await insertRetrievalProfile(db, {
      id: "constraint-poc-retrieval-r1",
      specSha256: "a".repeat(64),
      status: "poc",
    });
    await insertKnowledgeRelease(db, {
      id: "candidate-poc-retrieval-release",
      key: "constraint-poc-retrieval-release",
      retrievalProfileId: "constraint-poc-retrieval-r1",
      retrievalProfileSpecSha256: "a".repeat(64),
    });
  }, trigger("23514", "KNOWLEDGE_RELEASE_RETRIEVAL_PROFILE_NOT_ADOPTED"));

  await expectReject(db, "KnowledgeRelease retrieval pin must match its EmbeddingProfile pin", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-mismatch-embedding-r1",
      specSha256: "0".repeat(64),
      dimension: 4,
    });
    await insertKnowledgeRelease(db, {
      id: "candidate-mismatched-retrieval-release",
      key: "constraint-mismatched-retrieval-release",
      embeddingProfileId: "constraint-mismatch-embedding-r1",
      embeddingProfileSpecSha256: "0".repeat(64),
      embeddingDimension: 4,
    });
  }, trigger("23514", "KNOWLEDGE_RELEASE_RETRIEVAL_EMBEDDING_MISMATCH"));

  await expectReject(db, "KnowledgeRelease RetrievalProfile pin is immutable", async () => {
    await db.query(`
      UPDATE "knowledge_releases"
      SET "retrieval_profile_spec_sha256" = repeat('f', 64)
      WHERE "id" = 'release-building-a'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_IDENTITY_IMMUTABLE"));

  await expectReject(db, "KnowledgeChunk release must match its parent Document release", async () => {
    await insertKnowledgeRelease(db, {
      id: "candidate-chunk-release",
      key: "constraint-chunk-release",
      version: 1,
    });
    await db.query(`
      INSERT INTO "knowledge_chunks" (
        "id", "document_id", "release_id", "sequence", "heading_path", "content", "token_count"
      ) VALUES (
        'candidate-cross-release-chunk', 'knowledge-doc-building', 'candidate-chunk-release', 1,
        '[]'::jsonb, 'Cross-release content', 2
      )
    `);
  }, constraint("23503", "knowledge_chunks_document_id_release_id_fkey"));

  await expectReject(db, "KnowledgeChunkEmbedding release must match its Chunk release", async () => {
    await insertKnowledgeRelease(db, {
      id: "candidate-embedding-release",
      key: "constraint-embedding-release",
      version: 1,
    });
    await insertKnowledgeChunkEmbedding(db, { releaseId: "candidate-embedding-release" });
  }, constraint("23503", "knowledge_chunk_embeddings_chunk_id_release_id_fkey"));

  await expectReject(db, "KnowledgeChunkEmbedding dimension must match its vector", async () => {
    await insertKnowledgeChunkEmbedding(db, { embedding: "[1,0]" });
  }, constraint("23514", "knowledge_chunk_embeddings_vector_dimension_check"));

  await expectReject(db, "KnowledgeChunkEmbedding dimension must match its Profile", async () => {
    await insertKnowledgeChunkEmbedding(db, { dimension: 4, embedding: "[1,0,0,0]" });
  }, trigger("23514", "KNOWLEDGE_EMBEDDING_PROFILE_MISMATCH"));

  await expectReject(db, "KnowledgeChunkEmbedding must be L2 normalized", async () => {
    await insertKnowledgeChunkEmbedding(db, { embedding: "[2,0,0]" });
  }, constraint("23514", "knowledge_chunk_embeddings_l2_normalized_check"));

  await expectReject(db, "retired EmbeddingProfile cannot receive new vectors", async () => {
    await insertEmbeddingProfile(db, {
      id: "constraint-retired-embedding-r1",
      status: "adopted",
      specSha256: "2".repeat(64),
    });
    await insertRetrievalProfile(db, {
      id: "constraint-retired-retrieval-r1",
      status: "retired",
      specSha256: "3".repeat(64),
      embeddingProfileId: "constraint-retired-embedding-r1",
      embeddingProfileSpecSha256: "2".repeat(64),
    });
    await db.query(`
      UPDATE "embedding_profiles"
      SET "status" = 'retired'
      WHERE "id" = 'constraint-retired-embedding-r1'
    `);
    await insertKnowledgeRelease(db, {
      id: "candidate-retired-profile-release",
      key: "constraint-retired-profile-release",
      embeddingProfileId: "constraint-retired-embedding-r1",
      embeddingProfileSpecSha256: "2".repeat(64),
      retrievalProfileId: "constraint-retired-retrieval-r1",
      retrievalProfileSpecSha256: "3".repeat(64),
    });
  }, trigger("23514", "KNOWLEDGE_RELEASE_PROFILE_NOT_ADOPTED"));

  await expectReject(db, "published KnowledgeRelease cannot receive a new embedding", async () => {
    await insertKnowledgeChunkEmbedding(db, {
      chunkId: "knowledge-chunk-ready",
      releaseId: "release-content-a",
    });
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));

  await expectReject(db, "published KnowledgeChunkEmbedding is immutable", async () => {
    await db.query(`
      UPDATE "knowledge_chunk_embeddings"
      SET "embedding_sha256" = repeat('f', 64)
      WHERE "chunk_id" = 'knowledge-chunk-ready'
        AND "profile_id" = 'constraint-embedding-3-r1'
    `);
  }, trigger("23514", "KNOWLEDGE_CHUNK_EMBEDDING_IMMUTABLE"));

  await expectReject(db, "published KnowledgeChunkEmbedding cannot be deleted", async () => {
    await db.query(`
      DELETE FROM "knowledge_chunk_embeddings"
      WHERE "chunk_id" = 'knowledge-chunk-ready'
        AND "profile_id" = 'constraint-embedding-3-r1'
    `);
  }, trigger("23514", "KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE"));
}

async function insertBlob(db, overrides = {}) {
  const blob = {
    id: "candidate-blob",
    sha256: "0a".repeat(32),
    generation: 1,
    storageKey: "constraint/candidate-blob",
    mediaType: "application/octet-stream",
    byteSize: 20,
    status: "pending",
    verifiedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "blobs" (
      "id", "sha256", "generation", "storage_key", "media_type", "byte_size",
      "status", "verified_at", "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())
  `, [
    blob.id,
    blob.sha256,
    blob.generation,
    blob.storageKey,
    blob.mediaType,
    blob.byteSize,
    blob.status,
    blob.verifiedAt,
  ]);
}

async function insertBlobScan(db, overrides = {}) {
  const scan = {
    id: "candidate-scan",
    blobId: "blob-scan-candidate",
    attempt: 1,
    status: "queued",
    scanner: "constraint-scanner",
    scannerVersion: "1.0.0",
    signatureVersion: "test-signatures",
    evidence: null,
    failureCode: null,
    failureDetail: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "blob_scans" (
      "id", "blob_id", "attempt", "status", "scanner", "scanner_version",
      "signature_version", "evidence", "failure_code", "failure_detail",
      "started_at", "finished_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
      clock_timestamp()
    )
  `, [
    scan.id,
    scan.blobId,
    scan.attempt,
    scan.status,
    scan.scanner,
    scan.scannerVersion,
    scan.signatureVersion,
    scan.evidence === null ? null : JSON.stringify(scan.evidence),
    scan.failureCode,
    scan.failureDetail,
    scan.startedAt,
    scan.finishedAt,
  ]);
}

async function insertFileAsset(db, overrides = {}) {
  const file = {
    id: "candidate-file",
    projectId: "project-a",
    blobId: null,
    uploadedById: "principal-a",
    originalName: "candidate.bin",
    declaredMediaType: "application/octet-stream",
    detectedMediaType: null,
    byteSize: 1,
    status: "uploading",
    verifiedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "file_assets" (
      "id", "project_id", "blob_id", "uploaded_by_id", "original_name",
      "declared_media_type", "detected_media_type", "byte_size", "status",
      "verified_at", "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
  `, [
    file.id,
    file.projectId,
    file.blobId,
    file.uploadedById,
    file.originalName,
    file.declaredMediaType,
    file.detectedMediaType,
    file.byteSize,
    file.status,
    file.verifiedAt,
  ]);
}

async function insertFileUploadSession(db, overrides = {}) {
  const upload = {
    id: "candidate-file-upload-session",
    projectId: "project-a",
    fileAssetId: "candidate-upload-file",
    provider: "s3",
    providerUploadId: null,
    stagingKey: "staging/constraint/candidate-file-upload-session",
    status: "initiating",
    expectedByteSize: 1,
    expectedSha256: null,
    partSize: 5 * 1024 ** 2,
    revision: 0,
    idempotencyKey: "candidate-file-upload-key",
    requestHash: "1".repeat(64),
    completionIdempotencyKey: null,
    completionRequestHash: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    completedAt: null,
    abortedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "file_upload_sessions" (
      "id", "project_id", "file_asset_id", "provider", "provider_upload_id",
      "staging_key", "status", "expected_byte_size", "expected_sha256", "part_size",
      "revision", "idempotency_key", "request_hash", "completion_idempotency_key",
      "completion_request_hash", "expires_at", "completed_at", "aborted_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, clock_timestamp()
    )
  `, [
    upload.id,
    upload.projectId,
    upload.fileAssetId,
    upload.provider,
    upload.providerUploadId,
    upload.stagingKey,
    upload.status,
    upload.expectedByteSize,
    upload.expectedSha256,
    upload.partSize,
    upload.revision,
    upload.idempotencyKey,
    upload.requestHash,
    upload.completionIdempotencyKey,
    upload.completionRequestHash,
    upload.expiresAt,
    upload.completedAt,
    upload.abortedAt,
  ]);
}

async function insertVerificationUpload(db) {
  await insertFileAsset(db, {
    id: "candidate-upload-file",
    originalName: "verification.bin",
    byteSize: 20,
    status: "verifying",
  });
  await insertFileUploadSession(db, {
    providerUploadId: "constraint-provider-upload",
    status: "completed",
    expectedByteSize: 20,
    expectedSha256: "0b".repeat(32),
    completionIdempotencyKey: "candidate-file-completion-key",
    completionRequestHash: "2".repeat(64),
    completedAt: new Date(),
  });
}

async function insertFileVerificationAttempt(db, overrides = {}) {
  const attempt = {
    id: "candidate-file-verification-attempt",
    uploadSessionId: "candidate-file-upload-session",
    sequence: 1,
    queueJobId: "constraint-file-verify-job",
    queueRetryCount: 0,
    status: "running",
    fileStatus: null,
    failureCode: null,
    failureDetail: null,
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "file_verification_attempts" (
      "id", "upload_session_id", "sequence", "queue_job_id", "queue_retry_count",
      "status", "file_status", "failure_code", "failure_detail", "started_at",
      "finished_at", "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp())
  `, [
    attempt.id,
    attempt.uploadSessionId,
    attempt.sequence,
    attempt.queueJobId,
    attempt.queueRetryCount,
    attempt.status,
    attempt.fileStatus,
    attempt.failureCode,
    attempt.failureDetail,
    attempt.startedAt,
    attempt.finishedAt,
  ]);
}

async function insertExtraction(db, overrides = {}) {
  const extraction = {
    id: "candidate-extraction",
    fileAssetId: "file-extraction-a",
    sourceBlobId: "blob-extraction-source",
    attempt: 100,
    status: "queued",
    parser: "docling",
    parserVersion: "1.0.0",
    outputSchemaVersion: 1,
    idempotencyKey: "candidate-extraction-key",
    requestHash: "0".repeat(64),
    ...overrides,
  };
  await db.query(`
    INSERT INTO "file_extractions" (
      "id", "file_asset_id", "source_blob_id", "attempt", "status", "parser",
      "parser_version", "output_schema_version", "idempotency_key", "request_hash",
      "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
  `, [
    extraction.id,
    extraction.fileAssetId,
    extraction.sourceBlobId,
    extraction.attempt,
    extraction.status,
    extraction.parser,
    extraction.parserVersion,
    extraction.outputSchemaVersion,
    extraction.idempotencyKey,
    extraction.requestHash,
  ]);
}

async function insertExtractionOutput(db, overrides = {}) {
  const output = {
    extractionId: "candidate-extraction",
    kind: "markdown",
    position: 0,
    blobId: "blob-extraction-output",
    metadata: {},
    ...overrides,
  };
  await db.query(`
    INSERT INTO "file_extraction_outputs" (
      "extraction_id", "kind", "position", "blob_id", "metadata"
    ) VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [
    output.extractionId,
    output.kind,
    output.position,
    output.blobId,
    output.metadata === null ? null : JSON.stringify(output.metadata),
  ]);
}

async function insertPendingExternalImportSource(db, overrides = {}) {
  const source = {
    id: "candidate-external-import-source",
    projectId: "project-a",
    createdById: "principal-a",
    kind: "url_snapshot",
    label: "https://example.com/",
    request: { kind: "url_snapshot", sourceUrl: "https://example.com/" },
    requestHash: "e1".repeat(32),
    idempotencyKey: "constraint-candidate-external-import-source",
    ...overrides,
  };
  await db.query(`
    INSERT INTO "import_sources" (
      "id", "project_id", "created_by_id", "kind", "status", "label",
      "descriptor", "request", "request_hash", "idempotency_key", "checksum",
      "revision", "updated_at"
    ) VALUES ($1, $2, $3, $4, 'pending', $5, NULL, $6::jsonb, $7, $8, NULL, 0, clock_timestamp())
  `, [
    source.id,
    source.projectId,
    source.createdById,
    source.kind,
    source.label,
    JSON.stringify(source.request),
    source.requestHash,
    source.idempotencyKey,
  ]);
}

async function insertImportSourceAttempt(db, overrides = {}) {
  const attempt = {
    id: "candidate-import-source-attempt",
    importSourceId: "candidate-external-import-source",
    projectId: "project-a",
    attempt: 1,
    queueJobId: "candidate-import-source-attempt-job",
    ...overrides,
  };
  await db.query(`
    INSERT INTO "import_source_attempts" (
      "id", "import_source_id", "project_id", "attempt", "queue_job_id",
      "status", "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, 'queued', clock_timestamp())
  `, [
    attempt.id,
    attempt.importSourceId,
    attempt.projectId,
    attempt.attempt,
    attempt.queueJobId,
  ]);
}

async function succeedImportSourceAttempt(db, attemptId) {
  await db.query(`
    UPDATE "import_source_attempts"
    SET "status" = 'running',
        "lease_token" = 'constraint-import-source-lease',
        "lease_expires_at" = clock_timestamp() + interval '5 minutes',
        "started_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [attemptId]);
  await db.query(`
    UPDATE "import_source_attempts"
    SET "status" = 'succeeded',
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "finished_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [attemptId]);
}

async function insertExternalImportSourceBlob(db, importSourceId, sourcePath) {
  await insertImportSourceBlob(db, {
    id: `${importSourceId}-blob`,
    importSourceId,
    fileAssetId: null,
    role: "snapshot",
    path: sourcePath,
  });
}

async function markExternalImportSourceReady(db, { id, descriptor }) {
  await db.query(`
    UPDATE "import_sources"
    SET "status" = 'ready', "descriptor" = $2::jsonb, "checksum" = repeat('a', 64),
        "revision" = 1, "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [id, JSON.stringify(descriptor)]);
}

async function insertImportSource(db, overrides = {}) {
  const source = {
    id: "candidate-import-source",
    projectId: "project-a",
    createdById: "principal-a",
    kind: "file",
    status: "ready",
    label: "plain.txt",
    fileAssetId: "file-only-a",
    blobId: "blob-file-only",
    role: "primary",
    path: "plain.txt",
    mediaType: "text/plain",
    byteSize: 32,
    sha256: "a".repeat(64),
    requestHash: "a1".repeat(32),
    idempotencyKey: "constraint-candidate-import-source",
    ...overrides,
  };
  await db.query(`
    INSERT INTO "import_sources" (
      "id", "project_id", "created_by_id", "kind", "status", "label",
      "descriptor", "request", "request_hash", "idempotency_key", "checksum",
      "revision", "updated_at"
    ) VALUES ($1, $2, $3, $4, 'pending', $5, NULL, $6::jsonb, $7, $8, NULL, 0, clock_timestamp())
  `, [
    source.id,
    source.projectId,
    source.createdById,
    source.kind,
    source.label,
    JSON.stringify({ kind: source.kind, fileAssetId: source.fileAssetId }),
    source.requestHash,
    source.idempotencyKey,
  ]);
  await insertImportSourceBlob(db, {
    id: `${source.id}-blob`,
    importSourceId: source.id,
    projectId: source.projectId,
    position: 0,
    fileAssetId: source.fileAssetId,
    blobId: source.blobId,
    role: source.role,
    path: source.path,
    mediaType: source.mediaType,
    byteSize: source.byteSize,
    sha256: source.sha256,
  });
  if (source.status === "ready") {
    await db.query(`
      UPDATE "import_sources"
      SET "status" = 'ready', "descriptor" = $2::jsonb, "checksum" = $3,
          "revision" = 1, "updated_at" = clock_timestamp()
      WHERE "id" = $1
    `, [
      source.id,
      JSON.stringify({
        kind: source.kind,
        fileAssetId: source.fileAssetId,
        originalName: source.label,
        mediaType: source.mediaType,
      }),
      source.sha256,
    ]);
  }
}

async function insertImportSourceBlob(db, overrides = {}) {
  const blob = {
    id: "candidate-import-source-blob",
    importSourceId: "candidate-import-source",
    projectId: "project-a",
    position: 0,
    blobId: "blob-file-only",
    fileAssetId: "file-only-a",
    role: "primary",
    path: "plain.txt",
    mediaType: "text/plain",
    byteSize: 32,
    sha256: "a".repeat(64),
    ...overrides,
  };
  await db.query(`
    INSERT INTO "import_source_blobs" (
      "id", "import_source_id", "project_id", "position", "blob_id",
      "file_asset_id", "role", "path", "media_type", "byte_size", "sha256"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    blob.id,
    blob.importSourceId,
    blob.projectId,
    blob.position,
    blob.blobId,
    blob.fileAssetId,
    blob.role,
    blob.path,
    blob.mediaType,
    blob.byteSize,
    blob.sha256,
  ]);
}

async function insertRunSourceSnapshot(db, overrides = {}) {
  const snapshot = {
    id: "candidate-run-source-snapshot",
    runId: "candidate-run",
    projectId: "project-a",
    position: 0,
    sourceId: "source-attachment-a",
    kind: "file",
    label: "screen.png",
    checksum: "d".repeat(64),
    descriptor: {
      kind: "file",
      fileAssetId: "file-attachment-a",
      originalName: "screen.png",
      mediaType: "image/png",
    },
    manifest: {
      protocol: "workbench.import-source-snapshot.v1",
      sourceRevision: 1,
      checksum: "d".repeat(64),
      blobs: [{
        position: 0,
        blobId: "blob-attachment",
        role: "primary",
        path: "screen.png",
        mediaType: "image/png",
        byteSize: 96,
        sha256: "d".repeat(64),
      }],
    },
    ...overrides,
  };
  await db.query(`
    INSERT INTO "run_source_snapshots" (
      "id", "run_id", "project_id", "position", "source_id", "kind", "label",
      "checksum", "descriptor", "snapshot"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
  `, [
    snapshot.id,
    snapshot.runId,
    snapshot.projectId,
    snapshot.position,
    snapshot.sourceId,
    snapshot.kind,
    snapshot.label,
    snapshot.checksum,
    JSON.stringify(snapshot.descriptor),
    JSON.stringify(snapshot.manifest),
  ]);
}

async function insertKnowledgeDocument(db, overrides = {}) {
  const document = {
    id: "candidate-knowledge-document",
    releaseId: "release-building-a",
    sourceKind: "project_upload",
    sourcePath: "uploads/candidate.md",
    title: "Candidate knowledge",
    checksum: "9".repeat(64),
    route: "production",
    sourceBlobId: "blob-knowledge",
    metadata: {},
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_documents" (
      "id", "release_id", "source_kind", "source_path", "title", "checksum",
      "route", "source_blob_id", "metadata"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `, [
    document.id,
    document.releaseId,
    document.sourceKind,
    document.sourcePath,
    document.title,
    document.checksum,
    document.route,
    document.sourceBlobId,
    JSON.stringify(document.metadata),
  ]);
}

async function insertKnowledgeRelease(db, overrides = {}) {
  const release = {
    id: "candidate-knowledge-release",
    key: "constraint-content",
    workspaceId: "workspace-a",
    version: 2,
    status: "building",
    embeddingProfileId: "constraint-embedding-3-r1",
    embeddingProfileSpecSha256: "d".repeat(64),
    embeddingDimension: 3,
    retrievalProfileId: "constraint-retrieval-r1",
    retrievalProfileSpecSha256: "e".repeat(64),
    chunksReadyAt: null,
    manifestSha256: "9".repeat(64),
    manifest: {},
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_releases" (
      "id", "key", "workspace_id", "version", "status",
      "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension",
      "retrieval_profile_id", "retrieval_profile_spec_sha256",
      "manifest_sha256", "manifest", "chunks_ready_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
  `, [
    release.id,
    release.key,
    release.workspaceId,
    release.version,
    release.status,
    release.embeddingProfileId,
    release.embeddingProfileSpecSha256,
    release.embeddingDimension,
    release.retrievalProfileId,
    release.retrievalProfileSpecSha256,
    release.manifestSha256,
    JSON.stringify(release.manifest),
    release.chunksReadyAt,
  ]);
}

async function insertEmbeddingProfile(db, overrides = {}) {
  const profile = {
    id: "candidate-embedding-3-r1",
    dimension: 3,
    specDimension: undefined,
    specId: undefined,
    specSha256: "b".repeat(64),
    status: "adopted",
    initialStatus: "candidate",
    ...overrides,
  };
  const spec = {
    schema: "workbench.embedding-profile.v1",
    id: profile.specId ?? profile.id,
    protocol: "tei.embed.v1",
    engine: {
      id: "constraint-tei",
      version: "1.0.0",
      imageDigest: `sha256:${"2".repeat(64)}`,
    },
    model: {
      id: "constraint/model",
      revision: "revision-1",
      artifactSha256: "3".repeat(64),
    },
    tokenizer: {
      id: "constraint/tokenizer",
      revision: "revision-1",
      artifactSha256: "4".repeat(64),
      modelMaximumTokens: 64,
      chunkMaximumTokens: 32,
      overflow: "reject",
    },
    input: { queryPrefix: "", documentPrefix: "", normalization: "utf8-nfc-lf-v1" },
    output: {
      dimension: profile.specDimension ?? profile.dimension,
      dtype: "float32",
      pooling: "cls",
      normalization: "l2",
      distance: "cosine",
    },
    batch: { maximumInputs: 2, maximumTokens: 64 },
    conformanceProbeSha256: "5".repeat(64),
  };
  await db.query(`
    INSERT INTO "embedding_profiles" (
      "id", "spec", "spec_sha256", "dimension", "status"
    ) VALUES ($1, $2::jsonb, $3, $4, $5)
  `, [profile.id, JSON.stringify(spec), profile.specSha256, profile.dimension, profile.initialStatus]);
  if (profile.status === "poc" || profile.status === "adopted") {
    await db.query(`UPDATE "embedding_profiles" SET "status" = 'poc' WHERE "id" = $1`, [profile.id]);
  }
  if (profile.status === "adopted") {
    await db.query(`UPDATE "embedding_profiles" SET "status" = 'adopted' WHERE "id" = $1`, [profile.id]);
    await db.query(`
      INSERT INTO "knowledge_profile_adoption_receipts" (
        "id", "profile_kind", "profile_version", "embedding_profile_id",
        "embedding_profile_spec_sha256", "actor_principal_id", "scope"
      ) VALUES ($1, 'embedding', 1, $2, $3, 'principal-a', 'global')
    `, [`adoption-${profile.id}`, profile.id, profile.specSha256]);
  }
  if (profile.status === "retired") {
    await db.query(`UPDATE "embedding_profiles" SET "status" = 'retired' WHERE "id" = $1`, [profile.id]);
  }
}

async function insertRetrievalProfile(db, overrides = {}) {
  const profile = {
    id: "candidate-retrieval-r1",
    specId: undefined,
    specSha256: "c".repeat(64),
    embeddingProfileId: "constraint-embedding-3-r1",
    embeddingProfileSpecSha256: "d".repeat(64),
    embeddingDimension: 3,
    specEmbeddingProfileId: undefined,
    specEmbeddingProfileSpecSha256: undefined,
    specEmbeddingDimension: undefined,
    status: "adopted",
    initialStatus: "candidate",
    ...overrides,
  };
  const spec = {
    schema: "workbench.retrieval-profile.v1",
    id: profile.specId ?? profile.id,
    embedding: {
      profileId: profile.specEmbeddingProfileId ?? profile.embeddingProfileId,
      profileSpecSha256:
        profile.specEmbeddingProfileSpecSha256 ?? profile.embeddingProfileSpecSha256,
      dimension: profile.specEmbeddingDimension ?? profile.embeddingDimension,
    },
    segmenter: {
      implementationId: "jieba-wasm",
      version: "1.0.0",
      artifactSha256: "1".repeat(64),
      algorithm: "cut_for_search",
      hmm: false,
      dictionarySha256: "2".repeat(64),
      stopwordsSha256: "3".repeat(64),
      normalization: "utf8-nfc-lf-v1",
    },
    recall: {
      lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 20 },
      dense: { distance: "cosine", limit: 20 },
      fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
    },
    reranker: {
      protocol: "tei.rerank.v1",
      engine: {
        id: "constraint-tei-reranker",
        version: "1.0.0",
        imageDigest: `sha256:${"4".repeat(64)}`,
      },
      model: {
        id: "constraint/reranker",
        revision: "revision-1",
        artifactSha256: "5".repeat(64),
      },
      tokenizer: {
        id: "constraint/reranker-tokenizer",
        revision: "revision-1",
        artifactSha256: "6".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 20,
      finalResultLimit: 8,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "7".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
  await db.query(`
    INSERT INTO "retrieval_profiles" (
      "id", "spec", "spec_sha256",
      "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension",
      "status"
    ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
  `, [
    profile.id,
    JSON.stringify(spec),
    profile.specSha256,
    profile.embeddingProfileId,
    profile.embeddingProfileSpecSha256,
    profile.embeddingDimension,
    profile.initialStatus,
  ]);
  if (profile.status === "poc" || profile.status === "adopted") {
    await db.query(`UPDATE "retrieval_profiles" SET "status" = 'poc' WHERE "id" = $1`, [profile.id]);
  }
  if (profile.status === "adopted") {
    await db.query(`UPDATE "retrieval_profiles" SET "status" = 'adopted' WHERE "id" = $1`, [profile.id]);
    await db.query(`
      INSERT INTO "knowledge_profile_adoption_receipts" (
        "id", "profile_kind", "profile_version", "retrieval_profile_id",
        "retrieval_profile_spec_sha256", "actor_principal_id", "scope"
      ) VALUES ($1, 'retrieval', 1, $2, $3, 'principal-a', 'global')
    `, [`adoption-${profile.id}`, profile.id, profile.specSha256]);
  }
  if (profile.status === "retired") {
    await db.query(`UPDATE "retrieval_profiles" SET "status" = 'retired' WHERE "id" = $1`, [profile.id]);
  }
}

async function insertKnowledgeChunkEmbedding(db, overrides = {}) {
  const embedding = {
    chunkId: "knowledge-chunk-building",
    releaseId: "release-building-a",
    profileId: "constraint-embedding-3-r1",
    profileSpecSha256: "d".repeat(64),
    dimension: 3,
    embedding: "[1,0,0]",
    embeddingSha256: "6".repeat(64),
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_chunk_embeddings" (
      "chunk_id", "release_id", "profile_id", "profile_spec_sha256", "dimension", "embedding", "embedding_sha256"
    ) VALUES ($1, $2, $3, $4, $5, $6::public.vector, $7)
  `, [
    embedding.chunkId,
    embedding.releaseId,
    embedding.profileId,
    embedding.profileSpecSha256,
    embedding.dimension,
    embedding.embedding,
    embedding.embeddingSha256,
  ]);
}

async function insertKnowledgeEmbeddingBatch(db, overrides = {}) {
  const batch = {
    id: "candidate-knowledge-embedding-batch",
    releaseId: "release-building-a",
    profileId: "constraint-embedding-3-r1",
    profileSpecSha256: "d".repeat(64),
    dimension: 3,
    sequence: 0,
    chunkIds: ["knowledge-chunk-building"],
    inputCount: 1,
    inputSha256: "7".repeat(64),
    status: "pending",
    attemptCount: 0,
    leaseToken: null,
    queueJobId: null,
    queueRetryCount: null,
    tokenCount: null,
    outputSha256: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastErrorAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_embedding_batches" (
      "id", "release_id", "profile_id", "profile_spec_sha256", "dimension",
      "sequence", "chunk_ids", "input_count", "input_sha256", "status",
      "attempt_count", "lease_token", "queue_job_id", "queue_retry_count",
      "token_count", "output_sha256", "last_error_code", "last_error_detail",
      "last_error_at", "started_at", "finished_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20, $21
    )
  `, [
    batch.id,
    batch.releaseId,
    batch.profileId,
    batch.profileSpecSha256,
    batch.dimension,
    batch.sequence,
    batch.chunkIds,
    batch.inputCount,
    batch.inputSha256,
    batch.status,
    batch.attemptCount,
    batch.leaseToken,
    batch.queueJobId,
    batch.queueRetryCount,
    batch.tokenCount,
    batch.outputSha256,
    batch.lastErrorCode,
    batch.lastErrorDetail,
    batch.lastErrorAt,
    batch.startedAt,
    batch.finishedAt,
  ]);
}

async function advanceKnowledgeEmbeddingBatchToReady(
  db,
  id = "candidate-knowledge-embedding-batch",
) {
  await db.query(`
    UPDATE "knowledge_embedding_batches"
    SET "status" = 'running', "attempt_count" = 1,
        "lease_token" = 'constraint-ready-lease',
        "queue_job_id" = 'constraint-ready-job', "queue_retry_count" = 0,
        "started_at" = clock_timestamp()
    WHERE "id" = $1
  `, [id]);
  await db.query(`
    UPDATE "knowledge_embedding_batches"
    SET "status" = 'ready', "lease_token" = NULL, "token_count" = 3,
        "output_sha256" = repeat('8', 64), "finished_at" = clock_timestamp()
    WHERE "id" = $1
  `, [id]);
}

async function fileRevision(db, fileId) {
  const result = await db.query(`SELECT "revision" FROM "file_assets" WHERE "id" = $1`, [fileId]);
  assert.equal(result.rowCount, 1, `FileAsset ${fileId} must exist`);
  return result.rows[0].revision;
}

async function blobStatus(db, blobId) {
  const result = await db.query(`SELECT "status" FROM "blobs" WHERE "id" = $1`, [blobId]);
  assert.equal(result.rowCount, 1, `Blob ${blobId} must exist`);
  return result.rows[0].status;
}

async function moveBlobToQuarantine(db, blobId) {
  const result = await db.query(`
    UPDATE "blobs"
    SET "storage_key" = $2
          || substring("sha256" FROM 1 FOR 2) || '/'
          || substring("sha256" FROM 3 FOR 2) || '/'
          || "sha256" || '/g' || "generation"::TEXT,
        "updated_at" = clock_timestamp()
    WHERE "id" = $1
    RETURNING "storage_key"
  `, [blobId, "quarantine/blobs/"]);
  assert.equal(result.rowCount, 1, `Blob ${blobId} must exist`);
  assert.match(result.rows[0].storage_key, /^quarantine\/blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\/g[1-9][0-9]*$/);
}

async function softDeleteBlob(db, blobId) {
  await db.query(`
    UPDATE "blobs"
    SET "status" = 'deleted', "deleted_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [blobId]);
}

async function softDeleteFile(db, fileId) {
  await db.query(`
    UPDATE "file_assets"
    SET "status" = 'deleted',
        "deleted_at" = clock_timestamp(),
        "revision" = "revision" + 1,
        "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [fileId]);
}

async function insertVersion(db, overrides = {}) {
  const version = {
    id: "candidate-version",
    artifactId: "artifact-a",
    projectId: "project-a",
    version: 100,
    schemaVersion: 1,
    status: "staging",
    content: { protocol: "workbench.prd.v1", citations: [] },
    contentBlobId: null,
    checksum: "0".repeat(64),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "artifact_versions" (
      "id", "artifact_id", "project_id", "version", "schema_version", "status",
      "content", "content_blob_id", "checksum", "citations", "created_by_run_id",
      "knowledge_release_id"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12
    )
  `, [
    version.id,
    version.artifactId,
    version.projectId,
    version.version,
    version.schemaVersion,
    version.status,
    version.content === null ? null : JSON.stringify(version.content),
    version.contentBlobId,
    version.checksum,
    JSON.stringify(version.citations),
    version.createdByRunId,
    version.knowledgeReleaseId,
  ]);
}

async function insertPrdEditReceiptCandidate(db, {
  baseSchemaVersion,
  resultSchemaVersion,
}) {
  const revisionResult = await db.query(`
    SELECT "revision"
    FROM "artifacts"
    WHERE "id" = 'artifact-a'
  `);
  assert.equal(revisionResult.rowCount, 1);
  const initialRevision = revisionResult.rows[0].revision;
  const document = (schemaVersion) => ({
    protocol: `workbench.prd.v${schemaVersion}`,
    citations: [],
  });

  await insertVersion(db, {
    id: "candidate-edit-base-version",
    version: 110,
    schemaVersion: baseSchemaVersion,
    status: "ready",
    content: document(baseSchemaVersion),
    checksum: "1".repeat(64),
    createdByRunId: null,
  });
  await db.query(`
    UPDATE "artifacts"
    SET "current_version_id" = 'candidate-edit-base-version'
    WHERE "id" = 'artifact-a'
  `);

  await insertVersion(db, {
    id: "candidate-edit-result-version",
    version: 111,
    schemaVersion: resultSchemaVersion,
    status: "ready",
    content: document(resultSchemaVersion),
    checksum: "2".repeat(64),
    createdByRunId: null,
  });
  await db.query(`
    UPDATE "artifacts"
    SET "current_version_id" = 'candidate-edit-result-version'
    WHERE "id" = 'artifact-a'
  `);

  await db.query(`
    INSERT INTO "artifact_version_edit_receipts" (
      "id", "artifact_id", "base_artifact_version_id", "result_artifact_version_id",
      "expected_artifact_revision", "result_artifact_revision", "created_by_id",
      "idempotency_key", "request_hash"
    ) VALUES (
      'candidate-prd-edit-receipt', 'artifact-a',
      'candidate-edit-base-version', 'candidate-edit-result-version',
      $1, $2, 'principal-a', 'candidate-prd-edit', repeat('3', 64)
    )
  `, [initialRevision + 1, initialRevision + 2]);
}

async function insertPrototypeCandidate(db, options = {}) {
  const asset = {
    id: "candidate-image",
    kind: "image",
    name: "Candidate image",
    blobId: "blob-prototype-image",
    mediaType: "image/png",
    byteSize: 128,
    sha256: "ab".repeat(32),
    width: 320,
    height: 180,
    ...(options.asset ?? {}),
  };
  await db.query(`
    INSERT INTO "artifacts" ("id", "project_id", "kind", "title", "updated_at")
    VALUES ('candidate-prototype', 'project-a', 'prototype', 'Candidate Prototype', clock_timestamp())
  `);
  await db.query(`
    INSERT INTO "artifact_versions" (
      "id", "artifact_id", "project_id", "version", "schema_version", "status",
      "content", "content_blob_id", "checksum", "citations", "created_by_run_id"
    ) VALUES (
      'candidate-prototype-version', 'candidate-prototype', 'project-a', 1, 1, $1,
      $2::jsonb, NULL, repeat('ca', 32), '[]'::jsonb, NULL
    )
  `, [options.initialStatus ?? "staging", JSON.stringify({
    protocol: "workbench.prototype.v1",
    assets: [asset],
  })]);

  if (options.pin !== false) {
    const metadata = options.metadata ?? asset;
    await db.query(`
      INSERT INTO "artifact_version_assets" (
        "artifact_version_id", "artifact_id", "project_id", "asset_id", "kind",
        "blob_id", "media_type", "byte_size", "sha256", "metadata"
      ) VALUES (
        'candidate-prototype-version', 'candidate-prototype', 'project-a', $1, $2,
        $3, $4, $5, $6, $7::jsonb
      )
    `, [
      asset.id,
      asset.kind,
      options.pinBlobId ?? asset.blobId,
      options.pinMediaType ?? asset.mediaType,
      options.pinByteSize ?? asset.byteSize,
      options.pinSha256 ?? asset.sha256,
      JSON.stringify(metadata),
    ]);
  }
  if (options.finalize !== false && (options.initialStatus ?? "staging") === "staging") {
    await db.query(`
      UPDATE "artifact_versions" SET "status" = 'ready'
      WHERE "id" = 'candidate-prototype-version'
    `);
  }
}

async function insertDesignSystemCandidate(db, options = {}) {
  const document = options.document ?? designSystemDocumentFixture();
  await db.query(`
    INSERT INTO "artifacts" ("id", "project_id", "kind", "title", "updated_at")
    VALUES (
      'candidate-design-system', 'project-a', 'design_system',
      'Candidate Design System', clock_timestamp()
    )
  `);
  await db.query(`
    INSERT INTO "artifact_versions" (
      "id", "artifact_id", "project_id", "version", "schema_version", "status",
      "content", "content_blob_id", "checksum", "citations", "created_by_run_id",
      "knowledge_release_id"
    ) VALUES (
      'candidate-design-system-version', 'candidate-design-system', 'project-a',
      1, 1, 'staging', $1::jsonb, NULL, repeat('d1', 32), '[]'::jsonb, NULL, NULL
    )
  `, [JSON.stringify(document)]);
  await db.query(`
    UPDATE "artifact_versions" SET "status" = 'ready'
    WHERE "id" = 'candidate-design-system-version'
  `);
}

async function insertRun(db, overrides = {}) {
  const run = {
    id: "candidate-run",
    projectId: "project-a",
    threadId: "thread-a",
    retryOfRunId: null,
    createdById: "principal-a",
    knowledgeReleaseId: "release-ready-a",
    designStyleArtifactVersionId: null,
    designStyleSnapshot: null,
    designStyleSnapshotSha256: null,
    idempotencyKey: "candidate-run-key",
    requestHash: "0".repeat(64),
    requestId: "candidate-run-request",
    request: typedRunRequest(),
    modelId: "test-model",
    traceId: "candidate-run-trace",
    status: "cancelled",
    ...overrides,
  };
  await db.query(`
    INSERT INTO "runs" (
      "id", "project_id", "thread_id", "retry_of_run_id", "created_by_id", "knowledge_release_id",
      "design_style_artifact_version_id", "design_style_snapshot", "design_style_snapshot_sha256",
      "idempotency_key", "request_hash", "request_id", "request", "model_id", "trace_id", "status", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb,
      $14, $15, $16, clock_timestamp()
    )
  `, [
    run.id,
    run.projectId,
    run.threadId,
    run.retryOfRunId,
    run.createdById,
    run.knowledgeReleaseId,
    run.designStyleArtifactVersionId,
    run.designStyleSnapshot === null ? null : JSON.stringify(run.designStyleSnapshot),
    run.designStyleSnapshotSha256,
    run.idempotencyKey,
    run.requestHash,
    run.requestId,
    JSON.stringify(run.request),
    run.modelId,
    run.traceId,
    run.status,
  ]);
}

async function insertRuntimeAttempt(db, overrides = {}) {
  const attempt = {
    id: "candidate-runtime-attempt",
    runId: "run-a",
    runtimeBindingId: "runtime-binding-a",
    attempt: 1,
    adapter: "deerflow",
    externalThreadId: "external-thread-a",
    externalRunId: null,
    status: "pending",
    lastExternalEventId: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "runtime_attempts" (
      "id", "run_id", "runtime_binding_id", "attempt", "adapter",
      "external_thread_id", "external_run_id", "status", "last_external_event_id",
      "started_at", "finished_at", "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp())
  `, [
    attempt.id,
    attempt.runId,
    attempt.runtimeBindingId,
    attempt.attempt,
    attempt.adapter,
    attempt.externalThreadId,
    attempt.externalRunId,
    attempt.status,
    attempt.lastExternalEventId,
    attempt.startedAt,
    attempt.finishedAt,
  ]);
}

async function insertRunningRuntimeAttempt(db, overrides = {}) {
  const externalRunId = overrides.externalRunId ?? "external-run-a";
  const { externalRunId: _externalRunId, ...insertOverrides } = overrides;
  await insertRuntimeAttempt(db, insertOverrides);
  await beginRuntimeSubmission(db, insertOverrides.id ?? "candidate-runtime-attempt");
  await db.query(`
    UPDATE "runtime_attempts"
    SET "status" = 'running', "external_run_id" = $2, "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [insertOverrides.id ?? "candidate-runtime-attempt", externalRunId]);
}

async function beginRuntimeSubmission(db, attemptId) {
  await db.query(`
    UPDATE "runtime_attempts"
    SET "status" = 'submitting',
        "provider_idempotency_key" = 'wbrt:' || encode(public.digest("id", 'sha256'), 'hex'),
        "started_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [attemptId]);
}

async function insertCanvasToolInvocation(db) {
  await insertRuntimeAttempt(db);
  await db.query(`
    INSERT INTO "canvas_agent_sessions" (
      "id", "runtime_attempt_id", "run_id", "project_id", "thread_id",
      "principal_id", "board_id", "client_session_id", "project_session_generation",
      "profile", "declared_tools", "declaration_hash", "snapshot_sha256", "board_revision",
      "selected_node_ids", "visible_node_ids", "viewport", "expires_at"
    ) VALUES (
      'candidate-canvas-agent-session', 'candidate-runtime-attempt', 'run-a',
      'project-a', 'thread-a', 'principal-a', 'board-a', 'constraint-session-1', 1,
      'read', '["get_screen"]'::jsonb, repeat('a', 64), repeat('d', 64),
      (SELECT "revision" FROM "boards" WHERE "id" = 'board-a'),
      '[]'::jsonb, '[]'::jsonb, '{"x":0,"y":0,"zoom":1}'::jsonb,
      clock_timestamp() + interval '1 hour'
    );

    INSERT INTO "canvas_tool_grants" (
      "id", "agent_session_id", "payload_sha256", "declaration_hash",
      "snapshot_sha256", "issued_at", "expires_at"
    )
    SELECT
      '00000000-0000-4000-8000-000000000001'::uuid,
      "id", repeat('b', 64), "declaration_hash", "snapshot_sha256", "created_at", "expires_at"
    FROM "canvas_agent_sessions"
    WHERE "id" = 'candidate-canvas-agent-session';

    INSERT INTO "canvas_tool_invocations" (
      "id", "agent_session_id", "grant_id", "run_id", "project_id", "principal_id",
      "tool_call_id", "tool_name", "sequence", "request_hash", "request",
      "lease_token", "lease_expires_at", "board_revision_before",
      "canvas_state_revision_before", "canvas_state_sha256_before"
    ) VALUES (
      'candidate-canvas-tool-invocation', 'candidate-canvas-agent-session',
      '00000000-0000-4000-8000-000000000001'::uuid,
      'run-a', 'project-a', 'principal-a', 'constraint-tool-call-1', 'get_screen', 1,
      repeat('c', 64), '{}'::jsonb, 'constraint-lease-1',
      clock_timestamp() + interval '5 minutes',
      (SELECT "revision" FROM "boards" WHERE "id" = 'board-a'), 0, repeat('e', 64)
    );
  `);
}

async function prepareKnowledgeToolScope(db) {
  await db.query(`
    UPDATE "runs"
    SET "status" = 'running', "attempt" = 1,
        "started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" = 'run-a'
  `);
  await insertRuntimeAttempt(db);
}

async function prepareSuccessfulKnowledgeRetrieval(db, items = [{
  rank: 1, rrfScore: 0.03, rerankerScore: null,
  citation: {
    id: "constraint-citation", documentId: "constraint-document", chunkId: "constraint-chunk",
    sourcePath: "00-rules/constraint.md", title: "Constraint knowledge", quote: "Constraint knowledge content",
    locator: { heading: "Rules", startLine: null, endLine: null },
  },
}]) {
  await prepareKnowledgeToolScope(db);
  await insertKnowledgeToolBudget(db);
  await insertKnowledgeToolGrant(db);
  await db.query(`
    UPDATE "knowledge_tool_budgets"
    SET "window_starts" = 1, "total_starts" = 1, "updated_at" = clock_timestamp()
    WHERE "runtime_attempt_id" = 'candidate-runtime-attempt'
  `);
  await insertKnowledgeInvocation(db);
  const response = {
    protocol: "workbench.knowledge-retrieval-result.v1",
    evidence: {
      schema: "workbench.knowledge-retrieval-evidence.v1", mode: "hybrid", routeScope: "production",
      release: { id: "release-ready-a", key: "constraint-ready-a", version: 1 },
      embeddingProfile: { id: "constraint-embedding-3-r1", specSha256: "d".repeat(64), dimension: 3 },
      retrievalProfile: { id: "constraint-retrieval-r1", specSha256: "e".repeat(64) },
      candidateCounts: { lexical: items.length, dense: items.length, fused: items.length },
      fusion: { algorithm: "rrf", k: 60 }, reranker: { status: "not_needed" }, degraded: false,
    },
    items,
  };
  await db.query(`
    UPDATE "knowledge_retrieval_invocations"
    SET "status" = 'succeeded', "lease_token" = NULL, "lease_expires_at" = NULL,
        "response" = $1::jsonb, "response_sha256" = $2,
        "finished_at" = "last_started_at", "updated_at" = clock_timestamp()
    WHERE "id" = 'candidate-knowledge-invocation'
  `, [JSON.stringify(response), createHash("sha256").update(canonicalize(response)).digest("hex")]);
}

async function insertKnowledgeToolBudget(db, overrides = {}) {
  const budget = {
    runtimeAttemptId: "candidate-runtime-attempt",
    maxSuccessfulCalls: 12,
    maxConcurrentCalls: 2,
    maxStartsPerWindow: 12,
    windowSeconds: 60,
    maxAttemptsPerInvocation: 3,
    maxTotalStarts: 36,
    windowStartedAt: new Date(),
    windowStarts: 0,
    totalStarts: 0,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_tool_budgets" (
      "runtime_attempt_id", "max_successful_calls", "max_concurrent_calls",
      "max_starts_per_window", "window_seconds", "max_attempts_per_invocation",
      "max_total_starts", "window_started_at", "window_starts", "total_starts",
      "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())
  `, [
    budget.runtimeAttemptId,
    budget.maxSuccessfulCalls,
    budget.maxConcurrentCalls,
    budget.maxStartsPerWindow,
    budget.windowSeconds,
    budget.maxAttemptsPerInvocation,
    budget.maxTotalStarts,
    budget.windowStartedAt,
    budget.windowStarts,
    budget.totalStarts,
  ]);
}

async function insertKnowledgeToolGrant(db, overrides = {}) {
  const issuedAt = new Date();
  const grant = {
    id: "candidate-knowledge-grant",
    runtimeAttemptId: "candidate-runtime-attempt",
    runId: "run-a",
    principalId: "principal-a",
    projectId: "project-a",
    releaseId: "release-ready-a",
    payloadSha256: "7".repeat(64),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 15 * 60_000),
    revokedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_tool_grants" (
      "id", "runtime_attempt_id", "run_id", "principal_id", "project_id",
      "release_id", "payload_sha256", "issued_at", "expires_at", "revoked_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    grant.id,
    grant.runtimeAttemptId,
    grant.runId,
    grant.principalId,
    grant.projectId,
    grant.releaseId,
    grant.payloadSha256,
    grant.issuedAt,
    grant.expiresAt,
    grant.revokedAt,
  ]);
}

async function insertKnowledgeInvocation(db, overrides = {}) {
  const lastStartedAt = new Date();
  const invocation = {
    id: "candidate-knowledge-invocation",
    runtimeAttemptId: "candidate-runtime-attempt",
    invocationId: `knowledge:${"a".repeat(64)}`,
    lastGrantId: "candidate-knowledge-grant",
    querySha256: "8".repeat(64),
    status: "in_flight",
    attemptCount: 1,
    leaseToken: "candidate_knowledge_lease_token",
    leaseExpiresAt: new Date(lastStartedAt.getTime() + 60_000),
    response: null,
    responseSha256: null,
    lastErrorCode: null,
    lastStartedAt,
    finishedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "knowledge_retrieval_invocations" (
      "id", "runtime_attempt_id", "invocation_id", "last_grant_id",
      "query_sha256", "status", "attempt_count", "lease_token",
      "lease_expires_at", "response", "response_sha256", "last_error_code",
      "last_started_at", "finished_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
      clock_timestamp()
    )
  `, [
    invocation.id,
    invocation.runtimeAttemptId,
    invocation.invocationId,
    invocation.lastGrantId,
    invocation.querySha256,
    invocation.status,
    invocation.attemptCount,
    invocation.leaseToken,
    invocation.leaseExpiresAt,
    invocation.response === null ? null : JSON.stringify(invocation.response),
    invocation.responseSha256,
    invocation.lastErrorCode,
    invocation.lastStartedAt,
    invocation.finishedAt,
  ]);
}

function typedRunRequest(overrides = {}) {
  return {
    prompt: "Constraint probe",
    modelId: "test-model",
    workflow: "generate",
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    requestedArtifactKinds: [],
    ...overrides,
  };
}

function designSystemDocumentFixture(overrides = {}) {
  return {
    protocol: "workbench.design-system.v1",
    documentId: "candidate-design-system",
    title: "Candidate Design System",
    tokens: [],
    assets: [],
    principles: [],
    guidelines: [],
    components: [],
    ...overrides,
  };
}

function designStyleSnapshotFixture(overrides = {}) {
  const source = {
    projectId: "project-a",
    artifactId: "artifact-design-a",
    artifactVersionId: "version-design-a-ready",
    checksum: "1c".repeat(32),
    ...overrides,
  };
  return {
    protocol: "workbench.runtime.design-style.v1",
    source: {
      projectId: source.projectId,
      artifactId: source.artifactId,
      artifactVersionId: source.artifactVersionId,
      checksum: source.checksum,
    },
    documentId: source.documentId ?? "constraint-design-a",
    title: source.title ?? "Design System A",
    tokens: [],
    assets: [],
    principles: [],
    guidelines: [],
    components: [],
  };
}

function designPresetSnapshotFixture() {
  const reference = {
    kind: "preset",
    presetId: "workbench.bauhaus",
    version: 1,
    checksum: "4c".repeat(32),
  };
  return {
    reference,
    snapshot: {
      protocol: "workbench.runtime.design-preset.v1",
      source: {
        presetId: reference.presetId,
        version: reference.version,
        checksum: reference.checksum,
      },
      label: "Bauhaus",
      swatch: "#d23b49",
      description: "Immutable constraint probe preset snapshot.",
      directives: {
        composition: "Use geometric structure.",
        hierarchy: "Use direct hierarchy.",
        typography: "Use geometric typography.",
        components: "Use explicit components.",
        imagery: "Use diagrammatic imagery.",
        interaction: "Use direct interactions.",
      },
      tokens: { colors: { accent: "#d23b49" } },
    },
  };
}

async function insertProjectRelease(db, overrides = {}) {
  const release = {
    id: "candidate-project-release",
    projectId: "project-a",
    version: 99,
    status: "building",
    createdById: "principal-a",
    idempotencyKey: "constraint-candidate-release",
    requestHash: "6".repeat(64),
    boardId: "board-a",
    boardRevision: undefined,
    boardSnapshot: {
      protocol: "workbench.board-snapshot.v1",
      nodes: [],
      edges: [],
    },
    boardChecksum: "7".repeat(64),
    manifest: {
      protocol: "workbench.project-release.v1",
      artifacts: [],
    },
    manifestSha256: "8".repeat(64),
    failureCode: null,
    failureDetail: null,
    finishedAt: null,
    ...overrides,
  };
  const pinnedBoardRevision = release.boardRevision
    ?? await boardRevision(db, release.boardId);
  await db.query(`
    INSERT INTO "project_releases" (
      "id", "project_id", "version", "status", "created_by_id", "idempotency_key", "request_hash", "board_id",
      "board_revision", "board_snapshot", "board_checksum", "manifest",
      "manifest_sha256", "failure_code", "failure_detail", "finished_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb,
      $13, $14, $15, $16, clock_timestamp()
    )
  `, [
    release.id,
    release.projectId,
    release.version,
    release.status,
    release.createdById,
    release.idempotencyKey,
    release.requestHash,
    release.boardId,
    pinnedBoardRevision,
    JSON.stringify(release.boardSnapshot),
    release.boardChecksum,
    JSON.stringify(release.manifest),
    release.manifestSha256,
    release.failureCode,
    release.failureDetail,
    release.finishedAt,
  ]);
}

async function insertReleaseArtifactVersion(db, overrides = {}) {
  const pin = {
    releaseId: "project-release-building-a",
    projectId: "project-a",
    position: 0,
    artifactId: "artifact-a",
    artifactVersionId: "version-a-ready",
    title: undefined,
    kind: undefined,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "release_artifact_versions" (
      "release_id", "project_id", "position", "artifact_id", "artifact_version_id", "title", "kind"
    ) VALUES (
      $1, $2, $3, $4, $5,
      COALESCE($6, (SELECT "title" FROM "artifacts" WHERE "id" = $4)),
      COALESCE($7::"ArtifactKind", (SELECT "kind" FROM "artifacts" WHERE "id" = $4))
    )
  `, [
    pin.releaseId,
    pin.projectId,
    pin.position,
    pin.artifactId,
    pin.artifactVersionId,
    pin.title,
    pin.kind,
  ]);
}

async function insertShareGrant(db, overrides = {}) {
  const share = {
    id: "candidate-share",
    projectId: "project-a",
    releaseId: "project-release-ready-a",
    artifactVersionId: "version-prototype-ready",
    createdById: "principal-a",
    idempotencyKey: "candidate-share-key",
    requestHash: "4".repeat(64),
    tokenHash: "5".repeat(64),
    scope: "view",
    status: "active",
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "share_grants" (
      "id", "project_id", "release_id", "created_by_id", "idempotency_key",
      "request_hash", "token_hash", "scope", "status", "expires_at", "revoked_at", "artifact_version_id", "updated_at"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp())
  `, [
    share.id,
    share.projectId,
    share.releaseId,
    share.createdById,
    share.idempotencyKey,
    share.requestHash,
    share.tokenHash,
    share.scope,
    share.status,
    share.expiresAt,
    share.revokedAt,
    share.artifactVersionId,
  ]);
}

async function insertExportJob(db, overrides = {}) {
  const job = {
    id: "candidate-export",
    releaseId: "project-release-ready-a",
    createdById: "principal-a",
    idempotencyKey: "candidate-export-key",
    requestHash: "9".repeat(64),
    format: "html",
    packaging: "single_file",
    purpose: "export",
    selectionKind: "release",
    selectionArtifactId: null,
    selectionArtifactVersionId: null,
    selectionScreenId: null,
    status: "queued",
    revision: 0,
    options: {},
    outputBlobId: null,
    failureCode: null,
    failureDetail: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
  await db.query(`
    INSERT INTO "export_jobs" (
      "id", "release_id", "created_by_id", "idempotency_key", "request_hash",
      "format", "packaging", "purpose", "selection_kind", "selection_artifact_id",
      "selection_artifact_version_id", "selection_screen_id", "status", "revision", "options",
      "output_blob_id", "failure_code", "failure_detail", "started_at",
      "finished_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
      $16, $17, $18, $19, $20, clock_timestamp()
    )
  `, [
    job.id,
    job.releaseId,
    job.createdById,
    job.idempotencyKey,
    job.requestHash,
    job.format,
    job.packaging,
    job.purpose,
    job.selectionKind,
    job.selectionArtifactId,
    job.selectionArtifactVersionId,
    job.selectionScreenId,
    job.status,
    job.revision,
    JSON.stringify(job.options),
    job.outputBlobId,
    job.failureCode,
    job.failureDetail,
    job.startedAt,
    job.finishedAt,
  ]);
}

async function insertSucceededExportJob(db, overrides = {}) {
  const id = overrides.id ?? "candidate-export";
  await insertExportJob(db, { ...overrides, id });
  await startExportJob(db, id);
  await succeedExportJob(db, id, "blob-ready");
}

async function insertExternalExportDelivery(db, overrides = {}) {
  const delivery = {
    id: "candidate-delivery",
    exportJobId: "candidate-export",
    createdById: "principal-a",
    idempotencyKey: "candidate-delivery-key",
    requestHash: "8".repeat(64),
    target: "netlify",
    authentication: "not_required",
    status: "pending_confirmation",
    revision: 0,
    payload: null,
    remoteReference: null,
    failureCode: null,
    failureDetail: null,
    attempt: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    transferAuthorizedAt: null,
    confirmedAt: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "payload")) {
    delivery.payload = {
      exportJobId: delivery.exportJobId,
      releaseId: "project-release-ready-a",
      format: "html",
      packaging: "single_file",
      selection: { kind: "release" },
      output: {
        mediaType: "text/html",
        byteSize: 128,
        sha256: "7".repeat(64),
        fileName: "workbench.html",
      },
    };
  }
  await db.query(`
    INSERT INTO "external_export_deliveries" (
      "id", "export_job_id", "created_by_id", "idempotency_key", "request_hash",
      "target", "authentication", "status", "revision", "payload", "remote_reference",
      "failure_code", "failure_detail", "attempt", "lease_token", "lease_expires_at",
      "transfer_authorized_at", "confirmed_at", "started_at", "finished_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
      $12, $13, $14, $15, $16, $17, $18, $19, $20, clock_timestamp()
    )
  `, [
    delivery.id,
    delivery.exportJobId,
    delivery.createdById,
    delivery.idempotencyKey,
    delivery.requestHash,
    delivery.target,
    delivery.authentication,
    delivery.status,
    delivery.revision,
    JSON.stringify(delivery.payload),
    delivery.remoteReference,
    delivery.failureCode,
    delivery.failureDetail,
    delivery.attempt,
    delivery.leaseToken,
    delivery.leaseExpiresAt,
    delivery.transferAuthorizedAt,
    delivery.confirmedAt,
    delivery.startedAt,
    delivery.finishedAt,
  ]);
}

async function insertPreviewExportJob(db, overrides = {}) {
  await insertExportJob(db, {
    id: "candidate-preview-export",
    releaseId: null,
    purpose: "preview",
    idempotencyKey: "preview:candidate-preview-key",
    ...overrides,
  });
}

function previewArtifactPin(overrides = {}) {
  return {
    position: 0,
    projectId: "project-a",
    artifactId: "artifact-a",
    artifactVersionId: "version-a-ready",
    title: "Artifact A",
    kind: "prd",
    version: 1,
    schemaVersion: 1,
    checksum: "a".repeat(64),
    assets: [],
    ...overrides,
  };
}

function prototypePreviewArtifactPin(overrides = {}) {
  return previewArtifactPin({
    artifactId: "artifact-prototype",
    artifactVersionId: "version-prototype-ready",
    title: "Prototype Artifact",
    kind: "prototype",
    checksum: "8a".repeat(32),
    ...overrides,
  });
}

async function insertProjectPreview(db, {
  artifactPin = null,
  exportJobOverrides = {},
  ...overrides
} = {}) {
  await insertPreviewExportJob(db, exportJobOverrides);
  const artifactPins = artifactPin ? [artifactPin] : [];
  await insertProjectPreviewRecord(db, { artifactPins, ...overrides });
  if (artifactPin) await insertProjectPreviewArtifactPin(db, artifactPin);
  await db.query('SET CONSTRAINTS "project_previews_complete_snapshot_guard" IMMEDIATE');
  await db.query('SET CONSTRAINTS "project_previews_complete_snapshot_guard" DEFERRED');
}

async function insertProjectPreviewRecord(db, overrides = {}) {
  const projectId = overrides.projectId ?? "project-a";
  const boardId = overrides.boardId ?? "board-a";
  const boardResult = await db.query(`
    SELECT "revision" FROM "boards" WHERE "id" = $1 AND "project_id" = $2
  `, [boardId, projectId]);
  const boardRevision = overrides.boardRevision ?? boardResult.rows[0]?.revision;
  const preview = {
    id: "candidate-preview",
    projectId,
    boardId,
    boardRevision,
    boardSnapshot: {
      id: boardId,
      projectId,
      revision: boardRevision,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    },
    boardChecksum: "c".repeat(64),
    artifactPins: [],
    initialScreenId: null,
    exportJobId: "candidate-preview-export",
    createdById: "principal-a",
    idempotencyKey: "candidate-preview-key",
    requestHash: "9".repeat(64),
    ...overrides,
  };
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: preview.projectId,
    releaseVersion: 1,
    board: {
      id: preview.boardId,
      revision: preview.boardRevision,
      checksum: preview.boardChecksum,
    },
    artifacts: preview.artifactPins.map(({ projectId: _projectId, ...pin }) => pin),
  };
  await db.query(`
    INSERT INTO "project_previews" (
      "id", "project_id", "board_id", "board_revision", "board_snapshot",
      "board_checksum", "manifest", "manifest_sha256", "initial_screen_id",
      "export_job_id", "created_by_id", "idempotency_key", "request_hash",
      "expires_at", "updated_at"
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
      clock_timestamp() + interval '1 hour', clock_timestamp()
    )
  `, [
    preview.id,
    preview.projectId,
    preview.boardId,
    preview.boardRevision,
    JSON.stringify(preview.boardSnapshot),
    preview.boardChecksum,
    JSON.stringify(manifest),
    "d".repeat(64),
    preview.initialScreenId,
    preview.exportJobId,
    preview.createdById,
    preview.idempotencyKey,
    preview.requestHash,
  ]);
}

async function insertProjectPreviewArtifactPin(db, pin) {
  await db.query(`
    INSERT INTO "project_preview_artifact_versions" (
      "preview_id", "project_id", "position", "artifact_id",
      "artifact_version_id", "title", "kind"
    ) VALUES ('candidate-preview', $1, $2, $3, $4, $5, $6)
  `, [
    pin.projectId,
    pin.position,
    pin.artifactId,
    pin.artifactVersionId,
    pin.title,
    pin.kind,
  ]);
}

async function startExportJob(db, exportJobId) {
  await db.query(`
    UPDATE "export_jobs"
    SET "status" = 'running', "revision" = "revision" + 1,
        "started_at" = clock_timestamp(), "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [exportJobId]);
}

async function succeedExportJob(db, exportJobId, outputBlobId) {
  await db.query(`
    UPDATE "export_jobs"
    SET "status" = 'succeeded', "revision" = "revision" + 1,
        "output_blob_id" = $2, "finished_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE "id" = $1
  `, [exportJobId, outputBlobId]);
}

async function insertBoardNode(db, overrides = {}) {
  const node = {
    id: "candidate-node",
    boardId: "board-a",
    projectId: "project-a",
    nodeKey: "candidate-node",
    parentNodeKey: null,
    sortOrder: 2,
    kind: "artifact",
    position: { x: 0, y: 0 },
    size: null,
    artifactId: "artifact-a",
    artifactVersionId: "version-a-ready",
    data: {
      protocol: "workbench.board-node.v1",
      nodeType: "artifact",
      title: "Candidate artifact",
      artifactKind: "data",
    },
    ...overrides,
  };
  await db.query(`
    INSERT INTO "board_nodes" (
      "id", "board_id", "project_id", "node_key", "parent_node_key", "sort_order", "kind", "position", "size",
      "artifact_id", "artifact_version_id", "data"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb)
  `, [
    node.id,
    node.boardId,
    node.projectId,
    node.nodeKey,
    node.parentNodeKey,
    node.sortOrder,
    node.kind,
    JSON.stringify(node.position),
    node.size === null ? null : JSON.stringify(node.size),
    node.artifactId,
    node.artifactVersionId,
    JSON.stringify(node.data),
  ]);
}

function frameBoardNodeData(title) {
  return {
    protocol: "workbench.board-node.v1",
    nodeType: "frame",
    title,
    fill: null,
    stroke: "#5f6368",
  };
}

function drawingBoardNodeData() {
  return {
    protocol: "workbench.board-node.v1",
    nodeType: "drawing",
    title: "Drawing",
    stroke: {
      algorithm: "perfect-freehand@1",
      intrinsicSize: { width: 40, height: 40 },
      points: [[1, 1, 0.5], [20, 20, 0.5]],
      color: "#f1f3f4",
      size: 5,
      thinning: 0.55,
      smoothing: 0.65,
      streamline: 0.55,
      simulatePressure: true,
    },
  };
}

async function insertBoardEdge(db, overrides = {}) {
  const edge = {
    id: "candidate-edge",
    boardId: "board-a",
    edgeKey: "candidate-edge",
    sourceNodeKey: "left",
    targetNodeKey: "right",
    kind: "flow",
    data: {},
    ...overrides,
  };
  await db.query(`
    INSERT INTO "board_edges" (
      "id", "board_id", "edge_key", "source_node_key", "target_node_key", "kind", "data"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [
    edge.id,
    edge.boardId,
    edge.edgeKey,
    edge.sourceNodeKey,
    edge.targetNodeKey,
    edge.kind,
    JSON.stringify(edge.data),
  ]);
}

async function boardRevision(db, boardId) {
  const result = await db.query(`SELECT "revision" FROM "boards" WHERE "id" = $1`, [boardId]);
  assert.equal(result.rowCount, 1, `Board ${boardId} must exist`);
  return result.rows[0].revision;
}

async function expectReject(db, name, operation, expected) {
  const savepoint = nextSavepoint();
  await db.query(`SAVEPOINT ${savepoint}`);
  let databaseError;
  try {
    await operation();
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  } catch (error) {
    databaseError = error;
  }

  await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await db.query(`RELEASE SAVEPOINT ${savepoint}`);
  if (!databaseError) {
    throw new Error(`${name}: PostgreSQL accepted an invalid write`);
  }

  assert.equal(databaseError.code, expected.code, `${name}: unexpected SQLSTATE`);
  if (expected.constraint) {
    assert.equal(databaseError.constraint, expected.constraint, `${name}: unexpected constraint`);
  }
  if (expected.message) {
    assert.match(
      databaseError.message,
      new RegExp(escapeRegExp(expected.message)),
      `${name}: unexpected trigger error (${databaseError.message})`,
    );
  }
  checks.push({
    name,
    outcome: "rejected",
    sqlState: databaseError.code,
    guard: expected.constraint ?? expected.message,
  });
  console.log(`[constraints] PASS ${name}`);
}

async function expectAccept(db, name, operation) {
  const savepoint = nextSavepoint();
  await db.query(`SAVEPOINT ${savepoint}`);
  try {
    await operation();
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  } catch (error) {
    await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await db.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw new Error(`${name}: valid write was rejected: ${error instanceof Error ? error.message : error}`);
  }
  await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await db.query(`RELEASE SAVEPOINT ${savepoint}`);
  checks.push({ name, outcome: "accepted" });
  console.log(`[constraints] PASS ${name}`);
}

function constraint(code, name) {
  return { code, constraint: name };
}

function trigger(code, message) {
  return { code, message };
}

function nextSavepoint() {
  savepointSequence += 1;
  return `constraint_case_${savepointSequence}`;
}

async function runCommand(command, args, extraEnvironment) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = boundedAppend(output, chunk);
    if (verbose) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output = boundedAppend(output, chunk);
    if (verbose) process.stderr.write(chunk);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, commandTimeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));

  if (timedOut || result.code !== 0) {
    throw new Error(
      `migration command failed (${timedOut ? "timeout" : `exit ${result.code}, signal ${result.signal}`})\n${output}`,
    );
  }
}

function testDatabaseUrl(raw) {
  if (!raw?.trim()) throw new Error("WORKBENCH_TEST_DATABASE_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WORKBENCH_TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("WORKBENCH_TEST_DATABASE_URL must use postgresql:// or postgres://");
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || !isTestDatabaseName(name)) {
    throw new Error(`Refusing to use database without 'test' in its name: ${name || "(empty)"}`);
  }
  if (["postgres", "template0", "template1"].includes(name.toLowerCase())) {
    throw new Error(`Refusing to use protected PostgreSQL database: ${name}`);
  }
  url.searchParams.set("schema", "workbench");
  return url.toString();
}

function isTestDatabaseName(name) {
  return /(?:^|[_-])test(?:$|[_-])/i.test(name);
}

function assertSchemaResetConfirmation(name) {
  if (process.env.WORKBENCH_SCHEMA_RESET_CONFIRM !== name) {
    throw new Error(`WORKBENCH_SCHEMA_RESET_CONFIRM must exactly equal the test database name (${name})`);
  }
}

function pgConnectionUrl(value) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  url.searchParams.delete("options");
  return url.toString();
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function boundedAppend(current, incoming, limit = 256_000) {
  const combined = current + incoming;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
