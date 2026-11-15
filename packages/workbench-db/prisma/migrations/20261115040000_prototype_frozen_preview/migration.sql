BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE prototype_workflow_commands ADD COLUMN sequence BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX prototype_workflow_commands_sequence_key ON prototype_workflow_commands(sequence);
ALTER TABLE prototype_revisions
 ADD COLUMN built_artifact_key TEXT,
 ADD COLUMN built_artifact_sha256 CHAR(64),
 ADD COLUMN built_artifact_byte_size INTEGER,
 ADD COLUMN built_artifact_media_type TEXT,
 ADD CONSTRAINT prototype_frozen_manifest_complete CHECK (
   (built_artifact_key IS NULL AND built_artifact_sha256 IS NULL AND built_artifact_byte_size IS NULL AND built_artifact_media_type IS NULL)
   OR (built_artifact_key IS NOT NULL AND built_artifact_sha256 IS NOT NULL AND built_artifact_sha256 ~ '^[a-f0-9]{64}$' AND built_artifact_byte_size IS NOT NULL AND built_artifact_byte_size > 0 AND built_artifact_media_type = 'text/html; charset=utf-8')
 );
CREATE FUNCTION enforce_prototype_frozen_artifact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF OLD.built_artifact_key IS NOT NULL AND (NEW.built_artifact_key IS DISTINCT FROM OLD.built_artifact_key OR NEW.built_artifact_sha256 IS DISTINCT FROM OLD.built_artifact_sha256 OR NEW.built_artifact_byte_size IS DISTINCT FROM OLD.built_artifact_byte_size OR NEW.built_artifact_media_type IS DISTINCT FROM OLD.built_artifact_media_type) THEN
  RAISE EXCEPTION 'Frozen prototype artifact manifest is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prototype_frozen_artifact_immutable BEFORE UPDATE ON prototype_revisions FOR EACH ROW EXECUTE FUNCTION enforce_prototype_frozen_artifact_immutable();
COMMIT;
