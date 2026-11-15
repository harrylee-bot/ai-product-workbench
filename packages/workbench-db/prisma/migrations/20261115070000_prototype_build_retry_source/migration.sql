BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE prototype_plans ADD COLUMN retry_of_plan_id TEXT, ADD COLUMN reused_run_id TEXT;
ALTER TABLE prototype_plans ADD CONSTRAINT prototype_plans_retry_project_fkey FOREIGN KEY (retry_of_plan_id, project_id) REFERENCES prototype_plans(id, project_id) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE prototype_plans ADD CONSTRAINT prototype_plans_reused_run_project_fkey FOREIGN KEY (reused_run_id, project_id) REFERENCES runs(id, project_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE prototype_plans ADD CONSTRAINT prototype_plan_execution_source CHECK (reused_run_id IS NULL OR (runtime_run_id IS NULL AND retry_of_plan_id IS NOT NULL));
CREATE FUNCTION guard_prototype_retry_source() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE prior_plan RECORD; source_run RECORD;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.retry_of_plan_id IS DISTINCT FROM OLD.retry_of_plan_id OR NEW.reused_run_id IS DISTINCT FROM OLD.reused_run_id) THEN
  RAISE EXCEPTION 'PROTOTYPE_RETRY_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
 END IF;
 IF NEW.retry_of_plan_id IS NOT NULL AND TG_OP = 'INSERT' THEN
  EXECUTE format('SELECT * FROM %I.prototype_plans WHERE id = $1 AND project_id = $2', TG_TABLE_SCHEMA) INTO prior_plan USING NEW.retry_of_plan_id, NEW.project_id;
  IF prior_plan.id IS NULL OR prior_plan.status NOT IN ('failed', 'cancelled') THEN
   RAISE EXCEPTION 'PROTOTYPE_RETRY_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NEW.reused_run_id IS NOT NULL THEN
   EXECUTE format('SELECT * FROM %I.runs WHERE id = $1 AND project_id = $2', TG_TABLE_SCHEMA) INTO source_run USING NEW.reused_run_id, NEW.project_id;
   IF source_run.id IS NULL OR source_run.status <> 'succeeded' OR NEW.reused_run_id IS DISTINCT FROM COALESCE(prior_plan.runtime_run_id, prior_plan.reused_run_id) OR NEW.generation_request IS DISTINCT FROM source_run.request THEN
    RAISE EXCEPTION 'PROTOTYPE_REBUILD_SOURCE_INVALID' USING ERRCODE = '23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prototype_retry_source_guard BEFORE INSERT OR UPDATE ON prototype_plans FOR EACH ROW EXECUTE FUNCTION guard_prototype_retry_source();
COMMIT;
