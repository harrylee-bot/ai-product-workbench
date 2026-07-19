-- File ingestion has three independent lifecycles: the multipart upload, the
-- verified project file, and immutable extraction attempts.
ALTER TYPE "FileStatus" RENAME VALUE 'processing' TO 'verifying';

CREATE TYPE "FileUploadStatus" AS ENUM (
  'initiating',
  'initiated',
  'completing',
  'completed',
  'aborting',
  'aborted',
  'expired',
  'failed'
);

CREATE TYPE "FileExtractionStatus" AS ENUM (
  'queued',
  'running',
  'ready',
  'unsupported',
  'failed'
);

ALTER TABLE "blobs"
ADD COLUMN "verified_at" TIMESTAMP(3),
ADD COLUMN "gc_eligible_at" TIMESTAMP(3),
ADD COLUMN "deleted_at" TIMESTAMP(3);

UPDATE "blobs"
SET "verified_at" = "updated_at"
WHERE "status" IN ('ready', 'quarantined') AND "verified_at" IS NULL;

UPDATE "blobs"
SET "deleted_at" = "updated_at"
WHERE "status" = 'deleted' AND "deleted_at" IS NULL;

ALTER TABLE "file_assets"
DROP CONSTRAINT "file_assets_blob_id_fkey";

ALTER TABLE "file_assets"
RENAME COLUMN "media_type" TO "declared_media_type";

ALTER TABLE "file_assets"
ADD COLUMN "current_extraction_id" TEXT,
ADD COLUMN "detected_media_type" TEXT,
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failure_detail" TEXT,
ADD COLUMN "verified_at" TIMESTAMP(3),
ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Preserve any pre-foundation rows while making their old effective MIME type
-- explicit. New code must only set detected_media_type after server inspection.
UPDATE "file_assets"
SET "detected_media_type" = "declared_media_type"
WHERE "blob_id" IS NOT NULL;

UPDATE "file_assets"
SET "verified_at" = "updated_at"
WHERE "status" = 'ready' AND "verified_at" IS NULL;

UPDATE "file_assets"
SET "deleted_at" = "updated_at"
WHERE "status" = 'deleted' AND "deleted_at" IS NULL;

CREATE TABLE "file_upload_sessions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "file_asset_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 's3',
  "provider_upload_id" TEXT,
  "staging_key" TEXT NOT NULL,
  "status" "FileUploadStatus" NOT NULL DEFAULT 'initiating',
  "expected_byte_size" BIGINT NOT NULL,
  "expected_sha256" TEXT,
  "part_size" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "completion_idempotency_key" TEXT,
  "completion_request_hash" TEXT,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "aborted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "file_upload_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "file_extractions" (
  "id" TEXT NOT NULL,
  "file_asset_id" TEXT NOT NULL,
  "source_blob_id" TEXT NOT NULL,
  "result_blob_id" TEXT,
  "text_blob_id" TEXT,
  "attempt" INTEGER NOT NULL,
  "status" "FileExtractionStatus" NOT NULL DEFAULT 'queued',
  "parser" TEXT NOT NULL,
  "parser_version" TEXT NOT NULL,
  "output_schema_version" INTEGER NOT NULL,
  "content_sha256" TEXT,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "metadata" JSONB,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "file_extractions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "run_attachments" (
  "run_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "file_asset_id" TEXT NOT NULL,
  "blob_id" TEXT NOT NULL,
  "extraction_id" TEXT,
  "original_name" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_attachments_pkey" PRIMARY KEY ("run_id", "position")
);

-- The API serializes these byte counts as JSON numbers. Reject values outside
-- JavaScript's exact integer range before they can cross that boundary.
ALTER TABLE "blobs"
ADD CONSTRAINT "blobs_byte_size_safe_integer_check"
CHECK ("byte_size" >= 0 AND "byte_size" <= 9007199254740991),
ADD CONSTRAINT "blobs_sha256_format_check"
CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "blobs_ready_state_check"
CHECK ("status" <> 'ready' OR ("verified_at" IS NOT NULL AND "deleted_at" IS NULL)),
ADD CONSTRAINT "blobs_deleted_state_check"
CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL));

