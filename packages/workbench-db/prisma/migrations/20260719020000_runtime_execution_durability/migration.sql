BEGIN;

CREATE TYPE "RuntimeExternalEventStatus" AS ENUM ('pending', 'processed');

ALTER TABLE "runs"
ADD COLUMN "execution_owner_id" VARCHAR(128),
ADD COLUMN "execution_epoch" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "execution_heartbeat_at" TIMESTAMPTZ(6),
ADD COLUMN "execution_lease_expires_at" TIMESTAMPTZ(6),
ADD CONSTRAINT "runs_execution_epoch_nonnegative_check" CHECK ("execution_epoch" >= 0),
ADD CONSTRAINT "runs_execution_lease_shape_check" CHECK (
  ("execution_owner_id" IS NULL AND "execution_heartbeat_at" IS NULL AND "execution_lease_expires_at" IS NULL)
  OR (
    length("execution_owner_id") BETWEEN 1 AND 128
    AND "execution_heartbeat_at" IS NOT NULL
    AND "execution_lease_expires_at" IS NOT NULL
    AND "execution_lease_expires_at" > "execution_heartbeat_at"
  )
);

CREATE INDEX "runs_status_execution_lease_expires_at_idx"
ON "runs"("status", "execution_lease_expires_at");

ALTER TABLE "runtime_attempts"
ADD COLUMN "provider_idempotency_key" VARCHAR(128),
ADD COLUMN "external_event_sequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "submission_unknown_at" TIMESTAMPTZ(6),
ADD COLUMN "execution_owner_id" VARCHAR(128),
ADD COLUMN "execution_epoch" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "execution_heartbeat_at" TIMESTAMPTZ(6),
ADD COLUMN "execution_lease_expires_at" TIMESTAMPTZ(6),
ADD CONSTRAINT "runtime_attempts_external_event_sequence_nonnegative_check" CHECK ("external_event_sequence" >= 0),
ADD CONSTRAINT "runtime_attempts_execution_epoch_nonnegative_check" CHECK ("execution_epoch" >= 0),
ADD CONSTRAINT "runtime_attempts_provider_idempotency_key_check" CHECK (
  "provider_idempotency_key" IS NULL
  OR "provider_idempotency_key" ~ '^wbrt:[0-9a-f]{64}$'
),
ADD CONSTRAINT "runtime_attempts_submission_unknown_at_check" CHECK (
  "status" <> 'submission_unknown' OR "submission_unknown_at" IS NOT NULL
),
ADD CONSTRAINT "runtime_attempts_execution_lease_shape_check" CHECK (
  ("execution_owner_id" IS NULL AND "execution_heartbeat_at" IS NULL AND "execution_lease_expires_at" IS NULL)
  OR (
    length("execution_owner_id") BETWEEN 1 AND 128
    AND "execution_heartbeat_at" IS NOT NULL
    AND "execution_lease_expires_at" IS NOT NULL
    AND "execution_lease_expires_at" > "execution_heartbeat_at"
  )
);

-- Existing active attempts predate the provider key. Backfill them with the
-- same deterministic algorithm used by RuntimeAttemptService before enforcing
-- the state/key relationship.
UPDATE "runtime_attempts"
SET "provider_idempotency_key" = 'wbrt:' || encode(public.digest("id", 'sha256'), 'hex')
WHERE "status" <> 'pending'
  AND "provider_idempotency_key" IS NULL;

ALTER TABLE "runtime_attempts"
ADD CONSTRAINT "runtime_attempts_provider_idempotency_state_check" CHECK (
  (
    "status" NOT IN (
      'submitting',
      'submission_unknown',
      'running',
      'waiting_input',
      'cancelling',
      'succeeded'
    )
    OR "provider_idempotency_key" IS NOT NULL
  )
  AND ("external_run_id" IS NULL OR "provider_idempotency_key" IS NOT NULL)
);

ALTER TABLE "runtime_attempts" DROP CONSTRAINT "runtime_attempts_timestamps_check";
ALTER TABLE "runtime_attempts" ADD CONSTRAINT "runtime_attempts_timestamps_check" CHECK (
  CASE
    WHEN "status" = 'pending' THEN "started_at" IS NULL AND "finished_at" IS NULL
    WHEN "status" IN ('submitting', 'submission_unknown', 'running', 'cancelling')
      THEN "started_at" IS NOT NULL AND "finished_at" IS NULL
    ELSE "started_at" IS NOT NULL AND "finished_at" IS NOT NULL
  END
);

ALTER TABLE "runtime_attempts" DROP CONSTRAINT "runtime_attempts_external_run_state_check";
ALTER TABLE "runtime_attempts" ADD CONSTRAINT "runtime_attempts_external_run_state_check" CHECK (
  "status" IN ('pending', 'submitting', 'submission_unknown', 'failed', 'cancelled')
  OR "external_run_id" IS NOT NULL
);

CREATE UNIQUE INDEX "runtime_attempts_provider_idempotency_key_key"
ON "runtime_attempts"("provider_idempotency_key");

