BEGIN;

ALTER TABLE "runtime_attempts"
ADD COLUMN "provider_cancellation_operation_epoch" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "provider_cancellation_operation_started_at" TIMESTAMPTZ(6),
ADD COLUMN "provider_cancellation_operation_deadline_at" TIMESTAMPTZ(6),
ADD CONSTRAINT "runtime_attempts_provider_cancellation_operation_epoch_nonnegative_check"
  CHECK ("provider_cancellation_operation_epoch" >= 0),
ADD CONSTRAINT "runtime_attempts_provider_cancellation_operation_shape_check" CHECK (
  (
    "provider_cancellation_operation_started_at" IS NULL
    AND "provider_cancellation_operation_deadline_at" IS NULL
  )
  OR (
    "provider_cancellation_operation_epoch" > 0
    AND "provider_cancellation_operation_started_at" IS NOT NULL
    AND "provider_cancellation_operation_deadline_at" IS NOT NULL
    AND isfinite("provider_cancellation_operation_started_at")
    AND isfinite("provider_cancellation_operation_deadline_at")
    AND "provider_cancellation_operation_deadline_at"
      > "provider_cancellation_operation_started_at"
    AND "provider_cancellation_operation_deadline_at"
      - "provider_cancellation_operation_started_at" <= INTERVAL '10 minutes'
  )
);

ALTER TABLE "runtime_attempts"
DROP CONSTRAINT "runtime_attempts_external_run_id_length_check",
ADD CONSTRAINT "runtime_attempts_external_run_id_length_check" CHECK (
  "external_run_id" IS NULL
  OR (
    length("external_run_id") BETWEEN 1 AND 512
    AND length(btrim("external_run_id")) > 0
  )
);

CREATE UNIQUE INDEX "runtime_attempts_provider_cancel_operation_scope_key"
ON "runtime_attempts"(
  "id",
  "run_id",
  "provider_cancellation_operation_epoch"
);

ALTER TABLE "runtime_provider_cancellation_resolutions"
ADD COLUMN "operation_epoch" INTEGER NOT NULL,
ADD COLUMN "external_run_id" VARCHAR(512) NOT NULL,
ADD CONSTRAINT "runtime_provider_cancellation_resolutions_operation_epoch_positive_check"
  CHECK ("operation_epoch" > 0),
ADD CONSTRAINT "runtime_provider_cancellation_resolutions_external_run_id_length_check" CHECK (
  length("external_run_id") BETWEEN 1 AND 512
  AND length(btrim("external_run_id")) > 0
);

CREATE UNIQUE INDEX "runtime_provider_cancel_resolutions_operation_scope_key"
ON "runtime_provider_cancellation_resolutions"(
  "runtime_attempt_id",
  "run_id",
  "operation_epoch"
);

ALTER TABLE "runtime_provider_cancellation_resolutions"
DROP CONSTRAINT "runtime_provider_cancellation_resolutions_attempt_fkey",
ADD CONSTRAINT "runtime_provider_cancellation_resolutions_attempt_fkey"
  FOREIGN KEY ("runtime_attempt_id", "run_id", "operation_epoch")
  REFERENCES "runtime_attempts"(
    "id",
    "run_id",
    "provider_cancellation_operation_epoch"
  )
  ON DELETE CASCADE
  ON UPDATE RESTRICT;

