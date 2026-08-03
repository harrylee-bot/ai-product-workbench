BEGIN;

CREATE TABLE "runtime_provider_cancellation_resolutions" (
  "runtime_attempt_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "failure_code" VARCHAR(120) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "converged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_provider_cancellation_resolutions_pkey"
    PRIMARY KEY ("runtime_attempt_id"),
  CONSTRAINT "runtime_provider_cancellation_resolutions_attempt_run_key"
    UNIQUE ("runtime_attempt_id", "run_id"),
  CONSTRAINT "runtime_provider_cancellation_resolutions_failure_code_check"
    CHECK (length("failure_code") BETWEEN 1 AND 120),
  CONSTRAINT "runtime_provider_cancellation_resolutions_outcome_check"
    CHECK ("outcome" IN ('cancelled', 'already_terminal', 'external_run_absent')),
  CONSTRAINT "runtime_provider_cancellation_resolutions_attempt_fkey"
    FOREIGN KEY ("runtime_attempt_id", "run_id")
    REFERENCES "runtime_attempts"("id", "run_id")
    ON DELETE CASCADE
    ON UPDATE RESTRICT
);

CREATE INDEX "runtime_provider_cancellation_resolutions_run_id_converged_at_idx"
ON "runtime_provider_cancellation_resolutions"("run_id", "converged_at");

CREATE FUNCTION "guard_runtime_provider_cancellation_resolution_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owning_run_exists BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I."runs" WHERE "id" = $1)',
      TG_TABLE_SCHEMA
    )
    INTO owning_run_exists
    USING OLD."run_id";

    IF NOT owning_run_exists THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "runtime_provider_cancellation_resolutions_append_only_guard"
BEFORE UPDATE OR DELETE ON "runtime_provider_cancellation_resolutions"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_provider_cancellation_resolution_append_only"();

CREATE FUNCTION "guard_runtime_provider_cancellation_resolution_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'RUNTIME_PROVIDER_CANCELLATION_RESOLUTION_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "runtime_provider_cancellation_resolutions_truncate_guard"
BEFORE TRUNCATE ON "runtime_provider_cancellation_resolutions"
FOR EACH STATEMENT EXECUTE FUNCTION "guard_runtime_provider_cancellation_resolution_truncate"();

COMMIT;
