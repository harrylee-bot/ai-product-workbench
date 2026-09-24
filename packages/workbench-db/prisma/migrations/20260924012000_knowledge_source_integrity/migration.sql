BEGIN;

-- Legacy whole-project capabilities cannot be silently reinterpreted as a
-- Prototype selection. Preserve the audit rows while revoking their access.
UPDATE share_grants
SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revision = revision + 1
WHERE artifact_version_id IS NULL AND status = 'active';

CREATE FUNCTION enforce_knowledge_document_source() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  release_status "KnowledgeReleaseStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KNOWLEDGE_DOCUMENT_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT r.status INTO release_status
    FROM knowledge_documents d JOIN knowledge_releases r ON r.id = d.release_id
    WHERE d.id = OLD.document_id FOR SHARE OF r;
    IF release_status IN ('ready', 'retired') THEN
      RAISE EXCEPTION 'KNOWLEDGE_DOCUMENT_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT r.status INTO release_status
  FROM knowledge_documents d JOIN knowledge_releases r ON r.id = d.release_id
  WHERE d.id = NEW.document_id FOR SHARE OF r;
  IF release_status IS DISTINCT FROM 'building' OR NOT EXISTS (
    SELECT 1 FROM knowledge_documents d
    JOIN knowledge_releases r ON r.id = d.release_id
    JOIN artifact_versions v ON v.id = NEW.artifact_version_id
    JOIN artifact_finalizations f ON f.artifact_version_id = v.id
    WHERE d.id = NEW.document_id AND d.source_kind = 'artifact_version'
      AND r.project_id = v.project_id AND f.project_id = v.project_id
      AND v.status = 'ready' AND v.checksum = NEW.checksum AND f.checksum = NEW.checksum
      AND f.status IN ('confirmed', 'ingesting', 'ingested')
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_DOCUMENT_SOURCE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_document_source_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON knowledge_document_sources
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_document_source();

DO $$
DECLARE
  application_schema TEXT := current_schema();
  trusted_search_path TEXT;
BEGIN
  IF application_schema IS NULL THEN
    RAISE EXCEPTION 'KNOWLEDGE_SOURCE_SCHEMA_UNRESOLVED';
  END IF;
  trusted_search_path := CASE application_schema
    WHEN 'public' THEN 'pg_catalog, public'
    ELSE format('pg_catalog, %I, public', application_schema)
  END;
  EXECUTE format(
    'ALTER FUNCTION %I.%I() SET search_path TO %s',
    application_schema, 'enforce_knowledge_document_source', trusted_search_path
  );
END;
$$;

COMMIT;
