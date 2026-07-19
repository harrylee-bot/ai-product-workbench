-- Embedding profiles are immutable model contracts. Chunk content remains
-- independent from any vector provider so a new model revision never mutates
-- a published knowledge release in place.
BEGIN;

CREATE TYPE "EmbeddingProfileStatus" AS ENUM (
  'candidate',
  'poc',
  'adopted',
  'retired'
);

DROP INDEX "knowledge_chunks_embedding_hnsw_idx";

ALTER TABLE "knowledge_chunks"
DROP COLUMN "embedding_model",
DROP COLUMN "embedding",
ADD COLUMN "release_id" TEXT;

UPDATE "knowledge_chunks" AS chunk
SET "release_id" = document."release_id"
FROM "knowledge_documents" AS document
WHERE document."id" = chunk."document_id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "knowledge_chunks"
    WHERE "release_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_CHUNK_RELEASE_BACKFILL_FAILED' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "knowledge_chunks"
ALTER COLUMN "release_id" SET NOT NULL;

ALTER TABLE "knowledge_documents"
ADD CONSTRAINT "knowledge_documents_id_release_id_key"
UNIQUE ("id", "release_id");

ALTER TABLE "knowledge_chunks"
DROP CONSTRAINT "knowledge_chunks_document_id_fkey",
ADD CONSTRAINT "knowledge_chunks_id_release_id_key"
UNIQUE ("id", "release_id"),
ADD CONSTRAINT "knowledge_chunks_document_id_release_id_fkey"
FOREIGN KEY ("document_id", "release_id")
REFERENCES "knowledge_documents"("id", "release_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE INDEX "knowledge_chunks_release_id_idx"
ON "knowledge_chunks"("release_id");

CREATE TABLE "embedding_profiles" (
  "id" TEXT NOT NULL,
  "spec" JSONB NOT NULL,
  "spec_sha256" TEXT NOT NULL,
  "dimension" INTEGER NOT NULL,
  "status" "EmbeddingProfileStatus" NOT NULL DEFAULT 'candidate',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "embedding_profiles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_profiles_spec_object_check"
    CHECK (jsonb_typeof("spec") = 'object'),
  CONSTRAINT "embedding_profiles_spec_schema_check"
    CHECK ("spec" ->> 'schema' = 'workbench.embedding-profile.v1'),
  CONSTRAINT "embedding_profiles_spec_id_check"
    CHECK ("spec" ->> 'id' = "id"),
  CONSTRAINT "embedding_profiles_spec_dimension_check"
    CHECK (jsonb_path_query_first("spec", '$.output.dimension') = to_jsonb("dimension")),
  CONSTRAINT "embedding_profiles_spec_sha256_format_check"
    CHECK ("spec_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "embedding_profiles_dimension_range_check"
    CHECK ("dimension" BETWEEN 1 AND 16000)
);

CREATE UNIQUE INDEX "embedding_profiles_spec_sha256_key"
ON "embedding_profiles"("spec_sha256");

CREATE UNIQUE INDEX "embedding_profiles_id_dimension_key"
ON "embedding_profiles"("id", "dimension");

CREATE INDEX "embedding_profiles_status_created_at_idx"
ON "embedding_profiles"("status", "created_at");

CREATE TABLE "knowledge_chunk_embeddings" (
  "chunk_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "dimension" INTEGER NOT NULL,
  "embedding" public.vector NOT NULL,
  "embedding_sha256" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_chunk_embeddings_pkey"
    PRIMARY KEY ("chunk_id", "profile_id"),
  CONSTRAINT "knowledge_chunk_embeddings_dimension_range_check"
    CHECK ("dimension" BETWEEN 1 AND 16000),
  CONSTRAINT "knowledge_chunk_embeddings_vector_dimension_check"
    CHECK (public.vector_dims("embedding") = "dimension"),
  CONSTRAINT "knowledge_chunk_embeddings_l2_normalized_check"
    CHECK (abs(public.vector_norm("embedding") - 1.0) <= 0.001),
  CONSTRAINT "knowledge_chunk_embeddings_sha256_format_check"
    CHECK ("embedding_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_chunk_embeddings_chunk_id_release_id_fkey"
    FOREIGN KEY ("chunk_id", "release_id")
    REFERENCES "knowledge_chunks"("id", "release_id")
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "knowledge_chunk_embeddings_profile_id_dimension_fkey"
    FOREIGN KEY ("profile_id", "dimension")
    REFERENCES "embedding_profiles"("id", "dimension")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "knowledge_chunk_embeddings_release_id_profile_id_idx"
ON "knowledge_chunk_embeddings"("release_id", "profile_id");

CREATE INDEX "knowledge_chunk_embeddings_profile_id_dimension_idx"
ON "knowledge_chunk_embeddings"("profile_id", "dimension");

CREATE FUNCTION "guard_embedding_profile_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EMBEDDING_PROFILE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'candidate' THEN
      RAISE EXCEPTION 'EMBEDDING_PROFILE_INITIAL_STATUS_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."spec" IS DISTINCT FROM OLD."spec"
    OR NEW."spec_sha256" IS DISTINCT FROM OLD."spec_sha256"
    OR NEW."dimension" IS DISTINCT FROM OLD."dimension"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'EMBEDDING_PROFILE_SPEC_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    NEW."status" = OLD."status"
    OR (OLD."status" = 'candidate' AND NEW."status" IN ('poc', 'retired'))
    OR (OLD."status" = 'poc' AND NEW."status" IN ('adopted', 'retired'))
    OR (OLD."status" = 'adopted' AND NEW."status" = 'retired')
  ) THEN
    RAISE EXCEPTION 'EMBEDDING_PROFILE_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "embedding_profiles_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "embedding_profiles"
FOR EACH ROW EXECUTE FUNCTION "guard_embedding_profile_mutation"();

CREATE FUNCTION "guard_knowledge_chunk_embedding_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_release_id TEXT;
  owner_release_status "KnowledgeReleaseStatus";
  owner_profile_status "EmbeddingProfileStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KNOWLEDGE_CHUNK_EMBEDDING_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  owner_release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."release_id" ELSE NEW."release_id" END;

  SELECT release."status"
  INTO owner_release_status
  FROM "knowledge_releases" AS release
  WHERE release."id" = owner_release_id
  FOR SHARE;

  -- A cascading release delete has already removed the parent from view.
  IF owner_release_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF owner_release_status <> 'building' THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT profile."status"
    INTO owner_profile_status
    FROM "embedding_profiles" AS profile
    WHERE profile."id" = NEW."profile_id"
    FOR SHARE;

    IF owner_profile_status = 'retired' THEN
      RAISE EXCEPTION 'EMBEDDING_PROFILE_RETIRED' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "knowledge_chunk_embeddings_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_chunk_embeddings"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_chunk_embedding_mutation"();

CREATE OR REPLACE FUNCTION "guard_knowledge_chunk_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_release_id TEXT;
  owner_release_status "KnowledgeReleaseStatus";
BEGIN
  owner_release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."release_id" ELSE NEW."release_id" END;

  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_CHUNK_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT release."status"
  INTO owner_release_status
  FROM "knowledge_releases" AS release
  WHERE release."id" = owner_release_id
  FOR SHARE;

  -- A cascading release delete has already removed the parent from view.
  IF owner_release_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF owner_release_status <> 'building' THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMIT;
