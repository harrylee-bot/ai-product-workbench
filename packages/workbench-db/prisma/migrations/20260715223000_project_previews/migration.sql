BEGIN;

CREATE TYPE "ExportJobPurpose" AS ENUM ('export', 'preview');

ALTER TABLE "export_jobs"
ADD COLUMN "purpose" "ExportJobPurpose" NOT NULL DEFAULT 'export',
ALTER COLUMN "release_id" DROP NOT NULL,
ADD CONSTRAINT "export_jobs_purpose_release_check"
CHECK (
  ("purpose" = 'export' AND "release_id" IS NOT NULL)
  OR ("purpose" = 'preview' AND "release_id" IS NULL)
);

CREATE OR REPLACE FUNCTION "guard_export_job_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  release_status "ProjectReleaseStatus";
  output_status "BlobStatus";
  output_size BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'queued' OR NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'EXPORT_JOB_MUST_START_QUEUED' USING ERRCODE = '23514';
    END IF;
    IF NEW."purpose" = 'export' THEN
      SELECT release."status"
      INTO release_status
      FROM "project_releases" AS release
      WHERE release."id" = NEW."release_id"
      FOR SHARE;
      IF release_status IS DISTINCT FROM 'ready'::"ProjectReleaseStatus" THEN
        RAISE EXCEPTION 'EXPORT_JOB_RELEASE_NOT_READY' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."format" <> 'html' THEN
      RAISE EXCEPTION 'PREVIEW_JOB_MUST_BE_HTML' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
      RAISE EXCEPTION 'EXPORT_JOB_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."format" IS DISTINCT FROM OLD."format"
    OR NEW."selection_kind" IS DISTINCT FROM OLD."selection_kind"
    OR NEW."selection_artifact_id" IS DISTINCT FROM OLD."selection_artifact_id"
    OR NEW."selection_artifact_version_id" IS DISTINCT FROM OLD."selection_artifact_version_id"
    OR NEW."options" IS DISTINCT FROM OLD."options"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'EXPORT_JOB_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'EXPORT_JOB_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'EXPORT_JOB_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" = 'queued' AND NEW."status" IN ('queued', 'running', 'failed', 'cancelled'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('running', 'succeeded', 'failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'EXPORT_JOB_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'succeeded' THEN
    SELECT blob."status", blob."byte_size"
    INTO output_status, output_size
    FROM "blobs" AS blob
    WHERE blob."id" = NEW."output_blob_id"
    FOR SHARE;
    IF output_status IS DISTINCT FROM 'ready'::"BlobStatus"
      OR output_size IS NULL
      OR output_size <= 0
    THEN
      RAISE EXCEPTION 'EXPORT_JOB_OUTPUT_BLOB_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TABLE "project_previews" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "board_id" TEXT NOT NULL,
  "board_revision" INTEGER NOT NULL,
  "board_snapshot" JSONB NOT NULL,
  "board_checksum" CHAR(64) NOT NULL,
  "manifest" JSONB NOT NULL,
  "manifest_sha256" CHAR(64) NOT NULL,
  "export_job_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_previews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_previews_request_hash_format_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_previews_board_revision_check"
    CHECK ("board_revision" >= 0),
  CONSTRAINT "project_previews_board_snapshot_check"
    CHECK (jsonb_typeof("board_snapshot") = 'object'),
  CONSTRAINT "project_previews_board_checksum_format_check"
    CHECK ("board_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_previews_manifest_check"
    CHECK (jsonb_typeof("manifest") = 'object'),
  CONSTRAINT "project_previews_manifest_sha256_format_check"
    CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_previews_idempotency_key_check"
    CHECK (length("idempotency_key") BETWEEN 8 AND 200),
  CONSTRAINT "project_previews_expiry_check"
    CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "project_previews_export_job_id_key"
ON "project_previews"("export_job_id");
CREATE UNIQUE INDEX "project_previews_id_project_id_key"
ON "project_previews"("id", "project_id");
CREATE UNIQUE INDEX "project_previews_project_id_idempotency_key_key"
ON "project_previews"("project_id", "idempotency_key");
CREATE INDEX "project_previews_project_id_created_at_idx"
ON "project_previews"("project_id", "created_at");
CREATE INDEX "project_previews_expires_at_idx"
ON "project_previews"("expires_at");
CREATE INDEX "project_previews_created_by_id_idx"
ON "project_previews"("created_by_id");

CREATE TABLE "project_preview_artifact_versions" (
  "preview_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "artifact_version_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "kind" "ArtifactKind" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_preview_artifact_versions_pkey" PRIMARY KEY ("preview_id", "position"),
  CONSTRAINT "project_preview_artifact_versions_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "project_preview_artifact_versions_preview_artifact_key"
ON "project_preview_artifact_versions"("preview_id", "artifact_id");
CREATE UNIQUE INDEX "project_preview_artifact_versions_preview_version_key"
ON "project_preview_artifact_versions"("preview_id", "artifact_version_id");
CREATE INDEX "project_preview_artifact_versions_project_id_idx"
ON "project_preview_artifact_versions"("project_id");
CREATE INDEX "project_preview_artifact_versions_artifact_version_id_idx"
ON "project_preview_artifact_versions"("artifact_version_id");

ALTER TABLE "project_previews"
ADD CONSTRAINT "project_previews_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "project_previews_board_id_project_id_fkey"
FOREIGN KEY ("board_id", "project_id") REFERENCES "boards"("id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_previews_export_job_id_fkey"
FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "project_previews_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "project_preview_artifact_versions"
ADD CONSTRAINT "project_preview_artifact_versions_preview_id_project_id_fkey"
FOREIGN KEY ("preview_id", "project_id") REFERENCES "project_previews"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "project_preview_artifact_versions_artifact_version_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A Preview is an append-only snapshot receipt. The worker may advance only
-- its private ExportJob; the pinned Board, manifest, and ArtifactVersion set
-- must remain byte-for-byte stable after creation.
CREATE FUNCTION "guard_project_preview_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  export_purpose "ExportJobPurpose";
  export_format "ExportFormat";
  export_created_by_id TEXT;
  export_idempotency_key TEXT;
  export_request_hash CHAR(64);
  export_selection_kind "ExportSelectionKind";
  export_selection_artifact_id TEXT;
  export_selection_artifact_version_id TEXT;
  export_selection_node_ids TEXT[];
  current_board_revision INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT
    job."purpose",
    job."format",
    job."created_by_id",
    job."idempotency_key",
    job."request_hash",
    job."selection_kind",
    job."selection_artifact_id",
    job."selection_artifact_version_id",
    job."selection_node_ids"
  INTO
    export_purpose,
    export_format,
    export_created_by_id,
    export_idempotency_key,
    export_request_hash,
    export_selection_kind,
    export_selection_artifact_id,
    export_selection_artifact_version_id,
    export_selection_node_ids
  FROM "export_jobs" AS job
  WHERE job."id" = NEW."export_job_id"
  FOR SHARE;

  IF export_purpose IS DISTINCT FROM 'preview'::"ExportJobPurpose"
    OR export_format IS DISTINCT FROM 'html'::"ExportFormat"
    OR export_created_by_id IS DISTINCT FROM NEW."created_by_id"
    OR export_idempotency_key IS DISTINCT FROM 'preview:' || NEW."idempotency_key"
    OR export_request_hash IS DISTINCT FROM NEW."request_hash"
  THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_EXPORT_JOB_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "projects" AS project
    JOIN "project_members" AS member
      ON member."project_id" = project."id"
      AND member."principal_id" = NEW."created_by_id"
    JOIN "principals" AS principal
      ON principal."id" = member."principal_id"
    WHERE project."id" = NEW."project_id"
      AND project."status" = 'active'::"ProjectStatus"
      AND principal."status" = 'active'::"PrincipalStatus"
    FOR SHARE OF project, member, principal
  ) THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_CREATOR_NOT_AUTHORIZED' USING ERRCODE = '23514';
  END IF;

  SELECT board."revision"
  INTO current_board_revision
  FROM "boards" AS board
  WHERE board."id" = NEW."board_id"
    AND board."project_id" = NEW."project_id"
  FOR SHARE;

  IF current_board_revision IS DISTINCT FROM NEW."board_revision" THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_BOARD_REVISION_STALE' USING ERRCODE = '23514';
  END IF;

  IF NEW."board_snapshot" ->> 'id' IS DISTINCT FROM NEW."board_id"
    OR NEW."board_snapshot" ->> 'projectId' IS DISTINCT FROM NEW."project_id"
    OR NEW."board_snapshot" ->> 'revision' IS DISTINCT FROM NEW."board_revision"::TEXT
    OR NEW."manifest" ->> 'protocol' IS DISTINCT FROM 'workbench.project-release.v1'
    OR NEW."manifest" ->> 'projectId' IS DISTINCT FROM NEW."project_id"
    OR NEW."manifest" ->> 'releaseVersion' IS DISTINCT FROM '1'
    OR NEW."manifest" -> 'board' ->> 'id' IS DISTINCT FROM NEW."board_id"
    OR NEW."manifest" -> 'board' ->> 'revision' IS DISTINCT FROM NEW."board_revision"::TEXT
    OR NEW."manifest" -> 'board' ->> 'checksum' IS DISTINCT FROM NEW."board_checksum"
    OR jsonb_typeof(NEW."manifest" -> 'artifacts') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
  END IF;

  IF export_selection_kind = 'artifact'::"ExportSelectionKind" AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."manifest" -> 'artifacts') AS pin
    WHERE pin ->> 'artifactId' = export_selection_artifact_id
      AND pin ->> 'artifactVersionId' = export_selection_artifact_version_id
  ) THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_SELECTION_NOT_PINNED' USING ERRCODE = '23514';
  END IF;

  IF export_selection_kind = 'board_nodes'::"ExportSelectionKind" AND EXISTS (
    SELECT 1
    FROM unnest(export_selection_node_ids) AS selected(node_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW."board_snapshot" -> 'nodes') AS node
      WHERE node ->> 'id' = selected.node_id
    )
  ) THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_SELECTION_NOT_PINNED' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_previews_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "project_previews"
