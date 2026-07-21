BEGIN;

-- Cancellation is an idempotent command. Persist the exact accepted response
-- in the same transaction as the state transition and queue outbox write so a
-- lost HTTP response can be replayed without consulting mutable Run state.
CREATE TABLE "run_cancellation_receipts" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "response_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_cancellation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_cancellation_receipts_idempotency_key_check" CHECK (
    length("idempotency_key") BETWEEN 8 AND 128
    AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT "run_cancellation_receipts_request_hash_check" CHECK (
    "request_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "run_cancellation_receipts_response_hash_check" CHECK (
    "response_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "run_cancellation_receipts_response_shape_check" CHECK (
    jsonb_typeof("response") = 'object'
    AND "response" ->> 'id' = "run_id"
    AND "response" ->> 'status' IN ('cancelling', 'cancelled')
  )
);

CREATE UNIQUE INDEX "run_cancellation_receipts_principal_id_idempotency_key_key"
ON "run_cancellation_receipts"("principal_id", "idempotency_key");

CREATE INDEX "run_cancellation_receipts_run_id_created_at_idx"
ON "run_cancellation_receipts"("run_id", "created_at");

ALTER TABLE "run_cancellation_receipts"
ADD CONSTRAINT "run_cancellation_receipts_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "runs"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "run_cancellation_receipts"
ADD CONSTRAINT "run_cancellation_receipts_principal_id_fkey"
FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_run_cancellation_receipt_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'RUN_CANCELLATION_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "run_cancellation_receipts_mutation_guard"
BEFORE UPDATE ON "run_cancellation_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_run_cancellation_receipt_mutation"();

COMMIT;
