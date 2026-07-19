-- PostgreSQL truncates identifiers to 63 bytes. Give the Remix receipt index
-- a stable explicit name so schema introspection and future diffs agree.
ALTER INDEX "project_lineages_source_share_id_created_by_id_idempotency_key_"
RENAME TO "project_lineages_share_creator_idempotency_key";
