ALTER TABLE "knowledge_releases"
ADD COLUMN "build_attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lease_token" TEXT,
ADD COLUMN "lease_expires_at" TIMESTAMP(3),
ADD COLUMN "started_at" TIMESTAMP(3),
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "knowledge_releases"
ADD CONSTRAINT "knowledge_releases_build_attempt_nonnegative_check"
CHECK ("build_attempt" >= 0),
ADD CONSTRAINT "knowledge_releases_lease_pair_check"
CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL)),
ADD CONSTRAINT "knowledge_releases_terminal_lease_clear_check"
CHECK ("status" = 'building' OR ("lease_token" IS NULL AND "lease_expires_at" IS NULL));

CREATE INDEX "knowledge_releases_status_lease_expires_at_updated_at_idx"
ON "knowledge_releases"("status", "lease_expires_at", "updated_at");

CREATE OR REPLACE FUNCTION "guard_knowledge_release_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('ready', 'retired') THEN
      RAISE EXCEPTION 'KNOWLEDGE_RELEASE_PUBLISHED_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."started_at" IS NOT NULL
    AND NEW."started_at" IS DISTINCT FROM OLD."started_at"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RELEASE_STARTED_AT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('ready', 'retired') THEN
    IF NEW."manifest_sha256" IS DISTINCT FROM OLD."manifest_sha256"
      OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
      OR NEW."ready_at" IS DISTINCT FROM OLD."ready_at"
      OR NEW."build_attempt" IS DISTINCT FROM OLD."build_attempt"
      OR NEW."lease_token" IS DISTINCT FROM OLD."lease_token"
      OR NEW."lease_expires_at" IS DISTINCT FROM OLD."lease_expires_at"
      OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
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

  RETURN NEW;
END;
$$;