ALTER TABLE "file_assets"
ADD CONSTRAINT "file_assets_byte_size_safe_integer_check"
CHECK ("byte_size" >= 0 AND "byte_size" <= 9007199254740991),
ADD CONSTRAINT "file_assets_revision_nonnegative_check"
CHECK ("revision" >= 0),
ADD CONSTRAINT "file_assets_declared_media_type_nonempty_check"
CHECK (length("declared_media_type") > 0),
ADD CONSTRAINT "file_assets_ready_state_check"
CHECK (
  "status" <> 'ready'
  OR (
    "blob_id" IS NOT NULL
    AND "detected_media_type" IS NOT NULL
    AND "verified_at" IS NOT NULL
    AND "deleted_at" IS NULL
  )
),
ADD CONSTRAINT "file_assets_deleted_state_check"
CHECK (("status" = 'deleted') = ("deleted_at" IS NOT NULL));

ALTER TABLE "file_upload_sessions"
ADD CONSTRAINT "file_upload_sessions_byte_size_safe_integer_check"
CHECK ("expected_byte_size" >= 0 AND "expected_byte_size" <= 9007199254740991),
ADD CONSTRAINT "file_upload_sessions_part_size_positive_check"
CHECK ("part_size" > 0),
ADD CONSTRAINT "file_upload_sessions_revision_nonnegative_check"
CHECK ("revision" >= 0),
ADD CONSTRAINT "file_upload_sessions_expected_sha256_format_check"
CHECK ("expected_sha256" IS NULL OR "expected_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "file_upload_sessions_request_hash_format_check"
CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "file_upload_sessions_completion_pair_check"
CHECK (
  ("completion_idempotency_key" IS NULL)
  = ("completion_request_hash" IS NULL)
),
ADD CONSTRAINT "file_upload_sessions_completion_hash_format_check"
CHECK (
  "completion_request_hash" IS NULL
  OR "completion_request_hash" ~ '^[0-9a-f]{64}$'
),
ADD CONSTRAINT "file_upload_sessions_provider_upload_check"
CHECK (
  "status" NOT IN ('initiated', 'completing', 'completed', 'aborting')
  OR "provider_upload_id" IS NOT NULL
),
ADD CONSTRAINT "file_upload_sessions_completed_state_check"
CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL),
ADD CONSTRAINT "file_upload_sessions_aborted_state_check"
CHECK ("status" NOT IN ('aborted', 'expired') OR "aborted_at" IS NOT NULL),
ADD CONSTRAINT "file_upload_sessions_expiry_check"
CHECK ("expires_at" > "created_at");

ALTER TABLE "file_extractions"
ADD CONSTRAINT "file_extractions_attempt_positive_check"
CHECK ("attempt" > 0),
ADD CONSTRAINT "file_extractions_schema_version_positive_check"
CHECK ("output_schema_version" > 0),
ADD CONSTRAINT "file_extractions_content_sha256_format_check"
CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "file_extractions_timestamps_check"
CHECK (
  ("status" = 'queued' AND "started_at" IS NULL AND "finished_at" IS NULL)
  OR ("status" = 'running' AND "started_at" IS NOT NULL AND "finished_at" IS NULL)
  OR ("status" IN ('ready', 'unsupported', 'failed') AND "finished_at" IS NOT NULL)
),
ADD CONSTRAINT "file_extractions_ready_state_check"
CHECK (
  "status" <> 'ready'
  OR ("result_blob_id" IS NOT NULL AND "content_sha256" IS NOT NULL)
),
ADD CONSTRAINT "file_extractions_failed_state_check"
CHECK ("status" <> 'failed' OR "failure_code" IS NOT NULL);

