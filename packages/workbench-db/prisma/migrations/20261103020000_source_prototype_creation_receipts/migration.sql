-- Source prototypes have no image File/Blob source. Keep the existing image
-- receipt and its foreign keys unchanged; use a distinct creation receipt.
CREATE TABLE "source_prototype_creation_receipts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "artifact_version_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "source_prototype_creation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_prototype_creation_receipts_request_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "source_prototype_creation_receipts_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$')
);
CREATE UNIQUE INDEX "source_prototype_creation_receipts_artifact_id_key" ON "source_prototype_creation_receipts"("artifact_id");
CREATE UNIQUE INDEX "source_prototype_creation_receipts_artifact_version_id_key" ON "source_prototype_creation_receipts"("artifact_version_id");
CREATE UNIQUE INDEX "source_prototype_creation_receipts_project_idempotency_key" ON "source_prototype_creation_receipts"("project_id", "idempotency_key");
CREATE UNIQUE INDEX "source_prototype_creation_receipts_artifact_project_key" ON "source_prototype_creation_receipts"("artifact_id", "project_id");
CREATE UNIQUE INDEX "source_prototype_creation_receipts_version_project_key" ON "source_prototype_creation_receipts"("artifact_version_id", "artifact_id", "project_id");
CREATE INDEX "source_prototype_creation_receipts_created_by_id_idx" ON "source_prototype_creation_receipts"("created_by_id");
ALTER TABLE "source_prototype_creation_receipts" ADD CONSTRAINT "source_prototype_creation_receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "source_prototype_creation_receipts" ADD CONSTRAINT "source_prototype_creation_receipts_artifact_id_project_id_fkey" FOREIGN KEY ("artifact_id", "project_id") REFERENCES "artifacts"("id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "source_prototype_creation_receipts" ADD CONSTRAINT "source_prototype_creation_receipts_version_fkey" FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id") REFERENCES "artifact_versions"("id", "artifact_id", "project_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "source_prototype_creation_receipts" ADD CONSTRAINT "source_prototype_creation_receipts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Preserve current guard bodies and add only the prototype v2 envelope. Fail
-- instead of silently weakening a guard if the prior contract has drifted.
DO $migration$
DECLARE
  body TEXT;
  old_fragment TEXT;
  new_fragment TEXT;
BEGIN
  SELECT pg_get_functiondef('guard_artifact_version_update()'::regprocedure) INTO body;
  old_fragment := $old$IF artifact_kind IN ('prototype', 'design_system')
    AND NEW."schema_version" IS DISTINCT FROM 1$old$;
  new_fragment := $new$IF (artifact_kind = 'prototype' AND NEW."schema_version" NOT IN (1, 2))
    OR (artifact_kind = 'design_system' AND NEW."schema_version" IS DISTINCT FROM 1)$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'SOURCE_PROTOTYPE_GUARD_ANCHOR_MISMATCH'; END IF;
  body := replace(body, old_fragment, new_fragment);
  old_fragment := $old$OR NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prototype.v1'$old$;
  new_fragment := $new$OR CASE NEW."schema_version"
        WHEN 1 THEN NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prototype.v1'
        WHEN 2 THEN NEW."content"->>'protocol' IS DISTINCT FROM 'workbench.prototype-source.v1'
        ELSE TRUE
      END$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'SOURCE_PROTOTYPE_ENVELOPE_ANCHOR_MISMATCH'; END IF;
  body := replace(body, old_fragment, new_fragment);
  old_fragment := $old$  IF artifact_kind = 'design_system'$old$;
  new_fragment := $new$  IF artifact_kind = 'prototype' AND NEW."schema_version" = 2
    AND (
      NEW."content_blob_id" IS NOT NULL
      OR jsonb_typeof(NEW."content") IS DISTINCT FROM 'object'
      OR jsonb_typeof(NEW."content"->'files') IS DISTINCT FROM 'array'
      OR NEW."content"->'build'->>'renderer' IS DISTINCT FROM 'workbench.react-source.v1'
      OR COALESCE(NEW."content"->'build'->>'sourceChecksum', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(NEW."content"->'build'->>'htmlSha256', '') !~ '^[a-f0-9]{64}$'
      OR COALESCE(octet_length(NEW."content"->'build'->>'html'), 0) NOT BETWEEN 1 AND 2097152
    )
  THEN
    RAISE EXCEPTION 'SOURCE_PROTOTYPE_BUILD_ENVELOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF artifact_kind = 'design_system'$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'SOURCE_PROTOTYPE_BUILD_ANCHOR_MISMATCH'; END IF;
  body := replace(body, old_fragment, new_fragment);
  EXECUTE body;

  SELECT pg_get_functiondef('guard_artifact_version_edit_receipt()'::regprocedure) INTO body;
  old_fragment := $old$base_schema_version IS DISTINCT FROM 1
        OR result_schema_version IS DISTINCT FROM 1$old$;
  new_fragment := $new$base_schema_version IS DISTINCT FROM result_schema_version
        OR result_schema_version NOT IN (1, 2)$new$;
  IF position(old_fragment IN body) = 0 THEN RAISE EXCEPTION 'SOURCE_PROTOTYPE_EDIT_GUARD_ANCHOR_MISMATCH'; END IF;
  EXECUTE replace(body, old_fragment, new_fragment);
END;
$migration$;

-- One HTTP creation endpoint owns one idempotency namespace, even though the
-- source and image receipts have different physical source relationships.
CREATE FUNCTION "guard_artifact_creation_idempotency_scope"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."project_id" || ':' || NEW."idempotency_key", 0));
  IF (TG_TABLE_NAME = 'source_prototype_creation_receipts' AND EXISTS (
      SELECT 1 FROM "artifact_creation_receipts" WHERE "project_id" = NEW."project_id" AND "idempotency_key" = NEW."idempotency_key"
    )) OR (TG_TABLE_NAME = 'artifact_creation_receipts' AND EXISTS (
      SELECT 1 FROM "source_prototype_creation_receipts" WHERE "project_id" = NEW."project_id" AND "idempotency_key" = NEW."idempotency_key"
    ))
  THEN RAISE EXCEPTION 'ARTIFACT_CREATION_IDEMPOTENCY_SCOPE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "source_prototype_creation_idempotency_guard" BEFORE INSERT ON "source_prototype_creation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_creation_idempotency_scope"();
CREATE TRIGGER "artifact_creation_idempotency_scope_guard" BEFORE INSERT ON "artifact_creation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_artifact_creation_idempotency_scope"();

CREATE FUNCTION "guard_source_prototype_creation_receipt"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'SOURCE_PROTOTYPE_CREATION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "artifacts" artifact
    JOIN "artifact_versions" version ON version."id" = NEW."artifact_version_id"
      AND version."artifact_id" = artifact."id" AND version."project_id" = artifact."project_id"
    WHERE artifact."id" = NEW."artifact_id" AND artifact."project_id" = NEW."project_id"
      AND artifact."kind" = 'prototype' AND artifact."revision" = 1
      AND artifact."current_version_id" = version."id"
      AND version."version" = 1 AND version."schema_version" = 2 AND version."status" = 'ready'
      AND version."content_blob_id" IS NULL AND version."content"->>'protocol' = 'workbench.prototype-source.v1'
      AND version."citations" = '[]'::jsonb AND version."created_by_run_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'SOURCE_PROTOTYPE_CREATION_RECEIPT_RESULT_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "source_prototype_creation_receipts_guard" BEFORE INSERT OR UPDATE ON "source_prototype_creation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_source_prototype_creation_receipt"();
