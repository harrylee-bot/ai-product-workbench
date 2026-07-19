ALTER TABLE "blobs"
ADD COLUMN "gc_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "gc_last_error_code" TEXT,
ADD COLUMN "gc_last_error_detail" TEXT,
ADD COLUMN "gc_last_error_at" TIMESTAMP(3),
ADD COLUMN "storage_deleted_at" TIMESTAMP(3),
ADD CONSTRAINT "blobs_gc_attempt_count_nonnegative_check"
CHECK ("gc_attempt_count" >= 0),
ADD CONSTRAINT "blobs_gc_failure_envelope_check"
CHECK (
  ("gc_last_error_code" IS NULL) = ("gc_last_error_at" IS NULL)
  AND ("gc_last_error_code" IS NOT NULL OR "gc_last_error_detail" IS NULL)
),
ADD CONSTRAINT "blobs_storage_deleted_state_check"
CHECK (
  "storage_deleted_at" IS NULL
  OR ("status" = 'deleted' AND "deleted_at" IS NOT NULL)
),
ADD CONSTRAINT "blobs_gc_live_state_check"
CHECK (
  "status" = 'deleted'
  OR (
    "gc_attempt_count" = 0
    AND "gc_last_error_code" IS NULL
    AND "gc_last_error_detail" IS NULL
    AND "gc_last_error_at" IS NULL
    AND "storage_deleted_at" IS NULL
  )
);

CREATE INDEX "blobs_status_storage_deleted_at_gc_attempt_count_idx"
ON "blobs"("status", "storage_deleted_at", "gc_attempt_count");

-- BlobScan is intentionally absent. It is immutable audit evidence about the
-- bytes, not a consumer that requires the bytes to remain in object storage.
CREATE FUNCTION "blob_has_durable_byte_references"("candidate_blob_id" TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "file_assets" AS file
      WHERE file."blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "file_extractions" AS extraction
      WHERE extraction."source_blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "file_extraction_outputs" AS output
      WHERE output."blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "run_attachments" AS attachment
      WHERE attachment."blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "artifact_versions" AS version
      WHERE version."content_blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "artifact_version_assets" AS asset
      WHERE asset."blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "artifact_creation_receipts" AS receipt
      WHERE receipt."source_blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "knowledge_documents" AS document
      WHERE document."source_blob_id" = "candidate_blob_id"
    )
    OR EXISTS (
      SELECT 1 FROM "export_jobs" AS job
      WHERE job."output_blob_id" = "candidate_blob_id"
    );
$$;

-- Remove any stale eligibility left by older code before the reference-write
-- triggers below become authoritative.
UPDATE "blobs" AS blob
SET "gc_eligible_at" = NULL,
    "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
WHERE blob."status" <> 'deleted'
  AND blob."gc_eligible_at" IS NOT NULL
  AND "blob_has_durable_byte_references"(blob."id");

CREATE FUNCTION "guard_blob_reference_for_gc"()
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
  IF TG_OP = 'UPDATE'
    AND referenced_blob_id IS NOT DISTINCT FROM to_jsonb(OLD)->>TG_ARGV[0]
  THEN
    RETURN NEW;
  END IF;

  -- This update is both the eligibility cancellation and the serialization
  -- point against the GC transaction's FOR UPDATE lock.
  UPDATE "blobs"
  SET "gc_eligible_at" = NULL,
      "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
  WHERE "id" = referenced_blob_id
    AND "status" <> 'deleted'
    AND "deleted_at" IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOB_REFERENCE_TARGET_UNAVAILABLE' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "file_assets_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "blob_id" ON "file_assets"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('blob_id');

CREATE TRIGGER "blob_scans_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "blob_id" ON "blob_scans"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('blob_id');

CREATE TRIGGER "file_extractions_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "source_blob_id" ON "file_extractions"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('source_blob_id');

CREATE TRIGGER "file_extraction_outputs_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "blob_id" ON "file_extraction_outputs"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('blob_id');

CREATE TRIGGER "run_attachments_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "blob_id" ON "run_attachments"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('blob_id');

CREATE TRIGGER "artifact_versions_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "content_blob_id" ON "artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('content_blob_id');

CREATE TRIGGER "artifact_version_assets_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "blob_id" ON "artifact_version_assets"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('blob_id');

CREATE TRIGGER "artifact_creation_receipts_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "source_blob_id" ON "artifact_creation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('source_blob_id');

CREATE TRIGGER "knowledge_documents_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "source_blob_id" ON "knowledge_documents"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('source_blob_id');

CREATE TRIGGER "export_jobs_blob_gc_reference_guard"
BEFORE INSERT OR UPDATE OF "output_blob_id" ON "export_jobs"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_reference_for_gc"('output_blob_id');

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

  IF (
    EXISTS (
      SELECT 1 FROM "artifact_versions" AS version
      WHERE version."content_blob_id" = OLD."id" AND version."status" = 'ready'
    )
    OR EXISTS (
      SELECT 1
      FROM "artifact_version_assets" AS asset
      JOIN "artifact_versions" AS version ON version."id" = asset."artifact_version_id"
      WHERE asset."blob_id" = OLD."id" AND version."status" = 'ready'
    )
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_READY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "artifact_versions" AS version
    WHERE version."content_blob_id" = OLD."id"
  ) OR EXISTS (
    SELECT 1 FROM "artifact_version_assets" AS asset
    WHERE asset."blob_id" = OLD."id"
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

  -- This receipt is normally also covered by its FileAsset and ArtifactVersion
  -- references. Keep it explicit so future receipt retention changes cannot
  -- silently remove the GC fence.
  IF EXISTS (
    SELECT 1 FROM "artifact_creation_receipts" AS receipt
    WHERE receipt."source_blob_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_ARTIFACT_CREATION_RECEIPT' USING ERRCODE = '23503';
  END IF;

  IF "blob_has_durable_byte_references"(OLD."id") THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_DURABLE_BYTE_OWNER' USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "guard_blob_content_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256"
    OR NEW."generation" IS DISTINCT FROM OLD."generation"
    OR NEW."media_type" IS DISTINCT FROM OLD."media_type"
    OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
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
    OR (OLD."status" = 'deleted' AND NEW."status" = 'deleted')
  ) THEN
    RAISE EXCEPTION 'BLOB_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'deleted' AND (
    NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
    OR NEW."gc_eligible_at" IS DISTINCT FROM OLD."gc_eligible_at"
    OR NEW."deleted_at" IS DISTINCT FROM OLD."deleted_at"
    OR NEW."gc_attempt_count" < OLD."gc_attempt_count"
    OR NEW."gc_attempt_count" > OLD."gc_attempt_count" + 1
    OR (
      OLD."storage_deleted_at" IS NOT NULL
      AND (
        NEW."storage_deleted_at" IS DISTINCT FROM OLD."storage_deleted_at"
        OR NEW."gc_attempt_count" IS DISTINCT FROM OLD."gc_attempt_count"
        OR NEW."gc_last_error_code" IS DISTINCT FROM OLD."gc_last_error_code"
        OR NEW."gc_last_error_detail" IS DISTINCT FROM OLD."gc_last_error_detail"
        OR NEW."gc_last_error_at" IS DISTINCT FROM OLD."gc_last_error_at"
      )
    )
  ) THEN
    RAISE EXCEPTION 'BLOB_DELETED_STATE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
