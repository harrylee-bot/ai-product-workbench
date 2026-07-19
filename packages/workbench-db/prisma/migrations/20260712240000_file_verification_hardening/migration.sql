BEGIN;

CREATE TYPE "FileVerificationAttemptStatus" AS ENUM (
  'running',
  'succeeded',
  'retryable_failed',
  'terminal_failed'
);

CREATE TABLE "file_verification_attempts" (
  "id" TEXT NOT NULL,
  "upload_session_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "queue_job_id" TEXT NOT NULL,
  "queue_retry_count" INTEGER NOT NULL,
  "status" "FileVerificationAttemptStatus" NOT NULL DEFAULT 'running',
  "file_status" "FileStatus",
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "file_verification_attempts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "file_verification_attempts"
ADD CONSTRAINT "file_verification_attempts_sequence_positive_check"
CHECK ("sequence" > 0),
ADD CONSTRAINT "file_verification_attempts_retry_count_nonnegative_check"
CHECK ("queue_retry_count" >= 0),
ADD CONSTRAINT "file_verification_attempts_job_id_nonempty_check"
CHECK (length("queue_job_id") > 0),
ADD CONSTRAINT "file_verification_attempts_state_check"
CHECK (
  (
    "status" = 'running'
    AND "file_status" IS NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
    AND "finished_at" IS NULL
  )
  OR (
    "status" = 'succeeded'
    AND "file_status" IN ('ready', 'failed', 'quarantined', 'deleted')
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
    AND "finished_at" IS NOT NULL
  )
  OR (
    "status" = 'retryable_failed'
    AND "file_status" IS NULL
    AND "failure_code" IS NOT NULL
    AND "finished_at" IS NOT NULL
  )
  OR (
    "status" = 'terminal_failed'
    AND "file_status" = 'failed'
    AND "failure_code" IS NOT NULL
    AND "finished_at" IS NOT NULL
  )
),
ADD CONSTRAINT "file_verification_attempts_timestamp_order_check"
CHECK ("finished_at" IS NULL OR "finished_at" >= "started_at"),
ADD CONSTRAINT "file_verification_attempts_upload_session_id_fkey"
FOREIGN KEY ("upload_session_id") REFERENCES "file_upload_sessions"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "file_verification_attempts_upload_session_id_sequence_key"
ON "file_verification_attempts"("upload_session_id", "sequence");
CREATE UNIQUE INDEX "file_verification_attempts_queue_job_id_queue_retry_count_key"
ON "file_verification_attempts"("queue_job_id", "queue_retry_count");
CREATE INDEX "file_verification_attempts_upload_session_id_status_sequence_idx"
ON "file_verification_attempts"("upload_session_id", "status", "sequence");
CREATE INDEX "file_verification_attempts_status_updated_at_idx"
ON "file_verification_attempts"("status", "updated_at");

CREATE FUNCTION "guard_file_verification_attempt_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."upload_session_id" IS DISTINCT FROM OLD."upload_session_id"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."queue_job_id" IS DISTINCT FROM OLD."queue_job_id"
    OR NEW."queue_retry_count" IS DISTINCT FROM OLD."queue_retry_count"
    OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'FILE_VERIFICATION_ATTEMPT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'FILE_VERIFICATION_ATTEMPT_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'running'
    AND NEW."status" NOT IN ('running', 'succeeded', 'retryable_failed', 'terminal_failed')
  THEN
    RAISE EXCEPTION 'FILE_VERIFICATION_ATTEMPT_STATUS_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_verification_attempts_update_guard"
BEFORE UPDATE ON "file_verification_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_file_verification_attempt_update"();

-- User uploads are intentionally bounded by the slowest mandatory stage:
-- server hashing, malware scanning and a conditional single-object promotion.
ALTER TABLE "file_assets"
DROP CONSTRAINT "file_assets_byte_size_safe_integer_check",
ADD CONSTRAINT "file_assets_byte_size_safe_integer_check"
CHECK ("byte_size" > 0 AND "byte_size" <= 26214400);

ALTER TABLE "file_upload_sessions"
DROP CONSTRAINT "file_upload_sessions_byte_size_safe_integer_check",
ADD CONSTRAINT "file_upload_sessions_byte_size_safe_integer_check"
CHECK ("expected_byte_size" > 0 AND "expected_byte_size" <= 26214400);

ALTER TABLE "run_attachments"
DROP CONSTRAINT "run_attachments_byte_size_safe_integer_check",
ADD CONSTRAINT "run_attachments_byte_size_safe_integer_check"
CHECK ("byte_size" > 0 AND "byte_size" <= 26214400);

-- Blob content identity remains immutable. A pending verification reservation
-- may publish into the canonical namespace after clean evidence, while pending
-- or ready content may only move in the stricter direction into quarantine.
CREATE OR REPLACE FUNCTION "guard_blob_content_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
    OR NEW."generation" IS DISTINCT FROM OLD."generation"
    OR NEW."media_type" IS DISTINCT FROM OLD."media_type"
    OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
  THEN
    RAISE EXCEPTION 'BLOB_CONTENT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
    AND NOT (
      (
        OLD."status" = 'pending'
        AND NEW."status" = 'ready'
        AND NEW."storage_key" ~ '^blobs/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}/g[1-9][0-9]*$'
      )
      OR (
        OLD."status" IN ('pending', 'ready')
        AND NEW."status" = OLD."status"
        AND NEW."storage_key" ~ '^quarantine/blobs/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}/g[1-9][0-9]*$'
      )
    )
  THEN
    RAISE EXCEPTION 'BLOB_STORAGE_TRANSITION_INVALID' USING ERRCODE = '23514';
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

CREATE OR REPLACE FUNCTION "quarantine_blob_from_infected_scan"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_storage_key TEXT;
BEGIN
  IF NEW."status" = 'infected'
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status")
  THEN
    SELECT "storage_key"
    INTO owner_storage_key
    FROM "blobs"
    WHERE "id" = NEW."blob_id"
    FOR UPDATE;

    IF owner_storage_key !~ '^quarantine/blobs/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}/g[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'INFECTED_BLOB_STORAGE_NOT_ISOLATED' USING ERRCODE = '23514';
    END IF;

    UPDATE "blobs"
    SET "status" = 'quarantined',
        "verified_at" = COALESCE("verified_at", clock_timestamp()),
        "gc_eligible_at" = NULL,
        "updated_at" = clock_timestamp()
    WHERE "id" = NEW."blob_id"
      AND "status" IN ('pending', 'ready');

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

COMMIT;
