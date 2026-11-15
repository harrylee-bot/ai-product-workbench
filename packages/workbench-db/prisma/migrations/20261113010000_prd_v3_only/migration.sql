BEGIN;

-- Retired test projects must be removed by the authorized maintenance operation
-- before this release. Do not silently reinterpret their immutable documents.
DO $migration$
DECLARE
  body TEXT;
  old_fragment TEXT;
  new_fragment TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "artifact_versions" version
    JOIN "artifacts" artifact ON artifact."id" = version."artifact_id"
    WHERE artifact."kind" = 'prd' AND version."schema_version" <> 3
  ) THEN
    RAISE EXCEPTION 'PRD_RETIRED_PROJECT_CONTENT_MUST_BE_REMOVED';
  END IF;

  -- Preserve all intervening guards, function ownership and search_path settings.
  SELECT pg_get_functiondef('guard_artifact_version_update()'::regprocedure) INTO body;
  old_fragment := $old$IF artifact_kind = 'prd'
    AND NEW."schema_version" IS DISTINCT FROM 1
    AND NEW."schema_version" IS DISTINCT FROM 2$old$;
  new_fragment := $new$IF artifact_kind = 'prd'
    AND NEW."schema_version" IS DISTINCT FROM 3$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'PRD_SCHEMA_GUARD_ANCHOR_MISMATCH'; END IF;
  body := replace(body, old_fragment, new_fragment);

  old_fragment := $old$OR CASE NEW."schema_version"
        WHEN 1 THEN NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prd.v1'
        WHEN 2 THEN NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prd.v2'
        ELSE TRUE
      END$old$;
  new_fragment := $new$OR NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prd.v3'$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'PRD_ENVELOPE_GUARD_ANCHOR_MISMATCH'; END IF;
  EXECUTE replace(body, old_fragment, new_fragment);

  SELECT pg_get_functiondef('guard_artifact_version_edit_receipt()'::regprocedure) INTO body;
  old_fragment := $old$OR (
          result_schema_version IS DISTINCT FROM 1
          AND result_schema_version IS DISTINCT FROM 2
        )$old$;
  new_fragment := $new$OR result_schema_version IS DISTINCT FROM 3$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'PRD_EDIT_GUARD_ANCHOR_MISMATCH'; END IF;
  EXECUTE replace(body, old_fragment, new_fragment);
END;
$migration$;

COMMIT;
