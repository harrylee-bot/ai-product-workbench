BEGIN;

CREATE TABLE "runtime_provider_states" (
  "runtime_attempt_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "projection_version" INTEGER NOT NULL,
  "last_applied_sequence" INTEGER NOT NULL DEFAULT 0,
  "last_external_event_id" VARCHAR(1024),
  "raw_assistant_text" TEXT NOT NULL DEFAULT '',
  "visible_assistant_text" TEXT NOT NULL DEFAULT '',
  "redaction_buffer" TEXT NOT NULL DEFAULT '',
  "finalization_external_event_id" VARCHAR(1024),
  "finalization_payload_sha256" CHAR(64),
  "state_sha256" CHAR(64) NOT NULL,
  "built_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT "runtime_provider_states_pkey" PRIMARY KEY ("runtime_attempt_id"),
  CONSTRAINT "runtime_provider_states_projection_version_positive_check"
    CHECK ("projection_version" > 0),
  CONSTRAINT "runtime_provider_states_last_applied_sequence_nonnegative_check"
    CHECK ("last_applied_sequence" >= 0),
  CONSTRAINT "runtime_provider_states_initial_shape_check" CHECK (
    "last_applied_sequence" <> 0
    OR (
      "last_external_event_id" IS NULL
      AND "finalization_external_event_id" IS NULL
      AND "finalization_payload_sha256" IS NULL
    )
  ),
  CONSTRAINT "runtime_provider_states_text_length_check" CHECK (
    char_length("raw_assistant_text") <= 16000000
    AND char_length("visible_assistant_text") <= 16000000
    AND char_length("redaction_buffer") <= 4096
  ),
  CONSTRAINT "runtime_provider_states_finalization_pair_check" CHECK (
    ("finalization_external_event_id" IS NULL AND "finalization_payload_sha256" IS NULL)
    OR (
      "finalization_external_event_id" IS NOT NULL
      AND "finalization_payload_sha256" IS NOT NULL
    )
  ),
  CONSTRAINT "runtime_provider_states_hash_shape_check" CHECK (
    "state_sha256" ~ '^[0-9a-f]{64}$'
    AND (
      "finalization_payload_sha256" IS NULL
      OR "finalization_payload_sha256" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "runtime_provider_states_timestamps_check"
    CHECK ("updated_at" >= "built_at")
);

CREATE INDEX "runtime_provider_states_run_id_idx"
ON "runtime_provider_states"("run_id");

CREATE UNIQUE INDEX "runtime_provider_states_attempt_run_key"
ON "runtime_provider_states"("runtime_attempt_id", "run_id");

CREATE INDEX "runtime_provider_states_projection_version_last_applied_sequence_idx"
ON "runtime_provider_states"("projection_version", "last_applied_sequence");

ALTER TABLE "runtime_provider_states"
ADD CONSTRAINT "runtime_provider_states_attempt_scope_fkey"
FOREIGN KEY ("runtime_attempt_id", "run_id")
REFERENCES "runtime_attempts"("id", "run_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "guard_runtime_provider_state"()
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
    NEW."updated_at" := clock_timestamp();
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

CREATE TRIGGER "runtime_provider_state_guard"
BEFORE INSERT OR UPDATE ON "runtime_provider_states"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_provider_state"();

COMMIT;
