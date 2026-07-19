-- Share capabilities are intentionally one-token-per-Project. Raw bearer
-- tokens remain one-time response material and are never persisted.
-- Existing grants cannot be assigned truthful rotation receipts in this
-- greenfield schema, so migration refuses to fabricate them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "share_grants") THEN
    RAISE EXCEPTION 'MIGRATION_SHARE_ROTATION_RECEIPTS_NOT_BACKFILLABLE' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "share_grants"
DROP CONSTRAINT "share_grants_release_id_fkey",
ADD COLUMN "project_id" TEXT NOT NULL,
ADD COLUMN "idempotency_key" TEXT NOT NULL,
ADD COLUMN "request_hash" TEXT NOT NULL,
ADD CONSTRAINT "share_grants_idempotency_key_check"
CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
ADD CONSTRAINT "share_grants_request_hash_format_check"
CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

DROP INDEX "share_grants_release_id_status_idx";

CREATE INDEX "share_grants_project_id_status_idx"
ON "share_grants"("project_id", "status");

CREATE INDEX "share_grants_project_id_idempotency_key_created_at_idx"
ON "share_grants"("project_id", "idempotency_key", "created_at");

CREATE INDEX "share_grants_release_id_idx"
ON "share_grants"("release_id");

-- This is the database backstop for application-level Project row locking.
CREATE UNIQUE INDEX "share_grants_one_active_per_project_key"
ON "share_grants"("project_id")
WHERE "status" = 'active';

ALTER TABLE "share_grants"
ADD CONSTRAINT "share_grants_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "share_grants_release_id_project_id_fkey"
FOREIGN KEY ("release_id", "project_id") REFERENCES "project_releases"("id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_share_rotation_receipt_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
  THEN
    RAISE EXCEPTION 'SHARE_ROTATION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "share_grants_rotation_receipt_guard"
BEFORE UPDATE ON "share_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_share_rotation_receipt_mutation"();
