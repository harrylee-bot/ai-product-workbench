BEGIN;

CREATE TYPE "ArtifactFinalizationStatus" AS ENUM ('confirmed', 'ingesting', 'ingested', 'rejected', 'withdrawn');
CREATE TYPE "KnowledgeIngestionStatus" AS ENUM ('queued', 'converting', 'indexing', 'publishing', 'published', 'failed', 'withdrawn');

ALTER TABLE artifact_versions ADD COLUMN source_prd_version_id TEXT REFERENCES artifact_versions(id) ON DELETE RESTRICT;
ALTER TABLE share_grants ADD COLUMN artifact_version_id TEXT;
ALTER TABLE share_grants ADD CONSTRAINT share_grants_prototype_pin_fkey
  FOREIGN KEY (release_id, artifact_version_id) REFERENCES release_artifact_versions(release_id, artifact_version_id) ON DELETE RESTRICT;

CREATE TABLE artifact_finalizations (
  id TEXT PRIMARY KEY,
  artifact_version_id TEXT NOT NULL UNIQUE REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  confirmed_by_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  checksum TEXT NOT NULL,
  status "ArtifactFinalizationStatus" NOT NULL DEFAULT 'confirmed',
  confirmed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at TIMESTAMP(3)
);
CREATE INDEX artifact_finalizations_project_id_status_idx ON artifact_finalizations(project_id, status);
CREATE TABLE knowledge_ingestion_jobs (
  id TEXT PRIMARY KEY,
  finalization_id TEXT NOT NULL UNIQUE REFERENCES artifact_finalizations(id) ON DELETE RESTRICT,
  status "KnowledgeIngestionStatus" NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  source_path TEXT NOT NULL,
  markdown TEXT NOT NULL,
  checksum TEXT NOT NULL,
  error_code TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX knowledge_ingestion_jobs_status_updated_at_idx ON knowledge_ingestion_jobs(status, updated_at);
ALTER TABLE knowledge_releases
  ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  ADD COLUMN parent_release_id TEXT REFERENCES knowledge_releases(id) ON DELETE RESTRICT,
  ADD COLUMN ingestion_job_id TEXT REFERENCES knowledge_ingestion_jobs(id) ON DELETE RESTRICT;
CREATE INDEX knowledge_releases_project_id_status_version_idx ON knowledge_releases(project_id, status, version);
CREATE INDEX knowledge_releases_parent_release_id_idx ON knowledge_releases(parent_release_id);
CREATE INDEX knowledge_releases_ingestion_job_id_idx ON knowledge_releases(ingestion_job_id);
CREATE TABLE knowledge_document_sources (
  document_id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  artifact_version_id TEXT NOT NULL REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  checksum TEXT NOT NULL
);
CREATE INDEX knowledge_document_sources_artifact_version_id_idx ON knowledge_document_sources(artifact_version_id);

CREATE FUNCTION enforce_generation_knowledge_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.knowledge_release_id IS NULL THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_REQUIRED' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM knowledge_releases r WHERE r.id = NEW.knowledge_release_id
      AND r.status = 'ready' AND (r.project_id IS NULL OR r.project_id = NEW.project_id)) THEN
      RAISE EXCEPTION 'RUN_KNOWLEDGE_SCOPE_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'succeeded' AND (TG_OP = 'INSERT' OR OLD.status <> 'succeeded') THEN
    IF NEW.knowledge_release_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM knowledge_retrieval_invocations i
      JOIN knowledge_tool_grants g ON g.id = i.last_grant_id
      JOIN runtime_attempts a ON a.id = i.runtime_attempt_id
      WHERE g.run_id = NEW.id AND g.project_id = NEW.project_id
        AND g.release_id = NEW.knowledge_release_id AND g.principal_id = NEW.created_by_id
        AND a.run_id = NEW.id AND a.attempt = NEW.attempt
        AND i.status = 'succeeded' AND jsonb_array_length(i.response->'items') > 0
    ) THEN RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_REQUIRED' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER generation_knowledge_scope BEFORE INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION enforce_generation_knowledge_scope();

CREATE FUNCTION enforce_knowledge_lineage_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.parent_release_id IS DISTINCT FROM OLD.parent_release_id
    OR NEW.ingestion_job_id IS DISTINCT FROM OLD.ingestion_job_id
  ) THEN RAISE EXCEPTION 'KNOWLEDGE_LINEAGE_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  IF NEW.ingestion_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM knowledge_ingestion_jobs j
    JOIN artifact_finalizations f ON f.id = j.finalization_id
    JOIN projects p ON p.id = f.project_id
    JOIN knowledge_releases parent ON parent.id = NEW.parent_release_id
    WHERE j.id = NEW.ingestion_job_id AND f.project_id = NEW.project_id
      AND p.workspace_id = NEW.workspace_id
      AND (parent.project_id IS NULL OR parent.project_id = NEW.project_id)
      AND (parent.workspace_id IS NULL OR parent.workspace_id = NEW.workspace_id)
  ) THEN RAISE EXCEPTION 'KNOWLEDGE_LINEAGE_SCOPE_INVALID' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_lineage_scope BEFORE INSERT OR UPDATE ON knowledge_releases
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_lineage_scope();

