BEGIN;
SET LOCAL lock_timeout = '5s';

-- Convert old records once. Unidentifiable selectors become explicitly missing;
-- runtime readers never guess a node from text, position, or a legacy selector.
CREATE FUNCTION migrate_prototype_feedback_anchor(value JSONB, source_revision TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE node_id TEXT; converted JSONB;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN RETURN value; END IF;
  IF value ? 'sourceRevisionId' THEN RETURN value; END IF;
  node_id := substring(value ->> 'selector' from '^[A-Za-z][A-Za-z0-9_-]*\[data-wb-node="([A-Za-z][A-Za-z0-9_.:-]*)"\]$');
  IF length(node_id) > 96 OR node_id !~ '^[A-Za-z][A-Za-z0-9]*([-_.:][A-Za-z0-9]+)*$' THEN node_id := NULL; END IF;
  converted := jsonb_build_object('sourceRevisionId', source_revision, 'pageId', value ->> 'pageId',
    'scope', CASE WHEN node_id IS NULL THEN 'unresolved' ELSE 'node' END);
  IF node_id IS NOT NULL THEN converted := converted || jsonb_build_object('nodeId', node_id); END IF;
  IF value ? 'quote' THEN converted := converted || jsonb_build_object('quote', value -> 'quote'); END IF;
  RETURN converted;
END $$;

UPDATE prototype_feedback SET anchor = migrate_prototype_feedback_anchor(anchor, revision_id)
WHERE anchor IS NOT NULL AND anchor <> 'null'::jsonb AND NOT anchor ? 'sourceRevisionId';
UPDATE prototype_mutation_receipts
SET response = jsonb_set(response, '{anchor}', migrate_prototype_feedback_anchor(response -> 'anchor', response ->> 'revisionId'))
WHERE kind IN ('feedback_create', 'feedback_resolve') AND jsonb_typeof(response -> 'anchor') = 'object' AND NOT (response -> 'anchor') ? 'sourceRevisionId';
DROP FUNCTION migrate_prototype_feedback_anchor(JSONB, TEXT);

CREATE FUNCTION guard_prototype_feedback_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_pages JSONB; source_doc JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id <> OLD.project_id OR NEW.revision_id <> OLD.revision_id OR NEW.created_by_id <> OLD.created_by_id
      OR NEW.body <> OLD.body OR NEW.anchor IS DISTINCT FROM OLD.anchor THEN
      RAISE EXCEPTION 'PROTOTYPE_FEEDBACK_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT revision.pages, revision.source_document INTO source_pages, source_doc FROM prototype_revisions AS revision
    WHERE revision.id = NEW.revision_id AND revision.project_id = NEW.project_id FOR SHARE;
  IF source_pages IS NULL THEN RAISE EXCEPTION 'PROTOTYPE_FEEDBACK_SOURCE_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  IF NEW.anchor IS NULL OR NEW.anchor = 'null'::jsonb THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.anchor) <> 'object' OR NEW.anchor ->> 'sourceRevisionId' IS DISTINCT FROM NEW.revision_id
    OR NEW.anchor ->> 'scope' IS NULL OR NEW.anchor ->> 'scope' NOT IN ('page', 'node')
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.anchor) AS keys(value) WHERE value NOT IN ('sourceRevisionId','scope','pageId','nodeId','quote'))
    OR (NEW.anchor ? 'quote' AND (jsonb_typeof(NEW.anchor -> 'quote') <> 'string' OR length(NEW.anchor ->> 'quote') > 1000)) THEN
    RAISE EXCEPTION 'PROTOTYPE_FEEDBACK_ANCHOR_INVALID' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(source_pages) AS page WHERE page ->> 'id' = NEW.anchor ->> 'pageId') THEN
    RAISE EXCEPTION 'PROTOTYPE_FEEDBACK_PAGE_NOT_FOUND' USING ERRCODE = '23514';
  END IF;
  IF NEW.anchor ->> 'scope' = 'page' AND NEW.anchor ? 'nodeId' THEN
    RAISE EXCEPTION 'PROTOTYPE_FEEDBACK_PAGE_HAS_NODE' USING ERRCODE = '23514';
  END IF;
  IF NEW.anchor ->> 'scope' = 'node' AND (
    jsonb_typeof(NEW.anchor -> 'nodeId') IS DISTINCT FROM 'string' OR length(NEW.anchor ->> 'nodeId') NOT BETWEEN 1 AND 96
    OR NEW.anchor ->> 'nodeId' !~ '^[A-Za-z][A-Za-z0-9]*([-_.:][A-Za-z0-9]+)*$'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(source_doc -> 'nodes', '[]'::jsonb)) AS node
      WHERE node ->> 'id' = NEW.anchor ->> 'nodeId' AND node ->> 'screenId' = NEW.anchor ->> 'pageId')
  ) THEN RAISE EXCEPTION 'PROTOTYPE_FEEDBACK_NODE_NOT_FOUND' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prototype_feedback_anchor_guard BEFORE INSERT OR UPDATE ON prototype_feedback
FOR EACH ROW EXECUTE FUNCTION guard_prototype_feedback_anchor();
COMMIT;