-- RuntimeAttempt updates already hold the child row. Avoid reacquiring parent
-- rows in the legacy guard; operation writers use the canonical Run -> Attempt
-- order before the operation-specific trigger validates the parent state.
CREATE OR REPLACE FUNCTION "guard_runtime_attempt"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  binding_adapter TEXT;
  binding_external_thread_id TEXT;
  binding_thread_id TEXT;
  run_thread_id TEXT;
  resolution_exists BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format(
      'SELECT "thread_id"
         FROM %I."runs"
        WHERE "id" = $1
        FOR SHARE',
      TG_TABLE_SCHEMA
    )
    INTO run_thread_id
    USING NEW."run_id";

    EXECUTE format(
      'SELECT "adapter", "external_thread_id", "thread_id"
         FROM %I."runtime_bindings"
        WHERE "id" = $1
        FOR SHARE',
      TG_TABLE_SCHEMA
    )
    INTO binding_adapter, binding_external_thread_id, binding_thread_id
    USING NEW."runtime_binding_id";

    IF binding_adapter IS NULL
      OR run_thread_id IS NULL
      OR NEW."adapter" IS DISTINCT FROM binding_adapter
      OR NEW."external_thread_id" IS DISTINCT FROM binding_external_thread_id
      OR run_thread_id IS DISTINCT FROM binding_thread_id
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_BINDING_INVALID' USING ERRCODE = '23514';
    END IF;

    IF NEW."status" <> 'pending'
      OR NEW."external_run_id" IS NOT NULL
      OR NEW."provider_idempotency_key" IS NOT NULL
      OR NEW."last_external_event_id" IS NOT NULL
      OR NEW."external_event_sequence" <> 0
      OR NEW."submission_unknown_at" IS NOT NULL
      OR NEW."execution_owner_id" IS NOT NULL
      OR NEW."execution_epoch" <> 0
      OR NEW."execution_heartbeat_at" IS NOT NULL
      OR NEW."execution_lease_expires_at" IS NOT NULL
      OR NEW."provider_cancellation_operation_epoch" <> 0
      OR NEW."provider_cancellation_operation_started_at" IS NOT NULL
      OR NEW."provider_cancellation_operation_deadline_at" IS NOT NULL
      OR NEW."started_at" IS NOT NULL
      OR NEW."finished_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_MUST_START_PENDING' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

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

  IF NEW."external_run_id" IS DISTINCT FROM OLD."external_run_id" THEN
    IF OLD."external_run_id" IS NOT NULL
      OR NEW."external_run_id" IS NULL
      OR length(btrim(NEW."external_run_id")) = 0
    THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_EXTERNAL_RUN_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
           FROM %I."runtime_provider_cancellation_resolutions"
          WHERE "runtime_attempt_id" = $1
       )',
      TG_TABLE_SCHEMA
    )
    INTO resolution_exists
    USING OLD."id";

    IF resolution_exists THEN
      RAISE EXCEPTION 'RUNTIME_ATTEMPT_EXTERNAL_RUN_RESOLVED' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('succeeded', 'failed', 'cancelled') THEN
      IF OLD."status" <> 'failed'
        OR OLD."error_code" IS DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
        OR OLD."provider_cancellation_operation_epoch" < 1
        OR NEW."provider_cancellation_operation_epoch"
          <> OLD."provider_cancellation_operation_epoch"
      THEN
        RAISE EXCEPTION 'RUNTIME_ATTEMPT_EXTERNAL_RUN_HANDOFF_INVALID'
          USING ERRCODE = '23514';
      END IF;
    END IF;
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
    OR (
      OLD."status" = 'submitting'
      AND NEW."status" IN ('submission_unknown', 'running', 'cancelling', 'failed', 'cancelled')
    )
    OR (
      OLD."status" = 'submission_unknown'
      AND NEW."status" IN ('running', 'cancelling', 'failed', 'cancelled')
    )
    OR (
      OLD."status" = 'running'
      AND NEW."status" IN ('waiting_input', 'cancelling', 'succeeded', 'failed', 'cancelled')
    )
    OR (OLD."status" = 'waiting_input' AND NEW."status" IN ('cancelling', 'cancelled'))
    OR (OLD."status" = 'cancelling' AND NEW."status" IN ('failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'RUNTIME_ATTEMPT_STATUS_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION "guard_runtime_provider_cancellation_operation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  run_status TEXT;
  run_error_code TEXT;
  resolution_exists BOOLEAN;
  fresh_now TIMESTAMPTZ(6);
  requested_duration INTERVAL;
  old_active BOOLEAN;
  new_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."provider_cancellation_operation_epoch" <> 0
      OR NEW."provider_cancellation_operation_started_at" IS NOT NULL
      OR NEW."provider_cancellation_operation_deadline_at" IS NOT NULL
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_MUST_START_EMPTY'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  old_active := OLD."provider_cancellation_operation_started_at" IS NOT NULL;
  new_active := NEW."provider_cancellation_operation_started_at" IS NOT NULL;

  IF NOT old_active AND NOT new_active THEN
    IF NEW."provider_cancellation_operation_epoch"
      IS DISTINCT FROM OLD."provider_cancellation_operation_epoch"
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_EPOCH_INVALID'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF old_active AND new_active
    AND NEW."provider_cancellation_operation_epoch"
      = OLD."provider_cancellation_operation_epoch"
  THEN
    IF NEW."provider_cancellation_operation_started_at"
        IS DISTINCT FROM OLD."provider_cancellation_operation_started_at"
      OR NEW."provider_cancellation_operation_deadline_at"
        IS DISTINCT FROM OLD."provider_cancellation_operation_deadline_at"
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_MUTATION_INVALID'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  EXECUTE format(
    'SELECT "status"::TEXT, "error_code"
       FROM %I."runs"
      WHERE "id" = $1
      FOR SHARE',
    TG_TABLE_SCHEMA
  )
  INTO run_status, run_error_code
  USING NEW."run_id";

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_SCOPE_INVALID'
      USING ERRCODE = '23503';
  END IF;

  EXECUTE format(
    'SELECT EXISTS (
       SELECT 1
         FROM %I."runtime_provider_cancellation_resolutions"
        WHERE "runtime_attempt_id" = $1
     )',
    TG_TABLE_SCHEMA
  )
  INTO resolution_exists
  USING NEW."id";

  fresh_now := clock_timestamp();

  IF old_active AND NOT new_active THEN
    IF NEW."provider_cancellation_operation_epoch"
        IS DISTINCT FROM OLD."provider_cancellation_operation_epoch"
      OR OLD."provider_cancellation_operation_deadline_at" IS NULL
      OR OLD."provider_cancellation_operation_deadline_at" <= fresh_now
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_FINISH_INVALID'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF resolution_exists THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_RESOLVED'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."provider_cancellation_operation_started_at" IS NULL
    OR NEW."provider_cancellation_operation_deadline_at" IS NULL
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_SHAPE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  requested_duration := NEW."provider_cancellation_operation_deadline_at"
    - NEW."provider_cancellation_operation_started_at";
  IF requested_duration <= INTERVAL '0 seconds'
    OR requested_duration > INTERVAL '10 minutes'
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_DEADLINE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NOT old_active THEN
    IF NEW."provider_cancellation_operation_epoch"
      <> OLD."provider_cancellation_operation_epoch" + 1
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_EPOCH_INVALID'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."provider_cancellation_operation_epoch"
      <> OLD."provider_cancellation_operation_epoch" + 1
    OR OLD."provider_cancellation_operation_deadline_at" IS NULL
    OR fresh_now < OLD."provider_cancellation_operation_deadline_at"
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_TAKEOVER_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (
      run_status = 'cancelling'
      AND NEW."status"::TEXT IN (
        'pending', 'submitting', 'submission_unknown', 'running', 'cancelling'
      )
    )
    OR (
      run_status = 'failed'
      AND run_error_code IS NOT DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
      AND NEW."status"::TEXT = 'failed'
      AND NEW."error_code" IS NOT DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
    )
  ) THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_SCOPE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  -- The caller supplies only the requested duration. The database authors both
  -- timestamps after the parent and attempt rows have been acquired.
  NEW."provider_cancellation_operation_started_at" := fresh_now;
  NEW."provider_cancellation_operation_deadline_at" := fresh_now + requested_duration;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "runtime_attempts_provider_cancellation_operation_insert_guard"
