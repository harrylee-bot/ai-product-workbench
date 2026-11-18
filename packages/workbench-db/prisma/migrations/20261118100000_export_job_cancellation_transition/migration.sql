-- Restrict terminal cancellation to the cancelling state so API acceptance
-- and worker cleanup remain one durable lifecycle.
CREATE OR REPLACE FUNCTION "guard_export_job_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, workbench
AS $$
DECLARE
  release_status "ProjectReleaseStatus";
  output_status "BlobStatus";
  output_size BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'queued' OR NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'EXPORT_JOB_MUST_START_QUEUED' USING ERRCODE = '23514';
    END IF;
    IF NEW."purpose" = 'export' THEN
      SELECT release."status"
      INTO release_status
      FROM "project_releases" AS release
      WHERE release."id" = NEW."release_id"
      FOR SHARE;
      IF release_status IS DISTINCT FROM 'ready'::"ProjectReleaseStatus" THEN
        RAISE EXCEPTION 'EXPORT_JOB_RELEASE_NOT_READY' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."format" <> 'html' THEN
      RAISE EXCEPTION 'PREVIEW_JOB_MUST_BE_HTML' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'EXPORT_JOB_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."format" IS DISTINCT FROM OLD."format"
    OR NEW."selection_kind" IS DISTINCT FROM OLD."selection_kind"
    OR NEW."selection_artifact_id" IS DISTINCT FROM OLD."selection_artifact_id"
    OR NEW."selection_artifact_version_id" IS DISTINCT FROM OLD."selection_artifact_version_id"
    OR NEW."options" IS DISTINCT FROM OLD."options"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'EXPORT_JOB_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'EXPORT_JOB_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'EXPORT_JOB_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" = 'queued' AND NEW."status" IN ('queued', 'running', 'failed', 'cancelling'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('running', 'succeeded', 'failed', 'cancelling'))
    OR (OLD."status"::text = 'cancelling' AND NEW."status"::text = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'EXPORT_JOB_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'succeeded' THEN
    SELECT blob."status", blob."byte_size"
    INTO output_status, output_size
    FROM "blobs" AS blob
    WHERE blob."id" = NEW."output_blob_id"
    FOR SHARE;
    IF output_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR output_size IS NULL
      OR output_size <= 0
    THEN
      RAISE EXCEPTION 'EXPORT_JOB_OUTPUT_BLOB_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
