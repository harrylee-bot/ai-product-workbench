-- File parsing and knowledge publication are durable domain records. This
-- migration removes fixed parser-output slots and closes every path that could
-- expose unverified or mutable bytes to a Run or a published knowledge release.
BEGIN;

CREATE TYPE "BlobScanStatus" AS ENUM (
  'queued',
  'running',
  'clean',
  'infected',
  'failed'
);

CREATE TABLE "blob_scans" (
  "id" TEXT NOT NULL,
  "blob_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" "BlobScanStatus" NOT NULL DEFAULT 'queued',
  "scanner" TEXT NOT NULL,
  "scanner_version" TEXT NOT NULL,
  "signature_version" TEXT,
  "evidence" JSONB,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "blob_scans_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "blob_scans"
ADD CONSTRAINT "blob_scans_attempt_positive_check"
CHECK ("attempt" > 0),
ADD CONSTRAINT "blob_scans_scanner_nonempty_check"
CHECK (length("scanner") > 0 AND length("scanner_version") > 0),
ADD CONSTRAINT "blob_scans_evidence_object_check"
CHECK ("evidence" IS NULL OR jsonb_typeof("evidence") = 'object'),
ADD CONSTRAINT "blob_scans_timestamps_check"
CHECK (
  ("status" = 'queued' AND "started_at" IS NULL AND "finished_at" IS NULL)
  OR ("status" = 'running' AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
  OR ("status" IN ('clean', 'infected', 'failed') AND "finished_at" IS NOT NULL)
),
ADD CONSTRAINT "blob_scans_terminal_evidence_check"
CHECK (
  ("status" IN ('queued', 'running') AND "evidence" IS NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL)
  OR ("status" IN ('clean', 'infected') AND "evidence" IS NOT NULL AND "failure_code" IS NULL AND "failure_detail" IS NULL)
  OR "status" = 'failed'
),
ADD CONSTRAINT "blob_scans_failed_state_check"
CHECK ("status" <> 'failed' OR "failure_code" IS NOT NULL);

CREATE UNIQUE INDEX "blob_scans_blob_id_attempt_key"
ON "blob_scans"("blob_id", "attempt");
CREATE INDEX "blob_scans_blob_id_status_attempt_idx"
ON "blob_scans"("blob_id", "status", "attempt");

ALTER TABLE "blob_scans"
ADD CONSTRAINT "blob_scans_blob_id_fkey"
FOREIGN KEY ("blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "blobs"
ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
ADD CONSTRAINT "blobs_generation_positive_check"
CHECK ("generation" > 0);

DROP INDEX "blobs_sha256_key";

CREATE UNIQUE INDEX "blobs_sha256_generation_key"
ON "blobs"("sha256", "generation");
CREATE UNIQUE INDEX "blobs_active_sha256_key"
ON "blobs"("sha256")
WHERE "status" <> 'deleted';
CREATE INDEX "blobs_sha256_status_idx"
ON "blobs"("sha256", "status");

CREATE OR REPLACE FUNCTION "guard_blob_content_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
    OR NEW."generation" IS DISTINCT FROM OLD."generation"
    OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
    OR NEW."media_type" IS DISTINCT FROM OLD."media_type"
    OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
  THEN
    RAISE EXCEPTION 'BLOB_CONTENT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."verified_at" IS NOT NULL
    AND NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
  THEN
    RAISE EXCEPTION 'BLOB_VERIFICATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."status" = 'pending' AND NEW."status" IN ('pending', 'ready', 'quarantined', 'deleted'))
    OR (OLD."status" = 'ready' AND NEW."status" IN ('ready', 'quarantined', 'deleted'))
    OR (OLD."status" = 'quarantined' AND NEW."status" IN ('quarantined', 'deleted'))
  ) THEN
    RAISE EXCEPTION 'BLOB_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleted' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'BLOB_DELETED_STATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE "file_extractions"
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "request_hash" TEXT;

-- Existing attempts predate command receipts. Give them a collision-resistant
-- migration namespace so every future request still has strict replay identity.
UPDATE "file_extractions"
SET "idempotency_key" = 'migration:20260712210000:' || "id",
    "request_hash" = repeat('0', 64);

ALTER TABLE "file_extractions"
ALTER COLUMN "idempotency_key" SET NOT NULL,
ALTER COLUMN "request_hash" SET NOT NULL;

CREATE TABLE "file_extraction_outputs" (
  "extraction_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "blob_id" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "file_extraction_outputs_pkey"
    PRIMARY KEY ("extraction_id", "kind", "position")
);

INSERT INTO "file_extraction_outputs" (
  "extraction_id", "kind", "position", "blob_id", "created_at"
)
SELECT "id", 'structured', 0, "result_blob_id", "created_at"
FROM "file_extractions"
WHERE "result_blob_id" IS NOT NULL;

INSERT INTO "file_extraction_outputs" (
  "extraction_id", "kind", "position", "blob_id", "created_at"
)
SELECT "id", 'text', 0, "text_blob_id", "created_at"
FROM "file_extractions"
WHERE "text_blob_id" IS NOT NULL;

ALTER TABLE "file_extractions"
DROP CONSTRAINT "file_extractions_result_blob_id_fkey",
DROP CONSTRAINT "file_extractions_text_blob_id_fkey",
DROP CONSTRAINT "file_extractions_ready_state_check";

DROP INDEX "file_extractions_result_blob_id_idx";
DROP INDEX "file_extractions_text_blob_id_idx";

ALTER TABLE "file_extractions"
DROP COLUMN "result_blob_id",
DROP COLUMN "text_blob_id";

ALTER TABLE "file_extractions"
ADD CONSTRAINT "file_extractions_idempotency_key_nonempty_check"
CHECK (length("idempotency_key") > 0),
ADD CONSTRAINT "file_extractions_request_hash_format_check"
CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "file_extractions_ready_state_check"
CHECK (
  "status" <> 'ready'
  OR (
    "content_sha256" IS NOT NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
);

CREATE UNIQUE INDEX "file_extractions_file_asset_id_idempotency_key_key"
ON "file_extractions"("file_asset_id", "idempotency_key");

ALTER TABLE "file_extraction_outputs"
ADD CONSTRAINT "file_extraction_outputs_kind_format_check"
CHECK ("kind" ~ '^[a-z][a-z0-9._-]{0,63}$'),
ADD CONSTRAINT "file_extraction_outputs_position_nonnegative_check"
CHECK ("position" >= 0),
ADD CONSTRAINT "file_extraction_outputs_metadata_object_check"
CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object'),
ADD CONSTRAINT "file_extraction_outputs_extraction_id_fkey"
FOREIGN KEY ("extraction_id") REFERENCES "file_extractions"("id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "file_extraction_outputs_blob_id_fkey"
FOREIGN KEY ("blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "file_extraction_outputs_blob_id_idx"
ON "file_extraction_outputs"("blob_id");

-- User uploads and Run inputs cannot be empty even though a controlled system
-- Blob may legitimately represent an empty generated artifact.
ALTER TABLE "file_assets"
DROP CONSTRAINT "file_assets_byte_size_safe_integer_check",
ADD CONSTRAINT "file_assets_byte_size_safe_integer_check"
CHECK ("byte_size" > 0 AND "byte_size" <= 9007199254740991);

ALTER TABLE "file_assets"
DROP CONSTRAINT "file_assets_ready_state_check",
ADD CONSTRAINT "file_assets_ready_state_check"
CHECK (
  "status" <> 'ready'
  OR (
    "blob_id" IS NOT NULL
    AND "detected_media_type" IS NOT NULL
    AND "verified_at" IS NOT NULL
    AND "deleted_at" IS NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
);

ALTER TABLE "file_upload_sessions"
DROP CONSTRAINT "file_upload_sessions_byte_size_safe_integer_check",
ADD CONSTRAINT "file_upload_sessions_byte_size_safe_integer_check"
CHECK ("expected_byte_size" > 0 AND "expected_byte_size" <= 9007199254740991);

ALTER TABLE "run_attachments"
DROP CONSTRAINT "run_attachments_byte_size_safe_integer_check",
ADD CONSTRAINT "run_attachments_byte_size_safe_integer_check"
CHECK ("byte_size" > 0 AND "byte_size" <= 9007199254740991);

-- A release key is a logical stream; version, not a new arbitrary key, selects
-- an immutable snapshot in that stream.
DROP INDEX "knowledge_releases_key_key";
CREATE UNIQUE INDEX "knowledge_releases_key_version_key"
ON "knowledge_releases"("key", "version");

ALTER TABLE "knowledge_releases"
ADD CONSTRAINT "knowledge_releases_key_nonempty_check"
CHECK (length("key") > 0),
ADD CONSTRAINT "knowledge_releases_version_positive_check"
CHECK ("version" > 0),
ADD CONSTRAINT "knowledge_releases_manifest_sha256_format_check"
CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "knowledge_releases_manifest_object_check"
CHECK (jsonb_typeof("manifest") = 'object'),
ADD CONSTRAINT "knowledge_releases_ready_state_check"
CHECK (
  ("status" IN ('ready', 'retired') AND "ready_at" IS NOT NULL)
  OR ("status" IN ('building', 'failed') AND "ready_at" IS NULL)
);

ALTER TABLE "knowledge_documents"
DROP CONSTRAINT "knowledge_documents_source_blob_id_fkey",
ADD CONSTRAINT "knowledge_documents_source_blob_id_fkey"
FOREIGN KEY ("source_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_documents"
ADD CONSTRAINT "knowledge_documents_source_path_nonempty_check"
CHECK (length("source_path") > 0),
ADD CONSTRAINT "knowledge_documents_title_nonempty_check"
CHECK (length("title") > 0),
ADD CONSTRAINT "knowledge_documents_checksum_format_check"
CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "knowledge_documents_metadata_object_check"
CHECK (jsonb_typeof("metadata") = 'object');

ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_sequence_nonnegative_check"
CHECK ("sequence" >= 0),
ADD CONSTRAINT "knowledge_chunks_heading_path_array_check"
CHECK (jsonb_typeof("heading_path") = 'array'),
ADD CONSTRAINT "knowledge_chunks_token_count_nonnegative_check"
CHECK ("token_count" >= 0);

-- Do not install guards over an already-invalid state. Legacy rows must be
-- rescanned/rebuilt explicitly rather than silently retaining a false ready
-- label after this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "file_assets" AS file
    JOIN "blobs" AS blob ON blob."id" = file."blob_id"
    WHERE file."status" = 'ready'
      AND (
        blob."status" <> 'ready'
        OR blob."byte_size" <= 0
        OR (
          SELECT scan."status"
          FROM "blob_scans" AS scan
          WHERE scan."blob_id" = blob."id"
          ORDER BY scan."attempt" DESC
          LIMIT 1
        ) IS DISTINCT FROM 'clean'::"BlobScanStatus"
      )
  ) THEN
    RAISE EXCEPTION 'MIGRATION_READY_FILE_SCAN_EVIDENCE_MISSING' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "file_extractions" AS extraction
    WHERE extraction."status" = 'ready'
      AND (
        NOT EXISTS (
          SELECT 1
          FROM "file_extraction_outputs" AS output
          WHERE output."extraction_id" = extraction."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "file_extraction_outputs" AS output
          JOIN "blobs" AS blob ON blob."id" = output."blob_id"
          WHERE output."extraction_id" = extraction."id"
            AND (blob."status" <> 'ready' OR blob."byte_size" <= 0)
        )
      )
  ) THEN
    RAISE EXCEPTION 'MIGRATION_READY_EXTRACTION_OUTPUT_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "run_attachments" AS attachment
    JOIN "file_assets" AS file
      ON file."id" = attachment."file_asset_id"
      AND file."project_id" = attachment."project_id"
      AND file."blob_id" = attachment."blob_id"
    JOIN "blobs" AS blob ON blob."id" = attachment."blob_id"
    LEFT JOIN "file_extractions" AS extraction
      ON extraction."id" = attachment."extraction_id"
      AND extraction."file_asset_id" = attachment."file_asset_id"
      AND extraction."source_blob_id" = attachment."blob_id"
    WHERE file."status" <> 'ready'
      OR blob."status" <> 'ready'
      OR attachment."original_name" IS DISTINCT FROM file."original_name"
      OR attachment."media_type" IS DISTINCT FROM file."detected_media_type"
      OR attachment."byte_size" IS DISTINCT FROM blob."byte_size"
      OR attachment."sha256" IS DISTINCT FROM blob."sha256"
      OR (
        attachment."extraction_id" IS NOT NULL
        AND extraction."status" IS DISTINCT FROM 'ready'::"FileExtractionStatus"
      )
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
    FROM "knowledge_documents" AS document
    LEFT JOIN "blobs" AS blob ON blob."id" = document."source_blob_id"
    WHERE document."source_kind" = 'project_upload'
      AND (
        blob."status" IS DISTINCT FROM 'ready'::"BlobStatus"
        OR blob."byte_size" IS NULL
        OR blob."byte_size" <= 0
        OR (
          SELECT scan."status"
          FROM "blob_scans" AS scan
          WHERE scan."blob_id" = blob."id"
          ORDER BY scan."attempt" DESC
          LIMIT 1
        ) IS DISTINCT FROM 'clean'::"BlobScanStatus"
      )
  ) THEN
    RAISE EXCEPTION 'MIGRATION_PROJECT_UPLOAD_SCAN_EVIDENCE_MISSING' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "guard_blob_scan_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_blob_id TEXT;
  owner_blob_status "BlobStatus";
BEGIN
  owner_blob_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."blob_id" ELSE NEW."blob_id" END;

  SELECT blob."status"
  INTO owner_blob_status
  FROM "blobs" AS blob
  WHERE blob."id" = owner_blob_id
  FOR UPDATE;

  -- Terminal scanner evidence is retained even after object bytes are garbage
  -- collected and the owning Blob is soft-deleted.
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('clean', 'infected', 'failed') THEN
      RAISE EXCEPTION 'BLOB_SCAN_TERMINAL_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."blob_id" IS DISTINCT FROM OLD."blob_id"
      OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
      OR NEW."scanner" IS DISTINCT FROM OLD."scanner"
      OR NEW."scanner_version" IS DISTINCT FROM OLD."scanner_version"
      OR NEW."signature_version" IS DISTINCT FROM OLD."signature_version"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'BLOB_SCAN_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('clean', 'infected', 'failed') THEN
      RAISE EXCEPTION 'BLOB_SCAN_TERMINAL_EVIDENCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF NOT (
      (OLD."status" = 'queued' AND NEW."status" IN ('queued', 'running', 'failed'))
      OR (OLD."status" = 'running' AND NEW."status" IN ('running', 'clean', 'infected', 'failed'))
    ) THEN
      RAISE EXCEPTION 'BLOB_SCAN_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF owner_blob_status NOT IN ('pending'::"BlobStatus", 'ready'::"BlobStatus") THEN
    RAISE EXCEPTION 'BLOB_SCAN_REQUIRES_SCANNABLE_BLOB' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "blob_scans_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "blob_scans"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_scan_mutation"();

CREATE FUNCTION "quarantine_blob_from_infected_scan"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'infected'
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status")
  THEN
    UPDATE "blobs"
    SET "status" = 'quarantined',
        "verified_at" = COALESCE("verified_at", clock_timestamp()),
        "gc_eligible_at" = NULL,
        "updated_at" = clock_timestamp()
    WHERE "id" = NEW."blob_id"
      AND "status" IN ('pending', 'ready');

    -- A later signature database may discover malware in content that was
    -- previously clean or originated as a generated system Blob. Keep durable
    -- consumers for audit, but revoke every live File surface in this same
    -- transaction so content and new Run attachment APIs fail closed.
    UPDATE "file_assets"
    SET "status" = 'quarantined',
        "failure_code" = 'FILE_MALWARE_DETECTED',
        "failure_detail" = NULL,
        "revision" = "revision" + 1,
        "updated_at" = clock_timestamp()
    WHERE "blob_id" = NEW."blob_id"
      AND "status" IN ('verifying', 'ready');
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "blob_scans_infected_quarantine"
AFTER INSERT OR UPDATE ON "blob_scans"
FOR EACH ROW EXECUTE FUNCTION "quarantine_blob_from_infected_scan"();

CREATE FUNCTION "guard_ready_file_asset"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_blob_status "BlobStatus";
  referenced_blob_size BIGINT;
  latest_scan_status "BlobScanStatus";
BEGIN
  IF NEW."status" <> 'ready' THEN
    RETURN NEW;
  END IF;

  SELECT blob."status", blob."byte_size"
  INTO referenced_blob_status, referenced_blob_size
  FROM "blobs" AS blob
  WHERE blob."id" = NEW."blob_id"
  FOR SHARE;

  SELECT scan."status"
  INTO latest_scan_status
  FROM "blob_scans" AS scan
  WHERE scan."blob_id" = NEW."blob_id"
  ORDER BY scan."attempt" DESC
  LIMIT 1
  FOR SHARE;

  IF referenced_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
    OR referenced_blob_size IS NULL
    OR referenced_blob_size <= 0
    OR latest_scan_status IS DISTINCT FROM 'clean'::"BlobScanStatus"
  THEN
    RAISE EXCEPTION 'FILE_READY_BLOB_NOT_CLEAN' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_assets_ready_guard"
BEFORE INSERT OR UPDATE ON "file_assets"
FOR EACH ROW EXECUTE FUNCTION "guard_ready_file_asset"();

CREATE FUNCTION "guard_file_asset_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'deleted' THEN
    RAISE EXCEPTION 'FILE_ASSET_MUST_BE_SOFT_DELETED' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "file_assets_delete_guard"
BEFORE DELETE ON "file_assets"
FOR EACH ROW EXECUTE FUNCTION "guard_file_asset_delete"();

DROP TRIGGER "file_extractions_update_guard" ON "file_extractions";

CREATE OR REPLACE FUNCTION "guard_file_extraction_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_file_status "FileStatus";
  source_blob_status "BlobStatus";
  latest_scan_status "BlobScanStatus";
  output_count BIGINT;
  invalid_output_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('ready', 'unsupported', 'failed')
      AND EXISTS (
        SELECT 1
        FROM "file_assets" AS file
        WHERE file."id" = OLD."file_asset_id"
          AND file."status" <> 'deleted'
      )
    THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_TERMINAL_STATE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'queued' THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_MUST_START_QUEUED' USING ERRCODE = '23514';
    END IF;

    SELECT file."status", blob."status"
    INTO source_file_status, source_blob_status
    FROM "file_assets" AS file
    JOIN "blobs" AS blob ON blob."id" = file."blob_id"
    WHERE file."id" = NEW."file_asset_id"
      AND file."blob_id" = NEW."source_blob_id"
    FOR SHARE OF file, blob;

    SELECT scan."status"
    INTO latest_scan_status
    FROM "blob_scans" AS scan
    WHERE scan."blob_id" = NEW."source_blob_id"
    ORDER BY scan."attempt" DESC
    LIMIT 1
    FOR SHARE;

    IF source_file_status IS DISTINCT FROM 'ready'::"FileStatus"
      OR source_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR latest_scan_status IS DISTINCT FROM 'clean'::"BlobScanStatus"
    THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_SOURCE_NOT_READY' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."file_asset_id" IS DISTINCT FROM OLD."file_asset_id"
    OR NEW."source_blob_id" IS DISTINCT FROM OLD."source_blob_id"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."parser" IS DISTINCT FROM OLD."parser"
    OR NEW."parser_version" IS DISTINCT FROM OLD."parser_version"
    OR NEW."output_schema_version" IS DISTINCT FROM OLD."output_schema_version"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('ready', 'unsupported', 'failed') THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_TERMINAL_STATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."status" = 'queued' AND NEW."status" IN ('queued', 'running', 'unsupported', 'failed'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('running', 'ready', 'unsupported', 'failed'))
  ) THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'ready' THEN
    SELECT
      count(*),
      count(*) FILTER (WHERE blob."status" <> 'ready' OR blob."byte_size" <= 0)
    INTO output_count, invalid_output_count
    FROM "file_extraction_outputs" AS output
    JOIN "blobs" AS blob ON blob."id" = output."blob_id"
    WHERE output."extraction_id" = NEW."id";

    IF output_count = 0 OR invalid_output_count <> 0 THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_READY_OUTPUT_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_extractions_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "file_extractions"
FOR EACH ROW EXECUTE FUNCTION "guard_file_extraction_update"();

CREATE FUNCTION "guard_file_extraction_output_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_extraction_id TEXT;
  owner_status "FileExtractionStatus";
  output_blob_status "BlobStatus";
  output_blob_size BIGINT;
  owner_file_status "FileStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."extraction_id" IS DISTINCT FROM OLD."extraction_id"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."position" IS DISTINCT FROM OLD."position"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_OUTPUT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  owner_extraction_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD."extraction_id"
    ELSE NEW."extraction_id"
  END;

  SELECT extraction."status"
  INTO owner_status
  FROM "file_extractions" AS extraction
  WHERE extraction."id" = owner_extraction_id
  FOR SHARE;

  -- Cascading extraction deletion has already removed the parent from view.
  IF owner_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF owner_status NOT IN ('queued', 'running') THEN
    SELECT file."status"
    INTO owner_file_status
    FROM "file_extractions" AS extraction
    JOIN "file_assets" AS file ON file."id" = extraction."file_asset_id"
    WHERE extraction."id" = owner_extraction_id;

    IF owner_file_status IS DISTINCT FROM 'deleted'::"FileStatus" THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_OUTPUT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT blob."status", blob."byte_size"
    INTO output_blob_status, output_blob_size
    FROM "blobs" AS blob
    WHERE blob."id" = NEW."blob_id"
    FOR SHARE;

    IF output_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR output_blob_size IS NULL
      OR output_blob_size <= 0
    THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_OUTPUT_BLOB_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "file_extraction_outputs_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "file_extraction_outputs"
FOR EACH ROW EXECUTE FUNCTION "guard_file_extraction_output_mutation"();

-- File responses embed latest/current extraction state. Child mutations must
-- therefore invalidate the File ETag even when no File column was changed by
-- application code.
CREATE FUNCTION "bump_file_revision_from_new_extractions"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "file_assets"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT DISTINCT "file_asset_id" FROM file_extraction_new_rows
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_file_revision_from_old_extractions"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "file_assets"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT DISTINCT "file_asset_id" FROM file_extraction_old_rows
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_file_revision_from_changed_extractions"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "file_assets"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT "file_asset_id" FROM file_extraction_old_rows
    UNION
    SELECT "file_asset_id" FROM file_extraction_new_rows
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "file_extractions_insert_revision"
AFTER INSERT ON "file_extractions"
REFERENCING NEW TABLE AS file_extraction_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_file_revision_from_new_extractions"();

CREATE TRIGGER "file_extractions_update_revision"
AFTER UPDATE ON "file_extractions"
REFERENCING OLD TABLE AS file_extraction_old_rows NEW TABLE AS file_extraction_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_file_revision_from_changed_extractions"();

CREATE TRIGGER "file_extractions_delete_revision"
AFTER DELETE ON "file_extractions"
REFERENCING OLD TABLE AS file_extraction_old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_file_revision_from_old_extractions"();

CREATE FUNCTION "bump_file_revision_from_new_extraction_outputs"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "file_assets"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT DISTINCT extraction."file_asset_id"
    FROM file_extraction_output_new_rows AS output
    JOIN "file_extractions" AS extraction ON extraction."id" = output."extraction_id"
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_file_revision_from_old_extraction_outputs"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "file_assets"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT DISTINCT extraction."file_asset_id"
    FROM file_extraction_output_old_rows AS output
    JOIN "file_extractions" AS extraction ON extraction."id" = output."extraction_id"
  );
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_file_revision_from_changed_extraction_outputs"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "file_assets"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT extraction."file_asset_id"
    FROM file_extraction_output_old_rows AS output
    JOIN "file_extractions" AS extraction ON extraction."id" = output."extraction_id"
    UNION
    SELECT extraction."file_asset_id"
    FROM file_extraction_output_new_rows AS output
    JOIN "file_extractions" AS extraction ON extraction."id" = output."extraction_id"
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "file_extraction_outputs_insert_revision"
AFTER INSERT ON "file_extraction_outputs"
REFERENCING NEW TABLE AS file_extraction_output_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_file_revision_from_new_extraction_outputs"();

CREATE TRIGGER "file_extraction_outputs_update_revision"
AFTER UPDATE ON "file_extraction_outputs"
REFERENCING OLD TABLE AS file_extraction_output_old_rows NEW TABLE AS file_extraction_output_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_file_revision_from_changed_extraction_outputs"();

CREATE TRIGGER "file_extraction_outputs_delete_revision"
AFTER DELETE ON "file_extraction_outputs"
REFERENCING OLD TABLE AS file_extraction_output_old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_file_revision_from_old_extraction_outputs"();

DROP TRIGGER "run_attachments_update_guard" ON "run_attachments";

CREATE OR REPLACE FUNCTION "guard_run_attachment_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  source_file_status "FileStatus";
  source_file_name TEXT;
  source_file_media_type TEXT;
  source_file_size BIGINT;
  source_file_blob_id TEXT;
  source_blob_status "BlobStatus";
  source_blob_sha256 TEXT;
  latest_scan_status "BlobScanStatus";
  selected_extraction_status "FileExtractionStatus";
  owner_run_status "RunStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RUN_ATTACHMENT_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "runs" AS run WHERE run."id" = OLD."run_id") THEN
      RAISE EXCEPTION 'RUN_ATTACHMENT_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT run."status"
  INTO owner_run_status
  FROM "runs" AS run
  WHERE run."id" = NEW."run_id"
    AND run."project_id" = NEW."project_id"
  FOR SHARE;

  IF owner_run_status IS DISTINCT FROM 'queued'::"RunStatus" THEN
    RAISE EXCEPTION 'RUN_ATTACHMENT_RUN_NOT_QUEUED' USING ERRCODE = '23514';
  END IF;

  SELECT
    file."status",
    file."original_name",
    file."detected_media_type",
    file."byte_size",
    file."blob_id",
    blob."status",
    blob."sha256"
  INTO
    source_file_status,
    source_file_name,
    source_file_media_type,
    source_file_size,
    source_file_blob_id,
    source_blob_status,
    source_blob_sha256
  FROM "file_assets" AS file
  JOIN "blobs" AS blob ON blob."id" = file."blob_id"
  WHERE file."id" = NEW."file_asset_id"
    AND file."project_id" = NEW."project_id"
    AND file."blob_id" = NEW."blob_id"
  FOR SHARE OF file, blob;

  SELECT scan."status"
  INTO latest_scan_status
  FROM "blob_scans" AS scan
  WHERE scan."blob_id" = NEW."blob_id"
  ORDER BY scan."attempt" DESC
  LIMIT 1
  FOR SHARE;

  IF source_file_status IS DISTINCT FROM 'ready'::"FileStatus"
    OR source_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
    OR latest_scan_status IS DISTINCT FROM 'clean'::"BlobScanStatus"
    OR source_file_blob_id IS DISTINCT FROM NEW."blob_id"
    OR source_file_name IS DISTINCT FROM NEW."original_name"
    OR source_file_media_type IS DISTINCT FROM NEW."media_type"
    OR source_file_size IS DISTINCT FROM NEW."byte_size"
    OR source_blob_sha256 IS DISTINCT FROM NEW."sha256"
  THEN
    RAISE EXCEPTION 'RUN_ATTACHMENT_SOURCE_NOT_READY' USING ERRCODE = '23514';
  END IF;

  IF NEW."extraction_id" IS NOT NULL THEN
    SELECT extraction."status"
    INTO selected_extraction_status
    FROM "file_extractions" AS extraction
    WHERE extraction."id" = NEW."extraction_id"
      AND extraction."file_asset_id" = NEW."file_asset_id"
      AND extraction."source_blob_id" = NEW."blob_id"
    FOR SHARE;

    IF selected_extraction_status IS DISTINCT FROM 'ready'::"FileExtractionStatus" THEN
      RAISE EXCEPTION 'RUN_ATTACHMENT_EXTRACTION_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "run_attachments_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "run_attachments"
FOR EACH ROW EXECUTE FUNCTION "guard_run_attachment_update"();

-- Hard deletes are already covered by RESTRICT foreign keys. This unified soft
-- delete guard prevents GC from invalidating any durable consumer first.
CREATE OR REPLACE FUNCTION "guard_blob_artifact_references"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status"
    OR NEW."status" <> 'deleted'
  THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "artifact_versions" AS version
    WHERE version."content_blob_id" = OLD."id" AND version."status" = 'ready'
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_READY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "artifact_versions" AS version
    WHERE version."content_blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "run_attachments" AS attachment
    WHERE attachment."blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_RUN_ATTACHMENT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "file_extractions" AS extraction
    WHERE extraction."source_blob_id" = OLD."id"
  ) OR EXISTS (
    SELECT 1 FROM "file_extraction_outputs" AS output
    WHERE output."blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_FILE_EXTRACTION' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "file_assets" AS file WHERE file."blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_FILE_ASSET' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "knowledge_documents" AS document
    WHERE document."source_blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_KNOWLEDGE_DOCUMENT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "export_jobs" AS job WHERE job."output_blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_EXPORT_JOB' USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION "guard_knowledge_release_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('ready', 'retired') THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('ready', 'retired') THEN
    IF NEW."manifest_sha256" IS DISTINCT FROM OLD."manifest_sha256"
      OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
      OR NEW."ready_at" IS DISTINCT FROM OLD."ready_at"
      OR NOT (
        NEW."status" = OLD."status"
        OR (OLD."status" = 'ready' AND NEW."status" = 'retired')
      )
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."status" = 'failed' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_FAILED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT (
    OLD."status" = 'building'
    AND NEW."status" IN ('building', 'ready', 'failed')
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_releases_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_release_mutation"();

CREATE FUNCTION "guard_knowledge_document_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_release_id TEXT;
  owner_release_status "KnowledgeReleaseStatus";
  referenced_blob_status "BlobStatus";
  referenced_blob_size BIGINT;
  latest_scan_status "BlobScanStatus";
BEGIN
  owner_release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."release_id" ELSE NEW."release_id" END;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
    OR NEW."source_path" IS DISTINCT FROM OLD."source_path"
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_DOCUMENT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT release."status"
  INTO owner_release_status
  FROM "knowledge_releases" AS release
  WHERE release."id" = owner_release_id
  FOR SHARE;

  -- A cascading release delete has already removed the parent from view.
  IF owner_release_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF owner_release_status <> 'building' THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."source_blob_id" IS NOT NULL THEN
    SELECT blob."status", blob."byte_size"
    INTO referenced_blob_status, referenced_blob_size
    FROM "blobs" AS blob
    WHERE blob."id" = NEW."source_blob_id"
    FOR SHARE;

    IF referenced_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR referenced_blob_size IS NULL
      OR referenced_blob_size <= 0
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_DOCUMENT_SOURCE_BLOB_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW."source_kind" = 'project_upload' THEN
    IF NEW."source_blob_id" IS NULL THEN
      RAISE EXCEPTION 'KNOWLEDGE_PROJECT_UPLOAD_BLOB_REQUIRED' USING ERRCODE = '23514';
    END IF;

    SELECT scan."status"
    INTO latest_scan_status
    FROM "blob_scans" AS scan
    WHERE scan."blob_id" = NEW."source_blob_id"
    ORDER BY scan."attempt" DESC
    LIMIT 1
    FOR SHARE;

    IF latest_scan_status IS DISTINCT FROM 'clean'::"BlobScanStatus" THEN
      RAISE EXCEPTION 'KNOWLEDGE_PROJECT_UPLOAD_BLOB_NOT_CLEAN' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "knowledge_documents_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_documents"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_document_mutation"();

CREATE FUNCTION "guard_knowledge_chunk_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_document_id TEXT;
  owner_release_status "KnowledgeReleaseStatus";
BEGIN
  owner_document_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."document_id" ELSE NEW."document_id" END;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_CHUNK_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT release."status"
  INTO owner_release_status
  FROM "knowledge_documents" AS document
  JOIN "knowledge_releases" AS release ON release."id" = document."release_id"
  WHERE document."id" = owner_document_id
  FOR SHARE OF release;

  -- Cascading document/release deletion has already removed its parent.
  IF owner_release_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF owner_release_status <> 'building' THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "knowledge_chunks_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_chunks"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_chunk_mutation"();

COMMIT;
