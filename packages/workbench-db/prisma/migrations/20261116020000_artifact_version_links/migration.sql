BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE artifact_links (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE RESTRICT,
 source_version_id TEXT NOT NULL,
 target_version_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
 label TEXT CHECK (length(label) <= 240),
 created_by_id TEXT REFERENCES principals(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 idempotency_key TEXT,
 request_hash TEXT,
 legacy_board_edge_id TEXT UNIQUE,
 revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 removed_at TIMESTAMP(3),
 CONSTRAINT artifact_links_distinct_versions CHECK (source_version_id <> target_version_id),
 CONSTRAINT artifact_links_identity CHECK (
   (legacy_board_edge_id IS NOT NULL AND idempotency_key IS NULL AND request_hash IS NULL)
   OR (legacy_board_edge_id IS NULL AND created_by_id IS NOT NULL AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL AND request_hash ~ '^[a-f0-9]{64}$')
 ),
 CONSTRAINT artifact_links_source_fkey FOREIGN KEY(source_version_id,project_id) REFERENCES artifact_versions(id,project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT artifact_links_target_fkey FOREIGN KEY(target_version_id,project_id) REFERENCES artifact_versions(id,project_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 UNIQUE(project_id,idempotency_key)
);
CREATE INDEX artifact_links_project_id_created_at_id_idx ON artifact_links(project_id,created_at,id);
CREATE INDEX artifact_links_project_id_source_version_id_created_at_id_idx ON artifact_links(project_id,source_version_id,created_at,id);
CREATE INDEX artifact_links_project_id_target_version_id_created_at_id_idx ON artifact_links(project_id,target_version_id,created_at,id);

-- Import only business edges whose two artifact versions are explicitly pinned.
-- Do not guess versions from current pointers or reinterpret drawing/group edges.
INSERT INTO artifact_links(id,project_id,source_version_id,target_version_id,kind,label,legacy_board_edge_id)
SELECT 'imported:' || e.id,b.project_id,s.artifact_version_id,t.artifact_version_id,e.kind,
 CASE WHEN jsonb_typeof(e.data->'label')='string' THEN left(e.data->>'label',240) ELSE NULL END,e.id
FROM board_edges e
JOIN boards b ON b.id=e.board_id
JOIN board_nodes s ON s.board_id=e.board_id AND s.node_key=e.source_node_key
JOIN board_nodes t ON t.board_id=e.board_id AND t.node_key=e.target_node_key
JOIN artifact_versions sv ON sv.id=s.artifact_version_id AND sv.artifact_id=s.artifact_id AND sv.project_id=b.project_id
JOIN artifact_versions tv ON tv.id=t.artifact_version_id AND tv.artifact_id=t.artifact_id AND tv.project_id=b.project_id
WHERE s.artifact_id IS NOT NULL AND t.artifact_id IS NOT NULL
 AND sv.id<>tv.id AND sv.status='ready' AND tv.status='ready';

CREATE FUNCTION workbench_validate_artifact_link() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE endpoints_ready BOOLEAN;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.project_id,NEW.source_version_id,NEW.target_version_id,NEW.kind,NEW.label,NEW.created_by_id,NEW.idempotency_key,NEW.request_hash,NEW.legacy_board_edge_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.source_version_id,OLD.target_version_id,OLD.kind,OLD.label,OLD.created_by_id,OLD.idempotency_key,OLD.request_hash,OLD.legacy_board_edge_id,OLD.created_at)
   THEN RAISE EXCEPTION 'Artifact link identity and endpoints are immutable'; END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL OR NEW.revision<>OLD.revision+1
   THEN RAISE EXCEPTION 'Artifact link can only be removed once'; END IF;
 ELSE
  IF NEW.revision<>0 OR NEW.removed_at IS NOT NULL THEN RAISE EXCEPTION 'New artifact link must be active'; END IF;
  EXECUTE format('SELECT count(*)=2 FROM %I.artifact_versions WHERE id IN ($1,$2) AND project_id=$3 AND status=''ready''', TG_TABLE_SCHEMA)
   INTO endpoints_ready USING NEW.source_version_id,NEW.target_version_id,NEW.project_id;
  IF NOT endpoints_ready
   THEN RAISE EXCEPTION 'Artifact link endpoints must be ready versions of its project'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_links_validate BEFORE INSERT OR UPDATE ON artifact_links FOR EACH ROW EXECUTE FUNCTION workbench_validate_artifact_link();
COMMIT;
