BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TYPE "PrototypeMutationKind" ADD VALUE IF NOT EXISTS 'plan_update';
ALTER TYPE "PrototypeMutationKind" ADD VALUE IF NOT EXISTS 'revision_plan';
ALTER TABLE "prototype_plans" ADD COLUMN "input_snapshot" JSONB;
ALTER TABLE "prototype_plans" ADD CONSTRAINT "prototype_plans_input_snapshot_object" CHECK (input_snapshot IS NULL OR jsonb_typeof(input_snapshot) = 'object');
CREATE OR REPLACE FUNCTION enforce_prototype_plan_inputs_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.project_id <> OLD.project_id OR NEW.created_by_id <> OLD.created_by_id OR NEW.root_plan_id IS DISTINCT FROM OLD.root_plan_id OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR NEW.content_version <> OLD.content_version OR NEW.feedback_ids IS DISTINCT FROM OLD.feedback_ids THEN
   RAISE EXCEPTION 'Prototype plan identity and lineage are immutable';
 END IF;
 IF NEW.generation_request IS DISTINCT FROM OLD.generation_request OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot OR NEW.prompt <> OLD.prompt OR NEW.title <> OLD.title THEN
   IF OLD.status <> 'draft' OR NEW.status <> 'draft' OR OLD.runtime_run_id IS NOT NULL OR NEW.runtime_run_id IS NOT NULL OR NEW.revision <> OLD.revision + 1 THEN
     RAISE EXCEPTION 'Prototype generation inputs are immutable outside a draft CAS adjustment';
   END IF;
 END IF;
 RETURN NEW;
END $$;
-- The immutable approved Plan is an explicit snapshot owner. All source manifest and Run limits below remain enforced.
CREATE OR REPLACE FUNCTION "guard_run_source_snapshot_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status "RunStatus";
  retry_source_id TEXT;
  source_status "ImportSourceStatus";
  source_revision INTEGER;
  source_kind "ImportSourceKind";
  source_label TEXT;
  source_checksum TEXT;
  source_descriptor JSONB;
  source_manifest_count INTEGER;
  run_blob_count INTEGER;
  expected_blob_count INTEGER;
  actual_blob_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "runs" WHERE "id" = OLD."run_id") THEN
      RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT run."status", run."retry_of_run_id"
  INTO run_status, retry_source_id
  FROM "runs" AS run
  WHERE run."id" = NEW."run_id" AND run."project_id" = NEW."project_id"
  FOR SHARE;
  IF run_status IS DISTINCT FROM 'queued'::"RunStatus" THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_RUN_NOT_QUEUED' USING ERRCODE = '23514';
  END IF;

  SELECT source."status", source."revision", source."kind", source."label", source."checksum", source."descriptor"
  INTO source_status, source_revision, source_kind, source_label, source_checksum, source_descriptor
  FROM "import_sources" AS source
  WHERE source."id" = NEW."source_id" AND source."project_id" = NEW."project_id"
  FOR SHARE;
  IF source_kind IS NULL THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_SOURCE_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  expected_blob_count := jsonb_array_length(NEW."snapshot" -> 'blobs');
  SELECT COALESCE(sum(jsonb_array_length(snapshot."snapshot" -> 'blobs')), 0)::INTEGER
  INTO run_blob_count
  FROM "run_source_snapshots" AS snapshot
  WHERE snapshot."run_id" = NEW."run_id";
  IF run_blob_count + expected_blob_count > 50 THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_BLOB_LIMIT_EXCEEDED' USING ERRCODE = '23514';
  END IF;

  IF retry_source_id IS NULL THEN
    IF (source_status IS DISTINCT FROM 'ready'::"ImportSourceStatus"
      OR source_checksum IS DISTINCT FROM NEW."checksum"
      OR source_kind IS DISTINCT FROM NEW."kind"
      OR source_label IS DISTINCT FROM NEW."label"
      OR source_descriptor IS DISTINCT FROM NEW."descriptor"
      OR NEW."snapshot" ->> 'sourceRevision' <> source_revision::TEXT)
      AND NOT EXISTS (
        SELECT 1 FROM "prototype_plans" AS plan
        JOIN "runs" AS run ON run."id" = NEW."run_id" AND run."project_id" = plan."project_id" AND run."idempotency_key" = 'prototype:' || plan."id"
        WHERE plan."project_id" = NEW."project_id" AND plan."status" IN ('approved', 'generating')
          AND plan."input_snapshot" -> 'sources' -> NEW."position" = jsonb_build_object(
            'sourceId', NEW."source_id", 'kind', NEW."kind", 'label', NEW."label", 'checksum', NEW."checksum", 'descriptor', NEW."descriptor", 'snapshot', NEW."snapshot")
      )
    THEN
      RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_SOURCE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::INTEGER
    INTO source_manifest_count
    FROM "import_source_blobs" AS source_blob
    WHERE source_blob."import_source_id" = NEW."source_id";
    IF expected_blob_count IS DISTINCT FROM source_manifest_count
      OR EXISTS (
        SELECT 1
        FROM "import_source_blobs" AS source_blob
        LEFT JOIN LATERAL (
          SELECT manifest.value
          FROM jsonb_array_elements(NEW."snapshot" -> 'blobs') WITH ORDINALITY AS manifest(value, ordinal)
          WHERE manifest.ordinal - 1 = source_blob."position"
        ) AS manifest ON TRUE
        WHERE source_blob."import_source_id" = NEW."source_id"
          AND (
            manifest.value IS NULL
            OR manifest.value ->> 'blobId' IS DISTINCT FROM source_blob."blob_id"
            OR manifest.value ->> 'role' IS DISTINCT FROM source_blob."role"
            OR manifest.value ->> 'path' IS DISTINCT FROM source_blob."path"
            OR manifest.value ->> 'mediaType' IS DISTINCT FROM source_blob."media_type"
            OR CASE
              WHEN manifest.value ->> 'byteSize' ~ '^[0-9]+$'
              THEN (manifest.value ->> 'byteSize')::BIGINT
              ELSE -1
            END IS DISTINCT FROM source_blob."byte_size"
            OR manifest.value ->> 'sha256' IS DISTINCT FROM source_blob."sha256"
          )
      )
    THEN
      RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_MANIFEST_SOURCE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM "run_source_snapshots" AS original
      WHERE original."run_id" = retry_source_id
        AND original."position" = NEW."position"
        AND original."source_id" = NEW."source_id"
        AND original."kind" = NEW."kind"
        AND original."label" = NEW."label"
        AND original."checksum" = NEW."checksum"
        AND original."descriptor" = NEW."descriptor"
        AND original."snapshot" = NEW."snapshot"
    ) THEN
      RAISE EXCEPTION 'RUN_RETRY_SOURCE_SNAPSHOT_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT jsonb_array_length(NEW."snapshot" -> 'blobs')
  INTO expected_blob_count;
  SELECT count(*)::INTEGER
  INTO actual_blob_count
  FROM jsonb_array_elements(NEW."snapshot" -> 'blobs') AS manifest;
  IF expected_blob_count IS DISTINCT FROM actual_blob_count THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_MANIFEST_INVALID' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."snapshot" -> 'blobs') WITH ORDINALITY AS manifest(value, ordinal)
    WHERE (manifest.value ->> 'position')::INTEGER <> manifest.ordinal - 1
      OR length(COALESCE(manifest.value ->> 'blobId', '')) = 0
      OR (manifest.value ->> 'sha256') !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'RUN_SOURCE_SNAPSHOT_MANIFEST_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
