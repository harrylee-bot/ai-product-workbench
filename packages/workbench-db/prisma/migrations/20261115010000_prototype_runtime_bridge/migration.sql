BEGIN;
SET LOCAL lock_timeout = '5s';

-- A Temporal plan owns one durable Runtime run. Retries recover that run and
-- its fixed request / knowledge release instead of submitting a fresh model job.
ALTER TABLE "prototype_plans" ADD COLUMN "runtime_run_id" TEXT;
CREATE UNIQUE INDEX "prototype_plans_runtime_run_id_key" ON "prototype_plans"("runtime_run_id");
ALTER TABLE "prototype_plans" ADD CONSTRAINT "prototype_plans_runtime_run_project_fkey"
  FOREIGN KEY ("runtime_run_id", "project_id") REFERENCES "runs"("id", "project_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION "guard_prototype_plan_runtime_run"() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path TO pg_catalog, public AS $$
BEGIN
  IF OLD."runtime_run_id" IS NOT NULL AND NEW."runtime_run_id" IS DISTINCT FROM OLD."runtime_run_id" THEN
    RAISE EXCEPTION 'PROTOTYPE_RUNTIME_RUN_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "prototype_plan_runtime_run_guard" BEFORE UPDATE ON "prototype_plans"
  FOR EACH ROW EXECUTE FUNCTION "guard_prototype_plan_runtime_run"();

COMMIT;