ALTER TABLE "run_attachments"
ADD CONSTRAINT "run_attachments_position_nonnegative_check"
CHECK ("position" >= 0),
ADD CONSTRAINT "run_attachments_byte_size_safe_integer_check"
CHECK ("byte_size" >= 0 AND "byte_size" <= 9007199254740991),
ADD CONSTRAINT "run_attachments_sha256_format_check"
CHECK ("sha256" ~ '^[0-9a-f]{64}$');

CREATE INDEX "blobs_status_gc_eligible_at_idx"
ON "blobs"("status", "gc_eligible_at");
CREATE UNIQUE INDEX "blobs_id_byte_size_media_type_key"
ON "blobs"("id", "byte_size", "media_type");
CREATE UNIQUE INDEX "blobs_id_sha256_byte_size_media_type_key"
ON "blobs"("id", "sha256", "byte_size", "media_type");

CREATE UNIQUE INDEX "file_assets_current_extraction_id_key"
ON "file_assets"("current_extraction_id");
CREATE INDEX "file_assets_status_deleted_at_idx"
ON "file_assets"("status", "deleted_at");
CREATE UNIQUE INDEX "file_assets_id_project_id_key"
ON "file_assets"("id", "project_id");
CREATE UNIQUE INDEX "file_assets_id_blob_id_key"
ON "file_assets"("id", "blob_id");
CREATE UNIQUE INDEX "file_assets_id_project_id_blob_id_key"
ON "file_assets"("id", "project_id", "blob_id");
CREATE UNIQUE INDEX "file_assets_current_extraction_id_id_blob_id_key"
ON "file_assets"("current_extraction_id", "id", "blob_id");

CREATE UNIQUE INDEX "runs_id_project_id_key"
ON "runs"("id", "project_id");

CREATE UNIQUE INDEX "file_upload_sessions_file_asset_id_key"
ON "file_upload_sessions"("file_asset_id");
CREATE UNIQUE INDEX "file_upload_sessions_provider_upload_id_key"
ON "file_upload_sessions"("provider_upload_id");
CREATE UNIQUE INDEX "file_upload_sessions_staging_key_key"
ON "file_upload_sessions"("staging_key");
CREATE UNIQUE INDEX "file_upload_sessions_file_asset_id_project_id_key"
ON "file_upload_sessions"("file_asset_id", "project_id");
CREATE UNIQUE INDEX "file_upload_sessions_project_id_idempotency_key_key"
ON "file_upload_sessions"("project_id", "idempotency_key");
CREATE INDEX "file_upload_sessions_status_expires_at_idx"
ON "file_upload_sessions"("status", "expires_at");
CREATE INDEX "file_upload_sessions_project_id_created_at_idx"
ON "file_upload_sessions"("project_id", "created_at");

CREATE UNIQUE INDEX "file_extractions_file_asset_id_attempt_key"
ON "file_extractions"("file_asset_id", "attempt");
CREATE UNIQUE INDEX "file_extractions_id_file_asset_id_key"
ON "file_extractions"("id", "file_asset_id");
CREATE UNIQUE INDEX "file_extractions_id_file_asset_id_source_blob_id_key"
ON "file_extractions"("id", "file_asset_id", "source_blob_id");
CREATE INDEX "file_extractions_status_created_at_idx"
ON "file_extractions"("status", "created_at");
CREATE INDEX "file_extractions_source_blob_id_idx"
ON "file_extractions"("source_blob_id");
CREATE INDEX "file_extractions_result_blob_id_idx"
ON "file_extractions"("result_blob_id");
CREATE INDEX "file_extractions_text_blob_id_idx"
ON "file_extractions"("text_blob_id");

CREATE UNIQUE INDEX "run_attachments_run_id_file_asset_id_key"
ON "run_attachments"("run_id", "file_asset_id");
CREATE INDEX "run_attachments_file_asset_id_idx"
ON "run_attachments"("file_asset_id");
CREATE INDEX "run_attachments_blob_id_idx"
ON "run_attachments"("blob_id");
CREATE INDEX "run_attachments_extraction_id_idx"
ON "run_attachments"("extraction_id");

