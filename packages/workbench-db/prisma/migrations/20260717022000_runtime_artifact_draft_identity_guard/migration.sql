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

  IF artifact_kind IN ('prd', 'prototype', 'design_system') AND NEW."schema_version" <> 1 THEN
    RAISE EXCEPTION 'ARTIFACT_SCHEMA_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind = 'prd'
    AND NEW."content" IS NOT NULL
    AND (
      jsonb_typeof(NEW."content") <> 'object'
      OR NEW."content"->>'protocol' <> 'workbench.prd.v1'
      OR NEW."content"->'citations' IS DISTINCT FROM NEW."citations"
    )
  THEN
    RAISE EXCEPTION 'ARTIFACT_INLINE_IR_ENVELOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind = 'prototype'
    AND NEW."content" IS NOT NULL
    AND (
      jsonb_typeof(NEW."content") <> 'object'
      OR NEW."content"->>'protocol' <> 'workbench.prototype.v1'
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
