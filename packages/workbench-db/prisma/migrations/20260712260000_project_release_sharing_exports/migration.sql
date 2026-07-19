-- Shares, previews, remix, and exports consume immutable ProjectRelease rows.
-- Floating legacy rows cannot be migrated without inventing a historical
-- snapshot, so this greenfield migration fails instead of creating a shim.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "share_grants") THEN
    RAISE EXCEPTION 'MIGRATION_FLOATING_SHARE_GRANTS_NOT_SUPPORTED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "export_jobs") THEN
    RAISE EXCEPTION 'MIGRATION_FLOATING_EXPORT_JOBS_NOT_SUPPORTED' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TYPE "ProjectReleaseStatus" AS ENUM ('building', 'ready', 'failed');
CREATE TYPE "ExportFormat" AS ENUM ('html', 'react', 'figma', 'mcp');
CREATE TYPE "ExportSelectionKind" AS ENUM ('release', 'board', 'artifact');

CREATE TABLE "project_releases" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "ProjectReleaseStatus" NOT NULL DEFAULT 'building',
  "created_by_id" TEXT NOT NULL,
  "board_id" TEXT NOT NULL,
  "board_revision" INTEGER NOT NULL,
  "board_snapshot" JSONB NOT NULL,
  "board_checksum" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "manifest_sha256" TEXT NOT NULL,
  "failure_code" TEXT,
  "failure_detail" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "release_artifact_versions" (
  "release_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "artifact_version_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "release_artifact_versions_pkey" PRIMARY KEY ("release_id", "position")
);

DROP INDEX "share_grants_project_id_status_idx";

ALTER TABLE "share_grants"
DROP CONSTRAINT "share_grants_project_id_fkey",
ADD COLUMN "release_id" TEXT NOT NULL,
DROP COLUMN "project_id";

DROP INDEX "export_jobs_project_id_created_at_idx";
DROP INDEX "export_jobs_artifact_version_id_idx";

ALTER TABLE "export_jobs"
DROP CONSTRAINT "export_jobs_project_id_fkey",
DROP CONSTRAINT "export_jobs_artifact_version_id_project_id_fkey",
ADD COLUMN "release_id" TEXT NOT NULL,
ADD COLUMN "created_by_id" TEXT NOT NULL,
ADD COLUMN "idempotency_key" TEXT NOT NULL,
ADD COLUMN "request_hash" TEXT NOT NULL,
ADD COLUMN "selection_kind" "ExportSelectionKind" NOT NULL,
ADD COLUMN "selection_artifact_id" TEXT,
ADD COLUMN "selection_artifact_version_id" TEXT,
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failure_detail" TEXT,
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL,
DROP COLUMN "project_id",
DROP COLUMN "artifact_version_id",
DROP COLUMN "format",
ADD COLUMN "format" "ExportFormat" NOT NULL;