BEFORE INSERT ON "runtime_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_provider_cancellation_operation"();

CREATE TRIGGER "runtime_attempts_provider_cancellation_operation_update_guard"
BEFORE UPDATE OF
  "provider_cancellation_operation_epoch",
  "provider_cancellation_operation_started_at",
  "provider_cancellation_operation_deadline_at"
ON "runtime_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_provider_cancellation_operation"();

CREATE FUNCTION "guard_runtime_provider_cancellation_resolution_operation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_operation_epoch INTEGER;
  operation_started_at TIMESTAMPTZ(6);
  operation_deadline_at TIMESTAMPTZ(6);
  attempt_external_run_id TEXT;
  attempt_status TEXT;
  attempt_error_code TEXT;
  run_status TEXT;
  run_error_code TEXT;
  scope_found BOOLEAN;
  fresh_now TIMESTAMPTZ(6);
BEGIN
  EXECUTE format(
    'SELECT "status"::TEXT, "error_code", TRUE
       FROM %I."runs"
      WHERE "id" = $1
      FOR UPDATE',
    TG_TABLE_SCHEMA
  )
  INTO run_status, run_error_code, scope_found
  USING NEW."run_id";

  IF scope_found IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_SCOPE_INVALID'
      USING ERRCODE = '23503';
  END IF;

  scope_found := FALSE;
  EXECUTE format(
    'SELECT
        "provider_cancellation_operation_epoch",
        "provider_cancellation_operation_started_at",
        "provider_cancellation_operation_deadline_at",
        "external_run_id",
        "status"::TEXT,
        "error_code",
        TRUE
       FROM %I."runtime_attempts"
      WHERE "id" = $1
        AND "run_id" = $2
      FOR UPDATE',
    TG_TABLE_SCHEMA
  )
  INTO
    attempt_operation_epoch,
    operation_started_at,
    operation_deadline_at,
    attempt_external_run_id,
    attempt_status,
    attempt_error_code,
    scope_found
  USING NEW."runtime_attempt_id", NEW."run_id";

  IF scope_found IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_SCOPE_INVALID'
      USING ERRCODE = '23503';
  END IF;

  fresh_now := clock_timestamp();
  IF operation_started_at IS NULL
    OR operation_deadline_at IS NULL
    OR operation_deadline_at <= fresh_now
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_OPERATION_NOT_ACTIVE'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."operation_epoch" <> attempt_operation_epoch
    OR NEW."operation_epoch" < 1
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_EPOCH_INVALID'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."external_run_id" IS DISTINCT FROM attempt_external_run_id THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_EXTERNAL_RUN_INVALID'
      USING ERRCODE = '23514';
  END IF;
  IF run_status IS DISTINCT FROM 'failed'
    OR run_error_code IS DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
    OR attempt_status IS DISTINCT FROM 'failed'
    OR attempt_error_code IS DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_STATE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  NEW."converged_at" := fresh_now;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "runtime_provider_cancellation_resolutions_operation_guard"
