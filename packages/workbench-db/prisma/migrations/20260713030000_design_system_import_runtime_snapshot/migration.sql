-- Design Systems are first-class immutable ArtifactVersions. Cross-Project use
-- creates an independent target version and an immutable audit receipt; Runs
-- pin a fully materialized snapshot and never dereference the source Project.

ALTER TYPE "ArtifactKind" ADD VALUE IF NOT EXISTS 'design_system';

ALTER TABLE "runs"
ADD COLUMN "design_style_snapshot" JSONB,
ADD COLUMN "design_style_snapshot_sha256" TEXT;

ALTER TABLE "runs"
ADD CONSTRAINT "runs_design_style_snapshot_sha256_format_check"
CHECK (
  "design_style_snapshot_sha256" IS NULL
  OR "design_style_snapshot_sha256" ~ '^[0-9a-f]{64}$'
);

CREATE TABLE "design_system_imports" (
  "id" TEXT NOT NULL,
  "target_project_id" TEXT NOT NULL,
  "target_artifact_id" TEXT NOT NULL,
  "target_artifact_version_id" TEXT NOT NULL,
  "source_project_id" TEXT NOT NULL,
  "source_artifact_id" TEXT NOT NULL,
  "source_artifact_version_id" TEXT NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "design_system_imports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "design_system_imports_distinct_projects_check"
    CHECK ("source_project_id" <> "target_project_id"),
  CONSTRAINT "design_system_imports_source_checksum_format_check"
    CHECK ("source_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "design_system_imports_request_hash_format_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "design_system_imports_idempotency_key_check"
    CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$')
);

CREATE TABLE "design_system_creations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "artifact_version_id" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "design_system_creations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "design_system_creations_checksum_format_check"
    CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "design_system_creations_request_hash_format_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "design_system_creations_idempotency_key_check"
    CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$')
);

CREATE UNIQUE INDEX "design_system_creations_project_id_idempotency_key_key"
ON "design_system_creations"("project_id", "idempotency_key");
CREATE UNIQUE INDEX "design_system_creations_artifact_version_id_key"
ON "design_system_creations"("artifact_version_id");
CREATE INDEX "design_system_creations_artifact_id_project_id_idx"
ON "design_system_creations"("artifact_id", "project_id");
CREATE INDEX "design_system_creations_created_by_id_idx"
ON "design_system_creations"("created_by_id");

