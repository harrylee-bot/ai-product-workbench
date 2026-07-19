-- Remix creates a full Project graph. A durable receipt is required so a
-- retried or concurrent command returns that graph instead of duplicating it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "project_lineages") THEN
    RAISE EXCEPTION 'MIGRATION_PROJECT_REMIX_RECEIPTS_NOT_BACKFILLABLE' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "project_lineages"
ADD COLUMN "idempotency_key" TEXT NOT NULL,
ADD COLUMN "request_hash" TEXT NOT NULL,
ADD CONSTRAINT "project_lineages_idempotency_key_check"
CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
ADD CONSTRAINT "project_lineages_request_hash_format_check"
CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX "project_lineages_source_share_id_created_by_id_idempotency_key_key"
ON "project_lineages"("source_share_id", "created_by_id", "idempotency_key");
