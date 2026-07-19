-- Project-level Artifact creation is an idempotent command. The receipt pins
-- the verified source File/Blob and the exact first immutable ArtifactVersion.
CREATE TABLE "artifact_creation_receipts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "artifact_version_id" TEXT NOT NULL,
    "source_file_asset_id" TEXT NOT NULL,
    "source_blob_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_creation_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_creation_receipts_idempotency_key_check"
      CHECK (
        length("idempotency_key") BETWEEN 8 AND 128
        AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
      ),
    CONSTRAINT "artifact_creation_receipts_request_hash_format_check"
      CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "artifact_creation_receipts_project_id_idempotency_key_key"
ON "artifact_creation_receipts"("project_id", "idempotency_key");

CREATE UNIQUE INDEX "artifact_creation_receipts_artifact_id_key"
ON "artifact_creation_receipts"("artifact_id");

CREATE UNIQUE INDEX "artifact_creation_receipts_artifact_version_id_key"
ON "artifact_creation_receipts"("artifact_version_id");

CREATE UNIQUE INDEX "artifact_creation_receipts_artifact_id_project_id_key"
ON "artifact_creation_receipts"("artifact_id", "project_id");

CREATE UNIQUE INDEX "artifact_creation_receipts_version_artifact_project_key"
ON "artifact_creation_receipts"("artifact_version_id", "artifact_id", "project_id");

CREATE INDEX "artifact_creation_receipts_source_file_idx"
ON "artifact_creation_receipts"("source_file_asset_id", "project_id", "source_blob_id");

CREATE INDEX "artifact_creation_receipts_source_blob_id_idx"
ON "artifact_creation_receipts"("source_blob_id");

CREATE INDEX "artifact_creation_receipts_created_by_id_idx"
ON "artifact_creation_receipts"("created_by_id");

ALTER TABLE "artifact_creation_receipts"
ADD CONSTRAINT "artifact_creation_receipts_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_creation_receipts_artifact_id_project_id_fkey"
FOREIGN KEY ("artifact_id", "project_id")
REFERENCES "artifacts"("id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_creation_receipts_version_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_creation_receipts_source_file_fkey"
FOREIGN KEY ("source_file_asset_id", "project_id", "source_blob_id")
REFERENCES "file_assets"("id", "project_id", "blob_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_creation_receipts_source_blob_id_fkey"
FOREIGN KEY ("source_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_creation_receipts_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_artifact_creation_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind "ArtifactKind";
  artifact_current_version_id TEXT;
  artifact_revision INTEGER;
  version_number INTEGER;
  version_schema_version INTEGER;
  version_status "ArtifactVersionStatus";
  version_content JSONB;
  version_content_blob_id TEXT;
  version_checksum TEXT;
  version_citations JSONB;
  version_created_by_run_id TEXT;
  version_knowledge_release_id TEXT;
  file_status "FileStatus";
  file_deleted_at TIMESTAMP(3);
  file_detected_media_type TEXT;
  blob_status "BlobStatus";
  blob_deleted_at TIMESTAMP(3);
  blob_media_type TEXT;
  blob_sha256 TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ARTIFACT_CREATION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT
    artifact."kind",
    artifact."current_version_id",
    artifact."revision",
    version."version",
    version."schema_version",
    version."status",
    version."content",
    version."content_blob_id",
    version."checksum",
    version."citations",
    version."created_by_run_id",
    version."knowledge_release_id",
    file."status",
    file."deleted_at",
    file."detected_media_type",
    blob."status",
    blob."deleted_at",
    blob."media_type",
    blob."sha256"
  INTO
    artifact_kind,
    artifact_current_version_id,
    artifact_revision,
    version_number,
    version_schema_version,
    version_status,
    version_content,
    version_content_blob_id,
    version_checksum,
    version_citations,
    version_created_by_run_id,
    version_knowledge_release_id,
    file_status,
    file_deleted_at,
    file_detected_media_type,
    blob_status,
    blob_deleted_at,
    blob_media_type,
    blob_sha256
  FROM "artifacts" AS artifact
  JOIN "artifact_versions" AS version
    ON version."id" = NEW."artifact_version_id"
    AND version."artifact_id" = artifact."id"
    AND version."project_id" = artifact."project_id"
  JOIN "file_assets" AS file
    ON file."id" = NEW."source_file_asset_id"
    AND file."project_id" = artifact."project_id"
    AND file."blob_id" = NEW."source_blob_id"
  JOIN "blobs" AS blob ON blob."id" = NEW."source_blob_id"
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id"
  FOR SHARE OF artifact, version, file, blob;

  IF artifact_kind IS DISTINCT FROM 'image'::"ArtifactKind"
    OR artifact_current_version_id IS DISTINCT FROM NEW."artifact_version_id"
    OR artifact_revision IS DISTINCT FROM 1
    OR version_number IS DISTINCT FROM 1
    OR version_schema_version IS DISTINCT FROM 1
    OR version_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR version_content IS NOT NULL
    OR version_content_blob_id IS DISTINCT FROM NEW."source_blob_id"
    OR version_checksum IS DISTINCT FROM blob_sha256
    OR version_citations IS DISTINCT FROM '[]'::JSONB
    OR version_created_by_run_id IS NOT NULL
    OR version_knowledge_release_id IS NOT NULL
    OR file_status IS DISTINCT FROM 'ready'::"FileStatus"
    OR file_deleted_at IS NOT NULL
    OR file_detected_media_type IS DISTINCT FROM blob_media_type
    OR blob_status IS DISTINCT FROM 'ready'::"BlobStatus"
    OR blob_deleted_at IS NOT NULL
    OR blob_media_type NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  THEN
    RAISE EXCEPTION 'ARTIFACT_CREATION_RECEIPT_RESULT_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "artifact_creation_receipts_guard"
BEFORE INSERT OR UPDATE ON "artifact_creation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_creation_receipt"();
