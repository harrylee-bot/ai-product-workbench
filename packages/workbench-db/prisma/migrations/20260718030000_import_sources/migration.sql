BEGIN;

CREATE TYPE "ImportSourceKind" AS ENUM (
  'file',
  'design_md',
  'url_snapshot',
  'github_snapshot',
  'figma_snapshot'
);

CREATE TYPE "ImportSourceStatus" AS ENUM (
  'pending',
  'ready',
  'failed',
  'deleted'
);

-- Fetching an external source is an auditable job in its own right.  Keep its
-- lease/retry state out of import_sources: the source row is the frozen
-- identity and manifest, while attempts are append-only execution records.
CREATE TYPE "ImportSourceAttemptStatus" AS ENUM (
  'queued',
  'running',
  'succeeded',
  'retryable_failed',
  'terminal_failed'
);

CREATE TABLE "import_sources" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "kind" "ImportSourceKind" NOT NULL,
  "status" "ImportSourceStatus" NOT NULL DEFAULT 'pending',
  "label" VARCHAR(240) NOT NULL,
  "descriptor" JSONB,
  "request" JSONB NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "checksum" CHAR(64),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "failure_code" VARCHAR(120),
  "failure_detail" VARCHAR(2000),
  "deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "import_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_sources_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "import_sources_project_idempotency_key_key" UNIQUE ("project_id", "idempotency_key"),
  CONSTRAINT "import_sources_request_object_check" CHECK (jsonb_typeof("request") = 'object'),
  CONSTRAINT "import_sources_request_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "import_sources_request_kind_check" CHECK ("request" ->> 'kind' = "kind"::TEXT),
  CONSTRAINT "import_sources_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 240 AND "label" !~ '[[:cntrl:]]'),
  CONSTRAINT "import_sources_checksum_check" CHECK ("checksum" IS NULL OR "checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "import_sources_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "import_sources_lifecycle_check" CHECK (
    ("status" = 'ready' AND jsonb_typeof("descriptor") = 'object' AND "descriptor" ->> 'kind' = "kind"::TEXT AND "checksum" IS NOT NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL AND "deleted_at" IS NULL)
    OR ("status" = 'pending' AND "descriptor" IS NULL AND "checksum" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL AND "deleted_at" IS NULL)
    OR ("status" = 'failed' AND "descriptor" IS NULL AND "checksum" IS NULL AND "failure_code" IS NOT NULL AND "failure_detail" IS NOT NULL AND "deleted_at" IS NULL)
    OR ("status" = 'deleted' AND "failure_code" IS NULL AND "failure_detail" IS NULL AND "deleted_at" IS NOT NULL)
  ),
  CONSTRAINT "import_sources_failure_pair_check" CHECK (("failure_code" IS NULL) = ("failure_detail" IS NULL))
);

CREATE INDEX "import_sources_project_id_status_created_at_id_idx"
  ON "import_sources"("project_id", "status", "created_at", "id");
CREATE INDEX "import_sources_created_by_id_created_at_idx"
  ON "import_sources"("created_by_id", "created_at");

