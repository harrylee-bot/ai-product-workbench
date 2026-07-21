BEGIN;

CREATE TABLE "ready_object_integrity_incidents" (
  "id" TEXT NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "storage_key" TEXT NOT NULL,
  "failure_code" VARCHAR(120) NOT NULL,
  "expected_sha256" CHAR(64) NOT NULL,
  "expected_byte_size" BIGINT NOT NULL,
  "expected_media_type" TEXT NOT NULL,
  "observed_sha256" CHAR(64),
  "observed_byte_size" BIGINT,
  "observed_media_type" VARCHAR(512),
  "observed_content_range" VARCHAR(512),
  "occurrence_count" INTEGER NOT NULL DEFAULT 1,
  "first_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ready_object_integrity_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ready_object_integrity_incidents_fingerprint_key" UNIQUE ("fingerprint"),
  CONSTRAINT "ready_object_integrity_incidents_fingerprint_check"
    CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ready_object_integrity_incidents_failure_code_check"
    CHECK ("failure_code" IN (
      'OBJECT_STORAGE_BYTE_SIZE_MISMATCH',
      'OBJECT_STORAGE_MEDIA_TYPE_MISMATCH',
      'OBJECT_STORAGE_CONTENT_RANGE_MISMATCH',
      'OBJECT_STORAGE_SHA256_MISMATCH'
    )),
  CONSTRAINT "ready_object_integrity_incidents_expected_manifest_check"
    CHECK (
      "storage_key" <> ''
      AND "expected_sha256" ~ '^[0-9a-f]{64}$'
      AND "expected_byte_size" > 0
      AND "expected_media_type" <> ''
    ),
  CONSTRAINT "ready_object_integrity_incidents_observed_sha256_check"
    CHECK ("observed_sha256" IS NULL OR "observed_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ready_object_integrity_incidents_occurrence_check"
    CHECK ("occurrence_count" > 0),
  CONSTRAINT "ready_object_integrity_incidents_detection_order_check"
    CHECK ("last_detected_at" >= "first_detected_at")
);

CREATE INDEX "ready_object_integrity_incidents_storage_detected_idx"
  ON "ready_object_integrity_incidents" ("storage_key", "last_detected_at");
CREATE INDEX "ready_object_integrity_incidents_failure_detected_idx"
  ON "ready_object_integrity_incidents" ("failure_code", "last_detected_at");

CREATE TABLE "ready_object_integrity_retention_releases" (
  "id" TEXT NOT NULL,
  "incident_id" TEXT NOT NULL,
  "released_occurrence_count" INTEGER NOT NULL,
  "release_reference" VARCHAR(256) NOT NULL,
  "released_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ready_object_integrity_retention_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ready_object_integrity_release_occurrence_key"
    UNIQUE ("incident_id", "released_occurrence_count"),
  CONSTRAINT "ready_object_integrity_retention_releases_occurrence_check"
    CHECK ("released_occurrence_count" > 0),
  CONSTRAINT "ready_object_integrity_retention_releases_reference_check"
    CHECK (length("release_reference") BETWEEN 1 AND 256),
  CONSTRAINT "ready_object_integrity_retention_releases_incident_id_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "ready_object_integrity_incidents"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "ready_object_integrity_release_incident_released_idx"
  ON "ready_object_integrity_retention_releases" ("incident_id", "released_at");

CREATE FUNCTION "guard_ready_object_integrity_incident_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'READY_OBJECT_INTEGRITY_INCIDENT_DELETE_FORBIDDEN' USING ERRCODE = '23514';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
    OR NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
    OR NEW."expected_sha256" IS DISTINCT FROM OLD."expected_sha256"
    OR NEW."expected_byte_size" IS DISTINCT FROM OLD."expected_byte_size"
    OR NEW."expected_media_type" IS DISTINCT FROM OLD."expected_media_type"
    OR NEW."observed_sha256" IS DISTINCT FROM OLD."observed_sha256"
    OR NEW."observed_byte_size" IS DISTINCT FROM OLD."observed_byte_size"
    OR NEW."observed_media_type" IS DISTINCT FROM OLD."observed_media_type"
    OR NEW."observed_content_range" IS DISTINCT FROM OLD."observed_content_range"
    OR NEW."first_detected_at" IS DISTINCT FROM OLD."first_detected_at"
    OR NEW."occurrence_count" <> OLD."occurrence_count" + 1
    OR NEW."last_detected_at" < OLD."last_detected_at"
  THEN
    RAISE EXCEPTION 'READY_OBJECT_INTEGRITY_INCIDENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ready_object_integrity_incident_update_guard"
BEFORE UPDATE OR DELETE ON "ready_object_integrity_incidents"
FOR EACH ROW EXECUTE FUNCTION "guard_ready_object_integrity_incident_update"();

CREATE FUNCTION "guard_ready_object_integrity_audit_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'READY_OBJECT_INTEGRITY_AUDIT_TRUNCATE_FORBIDDEN' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "ready_object_integrity_incident_truncate_guard"
BEFORE TRUNCATE ON "ready_object_integrity_incidents"
FOR EACH STATEMENT EXECUTE FUNCTION "guard_ready_object_integrity_audit_truncate"();

CREATE FUNCTION "guard_ready_object_integrity_retention_release_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  incident_occurrence_count INTEGER;
  table_owner NAME;
BEGIN
  SELECT pg_get_userbyid(class."relowner")
  INTO table_owner
  FROM pg_class AS class
  WHERE class."oid" = TG_RELID;
  IF current_user IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'READY_OBJECT_INTEGRITY_RELEASE_REQUIRES_OWNER' USING ERRCODE = '42501';
  END IF;

  EXECUTE format(
    'SELECT "occurrence_count" FROM %I."ready_object_integrity_incidents" WHERE "id" = $1 FOR SHARE',
    TG_TABLE_SCHEMA
  )
  INTO incident_occurrence_count
  USING NEW."incident_id";
  IF incident_occurrence_count IS NULL
    OR NEW."released_occurrence_count" <> incident_occurrence_count
  THEN
    RAISE EXCEPTION 'READY_OBJECT_INTEGRITY_RELEASE_OCCURRENCE_STALE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ready_object_integrity_retention_release_insert_guard"
BEFORE INSERT ON "ready_object_integrity_retention_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_ready_object_integrity_retention_release_insert"();

CREATE FUNCTION "guard_ready_object_integrity_retention_release_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'READY_OBJECT_INTEGRITY_RELEASE_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "ready_object_integrity_retention_release_mutation_guard"
BEFORE UPDATE OR DELETE ON "ready_object_integrity_retention_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_ready_object_integrity_retention_release_mutation"();

CREATE TRIGGER "ready_object_integrity_retention_release_truncate_guard"
BEFORE TRUNCATE ON "ready_object_integrity_retention_releases"
FOR EACH STATEMENT EXECUTE FUNCTION "guard_ready_object_integrity_audit_truncate"();

COMMIT;