ALTER TABLE "file_assets"
ADD CONSTRAINT "file_assets_blob_id_byte_size_detected_media_type_fkey"
FOREIGN KEY ("blob_id", "byte_size", "detected_media_type")
REFERENCES "blobs"("id", "byte_size", "media_type")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "file_upload_sessions"
ADD CONSTRAINT "file_upload_sessions_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "file_upload_sessions_file_asset_id_project_id_fkey"
FOREIGN KEY ("file_asset_id", "project_id")
REFERENCES "file_assets"("id", "project_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "file_extractions"
ADD CONSTRAINT "file_extractions_file_asset_id_source_blob_id_fkey"
FOREIGN KEY ("file_asset_id", "source_blob_id")
REFERENCES "file_assets"("id", "blob_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "file_extractions_source_blob_id_fkey"
FOREIGN KEY ("source_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "file_extractions_result_blob_id_fkey"
FOREIGN KEY ("result_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "file_extractions_text_blob_id_fkey"
FOREIGN KEY ("text_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "file_assets"
ADD CONSTRAINT "file_assets_current_extraction_id_id_blob_id_fkey"
FOREIGN KEY ("current_extraction_id", "id", "blob_id")
REFERENCES "file_extractions"("id", "file_asset_id", "source_blob_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "run_attachments"
ADD CONSTRAINT "run_attachments_run_id_project_id_fkey"
FOREIGN KEY ("run_id", "project_id")
REFERENCES "runs"("id", "project_id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "run_attachments_file_asset_id_project_id_blob_id_fkey"
FOREIGN KEY ("file_asset_id", "project_id", "blob_id")
REFERENCES "file_assets"("id", "project_id", "blob_id")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "run_attachments_blob_id_sha256_byte_size_media_type_fkey"
FOREIGN KEY ("blob_id", "sha256", "byte_size", "media_type")
REFERENCES "blobs"("id", "sha256", "byte_size", "media_type")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "run_attachments_extraction_id_file_asset_id_blob_id_fkey"
FOREIGN KEY ("extraction_id", "file_asset_id", "blob_id")
REFERENCES "file_extractions"("id", "file_asset_id", "source_blob_id")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

-- Content identity is immutable. GC changes status/timestamps but never rewrites
-- a Blob row to point at different bytes.
CREATE FUNCTION "guard_blob_content_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
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

CREATE TRIGGER "blobs_content_identity_guard"
BEFORE UPDATE ON "blobs"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_content_identity"();

CREATE FUNCTION "guard_file_asset_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_status "FileExtractionStatus";
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."uploaded_by_id" IS DISTINCT FROM OLD."uploaded_by_id"
    OR NEW."original_name" IS DISTINCT FROM OLD."original_name"
    OR NEW."declared_media_type" IS DISTINCT FROM OLD."declared_media_type"
    OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
  THEN
    RAISE EXCEPTION 'FILE_ASSET_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."blob_id" IS NOT NULL AND NEW."blob_id" IS DISTINCT FROM OLD."blob_id" THEN
    RAISE EXCEPTION 'FILE_ASSET_BLOB_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."detected_media_type" IS NOT NULL
    AND NEW."detected_media_type" IS DISTINCT FROM OLD."detected_media_type"
  THEN
    RAISE EXCEPTION 'FILE_ASSET_DETECTED_MEDIA_TYPE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."verified_at" IS NOT NULL
    AND NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
  THEN
    RAISE EXCEPTION 'FILE_ASSET_VERIFICATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'FILE_ASSET_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."status" = 'uploading' AND NEW."status" IN ('uploading', 'verifying', 'failed', 'deleted'))
    OR (OLD."status" = 'verifying' AND NEW."status" IN ('verifying', 'ready', 'failed', 'quarantined', 'deleted'))
    OR (OLD."status" = 'ready' AND NEW."status" IN ('ready', 'quarantined', 'deleted'))
    OR (OLD."status" = 'failed' AND NEW."status" IN ('failed', 'deleted'))
    OR (OLD."status" = 'quarantined' AND NEW."status" IN ('quarantined', 'deleted'))
  ) THEN
    RAISE EXCEPTION 'FILE_ASSET_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleted' THEN
    RAISE EXCEPTION 'FILE_ASSET_DELETED_STATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."current_extraction_id" IS NOT NULL THEN
    SELECT "status" INTO current_status
    FROM "file_extractions"
    WHERE "id" = NEW."current_extraction_id"
      AND "file_asset_id" = NEW."id"
      AND "source_blob_id" = NEW."blob_id";

    IF current_status IS DISTINCT FROM 'ready'::"FileExtractionStatus" THEN
      RAISE EXCEPTION 'FILE_CURRENT_EXTRACTION_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_assets_update_guard"
BEFORE UPDATE ON "file_assets"
FOR EACH ROW EXECUTE FUNCTION "guard_file_asset_update"();

CREATE FUNCTION "guard_file_upload_session_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."file_asset_id" IS DISTINCT FROM OLD."file_asset_id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."staging_key" IS DISTINCT FROM OLD."staging_key"
    OR NEW."expected_byte_size" IS DISTINCT FROM OLD."expected_byte_size"
    OR NEW."expected_sha256" IS DISTINCT FROM OLD."expected_sha256"
    OR NEW."part_size" IS DISTINCT FROM OLD."part_size"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
  THEN
    RAISE EXCEPTION 'FILE_UPLOAD_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."provider_upload_id" IS NOT NULL
    AND NEW."provider_upload_id" IS DISTINCT FROM OLD."provider_upload_id"
  THEN
    RAISE EXCEPTION 'FILE_UPLOAD_PROVIDER_ID_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."completion_idempotency_key" IS NOT NULL
    AND (
      NEW."completion_idempotency_key" IS DISTINCT FROM OLD."completion_idempotency_key"
      OR NEW."completion_request_hash" IS DISTINCT FROM OLD."completion_request_hash"
    )
  THEN
    RAISE EXCEPTION 'FILE_UPLOAD_COMPLETION_IDEMPOTENCY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'FILE_UPLOAD_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('completed', 'aborted', 'expired', 'failed') THEN
    RAISE EXCEPTION 'FILE_UPLOAD_TERMINAL_STATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."status" = 'initiating' AND NEW."status" IN ('initiating', 'initiated', 'aborting', 'expired', 'failed'))
    OR (OLD."status" = 'initiated' AND NEW."status" IN ('initiated', 'completing', 'aborting', 'expired', 'failed'))
    OR (OLD."status" = 'completing' AND NEW."status" IN ('completing', 'completed', 'aborting', 'failed'))
    OR (OLD."status" = 'aborting' AND NEW."status" IN ('aborting', 'aborted', 'failed'))
  ) THEN
    RAISE EXCEPTION 'FILE_UPLOAD_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_upload_sessions_update_guard"
BEFORE UPDATE ON "file_upload_sessions"
FOR EACH ROW EXECUTE FUNCTION "guard_file_upload_session_update"();

CREATE FUNCTION "guard_file_extraction_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."file_asset_id" IS DISTINCT FROM OLD."file_asset_id"
    OR NEW."source_blob_id" IS DISTINCT FROM OLD."source_blob_id"
    OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
    OR NEW."parser" IS DISTINCT FROM OLD."parser"
    OR NEW."parser_version" IS DISTINCT FROM OLD."parser_version"
    OR NEW."output_schema_version" IS DISTINCT FROM OLD."output_schema_version"
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_extractions_update_guard"
BEFORE UPDATE ON "file_extractions"
FOR EACH ROW EXECUTE FUNCTION "guard_file_extraction_update"();

CREATE FUNCTION "guard_run_attachment_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RUN_ATTACHMENT_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "run_attachments_update_guard"
BEFORE UPDATE ON "run_attachments"
FOR EACH ROW EXECUTE FUNCTION "guard_run_attachment_update"();
