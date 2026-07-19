-- Knowledge Profile administration is a separate, least-privilege control
-- plane. Adoption is complete only when the status transition and immutable
-- actor receipt commit together.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "embedding_profiles" WHERE "status" = 'adopted')
    OR EXISTS (SELECT 1 FROM "retrieval_profiles" WHERE "status" = 'adopted')
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_PROFILE_ADOPTION_RECEIPT_BACKFILL_REQUIRED'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TYPE "KnowledgeProfileKind" AS ENUM ('embedding', 'retrieval');
CREATE TYPE "KnowledgeProfileScope" AS ENUM ('global');
CREATE TYPE "KnowledgeProfileOperatorAction" AS ENUM ('grant', 'revoke');

CREATE TABLE "knowledge_profile_operator_events" (
  "id" BIGSERIAL NOT NULL,
  "principal_id" TEXT NOT NULL,
  "action" "KnowledgeProfileOperatorAction" NOT NULL,
  "authorized_by" TEXT NOT NULL,
  "change_reference" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_profile_operator_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_profile_operator_events_principal_id_fkey"
    FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "knowledge_profile_operator_events_authorized_by_check"
    CHECK (
      length("authorized_by") BETWEEN 1 AND 200
      AND "authorized_by" = btrim("authorized_by")
    ),
  CONSTRAINT "knowledge_profile_operator_events_change_reference_check"
    CHECK (
      length("change_reference") BETWEEN 3 AND 200
      AND "change_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
    )
);

CREATE UNIQUE INDEX "knowledge_profile_operator_events_change_reference_key"
ON "knowledge_profile_operator_events"("change_reference");

CREATE INDEX "knowledge_profile_operator_events_principal_id_id_idx"
ON "knowledge_profile_operator_events"("principal_id", "id");

CREATE FUNCTION "guard_knowledge_profile_operator_event_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'KNOWLEDGE_PROFILE_OPERATOR_EVENT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "knowledge_profile_operator_events_mutation_guard"
BEFORE UPDATE OR DELETE ON "knowledge_profile_operator_events"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_profile_operator_event_mutation"();

CREATE UNIQUE INDEX "embedding_profiles_id_spec_sha256_key"
ON "embedding_profiles"("id", "spec_sha256");

