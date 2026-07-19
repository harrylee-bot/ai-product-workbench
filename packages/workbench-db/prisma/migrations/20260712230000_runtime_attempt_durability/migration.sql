BEGIN;

CREATE TYPE "RuntimeAttemptStatus" AS ENUM (
  'pending',
  'submitting',
  'running',
  'waiting_input',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled'
);

CREATE TABLE "runtime_attempts" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "runtime_binding_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "adapter" TEXT NOT NULL,
  "external_thread_id" TEXT NOT NULL,
  "external_run_id" TEXT,
  "status" "RuntimeAttemptStatus" NOT NULL DEFAULT 'pending',
  "last_external_event_id" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "error_code" TEXT,
  "error_detail" TEXT,
  "error_retryable" BOOLEAN,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "runtime_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "runtime_attempts_attempt_positive_check" CHECK ("attempt" > 0),
  CONSTRAINT "runtime_attempts_adapter_length_check" CHECK (length("adapter") BETWEEN 1 AND 80),
  CONSTRAINT "runtime_attempts_external_thread_id_length_check" CHECK (length("external_thread_id") BETWEEN 1 AND 512),
  CONSTRAINT "runtime_attempts_external_run_id_length_check" CHECK (
    "external_run_id" IS NULL OR length("external_run_id") BETWEEN 1 AND 512
  ),
  CONSTRAINT "runtime_attempts_last_event_id_length_check" CHECK (
    "last_external_event_id" IS NULL OR length("last_external_event_id") BETWEEN 1 AND 1024
  ),
  CONSTRAINT "runtime_attempts_timestamps_check" CHECK (
    CASE
      WHEN "status" = 'pending' THEN "started_at" IS NULL AND "finished_at" IS NULL
      WHEN "status" IN ('submitting', 'running', 'cancelling') THEN "started_at" IS NOT NULL AND "finished_at" IS NULL
      ELSE "started_at" IS NOT NULL AND "finished_at" IS NOT NULL
    END
  ),
  CONSTRAINT "runtime_attempts_external_run_state_check" CHECK (
    "status" IN ('pending', 'submitting', 'failed', 'cancelled') OR "external_run_id" IS NOT NULL
  ),
  CONSTRAINT "runtime_attempts_finished_order_check" CHECK (
    "finished_at" IS NULL OR "finished_at" >= "started_at"
  ),
  CONSTRAINT "runtime_attempts_error_envelope_check" CHECK (
    ("error_code" IS NULL AND "error_detail" IS NULL AND "error_retryable" IS NULL)
    OR (
      length("error_code") BETWEEN 1 AND 128
      AND length("error_detail") BETWEEN 1 AND 4000
      AND "error_retryable" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "runtime_attempts_run_id_attempt_key"
ON "runtime_attempts"("run_id", "attempt");

CREATE UNIQUE INDEX "runtime_attempts_adapter_external_run_id_key"
ON "runtime_attempts"("adapter", "external_run_id");

CREATE INDEX "runtime_attempts_runtime_binding_id_status_idx"
ON "runtime_attempts"("runtime_binding_id", "status");

CREATE INDEX "runtime_attempts_external_thread_id_status_idx"
ON "runtime_attempts"("external_thread_id", "status");

ALTER TABLE "runtime_attempts"
ADD CONSTRAINT "runtime_attempts_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "runs"("id")
ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "runtime_attempts_runtime_binding_id_fkey"
FOREIGN KEY ("runtime_binding_id") REFERENCES "runtime_bindings"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "guard_runtime_attempt"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  binding_adapter TEXT;
  binding_external_thread_id TEXT;
  binding_thread_id TEXT;
  run_thread_id TEXT;
BEGIN
  SELECT "adapter", "external_thread_id", "thread_id"
  INTO binding_adapter, binding_external_thread_id, binding_thread_id
  FROM "runtime_bindings"
  WHERE "id" = NEW."runtime_binding_id"
  FOR SHARE;

  SELECT "thread_id"
  INTO run_thread_id
  FROM "runs"
  WHERE "id" = NEW."run_id"
  FOR SHARE;

  IF binding_adapter IS NULL
    OR run_thread_id IS NULL
    OR NEW."adapter" IS DISTINCT FROM binding_adapter
    OR NEW."external_thread_id" IS DISTINCT FROM binding_external_thread_id
    OR run_thread_id IS DISTINCT FROM binding_thread_id
  THEN
    RAISE EXCEPTION 'RUNTIME_ATTEMPT_BINDING_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (
    NEW."status" <> 'pending'
    OR NEW."external_run_id" IS NOT NULL
    OR NEW."last_external_event_id" IS NOT NULL
    OR NEW."started_at" IS NOT NULL
    OR NEW."finished_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RUNTIME_ATTEMPT_MUST_START_PENDING' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."runtime_binding_id" IS DISTINCT FROM OLD."runtime_binding_id"
      OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
      OR NEW."adapter" IS DISTINCT FROM OLD."adapter"
      OR NEW."external_thread_id" IS DISTINCT FROM OLD."external_thread_id"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."external_run_id" IS NOT NULL
      AND NEW."external_run_id" IS DISTINCT FROM OLD."external_run_id"
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_EXTERNAL_RUN_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('succeeded', 'failed', 'cancelled') AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."last_external_event_id" IS DISTINCT FROM OLD."last_external_event_id"
      OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
      OR NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
      OR NEW."error_code" IS DISTINCT FROM OLD."error_code"
      OR NEW."error_detail" IS DISTINCT FROM OLD."error_detail"
      OR NEW."error_retryable" IS DISTINCT FROM OLD."error_retryable"
    ) THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'pending' AND NEW."status" IN ('submitting', 'failed', 'cancelled'))
      OR (OLD."status" = 'submitting' AND NEW."status" IN ('running', 'cancelling', 'failed', 'cancelled'))
      OR (OLD."status" = 'running' AND NEW."status" IN ('waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled'))
      OR (OLD."status" = 'waiting_input' AND NEW."status" IN ('cancelling', 'cancelled'))
      OR (OLD."status" = 'cancelling' AND NEW."status" IN ('failed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "runtime_attempt_guard"
BEFORE INSERT OR UPDATE ON "runtime_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_attempt"();

COMMIT;
