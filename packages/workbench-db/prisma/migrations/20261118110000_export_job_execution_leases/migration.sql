-- Persist cancellation signals and fenced execution leases for multi-worker cleanup.
ALTER TABLE "export_jobs"
ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(6),
ADD COLUMN "cancellation_acknowledged_at" TIMESTAMPTZ(6),
ADD COLUMN "execution_owner" TEXT,
ADD COLUMN "execution_lease_id" TEXT,
ADD COLUMN "execution_lease_expires_at" TIMESTAMPTZ(6);

ALTER TABLE "export_jobs" DROP CONSTRAINT "export_jobs_state_check";
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_state_check" CHECK (
  (status::text = 'queued' AND started_at IS NULL AND finished_at IS NULL AND output_blob_id IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND cancel_requested_at IS NULL AND cancellation_acknowledged_at IS NULL AND execution_owner IS NULL AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL)
  OR (status::text = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND output_blob_id IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND cancel_requested_at IS NULL AND cancellation_acknowledged_at IS NULL AND ((execution_owner IS NULL AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL) OR (execution_owner IS NOT NULL AND execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL)))
  OR (status::text = 'cancelling' AND finished_at IS NULL AND output_blob_id IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND cancel_requested_at IS NOT NULL AND cancellation_acknowledged_at IS NULL AND ((execution_owner IS NULL AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL) OR (execution_owner IS NOT NULL AND execution_lease_id IS NOT NULL AND execution_lease_expires_at IS NOT NULL)))
  OR (status::text = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND output_blob_id IS NOT NULL AND failure_code IS NULL AND failure_detail IS NULL AND cancel_requested_at IS NULL AND cancellation_acknowledged_at IS NULL AND execution_owner IS NULL AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL)
  OR (status::text = 'failed' AND finished_at IS NOT NULL AND output_blob_id IS NULL AND failure_code IS NOT NULL AND cancel_requested_at IS NULL AND cancellation_acknowledged_at IS NULL AND execution_owner IS NULL AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL)
  OR (status::text = 'cancelled' AND finished_at IS NOT NULL AND output_blob_id IS NULL AND failure_code IS NULL AND failure_detail IS NULL AND ((cancel_requested_at IS NULL AND cancellation_acknowledged_at IS NULL) OR (cancel_requested_at IS NOT NULL AND cancellation_acknowledged_at IS NOT NULL)) AND execution_owner IS NULL AND execution_lease_id IS NULL AND execution_lease_expires_at IS NULL)
);

CREATE INDEX "export_jobs_status_execution_lease_expires_at_idx" ON "export_jobs" ("status", "execution_lease_expires_at");

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
    OR (OLD."status"::text = 'cancelling' AND NEW."status"::text = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'EXPORT_JOB_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status"::text = 'cancelling' AND NEW."cancel_requested_at" IS NULL THEN
    RAISE EXCEPTION 'EXPORT_JOB_CANCEL_REQUEST_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW."status"::text = 'cancelled' AND NEW."cancellation_acknowledged_at" IS NULL THEN
    RAISE EXCEPTION 'EXPORT_JOB_CANCELLATION_ACK_REQUIRED' USING ERRCODE = '23514';
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
