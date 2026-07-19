ALTER TABLE "export_jobs"
ADD COLUMN "selection_screen_id" TEXT;

ALTER TABLE "export_jobs"
DROP CONSTRAINT "export_jobs_selection_check",
ADD CONSTRAINT "export_jobs_selection_check"
CHECK (
  (
    "selection_kind" IN ('release', 'board')
    AND "selection_artifact_id" IS NULL
    AND "selection_artifact_version_id" IS NULL
    AND "selection_screen_id" IS NULL
  )
  OR (
    "selection_kind" = 'artifact'
    AND "selection_artifact_id" IS NOT NULL
    AND "selection_artifact_version_id" IS NOT NULL
    AND ("selection_screen_id" IS NULL OR length("selection_screen_id") BETWEEN 1 AND 128)
  )
);

CREATE FUNCTION "guard_export_job_screen_selection_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."selection_screen_id" IS DISTINCT FROM OLD."selection_screen_id" THEN
    RAISE EXCEPTION 'EXPORT_JOB_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "export_jobs_screen_selection_mutation_guard"
BEFORE UPDATE ON "export_jobs"
FOR EACH ROW EXECUTE FUNCTION "guard_export_job_screen_selection_mutation"();
