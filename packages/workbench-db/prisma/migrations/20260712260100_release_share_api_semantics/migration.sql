-- API command receipts and compare-and-swap revisions are durable domain
-- state. Existing release rows cannot be assigned truthful idempotency
-- receipts, so this greenfield migration refuses to fabricate them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "project_releases") THEN
    RAISE EXCEPTION 'MIGRATION_PROJECT_RELEASE_RECEIPTS_NOT_BACKFILLABLE' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "project_releases"
ADD COLUMN "idempotency_key" TEXT NOT NULL,
ADD COLUMN "request_hash" TEXT NOT NULL,
ADD CONSTRAINT "project_releases_idempotency_key_check"
CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
ADD CONSTRAINT "project_releases_request_hash_format_check"
CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "project_releases_project_id_idempotency_key_key"
ON "project_releases"("project_id", "idempotency_key");

ALTER TABLE "share_grants"
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
ADD CONSTRAINT "share_grants_revision_nonnegative_check"
CHECK ("revision" >= 0);

CREATE FUNCTION "guard_release_api_receipt_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
  THEN
    RAISE EXCEPTION 'PROJECT_RELEASE_COMMAND_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_releases_api_receipt_guard"
BEFORE UPDATE ON "project_releases"
FOR EACH ROW EXECUTE FUNCTION "guard_release_api_receipt_mutation"();

CREATE FUNCTION "guard_share_grant_revision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'SHARE_GRANT_REVISION_MUST_INCREMENT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "share_grants_revision_guard"
BEFORE UPDATE ON "share_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_share_grant_revision"();