BEFORE INSERT ON "runtime_provider_cancellation_resolutions"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_provider_cancellation_resolution_operation"();

CREATE FUNCTION "guard_runtime_provider_cancellation_resolution_cleared"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  operation_epoch INTEGER;
  operation_started_at TIMESTAMPTZ(6);
  operation_deadline_at TIMESTAMPTZ(6);
  attempt_external_run_id TEXT;
  attempt_status TEXT;
  attempt_error_code TEXT;
  run_status TEXT;
  run_error_code TEXT;
BEGIN
  EXECUTE format(
    'SELECT
        attempt."provider_cancellation_operation_epoch",
        attempt."provider_cancellation_operation_started_at",
        attempt."provider_cancellation_operation_deadline_at",
        attempt."external_run_id",
        attempt."status"::TEXT,
        attempt."error_code",
        run."status"::TEXT,
        run."error_code"
       FROM %I."runtime_attempts" AS attempt
       JOIN %I."runs" AS run ON run."id" = attempt."run_id"
      WHERE attempt."id" = $1
        AND attempt."run_id" = $2',
    TG_TABLE_SCHEMA,
    TG_TABLE_SCHEMA
  )
  INTO
    operation_epoch,
    operation_started_at,
    operation_deadline_at,
    attempt_external_run_id,
    attempt_status,
    attempt_error_code,
    run_status,
    run_error_code
  USING NEW."runtime_attempt_id", NEW."run_id";

  IF operation_epoch IS DISTINCT FROM NEW."operation_epoch"
    OR operation_started_at IS NOT NULL
    OR operation_deadline_at IS NOT NULL
    OR attempt_external_run_id IS DISTINCT FROM NEW."external_run_id"
    OR attempt_status IS DISTINCT FROM 'failed'
    OR attempt_error_code IS DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
    OR run_status IS DISTINCT FROM 'failed'
    OR run_error_code IS DISTINCT FROM 'RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED'
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_NOT_CLEARED'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "runtime_provider_cancellation_resolutions_cleared_guard"
AFTER INSERT ON "runtime_provider_cancellation_resolutions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_provider_cancellation_resolution_cleared"();

