-- ArtifactVersion is the immutable publication boundary. Redundant project
-- keys make tenant ownership enforceable by PostgreSQL instead of relying on
-- every caller to repeat the same joins correctly.
BEGIN;

ALTER TABLE "artifacts"
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "artifact_versions"
ADD COLUMN "project_id" TEXT;

UPDATE "artifact_versions" AS version
SET "project_id" = artifact."project_id"
FROM "artifacts" AS artifact
WHERE artifact."id" = version."artifact_id";

ALTER TABLE "artifact_versions"
ALTER COLUMN "project_id" SET NOT NULL;

ALTER TABLE "board_nodes"
ADD COLUMN "project_id" TEXT;

UPDATE "board_nodes" AS node
SET "project_id" = board."project_id"
FROM "boards" AS board
WHERE board."id" = node."board_id";

ALTER TABLE "board_nodes"
ALTER COLUMN "project_id" SET NOT NULL;

-- Keep the JSON citation envelope aligned with workbench-contracts. Full PRD
-- and Prototype IR validation remains in the application because PostgreSQL
-- does not ship a JSON Schema validator.
CREATE FUNCTION "artifact_citations_valid"("citations_value" JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  citation JSONB;
  locator JSONB;
  start_line NUMERIC;
  end_line NUMERIC;
BEGIN
  IF jsonb_typeof("citations_value") <> 'array'
    OR jsonb_array_length("citations_value") > 1000
  THEN
    RETURN FALSE;
  END IF;

  FOR citation IN SELECT value FROM jsonb_array_elements("citations_value")
  LOOP
    IF jsonb_typeof(citation) <> 'object'
      OR NOT citation ?& ARRAY['id', 'documentId', 'chunkId', 'sourcePath', 'title', 'quote', 'locator']
      OR EXISTS (
        SELECT 1
        FROM jsonb_object_keys(citation) AS key
        WHERE key <> ALL (ARRAY['id', 'documentId', 'chunkId', 'sourcePath', 'title', 'quote', 'locator'])
      )
      OR jsonb_typeof(citation->'id') <> 'string'
      OR length(citation->>'id') NOT BETWEEN 1 AND 96
      OR (citation->>'id') !~ '^[A-Za-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]+)*$'
      OR jsonb_typeof(citation->'documentId') <> 'string'
      OR length(citation->>'documentId') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(citation->'chunkId') <> 'string'
      OR length(citation->>'chunkId') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(citation->'sourcePath') <> 'string'
      OR length(citation->>'sourcePath') NOT BETWEEN 1 AND 1024
      OR NOT (
        citation->'title' = 'null'::jsonb
        OR (
          jsonb_typeof(citation->'title') = 'string'
          AND length(citation->>'title') BETWEEN 1 AND 240
        )
      )
      OR NOT (
        citation->'quote' = 'null'::jsonb
        OR (
          jsonb_typeof(citation->'quote') = 'string'
          AND length(citation->>'quote') BETWEEN 1 AND 2000
        )
      )
      OR jsonb_typeof(citation->'locator') <> 'object'
    THEN
      RETURN FALSE;
    END IF;

    locator := citation->'locator';
    IF NOT locator ?& ARRAY['heading', 'startLine', 'endLine']
      OR EXISTS (
        SELECT 1
        FROM jsonb_object_keys(locator) AS key
        WHERE key <> ALL (ARRAY['heading', 'startLine', 'endLine'])
      )
      OR NOT (
        locator->'heading' = 'null'::jsonb
        OR (
          jsonb_typeof(locator->'heading') = 'string'
          AND length(locator->>'heading') BETWEEN 1 AND 500
        )
      )
      OR NOT (
        locator->'startLine' = 'null'::jsonb
        OR jsonb_typeof(locator->'startLine') = 'number'
      )
      OR NOT (
        locator->'endLine' = 'null'::jsonb
        OR jsonb_typeof(locator->'endLine') = 'number'
      )
    THEN
      RETURN FALSE;
    END IF;

    start_line := CASE
      WHEN locator->'startLine' = 'null'::jsonb THEN NULL
      ELSE (locator->>'startLine')::NUMERIC
    END;
    end_line := CASE
      WHEN locator->'endLine' = 'null'::jsonb THEN NULL
      ELSE (locator->>'endLine')::NUMERIC
    END;

    IF (start_line IS NOT NULL AND (start_line <= 0 OR start_line <> trunc(start_line)))
      OR (end_line IS NOT NULL AND (end_line <= 0 OR end_line <> trunc(end_line)))
      OR (start_line IS NOT NULL AND end_line IS NOT NULL AND end_line < start_line)
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements("citations_value") AS item
    GROUP BY item->>'id'
    HAVING count(*) > 1
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;

ALTER TABLE "artifacts"
ADD CONSTRAINT "artifacts_revision_nonnegative_check"
CHECK ("revision" >= 0),
ADD CONSTRAINT "artifacts_title_length_check"
CHECK (length("title") BETWEEN 1 AND 240);

ALTER TABLE "artifact_versions"
ADD CONSTRAINT "artifact_versions_version_positive_check"
CHECK ("version" > 0),
ADD CONSTRAINT "artifact_versions_schema_version_positive_check"
CHECK ("schema_version" > 0),
ADD CONSTRAINT "artifact_versions_checksum_format_check"
CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "artifact_versions_content_xor_blob_check"
CHECK (("content" IS NULL) <> ("content_blob_id" IS NULL)),
ADD CONSTRAINT "artifact_versions_citations_check"
CHECK ("artifact_citations_valid"("citations"));

ALTER TABLE "board_nodes"
ADD CONSTRAINT "board_nodes_artifact_pair_check"
CHECK (("artifact_id" IS NULL) = ("artifact_version_id" IS NULL));

-- Fail the migration rather than silently publishing an invalid historical
-- pointer. The static composite FK added below enforces identity; readiness is
-- a state predicate and therefore needs a trigger for future writes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "artifacts" AS artifact
    LEFT JOIN "artifact_versions" AS version
      ON version."id" = artifact."current_version_id"
      AND version."artifact_id" = artifact."id"
      AND version."project_id" = artifact."project_id"
    WHERE artifact."current_version_id" IS NOT NULL
      AND (version."id" IS NULL OR version."status" <> 'ready')
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_CURRENT_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifact_versions" AS version
    JOIN "artifacts" AS artifact ON artifact."id" = version."artifact_id"
    WHERE artifact."kind" IN ('prd', 'prototype')
      AND version."schema_version" <> 1
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_SCHEMA_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifact_versions" AS version
    JOIN "artifacts" AS artifact ON artifact."id" = version."artifact_id"
    WHERE artifact."kind" IN ('prd', 'prototype')
      AND version."content" IS NOT NULL
      AND (
        jsonb_typeof(version."content") <> 'object'
        OR version."content"->>'protocol' <> format('workbench.%s.v1', artifact."kind"::TEXT)
        OR version."content"->'citations' IS DISTINCT FROM version."citations"
      )
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_INLINE_IR_ENVELOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifact_versions" AS version
    JOIN "blobs" AS blob ON blob."id" = version."content_blob_id"
    WHERE version."status" = 'ready'
      AND (blob."status" <> 'ready' OR blob."byte_size" <= 0)
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_READY_CONTENT_BLOB_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "artifact_versions" AS version
    JOIN "artifacts" AS artifact ON artifact."id" = version."artifact_id"
    JOIN "projects" AS project ON project."id" = artifact."project_id"
    LEFT JOIN "knowledge_releases" AS release
      ON release."id" = version."knowledge_release_id"
    WHERE version."status" = 'ready'
      AND version."knowledge_release_id" IS NOT NULL
      AND (
        release."id" IS NULL
        OR release."status" NOT IN ('ready', 'retired')
        OR (
          release."workspace_id" IS NOT NULL
          AND release."workspace_id" IS DISTINCT FROM project."workspace_id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'ARTIFACT_READY_KNOWLEDGE_RELEASE_INVALID' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "artifacts_id_project_id_key"
ON "artifacts"("id", "project_id");

CREATE UNIQUE INDEX "artifact_versions_id_artifact_id_key"
ON "artifact_versions"("id", "artifact_id");
CREATE UNIQUE INDEX "artifact_versions_id_project_id_key"
ON "artifact_versions"("id", "project_id");
CREATE UNIQUE INDEX "artifact_versions_id_artifact_id_project_id_key"
ON "artifact_versions"("id", "artifact_id", "project_id");
CREATE INDEX "artifact_versions_project_id_status_created_at_idx"
ON "artifact_versions"("project_id", "status", "created_at");

CREATE UNIQUE INDEX "boards_id_project_id_key"
ON "boards"("id", "project_id");
CREATE INDEX "board_nodes_project_id_idx"
ON "board_nodes"("project_id");

ALTER TABLE "artifacts"
DROP CONSTRAINT "artifacts_current_version_id_fkey";

ALTER TABLE "artifact_versions"
DROP CONSTRAINT "artifact_versions_artifact_id_fkey",
DROP CONSTRAINT "artifact_versions_content_blob_id_fkey",
DROP CONSTRAINT "artifact_versions_created_by_run_id_fkey",
DROP CONSTRAINT "artifact_versions_knowledge_release_id_fkey";

ALTER TABLE "board_nodes"
DROP CONSTRAINT "board_nodes_board_id_fkey",
DROP CONSTRAINT "board_nodes_artifact_id_fkey",
DROP CONSTRAINT "board_nodes_artifact_version_id_fkey";

ALTER TABLE "export_jobs"
DROP CONSTRAINT "export_jobs_artifact_version_id_fkey",
DROP CONSTRAINT "export_jobs_output_blob_id_fkey";

ALTER TABLE "artifacts"
ADD CONSTRAINT "artifacts_current_version_id_id_fkey"
FOREIGN KEY ("current_version_id", "id")
REFERENCES "artifact_versions"("id", "artifact_id")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "artifact_versions"
ADD CONSTRAINT "artifact_versions_artifact_id_project_id_fkey"
FOREIGN KEY ("artifact_id", "project_id")
REFERENCES "artifacts"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_versions_content_blob_id_fkey"
FOREIGN KEY ("content_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "artifact_versions_created_by_run_id_project_id_fkey"
FOREIGN KEY ("created_by_run_id", "project_id")
REFERENCES "runs"("id", "project_id")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "artifact_versions_knowledge_release_id_fkey"
FOREIGN KEY ("knowledge_release_id") REFERENCES "knowledge_releases"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "board_nodes"
ADD CONSTRAINT "board_nodes_board_id_project_id_fkey"
FOREIGN KEY ("board_id", "project_id")
REFERENCES "boards"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "board_nodes_artifact_id_project_id_fkey"
FOREIGN KEY ("artifact_id", "project_id")
REFERENCES "artifacts"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "board_nodes_artifact_version_id_artifact_id_project_id_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "export_jobs"
ADD CONSTRAINT "export_jobs_artifact_version_id_project_id_fkey"
FOREIGN KEY ("artifact_version_id", "project_id")
REFERENCES "artifact_versions"("id", "project_id")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "export_jobs_output_blob_id_fkey"
FOREIGN KEY ("output_blob_id") REFERENCES "blobs"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_artifact_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'ARTIFACT_REVISION_MUST_START_AT_ZERO' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."kind" IS DISTINCT FROM OLD."kind"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'ARTIFACT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF NEW."title" IS DISTINCT FROM OLD."title"
      OR NEW."current_version_id" IS DISTINCT FROM OLD."current_version_id"
    THEN
      NEW."revision" := OLD."revision" + 1;
      NEW."updated_at" := clock_timestamp();
    ELSIF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
      RAISE EXCEPTION 'ARTIFACT_REVISION_CHANGE_WITHOUT_RESOURCE_CHANGE' USING ERRCODE = '23514';
    ELSE
      -- Preserve strong ETag semantics when an ORM emits a no-op update that
      -- only refreshes its @updatedAt field.
      NEW."updated_at" := OLD."updated_at";
    END IF;
  END IF;

  IF NEW."current_version_id" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "artifact_versions" AS version
      WHERE version."id" = NEW."current_version_id"
        AND version."artifact_id" = NEW."id"
        AND version."project_id" = NEW."project_id"
        AND version."status" = 'ready'
    )
  THEN
    RAISE EXCEPTION 'ARTIFACT_CURRENT_VERSION_NOT_READY' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "artifacts_update_guard"
BEFORE INSERT OR UPDATE ON "artifacts"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_update"();

CREATE FUNCTION "guard_artifact_version_update"()
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

  IF artifact_kind IN ('prd', 'prototype')
    AND NEW."content" IS NOT NULL
    AND (
      jsonb_typeof(NEW."content") <> 'object'
      OR NEW."content"->>'protocol' <> format('workbench.%s.v1', artifact_kind::TEXT)
      OR NEW."content"->'citations' IS DISTINCT FROM NEW."citations"
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

CREATE TRIGGER "artifact_versions_update_guard"
BEFORE INSERT OR UPDATE ON "artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_version_update"();

-- A ready ArtifactVersion may outlive the publishing process indefinitely, so
-- soft-deleting its content Blob would be just as destructive as hard delete.
CREATE FUNCTION "guard_blob_artifact_references"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NEW."status" <> 'ready'
    AND EXISTS (
      SELECT 1
      FROM "artifact_versions" AS version
      WHERE version."content_blob_id" = OLD."id"
        AND version."status" = 'ready'
    )
  THEN
    RAISE EXCEPTION 'BLOB_REFERENCED_BY_READY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "blobs_artifact_reference_guard"
BEFORE UPDATE ON "blobs"
FOR EACH ROW EXECUTE FUNCTION "guard_blob_artifact_references"();

-- Readiness and workspace scope are part of every published version's frozen
-- provenance. A referenced release may not later invalidate that provenance.
CREATE FUNCTION "guard_knowledge_release_artifact_references"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR (
      NEW."status" IS DISTINCT FROM OLD."status"
      AND NEW."status" NOT IN ('ready', 'retired')
    )
  )
    AND EXISTS (
      SELECT 1
      FROM "artifact_versions" AS version
      WHERE version."knowledge_release_id" = OLD."id"
        AND version."status" = 'ready'
    )
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_REFERENCED_BY_READY_ARTIFACT' USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_releases_artifact_reference_guard"
BEFORE UPDATE ON "knowledge_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_release_artifact_references"();

COMMIT;
