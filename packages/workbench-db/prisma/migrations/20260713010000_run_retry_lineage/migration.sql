-- A retry is a new durable Run created from the server-owned request snapshot.
-- Keep its lineage and eligibility enforceable outside the HTTP process.
ALTER TABLE "runs"
ADD COLUMN "retry_of_run_id" TEXT;

CREATE UNIQUE INDEX "runs_id_thread_id_key"
ON "runs"("id", "thread_id");

CREATE INDEX "runs_retry_of_run_id_idx"
ON "runs"("retry_of_run_id");

ALTER TABLE "runs"
ADD CONSTRAINT "runs_retry_of_run_id_thread_id_fkey"
FOREIGN KEY ("retry_of_run_id", "thread_id")
REFERENCES "runs"("id", "thread_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "runs_retry_not_self_check"
CHECK ("retry_of_run_id" IS NULL OR "retry_of_run_id" <> "id");

CREATE OR REPLACE FUNCTION "guard_run_identity_and_knowledge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_workspace_id TEXT;
  release_status "KnowledgeReleaseStatus";
  release_workspace_id TEXT;
  design_style_status "ArtifactVersionStatus";
  source_status "RunStatus";
  source_retryable BOOLEAN;
  source_request JSONB;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
      OR NEW."retry_of_run_id" IS DISTINCT FROM OLD."retry_of_run_id"
      OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
      OR NEW."knowledge_release_id" IS DISTINCT FROM OLD."knowledge_release_id"
      OR NEW."design_style_artifact_version_id" IS DISTINCT FROM OLD."design_style_artifact_version_id"
      OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
      OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
      OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
      OR NEW."request" IS DISTINCT FROM OLD."request"
      OR NEW."model_id" IS DISTINCT FROM OLD."model_id"
      OR NEW."trace_id" IS DISTINCT FROM OLD."trace_id"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    )
  THEN
    RAISE EXCEPTION 'RUN_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."retry_of_run_id" IS NOT NULL THEN
    SELECT source."status", source."error_retryable", source."request"
    INTO source_status, source_retryable, source_request
    FROM "runs" AS source
    WHERE source."id" = NEW."retry_of_run_id"
      AND source."thread_id" = NEW."thread_id"
    FOR SHARE;

    IF source_status IS DISTINCT FROM 'failed'::"RunStatus"
      OR source_retryable IS DISTINCT FROM TRUE
      OR source_request IS DISTINCT FROM NEW."request"
    THEN
      RAISE EXCEPTION 'RUN_RETRY_SOURCE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW."knowledge_release_id" IS NOT NULL THEN
    SELECT project."workspace_id"
    INTO run_workspace_id
    FROM "projects" AS project
    WHERE project."id" = NEW."project_id";

    SELECT release."status", release."workspace_id"
    INTO release_status, release_workspace_id
    FROM "knowledge_releases" AS release
    WHERE release."id" = NEW."knowledge_release_id"
    FOR SHARE;

    IF run_workspace_id IS NULL
      OR release_status IS DISTINCT FROM 'ready'::"KnowledgeReleaseStatus"
      OR (
        release_workspace_id IS NOT NULL
        AND release_workspace_id IS DISTINCT FROM run_workspace_id
      )
    THEN
      RAISE EXCEPTION 'RUN_KNOWLEDGE_RELEASE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW."design_style_artifact_version_id" IS NOT NULL THEN
    SELECT version."status"
    INTO design_style_status
    FROM "artifact_versions" AS version
    WHERE version."id" = NEW."design_style_artifact_version_id"
      AND version."project_id" = NEW."project_id"
    FOR SHARE;

    IF design_style_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus" THEN
      RAISE EXCEPTION 'RUN_DESIGN_STYLE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
