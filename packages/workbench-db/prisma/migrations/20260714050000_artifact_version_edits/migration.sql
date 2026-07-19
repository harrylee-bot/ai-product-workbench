-- User edits publish a new immutable ArtifactVersion and advance the mutable
-- Artifact pointer. This receipt makes the entire command replayable without
-- copying the already-immutable result document.
CREATE TABLE "artifact_version_edit_receipts" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "base_artifact_version_id" TEXT NOT NULL,
    "result_artifact_version_id" TEXT NOT NULL,
    "expected_artifact_revision" INTEGER NOT NULL,
    "result_artifact_revision" INTEGER NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_version_edit_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "artifact_version_edit_receipts_distinct_versions_check"
      CHECK ("base_artifact_version_id" <> "result_artifact_version_id"),
    CONSTRAINT "artifact_version_edit_receipts_revision_check"
      CHECK (
        "expected_artifact_revision" >= 0
        AND "result_artifact_revision" = "expected_artifact_revision" + 1
      ),
    CONSTRAINT "artifact_version_edit_receipts_idempotency_key_check"
      CHECK (
        length("idempotency_key") BETWEEN 8 AND 128
        AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
      ),
    CONSTRAINT "artifact_version_edit_receipts_request_hash_format_check"
      CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "artifact_version_edit_receipts_artifact_id_idempotency_key_key"
ON "artifact_version_edit_receipts"("artifact_id", "idempotency_key");

CREATE UNIQUE INDEX "artifact_version_edit_receipts_result_artifact_version_id_key"
ON "artifact_version_edit_receipts"("result_artifact_version_id");

CREATE INDEX "artifact_version_edit_receipts_base_artifact_version_id_idx"
ON "artifact_version_edit_receipts"("base_artifact_version_id");

CREATE INDEX "artifact_version_edit_receipts_created_by_id_idx"
ON "artifact_version_edit_receipts"("created_by_id");

ALTER TABLE "artifact_version_edit_receipts"
ADD CONSTRAINT "artifact_version_edit_receipts_artifact_id_fkey"
FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "artifact_version_edit_receipts"
ADD CONSTRAINT "artifact_version_edit_receipts_base_version_fkey"
FOREIGN KEY ("base_artifact_version_id", "artifact_id")
REFERENCES "artifact_versions"("id", "artifact_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "artifact_version_edit_receipts"
ADD CONSTRAINT "artifact_version_edit_receipts_result_version_fkey"
FOREIGN KEY ("result_artifact_version_id", "artifact_id")
REFERENCES "artifact_versions"("id", "artifact_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "artifact_version_edit_receipts"
ADD CONSTRAINT "artifact_version_edit_receipts_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_artifact_version_edit_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind "ArtifactKind";
  artifact_current_version_id TEXT;
  artifact_revision INTEGER;
  base_status "ArtifactVersionStatus";
  base_version INTEGER;
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

  IF artifact_kind IS DISTINCT FROM 'prototype'::"ArtifactKind"
    OR artifact_current_version_id IS DISTINCT FROM NEW."result_artifact_version_id"
    OR artifact_revision IS DISTINCT FROM NEW."result_artifact_revision"
    OR base_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR result_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus"
    OR result_schema_version IS DISTINCT FROM 1
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

CREATE TRIGGER "artifact_version_edit_receipts_guard"
BEFORE INSERT OR UPDATE ON "artifact_version_edit_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_version_edit_receipt"();