CREATE FUNCTION enforce_finalization_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM artifact_versions v WHERE v.id = NEW.artifact_version_id AND v.project_id = NEW.project_id
      AND v.status = 'ready' AND v.checksum = NEW.checksum
  ) THEN RAISE EXCEPTION 'FINALIZATION_VERSION_INVALID' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.artifact_version_id IS DISTINCT FROM OLD.artifact_version_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.confirmed_by_id IS DISTINCT FROM OLD.confirmed_by_id OR NEW.checksum IS DISTINCT FROM OLD.checksum
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
    OR (OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn')
  ) THEN RAISE EXCEPTION 'FINALIZATION_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finalization_identity BEFORE INSERT OR UPDATE ON artifact_finalizations
  FOR EACH ROW EXECUTE FUNCTION enforce_finalization_identity();

CREATE FUNCTION enforce_ingestion_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.finalization_id IS DISTINCT FROM OLD.finalization_id OR NEW.markdown IS DISTINCT FROM OLD.markdown
    OR NEW.checksum IS DISTINCT FROM OLD.checksum OR NEW.source_path IS DISTINCT FROM OLD.source_path
    OR (OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn')
  THEN RAISE EXCEPTION 'KNOWLEDGE_INGESTION_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ingestion_snapshot BEFORE UPDATE ON knowledge_ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_ingestion_snapshot();

CREATE FUNCTION enforce_generated_version_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'ready' AND NEW.source_prd_version_id IS DISTINCT FROM OLD.source_prd_version_id
  THEN RAISE EXCEPTION 'PROTOTYPE_PRD_PIN_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  IF NEW.created_by_run_id IS NOT NULL AND NEW.status = 'ready' AND (TG_OP = 'INSERT' OR OLD.status <> 'ready') THEN
    IF NEW.knowledge_release_id IS NULL OR jsonb_array_length(NEW.citations) < 1 OR NOT EXISTS (
      SELECT 1 FROM runs r WHERE r.id = NEW.created_by_run_id AND r.knowledge_release_id = NEW.knowledge_release_id
    ) THEN RAISE EXCEPTION 'GENERATED_VERSION_KNOWLEDGE_REQUIRED' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM artifacts a JOIN runs r ON r.id = NEW.created_by_run_id
      WHERE a.id = NEW.artifact_id AND a.kind = 'prototype' AND r.request->'requestedArtifactKinds' @> '["prd","prototype"]'::jsonb)
      AND NOT EXISTS (SELECT 1 FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.id = NEW.source_prd_version_id AND v.created_by_run_id = NEW.created_by_run_id
          AND v.project_id = NEW.project_id AND a.kind = 'prd' AND v.status = 'ready')
    THEN RAISE EXCEPTION 'PROTOTYPE_SAME_RUN_PRD_REQUIRED' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER generated_version_evidence BEFORE INSERT OR UPDATE ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_generated_version_evidence();

CREATE FUNCTION enforce_prototype_share_pin() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.artifact_version_id IS NULL OR NEW.scope <> 'view' OR NOT EXISTS (
    SELECT 1 FROM release_artifact_versions p WHERE p.release_id = NEW.release_id
      AND p.artifact_version_id = NEW.artifact_version_id AND p.kind = 'prototype'
  )) THEN RAISE EXCEPTION 'PROTOTYPE_SHARE_PIN_REQUIRED' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.artifact_version_id IS DISTINCT FROM OLD.artifact_version_id
  THEN RAISE EXCEPTION 'SHARE_VERSION_PIN_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prototype_share_pin BEFORE INSERT OR UPDATE ON share_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_prototype_share_pin();

DO $$
DECLARE
  application_schema TEXT := current_schema();
  function_name TEXT;
  trusted_search_path TEXT;
BEGIN
  IF application_schema IS NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_LIFECYCLE_SCHEMA_UNRESOLVED';
  END IF;
  trusted_search_path := CASE application_schema
    WHEN 'public' THEN 'pg_catalog, public'
    ELSE format('pg_catalog, %I, public', application_schema)
  END;
  FOREACH function_name IN ARRAY ARRAY[
    'enforce_generation_knowledge_scope', 'enforce_knowledge_lineage_scope',
    'enforce_finalization_identity', 'enforce_ingestion_snapshot',
    'enforce_generated_version_evidence', 'enforce_prototype_share_pin'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I() SET search_path TO %s',
      application_schema, function_name, trusted_search_path
    );
  END LOOP;
END;
$$;

COMMIT;
