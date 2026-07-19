-- A FileExtraction may submit to Docling exactly once. The external task id is
-- checkpointed before polling so every later delivery resumes the same task.
ALTER TABLE "file_extractions"
ADD COLUMN "processing_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "submission_generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "submission_started_at" TIMESTAMP(3),
ADD COLUMN "external_task_id" TEXT,
ADD COLUMN "task_checkpointed_at" TIMESTAMP(3),
ADD COLUMN "lease_token" TEXT,
ADD COLUMN "lease_expires_at" TIMESTAMP(3);

ALTER TABLE "file_extractions"
ADD CONSTRAINT "file_extractions_processing_attempts_nonnegative_check"
CHECK ("processing_attempts" >= 0),
ADD CONSTRAINT "file_extractions_submission_generation_check"
CHECK ("submission_generation" IN (0, 1)),
ADD CONSTRAINT "file_extractions_submission_checkpoint_check"
CHECK (
  (
    "submission_generation" = 0
    AND "submission_started_at" IS NULL
    AND "external_task_id" IS NULL
    AND "task_checkpointed_at" IS NULL
  )
  OR (
    "submission_generation" = 1
    AND "submission_started_at" IS NOT NULL
    AND (
      ("external_task_id" IS NULL AND "task_checkpointed_at" IS NULL)
      OR ("external_task_id" IS NOT NULL AND "task_checkpointed_at" IS NOT NULL)
    )
  )
),
ADD CONSTRAINT "file_extractions_external_task_id_format_check"
CHECK (
  "external_task_id" IS NULL
  OR (
    length("external_task_id") BETWEEN 1 AND 200
    AND "external_task_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
),
ADD CONSTRAINT "file_extractions_lease_pair_check"
CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
ADD CONSTRAINT "file_extractions_lease_token_format_check"
CHECK (
  "lease_token" IS NULL
  OR (length("lease_token") BETWEEN 1 AND 240 AND "lease_token" !~ '[[:cntrl:]]')
),
ADD CONSTRAINT "file_extractions_runtime_status_check"
CHECK (
  (
    "status" = 'queued'
    AND "processing_attempts" = 0
    AND "submission_generation" = 0
    AND "lease_token" IS NULL
  )
  OR (
    "status" = 'running'
    AND "processing_attempts" > 0
    AND "submission_generation" = 1
  )
  OR (
    "status" IN ('ready', 'unsupported', 'failed')
    AND "lease_token" IS NULL
  )
),
ADD CONSTRAINT "file_extractions_metadata_object_check"
CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');

CREATE UNIQUE INDEX "file_extractions_external_task_id_key"
ON "file_extractions"("external_task_id");

CREATE INDEX "file_extractions_status_lease_expires_at_updated_at_idx"
ON "file_extractions"("status", "lease_expires_at", "updated_at");

CREATE FUNCTION "guard_file_extraction_runtime_checkpoint"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."processing_attempts" <> 0
      OR NEW."submission_generation" <> 0
      OR NEW."submission_started_at" IS NOT NULL
      OR NEW."external_task_id" IS NOT NULL
      OR NEW."task_checkpointed_at" IS NOT NULL
      OR NEW."lease_token" IS NOT NULL
      OR NEW."lease_expires_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'FILE_EXTRACTION_RUNTIME_MUST_START_EMPTY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."processing_attempts" < OLD."processing_attempts"
    OR NEW."processing_attempts" > OLD."processing_attempts" + 1
  THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_PROCESSING_ATTEMPTS_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."submission_generation" < OLD."submission_generation"
    OR NEW."submission_generation" > OLD."submission_generation" + 1
  THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_SUBMISSION_GENERATION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF OLD."submission_started_at" IS NOT NULL
    AND NEW."submission_started_at" IS DISTINCT FROM OLD."submission_started_at"
  THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_SUBMISSION_CHECKPOINT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."external_task_id" IS NOT NULL
    AND NEW."external_task_id" IS DISTINCT FROM OLD."external_task_id"
  THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_EXTERNAL_TASK_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."task_checkpointed_at" IS NOT NULL
    AND NEW."task_checkpointed_at" IS DISTINCT FROM OLD."task_checkpointed_at"
  THEN
    RAISE EXCEPTION 'FILE_EXTRACTION_TASK_CHECKPOINT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_extractions_runtime_checkpoint_guard"
BEFORE INSERT OR UPDATE ON "file_extractions"
FOR EACH ROW EXECUTE FUNCTION "guard_file_extraction_runtime_checkpoint"();