CREATE TABLE "knowledge_profile_adoption_receipts" (
  "id" TEXT NOT NULL,
  "profile_kind" "KnowledgeProfileKind" NOT NULL,
  "profile_version" INTEGER NOT NULL DEFAULT 1,
  "embedding_profile_id" TEXT,
  "embedding_profile_spec_sha256" TEXT,
  "retrieval_profile_id" TEXT,
  "retrieval_profile_spec_sha256" TEXT,
  "actor_principal_id" TEXT NOT NULL,
  "scope" "KnowledgeProfileScope" NOT NULL DEFAULT 'global',
  "adopted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_profile_adoption_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_profile_adoption_receipts_profile_version_check"
    CHECK ("profile_version" = 1),
  CONSTRAINT "knowledge_profile_adoption_receipts_identity_check"
    CHECK (
      (
        "profile_kind" = 'embedding'
        AND "embedding_profile_id" IS NOT NULL
        AND "embedding_profile_spec_sha256" IS NOT NULL
        AND "retrieval_profile_id" IS NULL
        AND "retrieval_profile_spec_sha256" IS NULL
      )
      OR (
        "profile_kind" = 'retrieval'
        AND "retrieval_profile_id" IS NOT NULL
        AND "retrieval_profile_spec_sha256" IS NOT NULL
        AND "embedding_profile_id" IS NULL
        AND "embedding_profile_spec_sha256" IS NULL
      )
    ),
  CONSTRAINT "knowledge_profile_adoption_receipts_hash_check"
    CHECK (
      ("embedding_profile_spec_sha256" IS NULL OR "embedding_profile_spec_sha256" ~ '^[0-9a-f]{64}$')
      AND ("retrieval_profile_spec_sha256" IS NULL OR "retrieval_profile_spec_sha256" ~ '^[0-9a-f]{64}$')
    ),
  CONSTRAINT "knowledge_profile_adoption_receipts_embedding_fkey"
    FOREIGN KEY ("embedding_profile_id", "embedding_profile_spec_sha256")
    REFERENCES "embedding_profiles"("id", "spec_sha256")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "knowledge_profile_adoption_receipts_retrieval_fkey"
    FOREIGN KEY ("retrieval_profile_id", "retrieval_profile_spec_sha256")
    REFERENCES "retrieval_profiles"("id", "spec_sha256")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "knowledge_profile_adoption_receipts_actor_fkey"
    FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "knowledge_profile_adoption_receipts_embedding_profile_id_embedding_profile_spec_sha256_key"
ON "knowledge_profile_adoption_receipts"("embedding_profile_id", "embedding_profile_spec_sha256");

CREATE UNIQUE INDEX "knowledge_profile_adoption_receipts_retrieval_profile_id_retrieval_profile_spec_sha256_key"
ON "knowledge_profile_adoption_receipts"("retrieval_profile_id", "retrieval_profile_spec_sha256");

CREATE INDEX "knowledge_profile_adoption_receipts_kind_adopted_at_id_idx"
ON "knowledge_profile_adoption_receipts"("profile_kind", "adopted_at", "id");

CREATE INDEX "knowledge_profile_adoption_receipts_actor_adopted_at_idx"
ON "knowledge_profile_adoption_receipts"("actor_principal_id", "adopted_at");

CREATE FUNCTION "guard_knowledge_profile_adoption_receipt_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  profile_status TEXT;
  operator_action "KnowledgeProfileOperatorAction";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'KNOWLEDGE_PROFILE_ADOPTION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT event."action"
  INTO operator_action
  FROM "knowledge_profile_operator_events" AS event
  WHERE event."principal_id" = NEW."actor_principal_id"
  ORDER BY event."id" DESC
  LIMIT 1;

  IF operator_action IS DISTINCT FROM 'grant'::"KnowledgeProfileOperatorAction" THEN
    RAISE EXCEPTION 'KNOWLEDGE_PROFILE_ADOPTION_ACTOR_UNAUTHORIZED' USING ERRCODE = '23514';
  END IF;

  IF NEW."profile_kind" = 'embedding' THEN
    SELECT profile."status"::TEXT
    INTO profile_status
    FROM "embedding_profiles" AS profile
    WHERE profile."id" = NEW."embedding_profile_id"
      AND profile."spec_sha256" = NEW."embedding_profile_spec_sha256"
    FOR SHARE;
  ELSE
    SELECT profile."status"::TEXT
    INTO profile_status
    FROM "retrieval_profiles" AS profile
    WHERE profile."id" = NEW."retrieval_profile_id"
      AND profile."spec_sha256" = NEW."retrieval_profile_spec_sha256"
    FOR SHARE;
  END IF;

  IF profile_status IS DISTINCT FROM 'adopted' THEN
    RAISE EXCEPTION 'KNOWLEDGE_PROFILE_ADOPTION_RECEIPT_STATUS_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_profile_adoption_receipts_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "knowledge_profile_adoption_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_profile_adoption_receipt_mutation"();

CREATE FUNCTION "assert_embedding_profile_adoption_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'adopted'
    AND NOT EXISTS (
      SELECT 1
      FROM "knowledge_profile_adoption_receipts" AS receipt
      WHERE receipt."profile_kind" = 'embedding'
        AND receipt."profile_version" = 1
        AND receipt."embedding_profile_id" = NEW."id"
        AND receipt."embedding_profile_spec_sha256" = NEW."spec_sha256"
        AND receipt."scope" = 'global'
    )
  THEN
    RAISE EXCEPTION 'EMBEDDING_PROFILE_ADOPTION_RECEIPT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "embedding_profiles_adoption_receipt_guard"
AFTER INSERT OR UPDATE ON "embedding_profiles"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_embedding_profile_adoption_receipt"();

CREATE FUNCTION "assert_retrieval_profile_adoption_receipt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'adopted'
    AND NOT EXISTS (
      SELECT 1
      FROM "knowledge_profile_adoption_receipts" AS receipt
      WHERE receipt."profile_kind" = 'retrieval'
        AND receipt."profile_version" = 1
        AND receipt."retrieval_profile_id" = NEW."id"
        AND receipt."retrieval_profile_spec_sha256" = NEW."spec_sha256"
        AND receipt."scope" = 'global'
    )
  THEN
    RAISE EXCEPTION 'RETRIEVAL_PROFILE_ADOPTION_RECEIPT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "retrieval_profiles_adoption_receipt_guard"
AFTER INSERT OR UPDATE ON "retrieval_profiles"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "assert_retrieval_profile_adoption_receipt"();

COMMIT;