CREATE OR REPLACE FUNCTION "guard_runtime_provider_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  attempt_run_id TEXT;
  attempt_sequence INTEGER;
  attempt_status TEXT;
  cursor_sequence INTEGER;
  cursor_status TEXT;
  cursor_event TEXT;
  finalization_sequence INTEGER;
  finalization_status TEXT;
  finalization_event TEXT;
  finalization_hash CHAR(64);
BEGIN
  EXECUTE format(
    'SELECT attempt."run_id", attempt."external_event_sequence", attempt."status"::TEXT
     FROM %I."runtime_attempts" AS attempt
     WHERE attempt."id" = $1
     FOR SHARE',
    TG_TABLE_SCHEMA
  )
  INTO attempt_run_id, attempt_sequence, attempt_status
  USING NEW."runtime_attempt_id";

  IF attempt_run_id IS NULL
    OR NEW."run_id" IS DISTINCT FROM attempt_run_id
    OR NEW."last_applied_sequence" > attempt_sequence
  THEN
    RAISE EXCEPTION 'RUNTIME_PROVIDER_STATE_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."runtime_attempt_id" IS DISTINCT FROM OLD."runtime_attempt_id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."built_at" IS DISTINCT FROM OLD."built_at"
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_STATE_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF NEW."projection_version" < OLD."projection_version"
      OR NEW."last_applied_sequence" < OLD."last_applied_sequence"
      OR NEW."last_applied_sequence" > OLD."last_applied_sequence" + 1
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_STATE_MONOTONICITY_INVALID' USING ERRCODE = '23514';
    END IF;
    IF attempt_status IN ('succeeded', 'failed', 'cancelled')
      AND (
        NEW."projection_version" IS DISTINCT FROM OLD."projection_version"
        OR NEW."last_applied_sequence" IS DISTINCT FROM OLD."last_applied_sequence"
        OR NEW."state_sha256" IS DISTINCT FROM OLD."state_sha256"
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_STATE_TERMINAL_ATTEMPT' USING ERRCODE = '23514';
    END IF;
    NEW."updated_at" := GREATEST(
      clock_timestamp(),
      OLD."updated_at",
      NEW."built_at"
    );
  ELSE
    NEW."built_at" := clock_timestamp();
    NEW."updated_at" := NEW."built_at";
  END IF;

  IF NEW."last_external_event_id" IS NOT NULL THEN
    EXECUTE format(
      'SELECT event."sequence", event."status"::TEXT, event."event"
       FROM %I."runtime_external_events" AS event
       WHERE event."runtime_attempt_id" = $1
         AND event."external_event_id" = $2',
      TG_TABLE_SCHEMA
    )
    INTO cursor_sequence, cursor_status, cursor_event
    USING NEW."runtime_attempt_id", NEW."last_external_event_id";
    IF cursor_sequence IS NULL
      OR cursor_status <> 'processed'
      OR cursor_event = 'workbench.runtime.finalization.v2'
      OR cursor_sequence > NEW."last_applied_sequence"
      OR (
        NEW."finalization_external_event_id" IS NULL
        AND cursor_sequence <> NEW."last_applied_sequence"
      )
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_STATE_CURSOR_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."finalization_external_event_id" IS NOT NULL THEN
    EXECUTE format(
      'SELECT event."sequence", event."status"::TEXT, event."event", event."payload_sha256"
       FROM %I."runtime_external_events" AS event
       WHERE event."runtime_attempt_id" = $1
         AND event."external_event_id" = $2',
      TG_TABLE_SCHEMA
    )
    INTO finalization_sequence, finalization_status, finalization_event, finalization_hash
    USING NEW."runtime_attempt_id", NEW."finalization_external_event_id";
    IF finalization_sequence IS NULL
      OR finalization_status <> 'processed'
      OR finalization_event <> 'workbench.runtime.finalization.v2'
      OR finalization_sequence <> NEW."last_applied_sequence"
      OR finalization_hash IS DISTINCT FROM NEW."finalization_payload_sha256"
    THEN
      RAISE EXCEPTION 'RUNTIME_PROVIDER_STATE_FINALIZATION_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
