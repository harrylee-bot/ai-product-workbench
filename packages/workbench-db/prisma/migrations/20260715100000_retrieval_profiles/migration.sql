-- Retrieval profiles are immutable, independently adopted retrieval contracts.
-- A KnowledgeRelease pins the retrieval contract and its embedded vector
-- contract as one composite identity, so the two cannot drift apart.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "knowledge_releases") THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_RETRIEVAL_PROFILE_REBUILD_REQUIRED' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TYPE "RetrievalProfileStatus" AS ENUM (
  'candidate',
  'poc',
  'adopted',
  'retired'
);

CREATE TABLE "retrieval_profiles" (
  "id" TEXT NOT NULL,
  "spec" JSONB NOT NULL,
  "spec_sha256" TEXT NOT NULL,
  "embedding_profile_id" TEXT NOT NULL,
  "embedding_profile_spec_sha256" TEXT NOT NULL,
  "embedding_dimension" INTEGER NOT NULL,
  "status" "RetrievalProfileStatus" NOT NULL DEFAULT 'candidate',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "retrieval_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "retrieval_profiles_embedding_profile_fkey"
    FOREIGN KEY (
      "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension"
    ) REFERENCES "embedding_profiles"("id", "spec_sha256", "dimension")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "retrieval_profiles_spec_object_check"
    CHECK (jsonb_typeof("spec") = 'object'),
  CONSTRAINT "retrieval_profiles_spec_schema_check"
    CHECK ("spec" ->> 'schema' = 'workbench.retrieval-profile.v1'),
  CONSTRAINT "retrieval_profiles_spec_id_check"
    CHECK ("spec" ->> 'id' = "id"),
  CONSTRAINT "retrieval_profiles_spec_embedding_object_check"
    CHECK (jsonb_typeof("spec" -> 'embedding') = 'object'),
  CONSTRAINT "retrieval_profiles_spec_embedding_profile_id_check"
    CHECK ("spec" #>> '{embedding,profileId}' = "embedding_profile_id"),
  CONSTRAINT "retrieval_profiles_spec_embedding_sha256_check"
    CHECK (
      "spec" #>> '{embedding,profileSpecSha256}' = "embedding_profile_spec_sha256"
    ),
  CONSTRAINT "retrieval_profiles_spec_embedding_dimension_check"
    CHECK (
      jsonb_path_query_first("spec", '$.embedding.dimension') = to_jsonb("embedding_dimension")
    ),
  CONSTRAINT "retrieval_profiles_spec_routing_policy_check"
    CHECK ("spec" ->> 'routingPolicy' = 'workbench-knowledge-route-v1'),
  CONSTRAINT "retrieval_profiles_spec_citation_schema_check"
    CHECK ("spec" ->> 'citationSchema' = 'workbench.knowledge-citation.v1'),
  CONSTRAINT "retrieval_profiles_id_format_check"
    CHECK (
      length("id") BETWEEN 1 AND 128
      AND "id" ~ '^[a-z0-9][a-z0-9._-]*$'
    ),
  CONSTRAINT "retrieval_profiles_sha256_format_check"
    CHECK (
      "spec_sha256" ~ '^[0-9a-f]{64}$'
      AND "embedding_profile_spec_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "retrieval_profiles_embedding_dimension_range_check"
    CHECK ("embedding_dimension" BETWEEN 1 AND 16000)
);

CREATE UNIQUE INDEX "retrieval_profiles_spec_sha256_key"
ON "retrieval_profiles"("spec_sha256");

CREATE UNIQUE INDEX "retrieval_profiles_id_spec_sha256_key"
ON "retrieval_profiles"("id", "spec_sha256");

CREATE UNIQUE INDEX "retrieval_profiles_identity_key"
ON "retrieval_profiles"(
  "id", "spec_sha256", "embedding_profile_id",
  "embedding_profile_spec_sha256", "embedding_dimension"
);

CREATE INDEX "retrieval_profiles_status_created_at_idx"
ON "retrieval_profiles"("status", "created_at");

CREATE INDEX "retrieval_profiles_embedding_status_idx"
ON "retrieval_profiles"(
  "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension", "status"
);

ALTER TABLE "knowledge_releases"
ADD COLUMN "retrieval_profile_id" TEXT NOT NULL,
ADD COLUMN "retrieval_profile_spec_sha256" TEXT NOT NULL,
ADD CONSTRAINT "knowledge_releases_retrieval_profile_fkey"
  FOREIGN KEY (
    "retrieval_profile_id", "retrieval_profile_spec_sha256",
    "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension"
  ) REFERENCES "retrieval_profiles"(
    "id", "spec_sha256", "embedding_profile_id",
    "embedding_profile_spec_sha256", "embedding_dimension"
  ) ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_releases_retrieval_profile_key"
  UNIQUE (
    "id", "retrieval_profile_id", "retrieval_profile_spec_sha256",
    "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension"
  ),
ADD CONSTRAINT "knowledge_releases_retrieval_profile_sha256_format_check"
  CHECK ("retrieval_profile_spec_sha256" ~ '^[0-9a-f]{64}$');

CREATE INDEX "knowledge_releases_retrieval_profile_id_status_idx"
ON "knowledge_releases"("retrieval_profile_id", "status");

CREATE FUNCTION "guard_retrieval_profile_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  pinned_embedding_status "EmbeddingProfileStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RETRIEVAL_PROFILE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT profile."status"
  INTO pinned_embedding_status
  FROM "embedding_profiles" AS profile
  WHERE profile."id" = NEW."embedding_profile_id"
    AND profile."spec_sha256" = NEW."embedding_profile_spec_sha256"
    AND profile."dimension" = NEW."embedding_dimension"
  FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'candidate' THEN
      RAISE EXCEPTION 'RETRIEVAL_PROFILE_INITIAL_STATUS_INVALID' USING ERRCODE = '23514';
    END IF;
    IF pinned_embedding_status IS NULL OR pinned_embedding_status = 'retired' THEN
      RAISE EXCEPTION 'RETRIEVAL_PROFILE_EMBEDDING_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."spec" IS DISTINCT FROM OLD."spec"
    OR NEW."spec_sha256" IS DISTINCT FROM OLD."spec_sha256"
    OR NEW."embedding_profile_id" IS DISTINCT FROM OLD."embedding_profile_id"
    OR NEW."embedding_profile_spec_sha256" IS DISTINCT FROM OLD."embedding_profile_spec_sha256"
    OR NEW."embedding_dimension" IS DISTINCT FROM OLD."embedding_dimension"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'RETRIEVAL_PROFILE_SPEC_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW."status" = OLD."status"
    OR (OLD."status" = 'candidate' AND NEW."status" IN ('poc', 'retired'))
    OR (OLD."status" = 'poc' AND NEW."status" IN ('adopted', 'retired'))
    OR (OLD."status" = 'adopted' AND NEW."status" = 'retired')
  ) THEN
    RAISE EXCEPTION 'RETRIEVAL_PROFILE_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'adopted'
    AND pinned_embedding_status IS DISTINCT FROM 'adopted'::"EmbeddingProfileStatus"
  THEN
    RAISE EXCEPTION 'RETRIEVAL_PROFILE_EMBEDDING_NOT_ADOPTED' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'adopted'
    AND NEW."status" = 'retired'
    AND EXISTS (
      SELECT 1
      FROM "knowledge_releases" AS release
      WHERE release."retrieval_profile_id" = OLD."id"
        AND release."retrieval_profile_spec_sha256" = OLD."spec_sha256"
        AND release."status" = 'building'
    )
  THEN
    RAISE EXCEPTION 'RETRIEVAL_PROFILE_HAS_ACTIVE_RELEASE' USING ERRCODE = '23514';
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "retrieval_profiles_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "retrieval_profiles"
FOR EACH ROW EXECUTE FUNCTION "guard_retrieval_profile_mutation"();

CREATE FUNCTION "guard_knowledge_release_retrieval_profile"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  pinned_retrieval_status "RetrievalProfileStatus";
  pinned_embedding_profile_id TEXT;
  pinned_embedding_profile_spec_sha256 TEXT;
  pinned_embedding_dimension INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."retrieval_profile_id" IS DISTINCT FROM OLD."retrieval_profile_id"
    OR NEW."retrieval_profile_spec_sha256" IS DISTINCT FROM OLD."retrieval_profile_spec_sha256"
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT
    profile."status",
    profile."embedding_profile_id",
    profile."embedding_profile_spec_sha256",
    profile."embedding_dimension"
  INTO
    pinned_retrieval_status,
    pinned_embedding_profile_id,
    pinned_embedding_profile_spec_sha256,
    pinned_embedding_dimension
  FROM "retrieval_profiles" AS profile
  WHERE profile."id" = NEW."retrieval_profile_id"
    AND profile."spec_sha256" = NEW."retrieval_profile_spec_sha256"
  FOR SHARE;

  IF (TG_OP = 'INSERT' OR OLD."status" = 'building')
    AND pinned_retrieval_status IS DISTINCT FROM 'adopted'::"RetrievalProfileStatus"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_RETRIEVAL_PROFILE_NOT_ADOPTED' USING ERRCODE = '23514';
  END IF;

  IF pinned_retrieval_status IS NOT NULL AND (
    pinned_embedding_profile_id IS DISTINCT FROM NEW."embedding_profile_id"
    OR pinned_embedding_profile_spec_sha256 IS DISTINCT FROM NEW."embedding_profile_spec_sha256"
    OR pinned_embedding_dimension IS DISTINCT FROM NEW."embedding_dimension"
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_RETRIEVAL_EMBEDDING_MISMATCH' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_releases_retrieval_profile_guard"
BEFORE INSERT OR UPDATE ON "knowledge_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_release_retrieval_profile"();

COMMIT;
