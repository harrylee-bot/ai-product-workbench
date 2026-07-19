-- Production Knowledge releases pin one adopted embedding profile and advance
-- through durable batches. There is intentionally no compatibility backfill:
-- pre-production release projections must be rebuilt from the approved Vault.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "knowledge_releases") THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_REBUILD_REQUIRED' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TYPE "KnowledgeEmbeddingBatchStatus" AS ENUM (
  'pending',
  'running',
  'ready',
  'failed'
);

ALTER TABLE "embedding_profiles"
ADD CONSTRAINT "embedding_profiles_id_spec_sha256_dimension_key"
UNIQUE ("id", "spec_sha256", "dimension");

ALTER TABLE "knowledge_releases"
ADD COLUMN "embedding_profile_id" TEXT NOT NULL,
ADD COLUMN "embedding_profile_spec_sha256" TEXT NOT NULL,
ADD COLUMN "embedding_dimension" INTEGER NOT NULL,
ADD COLUMN "chunks_ready_at" TIMESTAMP(3),
ADD CONSTRAINT "knowledge_releases_embedding_profile_fkey"
  FOREIGN KEY ("embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension")
  REFERENCES "embedding_profiles"("id", "spec_sha256", "dimension")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_releases_id_embedding_profile_key"
  UNIQUE ("id", "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension"),
ADD CONSTRAINT "knowledge_releases_embedding_profile_sha256_format_check"
  CHECK ("embedding_profile_spec_sha256" ~ '^[0-9a-f]{64}$'),
ADD CONSTRAINT "knowledge_releases_embedding_dimension_range_check"
  CHECK ("embedding_dimension" BETWEEN 1 AND 16000),
ADD CONSTRAINT "knowledge_releases_chunks_ready_state_check"
  CHECK (
    ("status" IN ('building', 'failed'))
    OR ("status" IN ('ready', 'retired') AND "chunks_ready_at" IS NOT NULL)
  );

CREATE INDEX "knowledge_releases_embedding_profile_id_status_idx"
ON "knowledge_releases"("embedding_profile_id", "status");

ALTER TABLE "knowledge_chunk_embeddings"
ADD COLUMN "profile_spec_sha256" TEXT;

UPDATE "knowledge_chunk_embeddings" AS embedding
SET "profile_spec_sha256" = profile."spec_sha256"
FROM "embedding_profiles" AS profile
WHERE profile."id" = embedding."profile_id"
  AND profile."dimension" = embedding."dimension";

ALTER TABLE "knowledge_chunk_embeddings"
ALTER COLUMN "profile_spec_sha256" SET NOT NULL,
DROP CONSTRAINT "knowledge_chunk_embeddings_profile_id_dimension_fkey",
ADD CONSTRAINT "knowledge_chunk_embeddings_profile_id_spec_sha256_dimension_fkey"
  FOREIGN KEY ("profile_id", "profile_spec_sha256", "dimension")
  REFERENCES "embedding_profiles"("id", "spec_sha256", "dimension")
  ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_chunk_embeddings_profile_spec_sha256_format_check"
  CHECK ("profile_spec_sha256" ~ '^[0-9a-f]{64}$');

