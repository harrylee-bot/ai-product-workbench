-- Redundant ownership keys and immutable snapshot references are enforced in
-- PostgreSQL so background workers and future tools cannot bypass API checks.
BEGIN;

CREATE UNIQUE INDEX "threads_id_project_id_key"
ON "threads"("id", "project_id");

ALTER TABLE "runs"
DROP CONSTRAINT "runs_thread_id_fkey",
DROP CONSTRAINT "runs_knowledge_release_id_fkey";

ALTER TABLE "runs"
ADD CONSTRAINT "runs_thread_id_project_id_fkey"
FOREIGN KEY ("thread_id", "project_id")
REFERENCES "threads"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "runs_knowledge_release_id_fkey"
FOREIGN KEY ("knowledge_release_id")
REFERENCES "knowledge_releases"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "runs" AS run
    JOIN "projects" AS project ON project."id" = run."project_id"
    LEFT JOIN "knowledge_releases" AS release
      ON release."id" = run."knowledge_release_id"
    WHERE run."knowledge_release_id" IS NOT NULL
      AND (
        release."id" IS NULL
        OR release."status" NOT IN ('ready', 'retired')
        OR (
          release."workspace_id" IS NOT NULL
          AND release."workspace_id" IS DISTINCT FROM project."workspace_id"
        )
      )
  ) THEN
    RAISE EXCEPTION 'RUN_KNOWLEDGE_RELEASE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "board_nodes" AS node
    JOIN "artifact_versions" AS version
      ON version."id" = node."artifact_version_id"
      AND version."artifact_id" = node."artifact_id"
      AND version."project_id" = node."project_id"
    WHERE node."artifact_version_id" IS NOT NULL
      AND version."status" <> 'ready'
  ) THEN
    RAISE EXCEPTION 'BOARD_NODE_ARTIFACT_VERSION_NOT_READY' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "guard_run_identity_and_knowledge"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_workspace_id TEXT;
  release_status "KnowledgeReleaseStatus";
  release_workspace_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
      OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
      OR NEW."knowledge_release_id" IS DISTINCT FROM OLD."knowledge_release_id"
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER "runs_identity_and_knowledge_guard"
BEFORE INSERT OR UPDATE ON "runs"
FOR EACH ROW EXECUTE FUNCTION "guard_run_identity_and_knowledge"();

ALTER TABLE "boards"
ADD CONSTRAINT "boards_revision_nonnegative_check"
CHECK ("revision" >= 0);

CREATE FUNCTION "guard_board_revision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'BOARD_REVISION_MUST_START_AT_ZERO' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'BOARD_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'BOARD_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "boards_revision_guard"
BEFORE INSERT OR UPDATE ON "boards"
FOR EACH ROW EXECUTE FUNCTION "guard_board_revision"();

CREATE FUNCTION "bump_board_revision_from_new_children"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "boards"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (SELECT DISTINCT "board_id" FROM board_child_new_rows);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_board_revision_from_old_children"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "boards"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (SELECT DISTINCT "board_id" FROM board_child_old_rows);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "bump_board_revision_from_changed_children"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "boards"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT "board_id" FROM board_child_old_rows
    UNION
    SELECT "board_id" FROM board_child_new_rows
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "board_nodes_insert_revision"
AFTER INSERT ON "board_nodes"
REFERENCING NEW TABLE AS board_child_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_board_revision_from_new_children"();

CREATE TRIGGER "board_nodes_update_revision"
AFTER UPDATE ON "board_nodes"
REFERENCING OLD TABLE AS board_child_old_rows NEW TABLE AS board_child_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_board_revision_from_changed_children"();

CREATE TRIGGER "board_nodes_delete_revision"
AFTER DELETE ON "board_nodes"
REFERENCING OLD TABLE AS board_child_old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_board_revision_from_old_children"();

CREATE TRIGGER "board_edges_insert_revision"
AFTER INSERT ON "board_edges"
REFERENCING NEW TABLE AS board_child_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_board_revision_from_new_children"();

CREATE TRIGGER "board_edges_update_revision"
AFTER UPDATE ON "board_edges"
REFERENCING OLD TABLE AS board_child_old_rows NEW TABLE AS board_child_new_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_board_revision_from_changed_children"();

CREATE TRIGGER "board_edges_delete_revision"
AFTER DELETE ON "board_edges"
REFERENCING OLD TABLE AS board_child_old_rows
FOR EACH STATEMENT EXECUTE FUNCTION "bump_board_revision_from_old_children"();

CREATE FUNCTION "guard_board_node_artifact_version"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  version_status "ArtifactVersionStatus";
BEGIN
  IF NEW."artifact_id" IS NOT NULL AND NEW."artifact_version_id" IS NOT NULL THEN
    SELECT version."status"
    INTO version_status
    FROM "artifact_versions" AS version
    WHERE version."id" = NEW."artifact_version_id"
      AND version."artifact_id" = NEW."artifact_id"
      AND version."project_id" = NEW."project_id"
    FOR SHARE;

    IF version_status IS DISTINCT FROM 'ready'::"ArtifactVersionStatus" THEN
      RAISE EXCEPTION 'BOARD_NODE_ARTIFACT_VERSION_NOT_READY' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "board_nodes_artifact_version_guard"
BEFORE INSERT OR UPDATE ON "board_nodes"
FOR EACH ROW EXECUTE FUNCTION "guard_board_node_artifact_version"();

ALTER TABLE "board_edges"
ADD CONSTRAINT "board_edges_source_node_fkey"
FOREIGN KEY ("board_id", "source_node_key")
REFERENCES "board_nodes"("board_id", "node_key")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "board_edges_target_node_fkey"
FOREIGN KEY ("board_id", "target_node_key")
REFERENCES "board_nodes"("board_id", "node_key")
ON DELETE CASCADE ON UPDATE RESTRICT;

COMMIT;
