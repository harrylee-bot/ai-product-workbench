BEGIN;

-- PRD v2 is an additive document protocol. Keep every existing ArtifactVersion
-- invariant while binding each supported PRD schema version to exactly one
-- inline protocol. Prototype and Design System artifacts remain v1-only.
CREATE OR REPLACE FUNCTION "guard_artifact_version_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind TEXT;
  artifact_workspace_id TEXT;
  content_blob_status "BlobStatus";
  content_blob_byte_size BIGINT;
  knowledge_release_status "KnowledgeReleaseStatus";
  knowledge_release_workspace_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."artifact_id" IS DISTINCT FROM OLD."artifact_id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."schema_version" IS DISTINCT FROM OLD."schema_version"
      OR NEW."created_by_run_id" IS DISTINCT FROM OLD."created_by_run_id"
      OR NEW."runtime_draft_source_id" IS DISTINCT FROM OLD."runtime_draft_source_id"
      OR NEW."runtime_draft_index" IS DISTINCT FROM OLD."runtime_draft_index"
      OR NEW."runtime_draft_title" IS DISTINCT FROM OLD."runtime_draft_title"
      OR NEW."knowledge_release_id" IS DISTINCT FROM OLD."knowledge_release_id"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    )
  THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('ready', 'rejected') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ARTIFACT_TERMINAL_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT artifact."kind"::TEXT, project."workspace_id"
  INTO artifact_kind, artifact_workspace_id
  FROM "artifacts" AS artifact
  JOIN "projects" AS project ON project."id" = artifact."project_id"
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id";

  IF artifact_kind IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_OWNER_INVALID' USING ERRCODE = '23503';
  END IF;

  IF artifact_kind = 'prd'
    AND NEW."schema_version" IS DISTINCT FROM 1
    AND NEW."schema_version" IS DISTINCT FROM 2
  THEN
    RAISE EXCEPTION 'ARTIFACT_SCHEMA_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind IN ('prototype', 'design_system')
    AND NEW."schema_version" IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION 'ARTIFACT_SCHEMA_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind = 'prd'
    AND NEW."content" IS NOT NULL
    AND (
      jsonb_typeof(NEW."content") IS DISTINCT FROM 'object'
      OR CASE NEW."schema_version"
        WHEN 1 THEN NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prd.v1'
        WHEN 2 THEN NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prd.v2'
        ELSE TRUE
      END
      OR NEW."content"->'citations' IS DISTINCT FROM NEW."citations"
    )
  THEN
    RAISE EXCEPTION 'ARTIFACT_INLINE_IR_ENVELOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind = 'prototype'
    AND NEW."content" IS NOT NULL
    AND (
      jsonb_typeof(NEW."content") IS DISTINCT FROM 'object'
      OR NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prototype.v1'
    )
  THEN
    RAISE EXCEPTION 'ARTIFACT_INLINE_IR_ENVELOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind = 'design_system'
    AND (
      NEW."content_blob_id" IS NOT NULL
      OR jsonb_typeof(NEW."content") IS DISTINCT FROM 'object'
      OR NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.design-system.v1'
    )
  THEN
    RAISE EXCEPTION 'DESIGN_SYSTEM_INLINE_IR_ENVELOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'ready' AND NEW."content_blob_id" IS NOT NULL THEN
    SELECT blob."status", blob."byte_size"
    INTO content_blob_status, content_blob_byte_size
    FROM "blobs" AS blob
    WHERE blob."id" = NEW."content_blob_id"
    FOR SHARE;

    IF content_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR content_blob_byte_size IS NULL
      OR content_blob_byte_size <= 0
    THEN
      RAISE EXCEPTION 'ARTIFACT_READY_CONTENT_BLOB_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'ready'
    AND NEW."knowledge_release_id" IS NOT NULL
  THEN
    SELECT release."status", release."workspace_id"
    INTO knowledge_release_status, knowledge_release_workspace_id
    FROM "knowledge_releases" AS release
    WHERE release."id" = NEW."knowledge_release_id"
    FOR SHARE;

    IF knowledge_release_status NOT IN (
      'ready'::"KnowledgeReleaseStatus",
      'retired'::"KnowledgeReleaseStatus"
    )
      OR (
        knowledge_release_workspace_id IS NOT NULL
        AND knowledge_release_workspace_id IS DISTINCT FROM artifact_workspace_id
      )
    THEN
      RAISE EXCEPTION 'ARTIFACT_READY_KNOWLEDGE_RELEASE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Editing a PRD v2 must be able to publish a v2 result receipt. Prototype