ALTER TABLE "design_system_creations"
ADD CONSTRAINT "design_system_creations_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "design_system_creations_artifact_id_project_id_fkey"
FOREIGN KEY ("artifact_id", "project_id")
REFERENCES "artifacts"("id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "design_system_creations_version_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "design_system_creations_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "design_system_imports_target_project_id_idempotency_key_key"
ON "design_system_imports"("target_project_id", "idempotency_key");
CREATE UNIQUE INDEX "design_system_imports_target_artifact_version_id_key"
ON "design_system_imports"("target_artifact_version_id");
CREATE INDEX "design_system_imports_target_artifact_id_target_project_id_idx"
ON "design_system_imports"("target_artifact_id", "target_project_id");
CREATE INDEX "design_system_imports_source_project_id_created_at_idx"
ON "design_system_imports"("source_project_id", "created_at");
CREATE INDEX "design_system_imports_source_artifact_version_id_idx"
ON "design_system_imports"("source_artifact_version_id");
CREATE INDEX "design_system_imports_created_by_id_idx"
ON "design_system_imports"("created_by_id");

ALTER TABLE "design_system_imports"
ADD CONSTRAINT "design_system_imports_target_project_id_fkey"
FOREIGN KEY ("target_project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "design_system_imports_target_artifact_id_target_project_id_fkey"
FOREIGN KEY ("target_artifact_id", "target_project_id")
REFERENCES "artifacts"("id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "design_system_imports_target_version_fkey"
FOREIGN KEY ("target_artifact_version_id", "target_artifact_id", "target_project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "design_system_imports_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_design_system_import_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_workspace_id TEXT;
  target_kind TEXT;
  target_schema_version INTEGER;
  target_status "ArtifactVersionStatus";
  target_checksum TEXT;
  target_content JSONB;
  target_current_version_id TEXT;
  source_workspace_id TEXT;
  source_kind TEXT;
  source_schema_version INTEGER;
  source_status "ArtifactVersionStatus";
  source_checksum TEXT;
  source_content JSONB;
BEGIN
  SELECT
    project."workspace_id",
    artifact."kind"::TEXT,
    artifact."current_version_id",
    version."schema_version",
    version."status",
    version."checksum",
    version."content"
  INTO
    target_workspace_id,
    target_kind,
    target_current_version_id,
    target_schema_version,
    target_status,
    target_checksum,
    target_content
  FROM "projects" AS project
  JOIN "artifacts" AS artifact
    ON artifact."id" = NEW."target_artifact_id"
   AND artifact."project_id" = project."id"
  JOIN "artifact_versions" AS version
    ON version."id" = NEW."target_artifact_version_id"
   AND version."artifact_id" = artifact."id"
   AND version."project_id" = project."id"
  WHERE project."id" = NEW."target_project_id"
    AND project."status" = 'active';

  SELECT
    project."workspace_id",
    artifact."kind"::TEXT,
    version."schema_version",
    version."status",
    version."checksum",
    version."content"
  INTO
    source_workspace_id,
    source_kind,
    source_schema_version,
    source_status,
    source_checksum,
    source_content
  FROM "projects" AS project
  JOIN "artifacts" AS artifact
    ON artifact."id" = NEW."source_artifact_id"
   AND artifact."project_id" = project."id"
  JOIN "artifact_versions" AS version
    ON version."id" = NEW."source_artifact_version_id"
   AND version."artifact_id" = artifact."id"
   AND version."project_id" = project."id"
  WHERE project."id" = NEW."source_project_id"
    AND project."status" = 'active'
  FOR SHARE OF project, artifact, version;

  IF target_workspace_id IS NULL
    OR source_workspace_id IS NULL
    OR target_workspace_id IS DISTINCT FROM source_workspace_id
    OR target_kind IS DISTINCT FROM 'design_system'
    OR source_kind IS DISTINCT FROM 'design_system'
    OR target_schema_version IS DISTINCT FROM 1
    OR source_schema_version IS DISTINCT FROM 1
    OR target_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR source_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR target_current_version_id IS DISTINCT FROM NEW."target_artifact_version_id"
    OR source_checksum IS DISTINCT FROM NEW."source_checksum"
    OR target_checksum IS DISTINCT FROM NEW."source_checksum"
    OR jsonb_typeof(target_content) IS DISTINCT FROM 'object'
    OR jsonb_typeof(source_content) IS DISTINCT FROM 'object'
    OR target_content->>'protocol' IS DISTINCT FROM 'workbench.design-system.v1'
    OR source_content->>'protocol' IS DISTINCT FROM 'workbench.design-system.v1'
  THEN
    RAISE EXCEPTION 'DESIGN_SYSTEM_IMPORT_SNAPSHOT_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "project_members"
    WHERE "project_id" = NEW."target_project_id"
      AND "principal_id" = NEW."created_by_id"
      AND "role" IN ('owner', 'editor')
  ) OR NOT EXISTS (
    SELECT 1 FROM "project_members"
    WHERE "project_id" = NEW."source_project_id"
      AND "principal_id" = NEW."created_by_id"
  ) THEN
    RAISE EXCEPTION 'DESIGN_SYSTEM_IMPORT_ACTOR_NOT_AUTHORIZED' USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "design_system_imports_insert_guard"
BEFORE INSERT ON "design_system_imports"
FOR EACH ROW EXECUTE FUNCTION "guard_design_system_import_insert"();

CREATE FUNCTION "guard_design_system_import_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'DESIGN_SYSTEM_IMPORT_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "design_system_imports_immutable_guard"
BEFORE UPDATE OR DELETE ON "design_system_imports"
FOR EACH ROW EXECUTE FUNCTION "guard_design_system_import_mutation"();

CREATE FUNCTION "guard_design_system_creation_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind TEXT;
  artifact_current_version_id TEXT;
  version_schema INTEGER;
  version_status "ArtifactVersionStatus";
  version_checksum TEXT;
  version_content JSONB;
BEGIN
  SELECT
    artifact."kind"::TEXT,
    artifact."current_version_id",
    version."schema_version",
    version."status",
    version."checksum",
    version."content"
  INTO
    artifact_kind,
    artifact_current_version_id,
    version_schema,
    version_status,
    version_checksum,
    version_content
  FROM "projects" AS project
  JOIN "artifacts" AS artifact
    ON artifact."id" = NEW."artifact_id"
   AND artifact."project_id" = project."id"
  JOIN "artifact_versions" AS version
    ON version."id" = NEW."artifact_version_id"
   AND version."artifact_id" = artifact."id"
   AND version."project_id" = project."id"
  WHERE project."id" = NEW."project_id"
    AND project."status" = 'active';

  IF artifact_kind IS DISTINCT FROM 'design_system'
    OR artifact_current_version_id IS DISTINCT FROM NEW."artifact_version_id"
    OR version_schema IS DISTINCT FROM 1
    OR version_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR version_checksum IS DISTINCT FROM NEW."checksum"
    OR jsonb_typeof(version_content) IS DISTINCT FROM 'object'
    OR version_content->>'protocol' IS DISTINCT FROM 'workbench.design-system.v1'
  THEN
    RAISE EXCEPTION 'DESIGN_SYSTEM_CREATION_SNAPSHOT_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "project_members"
    WHERE "project_id" = NEW."project_id"
      AND "principal_id" = NEW."created_by_id"
      AND "role" IN ('owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'DESIGN_SYSTEM_CREATION_ACTOR_NOT_AUTHORIZED' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "design_system_creations_insert_guard"
BEFORE INSERT ON "design_system_creations"
FOR EACH ROW EXECUTE FUNCTION "guard_design_system_creation_insert"();

CREATE FUNCTION "guard_design_system_creation_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'DESIGN_SYSTEM_CREATION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "design_system_creations_immutable_guard"
BEFORE UPDATE OR DELETE ON "design_system_creations"
FOR EACH ROW EXECUTE FUNCTION "guard_design_system_creation_mutation"();

CREATE OR REPLACE FUNCTION "guard_ready_artifact_version_asset_completeness"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind TEXT;
  invalid_manifest_message TEXT;
  pin_mismatch_message TEXT;
BEGIN
  IF NEW."status" <> 'ready' THEN
    RETURN NEW;
  END IF;

  SELECT artifact."kind"::TEXT
  INTO artifact_kind
  FROM "artifacts" AS artifact
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id";

  IF artifact_kind NOT IN ('prototype', 'design_system') THEN
    IF EXISTS (
      SELECT 1 FROM "artifact_version_assets" AS pin
      WHERE pin."artifact_version_id" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'ARTIFACT_VERSION_ASSET_OWNER_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  invalid_manifest_message := CASE artifact_kind
    WHEN 'prototype' THEN 'PROTOTYPE_ASSET_MANIFEST_INVALID'
    ELSE 'DESIGN_SYSTEM_ASSET_MANIFEST_INVALID'
  END;
  pin_mismatch_message := CASE artifact_kind
    WHEN 'prototype' THEN 'PROTOTYPE_ASSET_PIN_MISMATCH'
    ELSE 'DESIGN_SYSTEM_ASSET_PIN_MISMATCH'
  END;

  IF NEW."content" IS NULL
    OR jsonb_typeof(NEW."content"->'assets') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION '%', invalid_manifest_message USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."content"->'assets') AS asset
    WHERE CASE
      WHEN jsonb_typeof(asset) <> 'object' THEN artifact_kind = 'design_system'
      WHEN COALESCE(asset->>'kind', '') NOT IN ('image', 'font') THEN artifact_kind = 'design_system'
      WHEN COALESCE(asset->>'id', '') = ''
        OR COALESCE(asset->>'blobId', '') = ''
        OR COALESCE(asset->>'mediaType', '') = ''
        OR COALESCE(asset->>'sha256', '') !~ '^[0-9a-f]{64}$'
        OR COALESCE(asset->>'byteSize', '') !~ '^[1-9][0-9]*$'
      THEN TRUE
      ELSE NOT EXISTS (
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
    END
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
    RAISE EXCEPTION '%', pin_mismatch_message USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

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

ALTER TABLE "runs" DROP CONSTRAINT "runs_typed_options_check";
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
      AND "design_style_snapshot" IS NULL
      AND "design_style_snapshot_sha256" IS NULL
    WHEN 'preset' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'presetId']) = '{}'::jsonb
      AND jsonb_extract_path_text("request", 'designStyle', 'presetId') ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
      AND "design_style_artifact_version_id" IS NULL
      AND "design_style_snapshot" IS NULL
      AND "design_style_snapshot_sha256" IS NULL
    WHEN 'artifact' THEN
      (jsonb_extract_path("request", 'designStyle') - ARRAY['kind', 'artifactVersionId']) = '{}'::jsonb
      AND length(jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId')) > 0
      AND jsonb_extract_path_text("request", 'designStyle', 'artifactVersionId') = "design_style_artifact_version_id"
      AND jsonb_typeof("design_style_snapshot") = 'object'
      AND "design_style_snapshot_sha256" IS NOT NULL
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
  design_style_artifact_id TEXT;
  design_style_kind TEXT;
  design_style_schema_version INTEGER;
  design_style_checksum TEXT;
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