ALTER TABLE "project_releases"
ADD CONSTRAINT "project_releases_version_positive_check"
CHECK ("version" > 0),
ADD CONSTRAINT "project_releases_board_revision_nonnegative_check"
CHECK ("board_revision" >= 0),
ADD CONSTRAINT "project_releases_board_snapshot_object_check"
CHECK (jsonb_typeof("board_snapshot") = 'object'),
ADD CONSTRAINT "project_releases_manifest_object_check"
CHECK (jsonb_typeof("manifest") = 'object'),
ADD CONSTRAINT "project_releases_board_checksum_format_check"
CHECK ("board_checksum" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "project_releases_manifest_sha256_format_check"
CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "project_releases_state_check"
CHECK (
  (
    "status" = 'building'
    AND "finished_at" IS NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
  OR (
    "status" = 'ready'
    AND "finished_at" IS NOT NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
  OR (
    "status" = 'failed'
    AND "finished_at" IS NOT NULL
    AND "failure_code" IS NOT NULL
  )
);

ALTER TABLE "release_artifact_versions"
ADD CONSTRAINT "release_artifact_versions_position_nonnegative_check"
CHECK ("position" >= 0);

ALTER TABLE "share_grants"
ADD CONSTRAINT "share_grants_token_hash_format_check"
CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "share_grants_expiry_check"
CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
ADD CONSTRAINT "share_grants_state_check"
CHECK (
  ("status" = 'active' AND "revoked_at" IS NULL)
  OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
  OR ("status" = 'expired' AND "revoked_at" IS NULL)
);

ALTER TABLE "export_jobs"
ADD CONSTRAINT "export_jobs_idempotency_key_nonempty_check"
CHECK (length("idempotency_key") BETWEEN 1 AND 200),
ADD CONSTRAINT "export_jobs_request_hash_format_check"
CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "export_jobs_revision_nonnegative_check"
CHECK ("revision" >= 0),
ADD CONSTRAINT "export_jobs_options_object_check"
CHECK (jsonb_typeof("options") = 'object'),
ADD CONSTRAINT "export_jobs_selection_check"
CHECK (
  (
    "selection_kind" IN ('release', 'board')
    AND "selection_artifact_id" IS NULL
    AND "selection_artifact_version_id" IS NULL
  )
  OR (
    "selection_kind" = 'artifact'
    AND "selection_artifact_id" IS NOT NULL
    AND "selection_artifact_version_id" IS NOT NULL
  )
),
ADD CONSTRAINT "export_jobs_state_check"
CHECK (
  (
    "status" = 'queued'
    AND "started_at" IS NULL
    AND "finished_at" IS NULL
    AND "output_blob_id" IS NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
  OR (
    "status" = 'running'
    AND "started_at" IS NOT NULL
    AND "finished_at" IS NULL
    AND "output_blob_id" IS NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
  OR (
    "status" = 'succeeded'
    AND "started_at" IS NOT NULL
    AND "finished_at" IS NOT NULL
    AND "output_blob_id" IS NOT NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
  OR (
    "status" = 'failed'
    AND "finished_at" IS NOT NULL
    AND "output_blob_id" IS NULL
    AND "failure_code" IS NOT NULL
  )
  OR (
    "status" = 'cancelled'
    AND "finished_at" IS NOT NULL
    AND "output_blob_id" IS NULL
    AND "failure_code" IS NULL
    AND "failure_detail" IS NULL
  )
);

CREATE UNIQUE INDEX "project_releases_project_id_version_key"
ON "project_releases"("project_id", "version");
CREATE UNIQUE INDEX "project_releases_id_project_id_key"
ON "project_releases"("id", "project_id");
CREATE INDEX "project_releases_project_id_status_version_idx"
ON "project_releases"("project_id", "status", "version");
CREATE INDEX "project_releases_created_by_id_idx"
ON "project_releases"("created_by_id");
CREATE INDEX "project_releases_board_id_idx"
ON "project_releases"("board_id");

CREATE UNIQUE INDEX "release_artifact_versions_release_id_artifact_id_key"
ON "release_artifact_versions"("release_id", "artifact_id");
CREATE UNIQUE INDEX "release_artifact_versions_release_id_artifact_version_id_key"
ON "release_artifact_versions"("release_id", "artifact_version_id");
CREATE UNIQUE INDEX "release_artifact_versions_release_id_artifact_id_artifact_version_id_key"
ON "release_artifact_versions"("release_id", "artifact_id", "artifact_version_id");
CREATE INDEX "release_artifact_versions_project_id_idx"
ON "release_artifact_versions"("project_id");
CREATE INDEX "release_artifact_versions_artifact_version_id_idx"
ON "release_artifact_versions"("artifact_version_id");

CREATE INDEX "share_grants_release_id_status_idx"
ON "share_grants"("release_id", "status");

CREATE UNIQUE INDEX "export_jobs_release_id_idempotency_key_key"
ON "export_jobs"("release_id", "idempotency_key");
CREATE INDEX "export_jobs_release_id_created_at_idx"
ON "export_jobs"("release_id", "created_at");
CREATE INDEX "export_jobs_created_by_id_idx"
ON "export_jobs"("created_by_id");
CREATE INDEX "export_jobs_selection_artifact_version_id_idx"
ON "export_jobs"("selection_artifact_version_id");

ALTER TABLE "project_releases"
ADD CONSTRAINT "project_releases_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_releases_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_releases_board_id_project_id_fkey"
FOREIGN KEY ("board_id", "project_id") REFERENCES "boards"("id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "release_artifact_versions"
ADD CONSTRAINT "release_artifact_versions_release_id_project_id_fkey"
FOREIGN KEY ("release_id", "project_id") REFERENCES "project_releases"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "release_artifact_versions_artifact_version_id_artifact_id_project_id_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "share_grants"
ADD CONSTRAINT "share_grants_release_id_fkey"
FOREIGN KEY ("release_id") REFERENCES "project_releases"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "export_jobs"
ADD CONSTRAINT "export_jobs_release_id_fkey"
FOREIGN KEY ("release_id") REFERENCES "project_releases"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "export_jobs_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "export_jobs_selected_release_artifact_fkey"
FOREIGN KEY ("release_id", "selection_artifact_id", "selection_artifact_version_id")
REFERENCES "release_artifact_versions"("release_id", "artifact_id", "artifact_version_id")
ON DELETE RESTRICT ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION "guard_project_release_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_board_revision INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'building' THEN
      RAISE EXCEPTION 'PROJECT_RELEASE_MUST_START_BUILDING' USING ERRCODE = '23514';
    END IF;

    SELECT board."revision"
    INTO current_board_revision
    FROM "boards" AS board
    WHERE board."id" = NEW."board_id"
      AND board."project_id" = NEW."project_id"
    FOR SHARE;

    IF current_board_revision IS DISTINCT FROM NEW."board_revision" THEN
      RAISE EXCEPTION 'PROJECT_RELEASE_BOARD_REVISION_STALE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('ready', 'failed') THEN
      RAISE EXCEPTION 'PROJECT_RELEASE_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."board_id" IS DISTINCT FROM OLD."board_id"
    OR NEW."board_revision" IS DISTINCT FROM OLD."board_revision"
    OR NEW."board_snapshot" IS DISTINCT FROM OLD."board_snapshot"
    OR NEW."board_checksum" IS DISTINCT FROM OLD."board_checksum"
    OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
    OR NEW."manifest_sha256" IS DISTINCT FROM OLD."manifest_sha256"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'PROJECT_RELEASE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'PROJECT_RELEASE_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NOT (OLD."status" = 'building' AND NEW."status" IN ('building', 'ready', 'failed')) THEN
    RAISE EXCEPTION 'PROJECT_RELEASE_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'ready' AND EXISTS (
    SELECT 1
    FROM "release_artifact_versions" AS pin
    JOIN "artifact_versions" AS version ON version."id" = pin."artifact_version_id"
    WHERE pin."release_id" = NEW."id"
      AND version."status" <> 'ready'
  ) THEN
    RAISE EXCEPTION 'PROJECT_RELEASE_ARTIFACT_VERSION_NOT_READY' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_releases_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "project_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_project_release_mutation"();

CREATE FUNCTION "guard_release_artifact_version_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_status "ProjectReleaseStatus";
  version_status "ArtifactVersionStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RELEASE_ARTIFACT_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT release."status"
  INTO owner_status
  FROM "project_releases" AS release
  WHERE release."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."release_id" ELSE NEW."release_id" END
  FOR SHARE;

  IF owner_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF owner_status IS DISTINCT FROM 'building'::"ProjectReleaseStatus" THEN
    RAISE EXCEPTION 'RELEASE_ARTIFACT_VERSION_OWNER_NOT_BUILDING' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT version."status"
    INTO version_status
    FROM "artifact_versions" AS version
    WHERE version."id" = NEW."artifact_version_id"
      AND version."artifact_id" = NEW."artifact_id"
      AND version."project_id" = NEW."project_id"
    FOR SHARE;

    IF version_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus" THEN
      RAISE EXCEPTION 'RELEASE_ARTIFACT_VERSION_NOT_READY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER "release_artifact_versions_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "release_artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_release_artifact_version_mutation"();

CREATE FUNCTION "guard_share_grant_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  release_status "ProjectReleaseStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SHARE_GRANT_DELETE_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' THEN
      RAISE EXCEPTION 'SHARE_GRANT_MUST_START_ACTIVE' USING ERRCODE = '23514';
    END IF;
    SELECT release."status"
    INTO release_status
    FROM "project_releases" AS release
    WHERE release."id" = NEW."release_id"
    FOR SHARE;
    IF release_status IS DISTINCT FROM 'ready'::"ProjectReleaseStatus" THEN
      RAISE EXCEPTION 'SHARE_GRANT_RELEASE_NOT_READY' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
      OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
      OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
      OR NEW."scope" IS DISTINCT FROM OLD."scope"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'SHARE_GRANT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" IN ('revoked', 'expired') THEN
      RAISE EXCEPTION 'SHARE_GRANT_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NOT (OLD."status" = 'active' AND NEW."status" IN ('active', 'revoked', 'expired')) THEN
      RAISE EXCEPTION 'SHARE_GRANT_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "share_grants_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "share_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_share_grant_mutation"();

CREATE FUNCTION "guard_export_job_mutation"()
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
    SELECT release."status"
    INTO release_status
    FROM "project_releases" AS release
    WHERE release."id" = NEW."release_id"
    FOR SHARE;
    IF release_status IS DISTINCT FROM 'ready'::"ProjectReleaseStatus" THEN
      RAISE EXCEPTION 'EXPORT_JOB_RELEASE_NOT_READY' USING ERRCODE = '23514';
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

CREATE TRIGGER "export_jobs_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "export_jobs"
FOR EACH ROW EXECUTE FUNCTION "guard_export_job_mutation"();
