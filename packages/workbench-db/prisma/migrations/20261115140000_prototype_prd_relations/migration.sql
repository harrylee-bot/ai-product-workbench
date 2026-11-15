BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE prototype_revisions ADD COLUMN source_artifact_version_id TEXT REFERENCES artifact_versions(id) ON DELETE RESTRICT;
CREATE INDEX prototype_revision_source_artifact_idx ON prototype_revisions(source_artifact_version_id, created_at, id);

-- Only recover an exact, unique source through the persisted generation Run and
-- identical validated document. Ambiguous historical rows stay unlinked.
WITH matches AS (
  SELECT revision.id, min(version.id) AS source_id, count(*) AS match_count
  FROM prototype_revisions revision
  JOIN prototype_plans plan ON plan.project_id = revision.project_id AND plan.content_version = revision.version
    AND (plan.id = revision.plan_id OR plan.root_plan_id = revision.plan_id)
  JOIN artifact_versions version ON version.project_id = revision.project_id
    AND version.created_by_run_id = COALESCE(plan.runtime_run_id, plan.reused_run_id)
    AND version.content = revision.source_document AND version.status = 'ready' AND version.schema_version = 1
  JOIN artifacts artifact ON artifact.id = version.artifact_id AND artifact.kind = 'prototype'
  GROUP BY revision.id
)
UPDATE prototype_revisions revision SET source_artifact_version_id = matches.source_id
FROM matches WHERE revision.id = matches.id AND matches.match_count = 1;

CREATE FUNCTION guard_prototype_source_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.source_artifact_version_id IS NOT NULL
    AND NEW.source_artifact_version_id IS DISTINCT FROM OLD.source_artifact_version_id THEN
    RAISE EXCEPTION 'PROTOTYPE_SOURCE_ARTIFACT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_artifact_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM artifact_versions version JOIN artifacts artifact ON artifact.id = version.artifact_id
    JOIN prototype_plans plan ON plan.project_id = NEW.project_id AND plan.content_version = NEW.version
      AND (plan.id = NEW.plan_id OR plan.root_plan_id = NEW.plan_id)
    WHERE version.id = NEW.source_artifact_version_id AND version.project_id = NEW.project_id
      AND version.created_by_run_id = COALESCE(plan.runtime_run_id, plan.reused_run_id)
      AND artifact.kind = 'prototype' AND version.status = 'ready' AND version.schema_version = 1
      AND version.content = NEW.source_document
  ) THEN RAISE EXCEPTION 'PROTOTYPE_SOURCE_ARTIFACT_MISMATCH' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prototype_source_artifact_guard BEFORE INSERT OR UPDATE ON prototype_revisions
FOR EACH ROW EXECUTE FUNCTION guard_prototype_source_artifact();

CREATE FUNCTION guard_fixed_prd_prototype_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request JSONB;
BEGIN
  IF NEW.created_by_run_id IS NULL THEN RETURN NEW; END IF;
  SELECT run.request INTO request FROM runs run WHERE run.id = NEW.created_by_run_id AND run.project_id = NEW.project_id;
  IF request ->> 'generationIntent' IN ('prd-prototype', 'prd-flow') AND EXISTS (
    SELECT 1 FROM artifacts WHERE id = NEW.artifact_id AND kind = 'prototype'
  ) THEN
    IF NEW.source_prd_version_id IS DISTINCT FROM request #>> '{artifactTargets,0,artifactVersionId}' OR NOT EXISTS (
      SELECT 1 FROM artifact_versions version JOIN artifacts artifact ON artifact.id = version.artifact_id
      WHERE version.id = NEW.source_prd_version_id AND version.project_id = NEW.project_id
        AND version.artifact_id = request #>> '{artifactTargets,0,artifactId}'
        AND version.status = 'ready' AND artifact.kind = 'prd'
    ) THEN RAISE EXCEPTION 'PROTOTYPE_FIXED_PRD_SOURCE_REQUIRED' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prototype_fixed_prd_source_guard BEFORE INSERT OR UPDATE ON artifact_versions
FOR EACH ROW EXECUTE FUNCTION guard_fixed_prd_prototype_source();
COMMIT;