FOR EACH ROW EXECUTE FUNCTION "guard_project_preview_mutation"();

CREATE FUNCTION "guard_project_preview_artifact_version_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  manifest_pin JSONB;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_ARTIFACT_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT preview."manifest" -> 'artifacts' -> NEW."position"
  INTO manifest_pin
  FROM "project_previews" AS preview
  WHERE preview."id" = NEW."preview_id"
    AND preview."project_id" = NEW."project_id"
  FOR SHARE;

  IF manifest_pin IS NULL
    OR manifest_pin ->> 'position' IS DISTINCT FROM NEW."position"::TEXT
    OR manifest_pin ->> 'artifactId' IS DISTINCT FROM NEW."artifact_id"
    OR manifest_pin ->> 'artifactVersionId' IS DISTINCT FROM NEW."artifact_version_id"
    OR manifest_pin ->> 'title' IS DISTINCT FROM NEW."title"
    OR manifest_pin ->> 'kind' IS DISTINCT FROM NEW."kind"::TEXT
  THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_ARTIFACT_VERSION_MANIFEST_MISMATCH' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_preview_artifact_versions_immutable_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "project_preview_artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_project_preview_artifact_version_mutation"();

CREATE FUNCTION "guard_project_preview_complete_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_pin_count INTEGER;
  actual_pin_count INTEGER;
BEGIN
  expected_pin_count := jsonb_array_length(NEW."manifest" -> 'artifacts');
  SELECT count(*)::INTEGER
  INTO actual_pin_count
  FROM "project_preview_artifact_versions"
  WHERE "preview_id" = NEW."id";

  IF actual_pin_count IS DISTINCT FROM expected_pin_count THEN
    RAISE EXCEPTION 'PROJECT_PREVIEW_ARTIFACT_VERSION_SET_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "project_previews_complete_snapshot_guard"
AFTER INSERT ON "project_previews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_project_preview_complete_snapshot"();

-- Every private Preview job must be owned by exactly one ProjectPreview
-- receipt before its creating transaction commits. Public Export jobs keep
-- their existing ProjectRelease source and never satisfy this trigger branch.
CREATE FUNCTION "guard_preview_export_job_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."purpose" = 'preview'::"ExportJobPurpose" AND NOT EXISTS (
    SELECT 1
    FROM "project_previews" AS preview
    WHERE preview."export_job_id" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'PREVIEW_EXPORT_JOB_RECEIPT_MISSING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "preview_export_jobs_receipt_guard"
AFTER INSERT ON "export_jobs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_preview_export_job_receipt"();

COMMIT;
