BEGIN;
SET LOCAL lock_timeout = '5s';

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

  IF NEW."revision" = OLD."revision" THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
      OR NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
      OR NEW."output_blob_id" IS DISTINCT FROM OLD."output_blob_id"
      OR NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
      OR NEW."failure_detail" IS DISTINCT FROM OLD."failure_detail"
      OR NEW."updated_at" IS DISTINCT FROM OLD."updated_at"
      OR NEW."cancel_requested_at" IS DISTINCT FROM OLD."cancel_requested_at"
      OR NEW."cancellation_acknowledged_at" IS DISTINCT FROM OLD."cancellation_acknowledged_at"
    THEN
      RAISE EXCEPTION 'EXPORT_JOB_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'EXPORT_JOB_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'EXPORT_JOB_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" = 'queued' AND NEW."status" IN ('queued', 'running', 'failed', 'cancelling'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('running', 'succeeded', 'failed', 'cancelling'))
    OR (OLD."status" = 'cancelling' AND NEW."status" IN ('cancelling', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'EXPORT_JOB_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status"::text = 'cancelling' AND NEW."cancel_requested_at" IS NULL THEN
    RAISE EXCEPTION 'EXPORT_JOB_CANCEL_REQUEST_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW."status"::text = 'cancelled' AND NEW."cancellation_acknowledged_at" IS NULL THEN
    RAISE EXCEPTION 'EXPORT_JOB_CANCELLATION_ACK_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF OLD."cancel_requested_at" IS NOT NULL AND NEW."cancel_requested_at" IS DISTINCT FROM OLD."cancel_requested_at" THEN
    RAISE EXCEPTION 'EXPORT_JOB_CANCEL_REQUEST_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (NEW."execution_owner" IS NULL AND NEW."execution_lease_id" IS NULL AND NEW."execution_lease_expires_at" IS NULL)
    OR (NEW."execution_owner" IS NOT NULL AND NEW."execution_lease_id" IS NOT NULL AND NEW."execution_lease_expires_at" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'EXPORT_JOB_EXECUTION_LEASE_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  IF NEW."status"::text = 'cancelled'
    AND (NEW."execution_owner" IS NOT NULL OR NEW."execution_lease_id" IS NOT NULL OR NEW."execution_lease_expires_at" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'EXPORT_JOB_EXECUTION_LEASE_MUST_CLEAR' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'cancelling' AND NEW."execution_lease_id" IS NOT NULL
    AND (NEW."execution_lease_id", NEW."execution_owner") IS DISTINCT FROM (OLD."execution_lease_id", OLD."execution_owner")
  THEN
    RAISE EXCEPTION 'EXPORT_JOB_CANCEL_LEASE_REASSIGNMENT' USING ERRCODE = '23514';
  END IF;
  IF OLD."execution_lease_id" IS NOT NULL AND NEW."execution_lease_id" IS NOT NULL
    AND (NEW."execution_lease_id", NEW."execution_owner") IS DISTINCT FROM (OLD."execution_lease_id", OLD."execution_owner")
    AND OLD."execution_lease_expires_at" > clock_timestamp()
  THEN
    RAISE EXCEPTION 'EXPORT_JOB_EXECUTION_LEASE_ACTIVE' USING ERRCODE = '23514';
  END IF;
  IF NEW."execution_lease_id" = OLD."execution_lease_id"
    AND NEW."execution_lease_expires_at" > OLD."execution_lease_expires_at"
    AND OLD."execution_lease_expires_at" <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'EXPORT_JOB_EXECUTION_LEASE_EXPIRED' USING ERRCODE = '23514';
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

COMMIT;
