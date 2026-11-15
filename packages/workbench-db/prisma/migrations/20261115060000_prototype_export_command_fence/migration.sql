BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE prototype_exports ADD COLUMN active_command_id TEXT;
UPDATE prototype_exports e SET active_command_id = (
 SELECT c.id FROM prototype_workflow_commands c
 WHERE c.project_id = e.project_id AND c.target_id = e.id AND c.kind = 'export_start'
   AND c.payload->>'revisionId' = e.revision_id AND c.payload->>'format' = e.format::text
 ORDER BY c.sequence DESC LIMIT 1
);
CREATE UNIQUE INDEX prototype_workflow_commands_id_project_target_key ON prototype_workflow_commands(id, project_id, target_id);
ALTER TABLE prototype_exports ADD CONSTRAINT prototype_exports_active_command_scope_fkey
 FOREIGN KEY (active_command_id, project_id, id) REFERENCES prototype_workflow_commands(id, project_id, target_id)
 ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION enforce_prototype_export_execution() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE command_sequence BIGINT; previous_sequence BIGINT;
BEGIN
 IF NEW.active_command_id IS NULL THEN
   RAISE EXCEPTION 'Prototype export requires an active execution command';
 END IF;
 EXECUTE format('SELECT sequence FROM %I.prototype_workflow_commands
   WHERE id = $1 AND project_id = $2 AND target_id = $3 AND kind = ''export_start''
     AND payload->>''revisionId'' = $4 AND payload->>''format'' = $5', TG_TABLE_SCHEMA)
   INTO command_sequence USING NEW.active_command_id, NEW.project_id, NEW.id, NEW.revision_id, NEW.format::text;
 IF command_sequence IS NULL THEN RAISE EXCEPTION 'Prototype export command scope is invalid'; END IF;
 IF TG_OP = 'UPDATE' THEN
   IF NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.revision_id <> OLD.revision_id OR NEW.format <> OLD.format THEN
     RAISE EXCEPTION 'Prototype export identity is immutable';
   END IF;
   IF NEW.active_command_id IS DISTINCT FROM OLD.active_command_id THEN
     EXECUTE format('SELECT sequence FROM %I.prototype_workflow_commands WHERE id = $1', TG_TABLE_SCHEMA)
       INTO previous_sequence USING OLD.active_command_id;
     IF OLD.status <> 'failed' OR NEW.status <> 'queued' OR (previous_sequence IS NOT NULL AND command_sequence <= previous_sequence) THEN
       RAISE EXCEPTION 'Prototype export execution replacement requires a new retry command';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prototype_export_execution BEFORE INSERT OR UPDATE ON prototype_exports FOR EACH ROW EXECUTE FUNCTION enforce_prototype_export_execution();
COMMIT;