-- edits retain their v1-only invariant.
CREATE OR REPLACE FUNCTION "guard_artifact_version_edit_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind "ArtifactKind";
  artifact_current_version_id TEXT;
  artifact_revision INTEGER;
  base_status "ArtifactVersionStatus";
  base_version INTEGER;
  base_schema_version INTEGER;
  base_citations JSONB;
  base_knowledge_release_id TEXT;
  result_status "ArtifactVersionStatus";
  result_version INTEGER;
  result_schema_version INTEGER;
  result_created_by_run_id TEXT;
  result_citations JSONB;
  result_knowledge_release_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_EDIT_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT
    artifact."kind",
    artifact."current_version_id",
    artifact."revision",
    base."status",
    base."version",
    base."schema_version",
    base."citations",
    base."knowledge_release_id",
    result."status",
    result."version",
    result."schema_version",
    result."created_by_run_id",
    result."citations",
    result."knowledge_release_id"
  INTO
    artifact_kind,
    artifact_current_version_id,
    artifact_revision,
    base_status,
    base_version,
    base_schema_version,
    base_citations,
    base_knowledge_release_id,
    result_status,
    result_version,
    result_schema_version,
    result_created_by_run_id,
    result_citations,
    result_knowledge_release_id
  FROM "artifacts" AS artifact
  JOIN "artifact_versions" AS base
    ON base."id" = NEW."base_artifact_version_id"
    AND base."artifact_id" = artifact."id"
  JOIN "artifact_versions" AS result
    ON result."id" = NEW."result_artifact_version_id"
    AND result."artifact_id" = artifact."id"
  WHERE artifact."id" = NEW."artifact_id";

  IF artifact_kind NOT IN ('prototype'::"ArtifactKind", 'prd'::"ArtifactKind")
    OR artifact_current_version_id IS DISTINCT FROM NEW."result_artifact_version_id"
    OR artifact_revision IS DISTINCT FROM NEW."result_artifact_revision"
    OR base_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR result_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR (
      artifact_kind = 'prototype'::"ArtifactKind"
      AND (
        base_schema_version IS DISTINCT FROM 1
        OR result_schema_version IS DISTINCT FROM 1
      )
    )
    OR (
      artifact_kind = 'prd'::"ArtifactKind"
      AND (
        base_schema_version IS DISTINCT FROM result_schema_version
        OR (
          result_schema_version IS DISTINCT FROM 1
          AND result_schema_version IS DISTINCT FROM 2
        )
      )
    )
    OR result_version <= base_version
    OR result_created_by_run_id IS NOT NULL
    OR result_citations IS DISTINCT FROM base_citations
    OR result_knowledge_release_id IS DISTINCT FROM base_knowledge_release_id
  THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_EDIT_RECEIPT_RESULT_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifact_version_assets" AS base_pin
    WHERE base_pin."artifact_version_id" = NEW."base_artifact_version_id"
      AND NOT EXISTS (
        SELECT 1
        FROM "artifact_version_assets" AS result_pin
        WHERE result_pin."artifact_version_id" = NEW."result_artifact_version_id"
          AND result_pin."asset_id" = base_pin."asset_id"
          AND result_pin."kind" = base_pin."kind"
          AND result_pin."blob_id" = base_pin."blob_id"
          AND result_pin."media_type" = base_pin."media_type"
          AND result_pin."byte_size" = base_pin."byte_size"
          AND result_pin."sha256" = base_pin."sha256"
          AND result_pin."metadata" = base_pin."metadata"
      )
  ) OR EXISTS (
    SELECT 1
    FROM "artifact_version_assets" AS result_pin
    WHERE result_pin."artifact_version_id" = NEW."result_artifact_version_id"
      AND NOT EXISTS (
        SELECT 1
        FROM "artifact_version_assets" AS base_pin
        WHERE base_pin."artifact_version_id" = NEW."base_artifact_version_id"
          AND base_pin."asset_id" = result_pin."asset_id"
          AND base_pin."kind" = result_pin."kind"
          AND base_pin."blob_id" = result_pin."blob_id"
          AND base_pin."media_type" = result_pin."media_type"
          AND base_pin."byte_size" = result_pin."byte_size"
          AND base_pin."sha256" = result_pin."sha256"
          AND base_pin."metadata" = result_pin."metadata"
      )
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_EDIT_RECEIPT_ASSET_INHERITANCE_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- CREATE OR REPLACE preserves ownership and privileges but can replace function
-- configuration. Reapply a fixed path that includes the Prisma target schema so
-- the same migration works for both public and isolated workbench schemas.
DO $$
DECLARE
  application_schema TEXT := current_schema();
  function_name TEXT;
  trusted_search_path TEXT;
BEGIN
  IF application_schema IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_GUARD_SCHEMA_UNRESOLVED';
  END IF;

  trusted_search_path := CASE application_schema
    WHEN 'public' THEN 'pg_catalog, public'
    ELSE format('pg_catalog, %I, public', application_schema)
  END;

  FOREACH function_name IN ARRAY ARRAY[
    'guard_artifact_version_update',
    'guard_artifact_version_edit_receipt'
  ]
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I() SET search_path TO %s',
      application_schema,
      function_name,
      trusted_search_path
    );
  END LOOP;
END;
$$;

COMMIT;
