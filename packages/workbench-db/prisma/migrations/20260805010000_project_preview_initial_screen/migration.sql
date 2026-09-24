BEGIN;

ALTER TABLE "project_previews"
ADD COLUMN "initial_screen_id" TEXT,
ADD CONSTRAINT "project_previews_initial_screen_id_length_check" CHECK (
  "initial_screen_id" IS NULL
  OR (
    length("initial_screen_id") BETWEEN 1 AND 128
    AND length(btrim("initial_screen_id")) > 0
  )
);

-- The previous schema could persist a Preview by reusing Export's screen crop.
-- There is no lossless backfill: a cropped job cannot prove it packaged the
-- complete Prototype, so abort the migration instead of blessing that state.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "project_previews" AS preview
    JOIN "export_jobs" AS job ON job."id" = preview."export_job_id"
    WHERE job."selection_screen_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_LEGACY_SELECTION_SCREEN_CROP_FORBIDDEN'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "guard_project_preview_initial_screen"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  export_selection_kind "ExportSelectionKind";
  export_selection_artifact_id TEXT;
  export_selection_artifact_version_id TEXT;
  export_selection_screen_id TEXT;
  selected_artifact_kind "ArtifactKind";
  selected_version_status "ArtifactVersionStatus";
  selected_version_content JSONB;
  selected_version_content_blob_id TEXT;
BEGIN
  SELECT
    job."selection_kind",
    job."selection_artifact_id",
    job."selection_artifact_version_id",
    job."selection_screen_id"
  INTO
    export_selection_kind,
    export_selection_artifact_id,
    export_selection_artifact_version_id,
    export_selection_screen_id
  FROM "export_jobs" AS job
  WHERE job."id" = NEW."export_job_id"
  FOR SHARE;

  IF export_selection_kind IS NULL THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_EXPORT_JOB_MISSING' USING ERRCODE = '23514';
  END IF;

  -- Preview always packages the complete selected Artifact. Start-screen intent
  -- is stored on ProjectPreview and must never reuse Export's crop column.
  IF export_selection_screen_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_SELECTION_SCREEN_CROP_FORBIDDEN' USING ERRCODE = '23514';
  END IF;

  IF NEW."initial_screen_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF export_selection_kind IS DISTINCT FROM 'artifact'::"ExportSelectionKind"
    OR export_selection_artifact_id IS NULL
    OR export_selection_artifact_version_id IS NULL
  THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_INITIAL_SCREEN_SELECTION_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT
    artifact."kind",
    version."status",
    version."content",
    version."content_blob_id"
  INTO
    selected_artifact_kind,
    selected_version_status,
    selected_version_content,
    selected_version_content_blob_id
  FROM "artifact_versions" AS version
  JOIN "artifacts" AS artifact
    ON artifact."id" = version."artifact_id"
    AND artifact."project_id" = version."project_id"
  WHERE version."id" = export_selection_artifact_version_id
    AND version."artifact_id" = export_selection_artifact_id
    AND version."project_id" = NEW."project_id"
  FOR SHARE OF version, artifact;

  IF selected_artifact_kind IS DISTINCT FROM 'prototype'::"ArtifactKind"
    OR selected_version_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR selected_version_content_blob_id IS NOT NULL
    OR jsonb_typeof(selected_version_content) IS DISTINCT FROM 'object'
    OR selected_version_content ->> 'protocol' IS DISTINCT FROM 'workbench.prototype.v1'
    OR jsonb_typeof(selected_version_content -> 'screens') IS DISTINCT FROM 'array'
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(selected_version_content -> 'screens') AS screen
      WHERE screen ->> 'id' = NEW."initial_screen_id"
    )
  THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_INITIAL_SCREEN_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  application_schema TEXT := current_schema();
  trusted_search_path TEXT;
BEGIN
  IF application_schema IS NULL THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_SCHEMA_UNRESOLVED';
  END IF;

  trusted_search_path := CASE application_schema
    WHEN 'public' THEN 'pg_catalog, public'
    ELSE format('pg_catalog, %I, public', application_schema)
  END;

  EXECUTE format(
    'ALTER FUNCTION %I.%I() SET search_path TO %s',
    application_schema,
    'guard_project_preview_initial_screen',
    trusted_search_path
  );
END;
$$;

CREATE TRIGGER "project_previews_initial_screen_guard"
BEFORE INSERT ON "project_previews"
FOR EACH ROW EXECUTE FUNCTION "guard_project_preview_initial_screen"();

COMMIT;
