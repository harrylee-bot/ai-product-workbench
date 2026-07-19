CREATE TABLE "artifact_version_assets" (
  "artifact_version_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "blob_id" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "byte_size" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "artifact_version_assets_pkey" PRIMARY KEY ("artifact_version_id", "asset_id")
);

CREATE INDEX "artifact_version_assets_artifact_id_project_id_idx"
ON "artifact_version_assets"("artifact_id", "project_id");
CREATE INDEX "artifact_version_assets_blob_id_idx"
ON "artifact_version_assets"("blob_id");

ALTER TABLE "artifact_version_assets"
ADD CONSTRAINT "artifact_version_assets_version_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_version_assets_blob_fkey"
FOREIGN KEY ("blob_id", "sha256", "byte_size", "media_type")
REFERENCES "blobs"("id", "sha256", "byte_size", "media_type")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_version_assets_kind_check"
CHECK ("kind" IN ('image', 'font')),
ADD CONSTRAINT "artifact_version_assets_asset_id_nonempty_check"
CHECK (length("asset_id") > 0),
ADD CONSTRAINT "artifact_version_assets_media_type_nonempty_check"
CHECK (length("media_type") > 0),
ADD CONSTRAINT "artifact_version_assets_byte_size_positive_check"
CHECK ("byte_size" > 0 AND "byte_size" <= 9007199254740991),
ADD CONSTRAINT "artifact_version_assets_sha256_format_check"
CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "artifact_version_assets_metadata_object_check"
CHECK (jsonb_typeof("metadata") = 'object');

CREATE FUNCTION "guard_artifact_version_asset_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_version_id TEXT;
  owner_status "ArtifactVersionStatus";
  referenced_blob_status "BlobStatus";
  referenced_blob_deleted_at TIMESTAMP(3);
BEGIN
  owner_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."artifact_version_id" ELSE NEW."artifact_version_id" END;

  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_ASSET_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT version."status"
  INTO owner_status
  FROM "artifact_versions" AS version
  WHERE version."id" = owner_version_id
  FOR SHARE;

  IF owner_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF owner_status <> 'staging' THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_ASSET_OWNER_NOT_STAGING' USING ERRCODE = '23514';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT blob."status", blob."deleted_at"
    INTO referenced_blob_status, referenced_blob_deleted_at
    FROM "blobs" AS blob
    WHERE blob."id" = NEW."blob_id"
    FOR SHARE;

    IF referenced_blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR referenced_blob_deleted_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'ARTIFACT_VERSION_ASSET_BLOB_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "artifact_version_assets_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "artifact_version_assets"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_version_asset_mutation"();

CREATE FUNCTION "guard_ready_artifact_version_asset_completeness"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind "ArtifactKind";
BEGIN
  IF NEW."status" <> 'ready' THEN
    RETURN NEW;
  END IF;

  SELECT artifact."kind"
  INTO artifact_kind
  FROM "artifacts" AS artifact
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id";

  IF artifact_kind <> 'prototype' THEN
    IF EXISTS (
      SELECT 1 FROM "artifact_version_assets" AS pin
      WHERE pin."artifact_version_id" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'ARTIFACT_VERSION_ASSET_OWNER_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."content" IS NULL
    OR jsonb_typeof(NEW."content"->'assets') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'PROTOTYPE_ASSET_MANIFEST_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."content"->'assets') AS asset
    WHERE asset->>'kind' IN ('image', 'font')
      AND (
        jsonb_typeof(asset) <> 'object'
        OR COALESCE(asset->>'id', '') = ''
        OR COALESCE(asset->>'blobId', '') = ''
        OR COALESCE(asset->>'mediaType', '') = ''
        OR COALESCE(asset->>'sha256', '') !~ '^[0-9a-f]{64}$'
        OR COALESCE(asset->>'byteSize', '') !~ '^[1-9][0-9]*$'
        OR NOT EXISTS (
          SELECT 1
          FROM "artifact_version_assets" AS pin
          WHERE pin."artifact_version_id" = NEW."id"
            AND pin."artifact_id" = NEW."artifact_id"
            AND pin."project_id" = NEW."project_id"
            AND pin."asset_id" = asset->>'id'
            AND pin."kind" = asset->>'kind'
            AND pin."blob_id" = asset->>'blobId'
            AND pin."media_type" = asset->>'mediaType'
            AND pin."sha256" = asset->>'sha256'
            AND pin."byte_size" = (asset->>'byteSize')::BIGINT
            AND pin."metadata" = asset
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM "artifact_version_assets" AS pin
    WHERE pin."artifact_version_id" = NEW."id"
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW."content"->'assets') AS asset
        WHERE asset->>'kind' IN ('image', 'font')
          AND asset->>'id' = pin."asset_id"
          AND asset = pin."metadata"
      )
  ) THEN
    RAISE EXCEPTION 'PROTOTYPE_ASSET_PIN_MISMATCH' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "artifact_versions_asset_completeness_guard"
BEFORE INSERT OR UPDATE ON "artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_ready_artifact_version_asset_completeness"();

-- PrototypeDocument keeps citations in the immutable ArtifactVersion envelope,
-- unlike PrdDocument, whose citations are also embedded in the document. Keep
-- the protocol check for both kinds without requiring a non-existent field.
CREATE OR REPLACE FUNCTION "guard_artifact_version_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind "ArtifactKind";
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
      OR NEW."knowledge_release_id" IS DISTINCT FROM OLD."knowledge_release_id"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    )
  THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('ready', 'rejected') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ARTIFACT_TERMINAL_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT artifact."kind", project."workspace_id"
  INTO artifact_kind, artifact_workspace_id
  FROM "artifacts" AS artifact
  JOIN "projects" AS project ON project."id" = artifact."project_id"
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id";

  IF artifact_kind IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_VERSION_OWNER_INVALID' USING ERRCODE = '23503';
  END IF;

  IF artifact_kind IN ('prd', 'prototype') AND NEW."schema_version" <> 1 THEN
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

  IF NEW."status" = 'ready' AND NEW."knowledge_release_id" IS NOT NULL THEN
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
      SELECT 1
      FROM "artifact_versions" AS version
      WHERE version."content_blob_id" = OLD."id"
        AND version."status" = 'ready'
    )
    OR EXISTS (
      SELECT 1
      FROM "artifact_version_assets" AS pin
      JOIN "artifact_versions" AS version ON version."id" = pin."artifact_version_id"
      WHERE pin."blob_id" = OLD."id"
        AND version."status" = 'ready'
    )
  ) THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_READY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifact_versions" AS version
    WHERE version."content_blob_id" = OLD."id"
  ) OR EXISTS (
    SELECT 1
    FROM "artifact_version_assets" AS pin
    WHERE pin."blob_id" = OLD."id"
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

  RETURN NEW;
END;
$$;
