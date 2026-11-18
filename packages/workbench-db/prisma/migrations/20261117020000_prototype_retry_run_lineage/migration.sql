-- Preserve immutable Run inputs while allowing exact terminal Prototype Plan retries.
CREATE OR REPLACE FUNCTION "guard_run_identity_and_knowledge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_workspace_id TEXT;
  release_status "KnowledgeReleaseStatus";
  release_workspace_id TEXT;
  design_style_status "ArtifactVersionStatus";
  design_style_artifact_id TEXT;
  design_style_kind TEXT;
  design_style_schema_version INTEGER;
  design_style_checksum TEXT;
  source_run "runs"%ROWTYPE;
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
      OR NEW."design_style_snapshot" IS DISTINCT FROM OLD."design_style_snapshot"
      OR NEW."design_style_snapshot_sha256" IS DISTINCT FROM OLD."design_style_snapshot_sha256"
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
    SELECT source.* INTO source_run
    FROM "runs" AS source
    WHERE source."id" = NEW."retry_of_run_id"
      AND source."project_id" = NEW."project_id"
      AND source."thread_id" = NEW."thread_id"
    FOR SHARE;

    IF source_run."id" IS NULL
      OR source_run."request" IS DISTINCT FROM NEW."request"
      OR source_run."knowledge_release_id" IS DISTINCT FROM NEW."knowledge_release_id"
      OR source_run."design_style_artifact_version_id" IS DISTINCT FROM NEW."design_style_artifact_version_id"
      OR source_run."design_style_snapshot" IS DISTINCT FROM NEW."design_style_snapshot"
      OR source_run."design_style_snapshot_sha256" IS DISTINCT FROM NEW."design_style_snapshot_sha256"
    THEN
      RAISE EXCEPTION 'RUN_RETRY_SOURCE_INVALID' USING ERRCODE = '23514';
    END IF;

    -- Ordinary Run retry still requires an explicitly retryable failure.
    -- A Prototype retry also permits its terminal cancelled/non-retryable Run,
    -- but only while preparing the exact approved derived Plan in this project.
    IF (source_run."status" = 'failed'::"RunStatus" AND source_run."error_retryable" = TRUE) IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1 FROM "prototype_plans" AS derived
        JOIN "prototype_plans" AS original
          ON original."id" = derived."retry_of_plan_id"
         AND original."project_id" = derived."project_id"
        WHERE derived."project_id" = NEW."project_id"
          AND derived."created_by_id" = NEW."created_by_id"
          AND NEW."idempotency_key" = 'prototype:' || derived."id"
          AND derived."status" = 'approved'
          AND derived."runtime_run_id" IS NULL AND derived."reused_run_id" IS NULL
          AND derived."generation_request" = NEW."request"
          AND derived."root_plan_id" = COALESCE(original."root_plan_id", original."id")
          AND derived."content_version" > original."content_version"
          AND derived."source_revision_id" IS NOT DISTINCT FROM original."source_revision_id"
          AND derived."feedback_ids" = original."feedback_ids"
          AND original."status" IN ('failed', 'cancelled')
          AND COALESCE(original."runtime_run_id", original."reused_run_id") = source_run."id"
          AND source_run."status" IN ('failed'::"RunStatus", 'cancelled'::"RunStatus")
      )
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
    SELECT version."status", artifact."id", artifact."kind"::TEXT, version."schema_version", version."checksum"
    INTO design_style_status, design_style_artifact_id, design_style_kind, design_style_schema_version, design_style_checksum
    FROM "artifact_versions" AS version
    JOIN "artifacts" AS artifact
      ON artifact."id" = version."artifact_id"
     AND artifact."project_id" = version."project_id"
    WHERE version."id" = NEW."design_style_artifact_version_id"
      AND version."project_id" = NEW."project_id"
    FOR SHARE OF version, artifact;

    IF design_style_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
      OR design_style_kind IS DISTINCT FROM 'design_system'
      OR design_style_schema_version IS DISTINCT FROM 1
      OR jsonb_typeof(NEW."design_style_snapshot") IS DISTINCT FROM 'object'
      OR NEW."design_style_snapshot"->>'protocol' IS DISTINCT FROM 'workbench.runtime.design-style.v1'
      OR NEW."design_style_snapshot"#>>'{source,projectId}' IS DISTINCT FROM NEW."project_id"
      OR NEW."design_style_snapshot"#>>'{source,artifactId}' IS DISTINCT FROM design_style_artifact_id
      OR NEW."design_style_snapshot"#>>'{source,artifactVersionId}' IS DISTINCT FROM NEW."design_style_artifact_version_id"
      OR NEW."design_style_snapshot"#>>'{source,checksum}' IS DISTINCT FROM design_style_checksum
    THEN
      RAISE EXCEPTION 'RUN_DESIGN_STYLE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
