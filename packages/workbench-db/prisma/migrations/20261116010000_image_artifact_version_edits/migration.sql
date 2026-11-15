BEGIN;
-- Extend the immutable edit receipt guard while retaining existing PRD, source
-- prototype, asset inheritance and trusted search_path protections.
DO $migration$
DECLARE body TEXT; old_fragment TEXT; new_fragment TEXT;
BEGIN
  SELECT pg_get_functiondef('guard_artifact_version_edit_receipt()'::regprocedure) INTO body;
  old_fragment := $old$artifact_kind NOT IN ('prototype'::"ArtifactKind", 'prd'::"ArtifactKind")$old$;
  new_fragment := $new$artifact_kind NOT IN ('prototype'::"ArtifactKind", 'prd'::"ArtifactKind", 'image'::"ArtifactKind")$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'IMAGE_EDIT_KIND_GUARD_ANCHOR_MISMATCH'; END IF;
  body := replace(body, old_fragment, new_fragment);
  old_fragment := $old$OR result_version <= base_version$old$;
  new_fragment := $new$OR (artifact_kind = 'image'::"ArtifactKind" AND (
      base_schema_version IS DISTINCT FROM 1 OR result_schema_version IS DISTINCT FROM 1
      OR NOT EXISTS (
        SELECT 1 FROM "artifact_versions" base
        JOIN "artifact_versions" result ON result."id" = NEW."result_artifact_version_id"
        JOIN "blobs" base_blob ON base_blob."id" = base."content_blob_id"
        JOIN "blobs" result_blob ON result_blob."id" = result."content_blob_id"
        WHERE base."id" = NEW."base_artifact_version_id"
          AND base."content" IS NULL AND result."content" IS NULL
          AND base_blob."status" = 'ready' AND result_blob."status" = 'ready'
          AND base_blob."deleted_at" IS NULL AND result_blob."deleted_at" IS NULL
          AND base."checksum" = base_blob."sha256" AND result."checksum" = result_blob."sha256"
          AND base_blob."media_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
          AND result_blob."media_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
      )
    ))
    OR result_version <= base_version$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'IMAGE_EDIT_BLOB_GUARD_ANCHOR_MISMATCH'; END IF;
  EXECUTE replace(body, old_fragment, new_fragment);
END;
$migration$;
COMMIT;
