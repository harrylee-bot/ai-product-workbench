-- Run controls visible in 产品工作台 are durable product semantics, not model names
-- or unvalidated UI metadata. A design-system ArtifactVersion is pinned by FK.
ALTER TABLE "runs"
ADD COLUMN "design_style_artifact_version_id" TEXT;

CREATE INDEX "runs_design_style_artifact_version_id_idx"
ON "runs"("design_style_artifact_version_id");

ALTER TABLE "runs"
ADD CONSTRAINT "runs_design_style_artifact_version_id_project_id_fkey"
FOREIGN KEY ("design_style_artifact_version_id", "project_id")
REFERENCES "artifact_versions"("id", "project_id")
ON DELETE NO ACTION ON UPDATE RESTRICT;

ALTER TABLE "runs"
ADD CONSTRAINT "runs_typed_options_check"
CHECK (
  jsonb_typeof("request") = 'object'
  AND jsonb_extract_path_text("request", 'modelId') = "model_id"
  AND jsonb_extract_path_text("request", 'workflow') IN ('generate', 'redesign', 'ideate', 'edit')
  AND jsonb_extract_path_text("request", 'targetSurface') IN ('app', 'web')
  AND jsonb_typeof(jsonb_extract_path("request", 'designStyle')) = 'object'
  AND CASE jsonb_extract_path_text("request", 'designStyle', 'kind')
    WHEN 'automatic' THEN
      jsonb_extract_path("request", 'designStyle') = '{"kind":"automatic"}'::jsonb
      AND "design_style_artifact_version_id" IS NULL
    WHEN 'preset' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'presetId']) = '{}'::jsonb
      AND jsonb_extract_path_text("request", 'designStyle', 'presetId') ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      AND "design_style_artifact_version_id" IS NULL
    WHEN 'artifact' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'artifactVersionId']) = '{}'::jsonb
      AND length(jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId')) > 0
      AND jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId') = "design_style_artifact_version_id"
    ELSE FALSE
  END
  AND (
    jsonb_extract_path_text("request", 'workflow') <> 'redesign'
    OR CASE
      WHEN jsonb_typeof(jsonb_extract_path("request", 'attachmentIds')) = 'array'
      THEN jsonb_array_length(jsonb_extract_path("request", 'attachmentIds')) > 0
      ELSE FALSE
    END
  )
);

CREATE OR REPLACE FUNCTION "guard_run_identity_and_knowledge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_workspace_id TEXT;
  release_status "KnowledgeReleaseStatus";
  release_workspace_id TEXT;
  design_style_status "ArtifactVersionStatus";
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
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
