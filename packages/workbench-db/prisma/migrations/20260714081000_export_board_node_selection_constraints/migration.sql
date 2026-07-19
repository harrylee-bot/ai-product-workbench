ALTER TABLE "export_jobs"
ADD COLUMN "selection_node_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE FUNCTION "valid_export_board_node_ids"(node_ids TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(node_ids) BETWEEN 1 AND 512
    AND cardinality(node_ids) = (
      SELECT count(DISTINCT node_id)
      FROM unnest(node_ids) AS selected(node_id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(node_ids) AS selected(node_id)
      WHERE length(node_id) NOT BETWEEN 1 AND 128
    )
    AND node_ids = ARRAY(
      SELECT node_id
      FROM unnest(node_ids) AS selected(node_id)
      ORDER BY node_id COLLATE "C"
    );
$$;

ALTER TABLE "export_jobs"
DROP CONSTRAINT "export_jobs_selection_check",
ADD CONSTRAINT "export_jobs_selection_check"
CHECK (
  (
    "selection_kind" IN ('release', 'board')
    AND "selection_artifact_id" IS NULL
    AND "selection_artifact_version_id" IS NULL
    AND "selection_screen_id" IS NULL
    AND cardinality("selection_node_ids") = 0
  )
  OR (
    "selection_kind" = 'board_nodes'
    AND "selection_artifact_id" IS NULL
    AND "selection_artifact_version_id" IS NULL
    AND "selection_screen_id" IS NULL
    AND "valid_export_board_node_ids"("selection_node_ids")
  )
  OR (
    "selection_kind" = 'artifact'
    AND "selection_artifact_id" IS NOT NULL
    AND "selection_artifact_version_id" IS NOT NULL
    AND ("selection_screen_id" IS NULL OR length("selection_screen_id") BETWEEN 1 AND 128)
    AND cardinality("selection_node_ids") = 0
  )
);

CREATE FUNCTION "guard_export_job_node_selection_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."selection_node_ids" IS DISTINCT FROM OLD."selection_node_ids" THEN
    RAISE EXCEPTION 'EXPORT_JOB_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "export_jobs_node_selection_mutation_guard"
BEFORE UPDATE ON "export_jobs"
FOR EACH ROW EXECUTE FUNCTION "guard_export_job_node_selection_mutation"();