ALTER TABLE "import_sources"
  ADD CONSTRAINT "import_sources_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "import_sources_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "import_source_attempts" (
  "id" TEXT NOT NULL,
  "import_source_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "queue_job_id" TEXT NOT NULL,
  "status" "ImportSourceAttemptStatus" NOT NULL DEFAULT 'queued',
  "lease_token" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "failure_code" VARCHAR(120),
  "failure_detail" VARCHAR(2000),
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "import_source_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_source_attempts_attempt_positive_check" CHECK ("attempt" > 0),
  CONSTRAINT "import_source_attempts_queue_job_id_check" CHECK (length(btrim("queue_job_id")) BETWEEN 1 AND 255 AND "queue_job_id" !~ '[[:cntrl:]]'),
  CONSTRAINT "import_source_attempts_lease_pair_check" CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "import_source_attempts_failure_pair_check" CHECK (("failure_code" IS NULL) = ("failure_detail" IS NULL)),
  CONSTRAINT "import_source_attempts_timestamp_order_check" CHECK (
    ("started_at" IS NULL OR "started_at" >= "created_at")
    AND ("finished_at" IS NULL OR "started_at" IS NOT NULL AND "finished_at" >= "started_at")
    AND ("lease_expires_at" IS NULL OR "started_at" IS NULL OR "lease_expires_at" > "started_at")
  ),
  CONSTRAINT "import_source_attempts_state_check" CHECK (
    ("status" = 'queued' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL AND "started_at" IS NULL AND "finished_at" IS NULL)
    OR ("status" = 'running' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
    OR ("status" = 'succeeded' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
    OR ("status" = 'retryable_failed' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "failure_code" IS NOT NULL AND "failure_detail" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
    OR ("status" = 'terminal_failed' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL AND "failure_code" IS NOT NULL AND "failure_detail" IS NOT NULL AND "started_at" IS NOT NULL AND "finished_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "import_source_attempts_source_id_attempt_key"
  ON "import_source_attempts"("import_source_id", "attempt");
CREATE UNIQUE INDEX "import_source_attempts_queue_job_id_key"
  ON "import_source_attempts"("queue_job_id");
CREATE UNIQUE INDEX "import_source_attempts_active_source_key"
  ON "import_source_attempts"("import_source_id")
  WHERE "status" IN ('queued', 'running');
CREATE INDEX "import_source_attempts_project_id_status_updated_at_idx"
  ON "import_source_attempts"("project_id", "status", "updated_at");
CREATE INDEX "import_source_attempts_source_id_status_attempt_idx"
  ON "import_source_attempts"("import_source_id", "status", "attempt");

ALTER TABLE "import_source_attempts"
  ADD CONSTRAINT "import_source_attempts_source_fkey"
  FOREIGN KEY ("import_source_id", "project_id") REFERENCES "import_sources"("id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "import_source_blobs" (
  "id" TEXT NOT NULL,
  "import_source_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "blob_id" TEXT NOT NULL,
  "file_asset_id" TEXT,
  "role" VARCHAR(80) NOT NULL,
  "path" VARCHAR(1024),
  "media_type" VARCHAR(255) NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "import_source_blobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_source_blobs_source_position_key" UNIQUE ("import_source_id", "position"),
  CONSTRAINT "import_source_blobs_source_path_key" UNIQUE ("import_source_id", "path"),
  CONSTRAINT "import_source_blobs_position_check" CHECK ("position" >= 0),
  CONSTRAINT "import_source_blobs_position_bound_check" CHECK ("position" BETWEEN 0 AND 49),
  CONSTRAINT "import_source_blobs_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 9007199254740991),
  CONSTRAINT "import_source_blobs_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "import_source_blobs_media_type_check" CHECK ("media_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
  CONSTRAINT "import_source_blobs_role_check" CHECK (length(btrim("role")) BETWEEN 1 AND 80 AND "role" !~ '[[:cntrl:]]'),
  CONSTRAINT "import_source_blobs_path_check" CHECK ("path" IS NULL OR (length("path") BETWEEN 1 AND 1024 AND "path" !~ '[[:cntrl:]]')),
  CONSTRAINT "import_source_blobs_metadata_check" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object')
);

CREATE INDEX "import_source_blobs_project_id_created_at_idx"
  ON "import_source_blobs"("project_id", "created_at");
CREATE INDEX "import_source_blobs_blob_id_idx"
  ON "import_source_blobs"("blob_id");
CREATE UNIQUE INDEX "import_source_blobs_source_blob_key"
  ON "import_source_blobs"("import_source_id", "blob_id");
CREATE INDEX "import_source_blobs_file_asset_scope_idx"
  ON "import_source_blobs"("file_asset_id", "project_id", "blob_id");

ALTER TABLE "import_source_blobs"
  ADD CONSTRAINT "import_source_blobs_source_fkey"
  FOREIGN KEY ("import_source_id", "project_id") REFERENCES "import_sources"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "import_source_blobs_blob_fkey"
  FOREIGN KEY ("blob_id", "sha256", "byte_size", "media_type") REFERENCES "blobs"("id", "sha256", "byte_size", "media_type") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "import_source_blobs_file_asset_fkey"
  FOREIGN KEY ("file_asset_id", "project_id", "blob_id") REFERENCES "file_assets"("id", "project_id", "blob_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "run_source_snapshots" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "source_id" TEXT NOT NULL,
  "kind" "ImportSourceKind" NOT NULL,
  "label" VARCHAR(240) NOT NULL,
  "checksum" CHAR(64) NOT NULL,
  "descriptor" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_source_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_source_snapshots_run_position_key" UNIQUE ("run_id", "position"),
  CONSTRAINT "run_source_snapshots_run_source_key" UNIQUE ("run_id", "source_id"),
  CONSTRAINT "run_source_snapshots_position_check" CHECK ("position" BETWEEN 0 AND 49),
  CONSTRAINT "run_source_snapshots_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "run_source_snapshots_kind_check" CHECK ("descriptor" ->> 'kind' = "kind"::TEXT),
  CONSTRAINT "run_source_snapshots_descriptor_check" CHECK (jsonb_typeof("descriptor") = 'object'),
  CONSTRAINT "run_source_snapshots_snapshot_check" CHECK (
    jsonb_typeof("snapshot") = 'object'
    AND "snapshot" ->> 'protocol' = 'workbench.import-source-snapshot.v1'
    AND ("snapshot" ->> 'sourceRevision') ~ '^[0-9]+$'
    AND "snapshot" ->> 'checksum' = "checksum"
    AND jsonb_typeof("snapshot" -> 'blobs') = 'array'
    AND jsonb_array_length("snapshot" -> 'blobs') <= 50
  )
);

CREATE INDEX "run_source_snapshots_source_id_created_at_idx"
  ON "run_source_snapshots"("source_id", "created_at");

ALTER TABLE "run_source_snapshots"
  ADD CONSTRAINT "run_source_snapshots_run_fkey"
  FOREIGN KEY ("run_id", "project_id") REFERENCES "runs"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT "run_source_snapshots_source_fkey"
  FOREIGN KEY ("source_id", "project_id") REFERENCES "import_sources"("id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The old attachment table is a transport-era snapshot, not a durable domain
-- object.  Existing development rows are converted once, then the table is
-- removed.  Invalid historical rows fail loudly instead of becoming a false
-- ready Source.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "run_attachments" AS attachment
    JOIN "file_assets" AS file
      ON file."id" = attachment."file_asset_id"
      AND file."project_id" = attachment."project_id"
      AND file."blob_id" = attachment."blob_id"
    JOIN "blobs" AS blob ON blob."id" = attachment."blob_id"
    WHERE file."status" IS DISTINCT FROM 'ready'::"FileStatus"
      OR blob."status" IS DISTINCT FROM 'ready'::"BlobStatus"
      OR blob."deleted_at" IS NOT NULL
      OR attachment."original_name" IS DISTINCT FROM file."original_name"
      OR attachment."media_type" IS DISTINCT FROM COALESCE(file."detected_media_type", file."declared_media_type")
      OR attachment."byte_size" IS DISTINCT FROM blob."byte_size"
      OR attachment."sha256" IS DISTINCT FROM blob."sha256"
      OR (
        SELECT scan."status"
        FROM "blob_scans" AS scan
        WHERE scan."blob_id" = blob."id"
        ORDER BY scan."attempt" DESC
        LIMIT 1
      ) IS DISTINCT FROM 'clean'::"BlobScanStatus"
  ) THEN
    RAISE EXCEPTION 'MIGRATION_RUN_ATTACHMENT_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "run_attachments"
    GROUP BY "run_id"
    HAVING count(*) > 50
      OR min("position") <> 0
      OR count(*) <> max("position") + 1
  ) THEN
    RAISE EXCEPTION 'MIGRATION_RUN_ATTACHMENT_POSITIONS_INVALID' USING ERRCODE = '23514';
  END IF;
END;
$$;

-- One Source is shared by all historical Runs that pinned the same verified
-- FileAsset.  The deterministic ids make this block rerunnable while the
-- migration transaction is being developed locally.
INSERT INTO "import_sources" (
  "id", "project_id", "created_by_id", "kind", "status", "label",
  "descriptor", "request", "request_hash", "idempotency_key", "checksum",
  "revision", "created_at", "updated_at"
)
SELECT
  'source_migrated_' || md5(candidate."project_id" || ':' || candidate."file_asset_id"),
  candidate."project_id",
  candidate."uploaded_by_id",
  'file'::"ImportSourceKind",
  'ready'::"ImportSourceStatus",
  candidate."original_name",
  jsonb_build_object(
    'kind', 'file',
    'fileAssetId', candidate."file_asset_id",
    'originalName', candidate."original_name",
    'mediaType', candidate."media_type"
  ),
  jsonb_build_object('kind', 'file', 'fileAssetId', candidate."file_asset_id"),
  encode(
      public.digest(
      '{"fileAssetId":' || to_json(candidate."file_asset_id")::TEXT || ',"kind":"file"}',
      'sha256'
    ),
    'hex'
  ),
  'migration:file:' || md5(candidate."project_id" || ':' || candidate."file_asset_id"),
  candidate."sha256",
  0,
  candidate."created_at",
  candidate."created_at"
FROM (
  SELECT
    attachment."project_id",
    attachment."file_asset_id",
    min(attachment."created_at") AS "created_at",
    file."uploaded_by_id",
    file."original_name",
    COALESCE(file."detected_media_type", file."declared_media_type") AS "media_type",
    blob."sha256"
  FROM "run_attachments" AS attachment
  JOIN "file_assets" AS file
    ON file."id" = attachment."file_asset_id"
    AND file."project_id" = attachment."project_id"
  JOIN "blobs" AS blob ON blob."id" = attachment."blob_id"
  GROUP BY
    attachment."project_id", attachment."file_asset_id", file."uploaded_by_id",
    file."original_name", COALESCE(file."detected_media_type", file."declared_media_type"),
    blob."sha256"
) AS candidate;

INSERT INTO "import_source_blobs" (
  "id", "import_source_id", "project_id", "position", "blob_id", "file_asset_id",
  "role", "path", "media_type", "byte_size", "sha256", "created_at"
)
SELECT
  'source_blob_migrated_' || md5(attachment."project_id" || ':' || attachment."file_asset_id"),
  source."id",
  attachment."project_id",
  0,
  attachment."blob_id",
  attachment."file_asset_id",
  'primary',
  attachment."original_name",
  attachment."media_type",
  attachment."byte_size",
  attachment."sha256",
  attachment."created_at"
FROM "run_attachments" AS attachment
JOIN "import_sources" AS source
  ON source."id" = 'source_migrated_' || md5(attachment."project_id" || ':' || attachment."file_asset_id")
WHERE attachment."position" = (
  SELECT min(first_attachment."position")
  FROM "run_attachments" AS first_attachment
  WHERE first_attachment."project_id" = attachment."project_id"
    AND first_attachment."file_asset_id" = attachment."file_asset_id"
);

INSERT INTO "run_source_snapshots" (
  "id", "run_id", "project_id", "position", "source_id", "kind", "label",
  "checksum", "descriptor", "snapshot", "created_at"
)
SELECT
  'run_source_migrated_' || md5(attachment."run_id" || ':' || attachment."position"),
  attachment."run_id",
  attachment."project_id",
  attachment."position",
  source."id",
  source."kind",
  source."label",
  source."checksum",
  source."descriptor",
  jsonb_build_object(
    'protocol', 'workbench.import-source-snapshot.v1',
    'sourceRevision', source."revision",
    'checksum', source."checksum",
    'blobs', jsonb_build_array(jsonb_build_object(
      'blobId', attachment."blob_id",
      'position', 0,
      'role', 'primary',
      'path', attachment."original_name",
      'mediaType', attachment."media_type",
      'byteSize', attachment."byte_size",
      'sha256', attachment."sha256"
    ))
  ),
  attachment."created_at"
FROM "run_attachments" AS attachment
JOIN "import_sources" AS source
  ON source."id" = 'source_migrated_' || md5(attachment."project_id" || ':' || attachment."file_asset_id");

-- Rewrite persisted request envelopes before installing the hard-cut typed
-- options check.  The old request hash is intentionally left as historical
-- idempotency evidence; old idempotency keys are not replayable after cutover.
ALTER TABLE "runs" DROP CONSTRAINT "runs_typed_options_check";
ALTER TABLE "runs" DISABLE TRIGGER "runs_identity_and_knowledge_guard";

UPDATE "runs" AS run
SET "request" =
      (run."request" - 'attachmentIds')
      || jsonb_build_object(
        'sourceIds', COALESCE(source_ids."source_ids", '[]'::JSONB)
      ),
    "updated_at" = clock_timestamp()
FROM (
  SELECT
    snapshot."run_id",
    jsonb_agg(to_jsonb(snapshot."source_id") ORDER BY snapshot."position") AS "source_ids"
  FROM "run_source_snapshots" AS snapshot
  GROUP BY snapshot."run_id"
) AS source_ids
WHERE run."id" = source_ids."run_id";

UPDATE "runs" AS run
SET "request" = (run."request" - 'attachmentIds') || jsonb_build_object('sourceIds', '[]'::JSONB),
    "updated_at" = clock_timestamp()
WHERE NOT (run."request" ? 'sourceIds');

ALTER TABLE "runs" ENABLE TRIGGER "runs_identity_and_knowledge_guard";

-- Thread user entries carry the same old attachment references.  Keep the
-- entry envelope parseable by the new API without retaining a second id list.
UPDATE "thread_entries" AS entry
SET "content" = (entry."content" - 'attachmentIds') || jsonb_build_object(
  'sourceIds', COALESCE((
    SELECT jsonb_agg(
      to_jsonb(('source_migrated_' || md5(thread."project_id" || ':' || ids.value))::TEXT)
      ORDER BY ids.ordinal
    )
    FROM jsonb_array_elements_text(entry."content" -> 'attachmentIds')
      WITH ORDINALITY AS ids(value, ordinal)
  ), '[]'::JSONB)
)
FROM "threads" AS thread
WHERE entry."thread_id" = thread."id"
  AND entry."content" ->> 'type' = 'user.prompt'
  AND jsonb_typeof(entry."content" -> 'attachmentIds') = 'array';

-- SubmissionIntent requests are persisted Run envelopes too.  Submitted
-- intents must match their newly rewritten Run; still-open intents retain
-- their attachment slots and start with an empty explicit Source list.
ALTER TABLE "submission_intents" DISABLE TRIGGER "submission_intents_mutation_guard";
UPDATE "submission_intents" AS intent
SET "request" = run."request",
    "updated_at" = clock_timestamp()
FROM "runs" AS run
WHERE intent."run_id" IS NOT NULL AND run."id" = intent."run_id";
UPDATE "submission_intents" AS intent
SET "request" = (intent."request" - 'attachmentIds') || jsonb_build_object('sourceIds', '[]'::JSONB),
    "updated_at" = clock_timestamp()
WHERE intent."run_id" IS NULL AND intent."request" ? 'attachmentIds';
ALTER TABLE "submission_intents" ENABLE TRIGGER "submission_intents_mutation_guard";

DROP TRIGGER IF EXISTS "run_attachments_update_guard" ON "run_attachments";
DROP TRIGGER IF EXISTS "run_attachments_mutation_guard" ON "run_attachments";
DROP TRIGGER IF EXISTS "run_attachments_blob_gc_reference_guard" ON "run_attachments";
DROP FUNCTION IF EXISTS "guard_run_attachment_update"();

-- Replace every durable-byte reference check before removing the old table.
CREATE OR REPLACE FUNCTION "blob_has_durable_byte_references"("candidate_blob_id" TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT
    EXISTS (SELECT 1 FROM "file_assets" AS file WHERE file."blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "file_extractions" AS extraction WHERE extraction."source_blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "file_extraction_outputs" AS output WHERE output."blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "import_source_blobs" AS source_blob WHERE source_blob."blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "artifact_versions" AS version WHERE version."content_blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "artifact_version_assets" AS asset WHERE asset."blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "artifact_creation_receipts" AS receipt WHERE receipt."source_blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "knowledge_documents" AS document WHERE document."source_blob_id" = "candidate_blob_id")
    OR EXISTS (SELECT 1 FROM "export_jobs" AS job WHERE job."output_blob_id" = "candidate_blob_id");
$$;

CREATE OR REPLACE FUNCTION "guard_blob_artifact_references"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'deleted')
    OR (NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at" AND NEW."deleted_at" IS NOT NULL)
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "artifact_versions" AS version
    WHERE version."content_blob_id" = OLD."id" AND version."status" = 'ready'
  ) OR EXISTS (
    SELECT 1
    FROM "artifact_version_assets" AS asset
    JOIN "artifact_versions" AS version ON version."id" = asset."artifact_version_id"
    WHERE asset."blob_id" = OLD."id" AND version."status" = 'ready'
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_READY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (SELECT 1 FROM "artifact_versions" AS version WHERE version."content_blob_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "artifact_version_assets" AS asset WHERE asset."blob_id" = OLD."id")
  THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (SELECT 1 FROM "import_source_blobs" AS source_blob WHERE source_blob."blob_id" = OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_IMPORT_SOURCE' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (SELECT 1 FROM "file_extractions" AS extraction WHERE extraction."source_blob_id" = OLD."id")
    OR EXISTS (SELECT 1 FROM "file_extraction_outputs" AS output WHERE output."blob_id" = OLD."id")
  THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_FILE_EXTRACTION' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (SELECT 1 FROM "file_assets" AS file WHERE file."blob_id" = OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_FILE_ASSET' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM "knowledge_documents" AS document WHERE document."source_blob_id" = OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_KNOWLEDGE_DOCUMENT' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM "export_jobs" AS job WHERE job."output_blob_id" = OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_EXPORT_JOB' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM "artifact_creation_receipts" AS receipt WHERE receipt."source_blob_id" = OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_ARTIFACT_CREATION_RECEIPT' USING ERRCODE = '23503';
  END IF;
  IF "blob_has_durable_byte_references"(OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_DURABLE_BYTE_OWNER' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "guard_blob_reference_for_gc"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_blob_id TEXT;
BEGIN
  referenced_blob_id := to_jsonb(NEW)->>TG_ARGV[0];
  IF referenced_blob_id IS NULL OR referenced_blob_id = '' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND referenced_blob_id IS NOT DISTINCT FROM to_jsonb(OLD)->>TG_ARGV[0] THEN
    RETURN NEW;
  END IF;
  UPDATE "blobs"
  SET "gc_eligible_at" = NULL, "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
  WHERE "id" = referenced_blob_id AND "status" <> 'deleted' AND "deleted_at" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOB_REFERENCE_TARGET_UNAVAILABLE' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

-- Existing blobs may have been marked GC-eligible before their first Source
-- reference was materialized. Recompute the eligibility fence now that the
-- Source manifest is authoritative.
UPDATE "blobs" AS blob
SET "gc_eligible_at" = NULL,
    "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE blob."status" <> 'deleted'
  AND blob."gc_eligible_at" IS NOT NULL
  AND "blob_has_durable_byte_references"(blob."id");

CREATE TRIGGER "import_source_blobs_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "blob_id" ON "import_source_blobs"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('blob_id');

DROP TABLE "run_attachments";

-- A source blob is writable only while its Source is pending.  This forces
-- workers to build the complete manifest first and flip Source to ready once.
CREATE OR REPLACE FUNCTION "guard_import_source_blob_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_status "ImportSourceStatus";
  blob_status "BlobStatus";
  latest_scan_status "BlobScanStatus";
  file_status "FileStatus";
  file_blob_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_BLOB_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "import_sources" WHERE "id" = OLD."import_source_id") THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_BLOB_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT source."status"
  INTO source_status
  FROM "import_sources" AS source
  WHERE source."id" = NEW."import_source_id"
    AND source."project_id" = NEW."project_id"
  FOR SHARE;
  IF source_status IS DISTINCT FROM 'pending'::"ImportSourceStatus" THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_MANIFEST_FROZEN' USING ERRCODE = '23514';
  END IF;

  SELECT blob."status", scan."status"
  INTO blob_status, latest_scan_status
  FROM "blobs" AS blob
  LEFT JOIN LATERAL (
    SELECT scan."status"
    FROM "blob_scans" AS scan
    WHERE scan."blob_id" = blob."id"
    ORDER BY scan."attempt" DESC
    LIMIT 1
  ) AS scan ON TRUE
  WHERE blob."id" = NEW."blob_id"
    AND blob."sha256" = NEW."sha256"
    AND blob."byte_size" = NEW."byte_size"
    AND blob."media_type" = NEW."media_type"
  FOR SHARE OF blob;
  IF blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
    OR latest_scan_status IS DISTINCT FROM 'clean'::"BlobScanStatus"
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_BLOB_NOT_READY' USING ERRCODE = '23514';
  END IF;

  IF NEW."file_asset_id" IS NOT NULL THEN
    SELECT file."status", file."blob_id"
    INTO file_status, file_blob_id
    FROM "file_assets" AS file
    WHERE file."id" = NEW."file_asset_id"
      AND file."project_id" = NEW."project_id"
    FOR SHARE;
    IF file_status IS DISTINCT FROM 'ready'::"FileStatus"
      OR file_blob_id IS DISTINCT FROM NEW."blob_id"
    THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_FILE_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "import_source_blobs_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "import_source_blobs"
FOR EACH ROW EXECUTE FUNCTION "guard_import_source_blob_mutation"();

CREATE OR REPLACE FUNCTION "guard_import_source_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."label" IS DISTINCT FROM OLD."label"
    OR NEW."request" IS DISTINCT FROM OLD."request"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'pending' AND NEW."status" NOT IN ('pending', 'ready', 'failed', 'deleted')
    OR OLD."status" = 'ready' AND NEW."status" NOT IN ('ready', 'deleted')
    OR OLD."status" = 'failed' AND NEW."status" NOT IN ('failed', 'deleted')
    OR OLD."status" = 'deleted' AND NEW."status" <> 'deleted'
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'pending'
    AND (NEW."descriptor" IS DISTINCT FROM OLD."descriptor" OR NEW."checksum" IS DISTINCT FROM OLD."checksum")
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_MANIFEST_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" = 'pending'
    AND (NEW."descriptor" IS DISTINCT FROM OLD."descriptor" OR NEW."checksum" IS DISTINCT FROM OLD."checksum")
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_PENDING_MANIFEST_MUTATION' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'ready' AND OLD."status" <> 'pending'
    AND (NEW."descriptor" IS DISTINCT FROM OLD."descriptor" OR NEW."checksum" IS DISTINCT FROM OLD."checksum")
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_MANIFEST_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'deleted' AND NEW."failure_code" IS NOT NULL THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_DELETED_FAILURE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "import_sources_update_guard"
BEFORE UPDATE ON "import_sources"
FOR EACH ROW EXECUTE FUNCTION "guard_import_source_update"();

CREATE OR REPLACE FUNCTION "guard_import_source_attempt_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."import_source_id" IS DISTINCT FROM OLD."import_source_id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."queue_job_id" IS DISTINCT FROM OLD."queue_job_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('succeeded', 'retryable_failed', 'terminal_failed')
    AND NEW IS DISTINCT FROM OLD
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'queued' AND NEW."status" NOT IN ('queued', 'running')
    OR OLD."status" = 'running' AND NEW."status" NOT IN ('running', 'succeeded', 'retryable_failed', 'terminal_failed')
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_STATUS_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "import_source_attempts_update_guard"
BEFORE UPDATE OR DELETE ON "import_source_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_import_source_attempt_update"();

CREATE OR REPLACE FUNCTION "guard_import_source_attempt_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind "ImportSourceKind";
  source_status "ImportSourceStatus";
  expected_attempt INTEGER;
BEGIN
  SELECT source."kind", source."status"
  INTO source_kind, source_status
  FROM "import_sources" AS source
  WHERE source."id" = NEW."import_source_id"
    AND source."project_id" = NEW."project_id"
  FOR UPDATE;
  IF source_kind IS NULL OR source_kind IN ('file', 'design_md') THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_LOCAL_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF source_status NOT IN ('pending', 'deleted') THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_SOURCE_NOT_PENDING' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(max(attempt), 0) + 1
  INTO expected_attempt
  FROM "import_source_attempts"
  WHERE "import_source_id" = NEW."import_source_id";
  IF NEW."attempt" <> expected_attempt THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_SEQUENCE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "import_source_attempts_insert_guard"
BEFORE INSERT ON "import_source_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_import_source_attempt_insert"();

-- Validate a complete, contiguous manifest and the attempt/source lifecycle at
-- transaction end.  This is deliberately deferred so workers can write blobs,
-- attempt receipt and final Source state in one transaction.
CREATE OR REPLACE FUNCTION "guard_import_source_complete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_kind "ImportSourceKind";
  current_status "ImportSourceStatus";
  manifest_count INTEGER;
  max_position INTEGER;
  expected_attempt_status "ImportSourceAttemptStatus";
  latest_attempt_status "ImportSourceAttemptStatus";
  descriptor_kind TEXT;
BEGIN
  -- A single transaction commonly emits both INSERT(pending) and
  -- UPDATE(ready/failed) events. Constraint triggers receive each event's
  -- OLD/NEW image, so ignore stale intermediate images and validate the row's
  -- final visible state instead.
  SELECT source."status"
  INTO current_status
  FROM "import_sources" AS source
  WHERE source."id" = NEW."id";
  IF current_status IS DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;
  source_kind := NEW."kind";
  descriptor_kind := NEW."descriptor" ->> 'kind';

  IF NEW."status" = 'pending' THEN
    IF source_kind IN ('file', 'design_md') THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_LOCAL_PENDING_NOT_ALLOWED' USING ERRCODE = '23514';
    END IF;
    SELECT attempt."status"
    INTO latest_attempt_status
    FROM "import_source_attempts" AS attempt
    WHERE attempt."import_source_id" = NEW."id"
    ORDER BY attempt."attempt" DESC
    LIMIT 1;
    IF latest_attempt_status IS NULL THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_ATTEMPT_RECEIPT_MISSING' USING ERRCODE = '23514';
    END IF;
    IF latest_attempt_status NOT IN (
      'queued'::"ImportSourceAttemptStatus",
      'running'::"ImportSourceAttemptStatus",
      'retryable_failed'::"ImportSourceAttemptStatus"
    ) THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_PENDING_ATTEMPT_STATE_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'failed' THEN
    SELECT attempt."status"
    INTO latest_attempt_status
    FROM "import_source_attempts" AS attempt
    WHERE attempt."import_source_id" = NEW."id"
    ORDER BY attempt."attempt" DESC
    LIMIT 1;
    IF latest_attempt_status IS DISTINCT FROM 'terminal_failed'::"ImportSourceAttemptStatus" THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_TERMINAL_FAILURE_RECEIPT_MISSING' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" = 'deleted' THEN
    RETURN NEW;
  END IF;

  IF NEW."status" <> 'ready' THEN
    RETURN NEW;
  END IF;

  IF descriptor_kind IS DISTINCT FROM source_kind::TEXT
    OR NEW."descriptor" IS NULL
    OR NEW."checksum" IS NULL
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_READY_DESCRIPTOR_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::INTEGER, max(blob."position")
  INTO manifest_count, max_position
  FROM "import_source_blobs" AS blob
  WHERE blob."import_source_id" = NEW."id";
  IF manifest_count < 1 OR manifest_count > 50 OR max_position IS DISTINCT FROM manifest_count - 1 THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_MANIFEST_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "import_source_blobs" AS source_blob
    JOIN "blobs" AS blob ON blob."id" = source_blob."blob_id"
    WHERE source_blob."import_source_id" = NEW."id"
      AND (
        blob."status" IS DISTINCT FROM 'ready'::"BlobStatus"
        OR blob."deleted_at" IS NOT NULL
        OR (
          SELECT scan."status"
          FROM "blob_scans" AS scan
          WHERE scan."blob_id" = blob."id"
          ORDER BY scan."attempt" DESC
          LIMIT 1
        ) IS DISTINCT FROM 'clean'::"BlobScanStatus"
      )
  ) THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_MANIFEST_BLOB_NOT_CLEAN' USING ERRCODE = '23514';
  END IF;

  IF source_kind IN ('file', 'design_md') THEN
    IF manifest_count <> 1
      OR EXISTS (
        SELECT 1 FROM "import_source_blobs" AS source_blob
        WHERE source_blob."import_source_id" = NEW."id"
          AND (source_blob."file_asset_id" IS NULL OR source_blob."role" <> 'primary' OR source_blob."position" <> 0)
      )
      OR NEW."checksum" IS DISTINCT FROM (
        SELECT blob."sha256"
        FROM "import_source_blobs" AS source_blob
        JOIN "blobs" AS blob ON blob."id" = source_blob."blob_id"
        WHERE source_blob."import_source_id" = NEW."id"
      )
      OR NEW."descriptor" ->> 'fileAssetId' IS DISTINCT FROM (
        SELECT source_blob."file_asset_id"
        FROM "import_source_blobs" AS source_blob
        WHERE source_blob."import_source_id" = NEW."id"
      )
      OR NEW."descriptor" ->> 'originalName' IS DISTINCT FROM (
        SELECT file."original_name"
        FROM "import_source_blobs" AS source_blob
        JOIN "file_assets" AS file ON file."id" = source_blob."file_asset_id"
        WHERE source_blob."import_source_id" = NEW."id"
      )
      OR NEW."descriptor" ->> 'mediaType' IS DISTINCT FROM (
        SELECT COALESCE(file."detected_media_type", file."declared_media_type")
        FROM "import_source_blobs" AS source_blob
        JOIN "file_assets" AS file ON file."id" = source_blob."file_asset_id"
        WHERE source_blob."import_source_id" = NEW."id"
      )
    THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_LOCAL_MANIFEST_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM "import_source_blobs" AS source_blob
    WHERE source_blob."import_source_id" = NEW."id" AND source_blob."file_asset_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_EXTERNAL_FILE_ASSET_INVALID' USING ERRCODE = '23514';
  END IF;

  IF source_kind = 'github_snapshot'
    AND (
      NEW."descriptor" ->> 'commitSha' IS NULL
      OR NEW."descriptor" ->> 'commitSha' !~ '^[0-9a-fA-F]{40}$'
      OR NEW."descriptor" ->> 'repository' IS DISTINCT FROM NEW."request" ->> 'repository'
    )
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_GITHUB_COMMIT_NOT_PINNED' USING ERRCODE = '23514';
  END IF;
  IF source_kind = 'figma_snapshot'
    AND (
      length(COALESCE(NEW."descriptor" ->> 'versionId', '')) = 0
      OR NEW."descriptor" ->> 'fileKey' IS DISTINCT FROM NEW."request" ->> 'fileKey'
      OR (
        NEW."request" ->> 'versionId' IS NOT NULL
        AND NEW."descriptor" ->> 'versionId' IS DISTINCT FROM NEW."request" ->> 'versionId'
      )
    )
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_FIGMA_VERSION_NOT_PINNED' USING ERRCODE = '23514';
  END IF;
  IF source_kind = 'url_snapshot'
    AND (
      length(COALESCE(NEW."descriptor" ->> 'sourceUrl', '')) = 0
      OR NEW."descriptor" ->> 'sourceUrl' IS DISTINCT FROM NEW."request" ->> 'sourceUrl'
      OR (
        NEW."descriptor" ->> 'resolvedUrl' IS NOT NULL
        AND NEW."descriptor" ->> 'resolvedUrl' !~ '^(https?)://'
      )
    )
  THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_URL_NOT_PINNED' USING ERRCODE = '23514';
  END IF;

  IF source_kind IN ('url_snapshot', 'github_snapshot', 'figma_snapshot') THEN
    SELECT attempt."status"
    INTO latest_attempt_status
    FROM "import_source_attempts" AS attempt
    WHERE attempt."import_source_id" = NEW."id"
    ORDER BY attempt."attempt" DESC
    LIMIT 1;
    IF latest_attempt_status IS DISTINCT FROM 'succeeded'::"ImportSourceAttemptStatus" THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_SUCCESS_RECEIPT_MISSING' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "import_sources_complete_guard"
AFTER INSERT OR UPDATE ON "import_sources"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_import_source_complete"();

CREATE OR REPLACE FUNCTION "guard_run_source_snapshot_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status "RunStatus";
  retry_source_id TEXT;
  source_status "ImportSourceStatus";
  source_revision INTEGER;
  source_kind "ImportSourceKind";
  source_label TEXT;
  source_checksum TEXT;
  source_descriptor JSONB;
  source_manifest_count INTEGER;
  run_blob_count INTEGER;
  expected_blob_count INTEGER;
  actual_blob_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "runs" WHERE "id" = OLD."run_id") THEN
      RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT run."status", run."retry_of_run_id"
  INTO run_status, retry_source_id
  FROM "runs" AS run
  WHERE run."id" = NEW."run_id" AND run."project_id" = NEW."project_id"
  FOR SHARE;
  IF run_status IS DISTINCT FROM 'queued'::"RunStatus" THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_RUN_NOT_QUEUED' USING ERRCODE = '23514';
  END IF;

  SELECT source."status", source."revision", source."kind", source."label", source."checksum", source."descriptor"
  INTO source_status, source_revision, source_kind, source_label, source_checksum, source_descriptor
  FROM "import_sources" AS source
  WHERE source."id" = NEW."source_id" AND source."project_id" = NEW."project_id"
  FOR SHARE;
  IF source_kind IS NULL THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_SOURCE_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  expected_blob_count := jsonb_array_length(NEW."snapshot" -> 'blobs');
  SELECT COALESCE(sum(jsonb_array_length(snapshot."snapshot" -> 'blobs')), 0)::INTEGER
  INTO run_blob_count
  FROM "run_source_snapshots" AS snapshot
  WHERE snapshot."run_id" = NEW."run_id";
  IF run_blob_count + expected_blob_count > 50 THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_BLOB_LIMIT_EXCEEDED' USING ERRCODE = '23514';
  END IF;

  IF retry_source_id IS NULL THEN
    IF source_status IS DISTINCT FROM 'ready'::"ImportSourceStatus"
      OR source_checksum IS DISTINCT FROM NEW."checksum"
      OR source_kind IS DISTINCT FROM NEW."kind"
      OR source_label IS DISTINCT FROM NEW."label"
      OR source_descriptor IS DISTINCT FROM NEW."descriptor"
      OR NEW."snapshot" ->> 'sourceRevision' <> source_revision::TEXT
    THEN
      RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_SOURCE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::INTEGER
    INTO source_manifest_count
    FROM "import_source_blobs" AS source_blob
    WHERE source_blob."import_source_id" = NEW."source_id";
    IF expected_blob_count IS DISTINCT FROM source_manifest_count
      OR EXISTS (
        SELECT 1
        FROM "import_source_blobs" AS source_blob
        LEFT JOIN LATERAL (
          SELECT manifest.value
          FROM jsonb_array_elements(NEW."snapshot" -> 'blobs') WITH ORDINALITY AS manifest(value, ordinal)
          WHERE manifest.ordinal - 1 = source_blob."position"
        ) AS manifest ON TRUE
        WHERE source_blob."import_source_id" = NEW."source_id"
          AND (
            manifest.value IS NULL
            OR manifest.value ->> 'blobId' IS DISTINCT FROM source_blob."blob_id"
            OR manifest.value ->> 'role' IS DISTINCT FROM source_blob."role"
            OR manifest.value ->> 'path' IS DISTINCT FROM source_blob."path"
            OR manifest.value ->> 'mediaType' IS DISTINCT FROM source_blob."media_type"
            OR CASE
              WHEN manifest.value ->> 'byteSize' ~ '^[0-9]+$'
              THEN (manifest.value ->> 'byteSize')::BIGINT
              ELSE -1
            END IS DISTINCT FROM source_blob."byte_size"
            OR manifest.value ->> 'sha256' IS DISTINCT FROM source_blob."sha256"
          )
      )
    THEN
      RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_MANIFEST_SOURCE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM "run_source_snapshots" AS original
      WHERE original."run_id" = retry_source_id
        AND original."position" = NEW."position"
        AND original."source_id" = NEW."source_id"
        AND original."kind" = NEW."kind"
        AND original."label" = NEW."label"
        AND original."checksum" = NEW."checksum"
        AND original."descriptor" = NEW."descriptor"
        AND original."snapshot" = NEW."snapshot"
    ) THEN
      RAISE EXCEPTION 'RUN_RETRY_SOURCE_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT jsonb_array_length(NEW."snapshot" -> 'blobs')
  INTO expected_blob_count;
  SELECT count(*)::INTEGER
  INTO actual_blob_count
  FROM jsonb_array_elements(NEW."snapshot" -> 'blobs') AS manifest;
  IF expected_blob_count IS DISTINCT FROM actual_blob_count THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_MANIFEST_INVALID' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."snapshot" -> 'blobs') WITH ORDINALITY AS manifest(value, ordinal)
    WHERE (manifest.value ->> 'position')::INTEGER <> manifest.ordinal - 1
      OR length(COALESCE(manifest.value ->> 'blobId', '')) = 0
      OR (manifest.value ->> 'sha256') !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_MANIFEST_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "run_source_snapshots_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "run_source_snapshots"
FOR EACH ROW EXECUTE FUNCTION "guard_run_source_snapshot_mutation"();

CREATE OR REPLACE FUNCTION "guard_run_source_snapshot_set"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count INTEGER;
  actual_count INTEGER;
  target_run_id TEXT;
  request_json JSONB;
  source_run_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'runs' THEN
    target_run_id := NEW."id";
    request_json := NEW."request";
    source_run_id := NEW."retry_of_run_id";
  ELSE
    SELECT run."id", run."request", run."retry_of_run_id"
    INTO target_run_id, request_json, source_run_id
    FROM "runs" AS run
    WHERE run."id" = NEW."run_id";
  END IF;
  expected_count := jsonb_array_length(request_json -> 'sourceIds');
  SELECT count(*)::INTEGER INTO actual_count FROM "run_source_snapshots" AS snapshot_count WHERE snapshot_count."run_id" = target_run_id;
  IF expected_count IS DISTINCT FROM actual_count THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_SET_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(request_json -> 'sourceIds') WITH ORDINALITY AS requested(source_id, ordinal)
    LEFT JOIN "run_source_snapshots" AS snapshot
      ON snapshot."run_id" = target_run_id AND snapshot."position" = requested.ordinal - 1
    WHERE snapshot."source_id" IS DISTINCT FROM requested.source_id
  ) THEN
    RAISE EXCEPTION 'RUN_SOURCE_REQUEST_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF source_run_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "run_source_snapshots" AS original
    FULL JOIN "run_source_snapshots" AS retry
      ON retry."run_id" = target_run_id AND retry."position" = original."position"
    WHERE original."run_id" = source_run_id
      AND (
        retry."source_id" IS DISTINCT FROM original."source_id"
        OR retry."kind" IS DISTINCT FROM original."kind"
        OR retry."label" IS DISTINCT FROM original."label"
        OR retry."checksum" IS DISTINCT FROM original."checksum"
        OR retry."descriptor" IS DISTINCT FROM original."descriptor"
        OR retry."snapshot" IS DISTINCT FROM original."snapshot"
      )
  ) THEN
    RAISE EXCEPTION 'RUN_RETRY_SOURCE_SNAPSHOT_SET_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "runs_source_snapshot_set_guard"
AFTER INSERT OR UPDATE ON "runs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_run_source_snapshot_set"();

CREATE CONSTRAINT TRIGGER "run_source_snapshots_set_guard"
AFTER INSERT ON "run_source_snapshots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_run_source_snapshot_set"();

-- The final Run request contract has one source vocabulary.  In particular,
-- attachmentIds is rejected so a second truth source cannot return later.
ALTER TABLE "runs"
ADD CONSTRAINT "runs_typed_options_check"
CHECK (
  jsonb_typeof("request") = 'object'
  AND jsonb_extract_path_text("request", 'modelId') = "model_id"
  AND jsonb_extract_path_text("request", 'workflow') IN ('generate', 'redesign', 'ideate', 'edit')
  AND jsonb_extract_path_text("request", 'targetSurface') IN ('app', 'web')
  AND jsonb_typeof(jsonb_extract_path("request", 'designStyle')) = 'object'
  AND NOT ("request" ? 'attachmentIds')
  AND jsonb_typeof(jsonb_extract_path("request", 'sourceIds')) = 'array'
  AND jsonb_array_length(jsonb_extract_path("request", 'sourceIds')) <= 50
  AND NOT jsonb_path_exists("request", '$.sourceIds[*] ? (@.type() != "string" || @ == "")')
  AND CASE jsonb_extract_path_text("request", 'designStyle', 'kind')
    WHEN 'automatic' THEN
      jsonb_extract_path("request", 'designStyle') = '{"kind":"automatic"}'::jsonb
      AND "design_style_artifact_version_id" IS NULL
      AND "design_style_snapshot" IS NULL
      AND "design_style_snapshot_sha256" IS NULL
    WHEN 'preset' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'presetId', 'version', 'checksum']) = '{}'::jsonb
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'presetId')) IS NOT DISTINCT FROM 'string'
      AND jsonb_extract_path_text("request", 'designStyle', 'presetId') ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'version')) IS NOT DISTINCT FROM 'number'
      AND jsonb_extract_path_text("request", 'designStyle', 'version') ~ '^[1-9][0-9]*$'
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'checksum')) IS NOT DISTINCT FROM 'string'
      AND jsonb_extract_path_text("request", 'designStyle', 'checksum') ~ '^[0-9a-f]{64}$'
      AND "design_style_artifact_version_id" IS NULL
      AND jsonb_typeof("design_style_snapshot") IS NOT DISTINCT FROM 'object'
      AND "design_style_snapshot_sha256" IS NOT NULL
      AND ("design_style_snapshot" - ARRAY['protocol', 'source', 'label', 'swatch', 'description', 'directives', 'tokens']) = '{}'::jsonb
      AND "design_style_snapshot"->>'protocol' IS NOT DISTINCT FROM 'workbench.runtime.design-preset.v1'
      AND jsonb_typeof("design_style_snapshot"->'source') IS NOT DISTINCT FROM 'object'
      AND (("design_style_snapshot"->'source') - ARRAY['presetId', 'version', 'checksum']) = '{}'::jsonb
      AND "design_style_snapshot"#>>'{source,presetId}' IS NOT DISTINCT FROM jsonb_extract_path_text("request", 'designStyle', 'presetId')
      AND "design_style_snapshot"#>'{source,version}' IS NOT DISTINCT FROM jsonb_extract_path("request", 'designStyle', 'version')
      AND "design_style_snapshot"#>>'{source,checksum}' IS NOT DISTINCT FROM jsonb_extract_path_text("request", 'designStyle', 'checksum')
      AND jsonb_typeof("design_style_snapshot"->'label') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("design_style_snapshot"->'swatch') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("design_style_snapshot"->'description') IS NOT DISTINCT FROM 'string'
      AND jsonb_typeof("design_style_snapshot"->'directives') IS NOT DISTINCT FROM 'object'
      AND jsonb_typeof("design_style_snapshot"->'tokens') IS NOT DISTINCT FROM 'object'
    WHEN 'artifact' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'artifactVersionId']) = '{}'::jsonb
      AND jsonb_typeof(jsonb_extract_path("request", 'designStyle', 'artifactVersionId')) IS NOT DISTINCT FROM 'string'
      AND length(jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId')) > 0
      AND jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId') = "design_style_artifact_version_id"
      AND jsonb_typeof("design_style_snapshot") IS NOT DISTINCT FROM 'object'
      AND "design_style_snapshot_sha256" IS NOT NULL
    ELSE FALSE
  END
  AND (
    jsonb_extract_path_text("request", 'workflow') <> 'redesign'
    OR jsonb_array_length(jsonb_extract_path("request", 'sourceIds')) > 0
  )
);

COMMIT;