CREATE TABLE "knowledge_embedding_batches" (
  "id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "profile_id" TEXT NOT NULL,
  "profile_spec_sha256" TEXT NOT NULL,
  "dimension" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "chunk_ids" TEXT[] NOT NULL,
  "input_count" INTEGER NOT NULL,
  "input_sha256" TEXT NOT NULL,
  "status" "KnowledgeEmbeddingBatchStatus" NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "queue_job_id" TEXT,
  "queue_retry_count" INTEGER,
  "token_count" INTEGER,
  "output_sha256" TEXT,
  "last_error_code" TEXT,
  "last_error_detail" TEXT,
  "last_error_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_embedding_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_embedding_batches_release_profile_fkey"
    FOREIGN KEY ("release_id", "profile_id", "profile_spec_sha256", "dimension")
    REFERENCES "knowledge_releases"(
      "id", "embedding_profile_id", "embedding_profile_spec_sha256", "embedding_dimension"
    ) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "knowledge_embedding_batches_profile_fkey"
    FOREIGN KEY ("profile_id", "profile_spec_sha256", "dimension")
    REFERENCES "embedding_profiles"("id", "spec_sha256", "dimension")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "knowledge_embedding_batches_sequence_nonnegative_check"
    CHECK ("sequence" >= 0),
  CONSTRAINT "knowledge_embedding_batches_input_count_positive_check"
    CHECK ("input_count" > 0 AND cardinality("chunk_ids") = "input_count"),
  CONSTRAINT "knowledge_embedding_batches_attempt_count_nonnegative_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "knowledge_embedding_batches_queue_retry_count_check"
    CHECK ("queue_retry_count" IS NULL OR "queue_retry_count" >= 0),
  CONSTRAINT "knowledge_embedding_batches_token_count_check"
    CHECK ("token_count" IS NULL OR "token_count" >= 0),
  CONSTRAINT "knowledge_embedding_batches_sha256_format_check"
    CHECK (
      "input_sha256" ~ '^[0-9a-f]{64}$'
      AND ("output_sha256" IS NULL OR "output_sha256" ~ '^[0-9a-f]{64}$')
      AND "profile_spec_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "knowledge_embedding_batches_error_pair_check"
    CHECK (("last_error_code" IS NULL) = ("last_error_at" IS NULL)),
  CONSTRAINT "knowledge_embedding_batches_state_check"
    CHECK (
      (
        "status" = 'pending'
        AND "lease_token" IS NULL
        AND "queue_job_id" IS NULL
        AND "queue_retry_count" IS NULL
        AND "token_count" IS NULL
        AND "output_sha256" IS NULL
        AND "started_at" IS NULL
        AND "finished_at" IS NULL
      )
      OR (
        "status" = 'running'
        AND "lease_token" IS NOT NULL
        AND "queue_job_id" IS NOT NULL
        AND "queue_retry_count" IS NOT NULL
        AND "token_count" IS NULL
        AND "output_sha256" IS NULL
        AND "started_at" IS NOT NULL
        AND "finished_at" IS NULL
      )
      OR (
        "status" = 'ready'
        AND "lease_token" IS NULL
        AND "queue_job_id" IS NOT NULL
        AND "queue_retry_count" IS NOT NULL
        AND "token_count" IS NOT NULL
        AND "output_sha256" IS NOT NULL
        AND "started_at" IS NOT NULL
        AND "finished_at" IS NOT NULL
        AND "last_error_code" IS NULL
        AND "last_error_detail" IS NULL
        AND "last_error_at" IS NULL
      )
      OR (
        "status" = 'failed'
        AND "lease_token" IS NULL
        AND "output_sha256" IS NULL
        AND "finished_at" IS NOT NULL
        AND "last_error_code" IS NOT NULL
        AND "last_error_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "knowledge_embedding_batches_release_id_sequence_key"
ON "knowledge_embedding_batches"("release_id", "sequence");

CREATE INDEX "knowledge_embedding_batches_release_id_status_sequence_idx"
ON "knowledge_embedding_batches"("release_id", "status", "sequence");

CREATE INDEX "knowledge_embedding_batches_profile_idx"
ON "knowledge_embedding_batches"("profile_id", "profile_spec_sha256", "dimension");

CREATE OR REPLACE FUNCTION "guard_embedding_profile_mutation"()
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

  IF OLD."status" = 'adopted'
    AND NEW."status" = 'retired'
    AND EXISTS (
      SELECT 1
      FROM "knowledge_releases" AS release
      WHERE release."embedding_profile_id" = OLD."id"
        AND release."status" = 'building'
    )
  THEN
    RAISE EXCEPTION 'EMBEDDING_PROFILE_HAS_ACTIVE_RELEASE' USING ERRCODE = '23514';
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "guard_knowledge_chunk_embedding_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_release_status "KnowledgeReleaseStatus";
  owner_profile_id TEXT;
  owner_profile_spec_sha256 TEXT;
  owner_dimension INTEGER;
  owner_profile_status "EmbeddingProfileStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'KNOWLEDGE_CHUNK_EMBEDDING_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT
    release."status",
    release."embedding_profile_id",
    release."embedding_profile_spec_sha256",
    release."embedding_dimension",
    profile."status"
  INTO
    owner_release_status,
    owner_profile_id,
    owner_profile_spec_sha256,
    owner_dimension,
    owner_profile_status
  FROM "knowledge_releases" AS release
  JOIN "embedding_profiles" AS profile
    ON profile."id" = release."embedding_profile_id"
   AND profile."spec_sha256" = release."embedding_profile_spec_sha256"
   AND profile."dimension" = release."embedding_dimension"
  WHERE release."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."release_id" ELSE NEW."release_id" END
  FOR SHARE OF release, profile;

  -- A cascading release delete has already removed the parent from view.
  IF owner_release_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF owner_release_status <> 'building' THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."profile_id" IS DISTINCT FROM owner_profile_id
      OR NEW."profile_spec_sha256" IS DISTINCT FROM owner_profile_spec_sha256
      OR NEW."dimension" IS DISTINCT FROM owner_dimension
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_PROFILE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF owner_profile_status <> 'adopted' THEN
      RAISE EXCEPTION 'EMBEDDING_PROFILE_NOT_ADOPTED' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION "guard_knowledge_embedding_batch_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_release_status "KnowledgeReleaseStatus";
  distinct_chunk_count INTEGER;
BEGIN
  SELECT release."status"
  INTO owner_release_status
  FROM "knowledge_releases" AS release
  WHERE release."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."release_id" ELSE NEW."release_id" END
  FOR SHARE;

  IF owner_release_status IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF owner_release_status <> 'building' THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CONTENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' OR NEW."attempt_count" <> 0 THEN
      RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_INITIAL_STATE_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT COUNT(DISTINCT chunk_id)::INTEGER
    INTO distinct_chunk_count
    FROM unnest(NEW."chunk_ids") AS chunk_id;
    IF distinct_chunk_count <> NEW."input_count"
      OR EXISTS (
        SELECT 1
        FROM unnest(NEW."chunk_ids") AS requested(chunk_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM "knowledge_chunks" AS chunk
          WHERE chunk."id" = requested.chunk_id
            AND chunk."release_id" = NEW."release_id"
        )
      )
      OR EXISTS (
        SELECT 1
        FROM "knowledge_embedding_batches" AS existing
        WHERE existing."release_id" = NEW."release_id"
          AND existing."chunk_ids" && NEW."chunk_ids"
      )
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_CHUNKS_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'ready' THEN
      RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_READY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
    OR NEW."profile_id" IS DISTINCT FROM OLD."profile_id"
    OR NEW."profile_spec_sha256" IS DISTINCT FROM OLD."profile_spec_sha256"
    OR NEW."dimension" IS DISTINCT FROM OLD."dimension"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."chunk_ids" IS DISTINCT FROM OLD."chunk_ids"
    OR NEW."input_count" IS DISTINCT FROM OLD."input_count"
    OR NEW."input_sha256" IS DISTINCT FROM OLD."input_sha256"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'ready' THEN
    RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_READY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" = 'pending' AND NEW."status" IN ('running', 'failed'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('pending', 'ready', 'failed'))
  ) THEN
    RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" = 'running' THEN
    IF NEW."attempt_count" <> OLD."attempt_count" + 1 THEN
      RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_ATTEMPT_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."attempt_count" <> OLD."attempt_count" THEN
    RAISE EXCEPTION 'KNOWLEDGE_EMBEDDING_BATCH_ATTEMPT_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_embedding_batches_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_embedding_batches"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_embedding_batch_mutation"();

CREATE OR REPLACE FUNCTION "guard_knowledge_release_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  pinned_profile_status "EmbeddingProfileStatus";
  expected_chunk_count INTEGER;
  embedded_chunk_count INTEGER;
  batched_chunk_count INTEGER;
  distinct_batched_chunk_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('ready', 'retired') THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT profile."status"
  INTO pinned_profile_status
  FROM "embedding_profiles" AS profile
  WHERE profile."id" = NEW."embedding_profile_id"
    AND profile."spec_sha256" = NEW."embedding_profile_spec_sha256"
    AND profile."dimension" = NEW."embedding_dimension"
  FOR SHARE;
  IF (TG_OP = 'INSERT' OR OLD."status" = 'building')
    AND pinned_profile_status IS DISTINCT FROM 'adopted'::"EmbeddingProfileStatus"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_PROFILE_NOT_ADOPTED' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."key" IS DISTINCT FROM OLD."key"
      OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."embedding_profile_id" IS DISTINCT FROM OLD."embedding_profile_id"
      OR NEW."embedding_profile_spec_sha256" IS DISTINCT FROM OLD."embedding_profile_spec_sha256"
      OR NEW."embedding_dimension" IS DISTINCT FROM OLD."embedding_dimension"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."started_at" IS NOT NULL
      AND NEW."started_at" IS DISTINCT FROM OLD."started_at"
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_STARTED_AT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD."chunks_ready_at" IS NOT NULL
      AND NEW."chunks_ready_at" IS DISTINCT FROM OLD."chunks_ready_at"
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CHUNKS_CHECKPOINT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('ready', 'retired') THEN
      IF NEW."manifest_sha256" IS DISTINCT FROM OLD."manifest_sha256"
        OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
        OR NEW."ready_at" IS DISTINCT FROM OLD."ready_at"
        OR NEW."build_attempt" IS DISTINCT FROM OLD."build_attempt"
        OR NEW."lease_token" IS DISTINCT FROM OLD."lease_token"
        OR NEW."lease_expires_at" IS DISTINCT FROM OLD."lease_expires_at"
        OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
        OR NEW."chunks_ready_at" IS DISTINCT FROM OLD."chunks_ready_at"
        OR NOT (
          NEW."status" = OLD."status"
          OR (OLD."status" = 'ready' AND NEW."status" = 'retired')
        )
      THEN
        RAISE EXCEPTION 'KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."status" = 'failed' THEN
      IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'KNOWLEDGE_RELEASE_FAILED_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT (
      OLD."status" = 'building'
      AND NEW."status" IN ('building', 'ready', 'failed')
    ) THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'ready' AND (TG_OP = 'INSERT' OR OLD."status" <> 'ready') THEN
    IF NEW."chunks_ready_at" IS NULL THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_CHUNKS_NOT_READY' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "knowledge_embedding_batches" AS batch
      WHERE batch."release_id" = NEW."id"
        AND batch."status" <> 'ready'
    ) THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_EMBEDDING_BATCHES_INCOMPLETE' USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::INTEGER
    INTO expected_chunk_count
    FROM "knowledge_chunks" AS chunk
    WHERE chunk."release_id" = NEW."id";

    SELECT COUNT(*)::INTEGER
    INTO embedded_chunk_count
    FROM "knowledge_chunk_embeddings" AS embedding
    WHERE embedding."release_id" = NEW."id"
      AND embedding."profile_id" = NEW."embedding_profile_id"
      AND embedding."profile_spec_sha256" = NEW."embedding_profile_spec_sha256"
      AND embedding."dimension" = NEW."embedding_dimension";

    SELECT COALESCE(SUM(batch."input_count"), 0)::INTEGER
    INTO batched_chunk_count
    FROM "knowledge_embedding_batches" AS batch
    WHERE batch."release_id" = NEW."id"
      AND batch."status" = 'ready';

    SELECT COUNT(DISTINCT requested.chunk_id)::INTEGER
    INTO distinct_batched_chunk_count
    FROM "knowledge_embedding_batches" AS batch
    CROSS JOIN LATERAL unnest(batch."chunk_ids") AS requested(chunk_id)
    WHERE batch."release_id" = NEW."id"
      AND batch."status" = 'ready';

    IF embedded_chunk_count <> expected_chunk_count
      OR batched_chunk_count <> expected_chunk_count
      OR distinct_batched_chunk_count <> expected_chunk_count
      OR EXISTS (
        SELECT 1
        FROM "knowledge_embedding_batches" AS batch
        CROSS JOIN LATERAL unnest(batch."chunk_ids") AS requested(chunk_id)
        WHERE batch."release_id" = NEW."id"
          AND batch."status" = 'ready'
          AND NOT EXISTS (
            SELECT 1
            FROM "knowledge_chunks" AS chunk
            WHERE chunk."id" = requested.chunk_id
              AND chunk."release_id" = NEW."id"
          )
      )
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_EMBEDDING_INCOMPLETE' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