CREATE INDEX "runtime_attempts_status_execution_lease_expires_at_idx"
ON "runtime_attempts"("status", "execution_lease_expires_at");

CREATE OR REPLACE FUNCTION "guard_runtime_attempt"()
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
    OR NEW."provider_idempotency_key" IS NOT NULL
    OR NEW."last_external_event_id" IS NOT NULL
    OR NEW."external_event_sequence" <> 0
    OR NEW."submission_unknown_at" IS NOT NULL
    OR NEW."execution_owner_id" IS NOT NULL
    OR NEW."execution_epoch" <> 0
    OR NEW."execution_heartbeat_at" IS NOT NULL
    OR NEW."execution_lease_expires_at" IS NOT NULL
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
      OR (
        OLD."provider_idempotency_key" IS NOT NULL
        AND NEW."provider_idempotency_key" IS DISTINCT FROM OLD."provider_idempotency_key"
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."external_run_id" IS NOT NULL
      AND NEW."external_run_id" IS DISTINCT FROM OLD."external_run_id"
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_EXTERNAL_RUN_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF NEW."external_event_sequence" < OLD."external_event_sequence" THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_EVENT_SEQUENCE_REGRESSION' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('succeeded', 'failed', 'cancelled') AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."last_external_event_id" IS DISTINCT FROM OLD."last_external_event_id"
      OR NEW."external_event_sequence" IS DISTINCT FROM OLD."external_event_sequence"
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
      OR (OLD."status" = 'submitting' AND NEW."status" IN ('submission_unknown', 'running', 'cancelling', 'failed', 'cancelled'))
      OR (OLD."status" = 'submission_unknown' AND NEW."status" IN ('running', 'cancelling', 'failed', 'cancelled'))
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

CREATE TABLE "runtime_external_events" (
  "id" TEXT NOT NULL,
  "runtime_attempt_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "external_run_id" VARCHAR(512) NOT NULL,
  "external_event_id" VARCHAR(1024) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event" VARCHAR(128) NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_sha256" CHAR(64) NOT NULL,
  "status" "RuntimeExternalEventStatus" NOT NULL DEFAULT 'pending',
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),

  CONSTRAINT "runtime_external_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "runtime_external_events_sequence_positive_check" CHECK ("sequence" > 0),
  CONSTRAINT "runtime_external_events_event_length_check" CHECK (length("event") BETWEEN 1 AND 128),
  CONSTRAINT "runtime_external_events_payload_sha256_check" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "runtime_external_events_processed_shape_check" CHECK (
    ("status" = 'pending' AND "processed_at" IS NULL)
    OR ("status" = 'processed' AND "processed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "runtime_external_events_attempt_event_key"
ON "runtime_external_events"("runtime_attempt_id", "external_event_id");

CREATE UNIQUE INDEX "runtime_external_events_attempt_sequence_key"
ON "runtime_external_events"("runtime_attempt_id", "sequence");

CREATE INDEX "runtime_external_events_attempt_status_sequence_idx"
ON "runtime_external_events"("runtime_attempt_id", "status", "sequence");

ALTER TABLE "runtime_external_events"
ADD CONSTRAINT "runtime_external_events_attempt_fkey"
FOREIGN KEY ("runtime_attempt_id", "run_id")
REFERENCES "runtime_attempts"("id", "run_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "guard_runtime_external_event"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_run_id TEXT;
  attempt_external_run_id TEXT;
  attempt_event_sequence INTEGER;
BEGIN
  SELECT "run_id", "external_run_id", "external_event_sequence"
  INTO attempt_run_id, attempt_external_run_id, attempt_event_sequence
  FROM "runtime_attempts"
  WHERE "id" = NEW."runtime_attempt_id"
  FOR SHARE;

  IF attempt_run_id IS NULL
    OR NEW."run_id" IS DISTINCT FROM attempt_run_id
    OR NEW."external_run_id" IS DISTINCT FROM attempt_external_run_id
    OR NEW."sequence" > attempt_event_sequence
  THEN
    RAISE EXCEPTION 'RUNTIME_EXTERNAL_EVENT_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (NEW."status" <> 'pending' OR NEW."processed_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'RUNTIME_EXTERNAL_EVENT_MUST_START_PENDING' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."runtime_attempt_id" IS DISTINCT FROM OLD."runtime_attempt_id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."external_run_id" IS DISTINCT FROM OLD."external_run_id"
      OR NEW."external_event_id" IS DISTINCT FROM OLD."external_event_id"
      OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
      OR NEW."event" IS DISTINCT FROM OLD."event"
      OR NEW."payload" IS DISTINCT FROM OLD."payload"
      OR NEW."payload_sha256" IS DISTINCT FROM OLD."payload_sha256"
      OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
      OR OLD."status" <> 'pending'
      OR NEW."status" <> 'processed'
      OR NEW."processed_at" IS NULL
    THEN
      RAISE EXCEPTION 'RUNTIME_EXTERNAL_EVENT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "runtime_external_event_guard"
BEFORE INSERT OR UPDATE ON "runtime_external_events"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_external_event"();

COMMIT;
