BEGIN;

CREATE TYPE "KnowledgeRetrievalInvocationStatus" AS ENUM (
  'in_flight',
  'succeeded',
  'failed',
  'discarded',
  'abandoned'
);

CREATE TABLE "knowledge_tool_budgets" (
  "runtime_attempt_id" TEXT NOT NULL,
  "max_successful_calls" INTEGER NOT NULL,
  "max_concurrent_calls" INTEGER NOT NULL,
  "max_starts_per_window" INTEGER NOT NULL,
  "window_seconds" INTEGER NOT NULL,
  "max_attempts_per_invocation" INTEGER NOT NULL,
  "max_total_starts" INTEGER NOT NULL,
  "window_started_at" TIMESTAMP(3) NOT NULL,
  "window_starts" INTEGER NOT NULL DEFAULT 0,
  "total_starts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "knowledge_tool_budgets_pkey" PRIMARY KEY ("runtime_attempt_id"),
  CONSTRAINT "knowledge_tool_budgets_policy_check" CHECK (
    "max_successful_calls" BETWEEN 1 AND 1000
    AND "max_concurrent_calls" BETWEEN 1 AND "max_successful_calls"
    AND "max_starts_per_window" BETWEEN 1 AND 10000
    AND "window_seconds" BETWEEN 1 AND 3600
    AND "max_attempts_per_invocation" BETWEEN 1 AND 100
    AND "max_total_starts" BETWEEN "max_successful_calls" AND 100000
  ),
  CONSTRAINT "knowledge_tool_budgets_counters_check" CHECK (
    "window_starts" BETWEEN 0 AND "max_starts_per_window"
    AND "total_starts" BETWEEN 0 AND "max_total_starts"
  ),
  CONSTRAINT "knowledge_tool_budgets_timestamps_check" CHECK (
    "window_started_at" >= "created_at" - INTERVAL '5 seconds'
    AND "updated_at" >= "created_at"
  )
);

CREATE TABLE "knowledge_tool_grants" (
  "id" TEXT NOT NULL,
  "runtime_attempt_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "payload_sha256" TEXT NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_tool_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_tool_grants_id_check" CHECK (
    length("id") BETWEEN 1 AND 200
    AND "id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'
  ),
  CONSTRAINT "knowledge_tool_grants_payload_sha256_check" CHECK (
    "payload_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_tool_grants_expiry_check" CHECK (
    "expires_at" > "issued_at"
    AND "expires_at" <= "issued_at" + INTERVAL '1 hour'
    AND ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
  )
);

CREATE UNIQUE INDEX "knowledge_tool_grants_payload_sha256_key"
ON "knowledge_tool_grants"("payload_sha256");
CREATE INDEX "knowledge_tool_grants_runtime_attempt_id_expires_at_idx"
ON "knowledge_tool_grants"("runtime_attempt_id", "expires_at");
CREATE INDEX "knowledge_tool_grants_run_id_idx" ON "knowledge_tool_grants"("run_id");
CREATE INDEX "knowledge_tool_grants_principal_id_idx" ON "knowledge_tool_grants"("principal_id");
CREATE INDEX "knowledge_tool_grants_project_id_idx" ON "knowledge_tool_grants"("project_id");
CREATE INDEX "knowledge_tool_grants_release_id_idx" ON "knowledge_tool_grants"("release_id");

CREATE TABLE "knowledge_retrieval_invocations" (
  "id" TEXT NOT NULL,
  "runtime_attempt_id" TEXT NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "last_grant_id" TEXT NOT NULL,
  "query_sha256" TEXT NOT NULL,
  "status" "KnowledgeRetrievalInvocationStatus" NOT NULL,
  "attempt_count" INTEGER NOT NULL,
  "lease_token" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "response" JSONB,
  "response_sha256" TEXT,
  "last_error_code" TEXT,
  "last_started_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "knowledge_retrieval_invocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_retrieval_invocations_id_check" CHECK (
    length("id") BETWEEN 1 AND 200
    AND "id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$'
  ),
  CONSTRAINT "knowledge_retrieval_invocations_invocation_id_check" CHECK (
    length("invocation_id") BETWEEN 8 AND 128
    AND "invocation_id" ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT "knowledge_retrieval_invocations_query_sha256_check" CHECK (
    "query_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_retrieval_invocations_attempt_count_check" CHECK (
    "attempt_count" BETWEEN 1 AND 100
  ),
  CONSTRAINT "knowledge_retrieval_invocations_lease_token_check" CHECK (
    "lease_token" IS NULL
    OR (length("lease_token") BETWEEN 16 AND 128 AND "lease_token" ~ '^[A-Za-z0-9_-]+$')
  ),
  CONSTRAINT "knowledge_retrieval_invocations_response_sha256_check" CHECK (
    "response_sha256" IS NULL OR "response_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_retrieval_invocations_error_code_check" CHECK (
    "last_error_code" IS NULL OR length("last_error_code") BETWEEN 1 AND 128
  ),
  CONSTRAINT "knowledge_retrieval_invocations_state_check" CHECK (
    CASE "status"
      WHEN 'in_flight' THEN
        "lease_token" IS NOT NULL
        AND "lease_expires_at" > "last_started_at"
        AND "lease_expires_at" <= "last_started_at" + INTERVAL '15 minutes'
        AND "response" IS NULL
        AND "response_sha256" IS NULL
        AND "last_error_code" IS NULL
        AND "finished_at" IS NULL
      WHEN 'succeeded' THEN
        "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
        AND jsonb_typeof("response") = 'object'
        AND "response" ->> 'protocol' = 'workbench.knowledge-retrieval-result.v1'
        AND octet_length("response"::TEXT) <= 1048576
        AND "response_sha256" IS NOT NULL
        AND "last_error_code" IS NULL
        AND "finished_at" >= "last_started_at"
      ELSE
        "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
        AND "response" IS NULL
        AND "response_sha256" IS NULL
        AND "last_error_code" IS NOT NULL
        AND "finished_at" >= "last_started_at"
    END
  ),
  CONSTRAINT "knowledge_retrieval_invocations_timestamps_check" CHECK (
    "last_started_at" >= "created_at" - INTERVAL '5 seconds'
    AND "updated_at" >= "created_at"
  )
);

CREATE UNIQUE INDEX "knowledge_retrieval_invocations_attempt_invocation_key"
ON "knowledge_retrieval_invocations"("runtime_attempt_id", "invocation_id");
CREATE INDEX "knowledge_retrieval_invocations_attempt_status_lease_idx"
ON "knowledge_retrieval_invocations"("runtime_attempt_id", "status", "lease_expires_at");
CREATE INDEX "knowledge_retrieval_invocations_last_grant_id_idx"
ON "knowledge_retrieval_invocations"("last_grant_id");

ALTER TABLE "knowledge_tool_budgets"
ADD CONSTRAINT "knowledge_tool_budgets_runtime_attempt_id_fkey"
FOREIGN KEY ("runtime_attempt_id") REFERENCES "runtime_attempts"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "knowledge_tool_grants"
ADD CONSTRAINT "knowledge_tool_grants_runtime_attempt_id_fkey"
FOREIGN KEY ("runtime_attempt_id") REFERENCES "knowledge_tool_budgets"("runtime_attempt_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_tool_grants_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "runs"("id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_tool_grants_principal_id_fkey"
FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_tool_grants_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_tool_grants_release_id_fkey"
FOREIGN KEY ("release_id") REFERENCES "knowledge_releases"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "knowledge_retrieval_invocations"
ADD CONSTRAINT "knowledge_retrieval_invocations_runtime_attempt_id_fkey"
FOREIGN KEY ("runtime_attempt_id") REFERENCES "knowledge_tool_budgets"("runtime_attempt_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "knowledge_retrieval_invocations_last_grant_id_fkey"
FOREIGN KEY ("last_grant_id") REFERENCES "knowledge_tool_grants"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "guard_knowledge_tool_budget"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_status "RuntimeAttemptStatus";
  attempt_number INTEGER;
  run_status "RunStatus";
  run_attempt INTEGER;
  run_release_id TEXT;
BEGIN
  SELECT attempt."status", attempt."attempt", run."status", run."attempt", run."knowledge_release_id"
  INTO attempt_status, attempt_number, run_status, run_attempt, run_release_id
  FROM "runtime_attempts" AS attempt
  JOIN "runs" AS run ON run."id" = attempt."run_id"
  WHERE attempt."id" = NEW."runtime_attempt_id"
  FOR SHARE OF attempt, run;

  IF attempt_status IS NULL
    OR run_status IS DISTINCT FROM 'running'::"RunStatus"
    OR attempt_status NOT IN ('pending', 'submitting', 'running')
    OR attempt_number IS DISTINCT FROM run_attempt
    OR run_release_id IS NULL
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (NEW."window_starts" <> 0 OR NEW."total_starts" <> 0) THEN
    RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_MUST_START_EMPTY' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."runtime_attempt_id" IS DISTINCT FROM OLD."runtime_attempt_id"
      OR NEW."max_successful_calls" IS DISTINCT FROM OLD."max_successful_calls"
      OR NEW."max_concurrent_calls" IS DISTINCT FROM OLD."max_concurrent_calls"
      OR NEW."max_starts_per_window" IS DISTINCT FROM OLD."max_starts_per_window"
      OR NEW."window_seconds" IS DISTINCT FROM OLD."window_seconds"
      OR NEW."max_attempts_per_invocation" IS DISTINCT FROM OLD."max_attempts_per_invocation"
      OR NEW."max_total_starts" IS DISTINCT FROM OLD."max_total_starts"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_POLICY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF NEW."total_starts" IS DISTINCT FROM OLD."total_starts" + 1 THEN
      RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_TOTAL_START_INVALID' USING ERRCODE = '23514';
    END IF;

    IF NEW."window_started_at" IS NOT DISTINCT FROM OLD."window_started_at" THEN
      IF NEW."window_starts" IS DISTINCT FROM OLD."window_starts" + 1 THEN
        RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_WINDOW_START_INVALID' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."window_started_at" >= OLD."window_started_at" + make_interval(secs => OLD."window_seconds") THEN
      IF NEW."window_starts" IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_WINDOW_RESET_INVALID' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'KNOWLEDGE_TOOL_BUDGET_WINDOW_EARLY_RESET' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_tool_budget_guard"
BEFORE INSERT OR UPDATE ON "knowledge_tool_budgets"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_tool_budget"();

CREATE FUNCTION "guard_knowledge_tool_grant"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  scoped_run_id TEXT;
  scoped_principal_id TEXT;
  scoped_project_id TEXT;
  scoped_release_id TEXT;
  attempt_status "RuntimeAttemptStatus";
  attempt_number INTEGER;
  run_status "RunStatus";
  run_attempt INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."runtime_attempt_id" IS DISTINCT FROM OLD."runtime_attempt_id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."principal_id" IS DISTINCT FROM OLD."principal_id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
      OR NEW."payload_sha256" IS DISTINCT FROM OLD."payload_sha256"
      OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
      OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at")
      OR (OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NULL)
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_TOOL_GRANT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    run."id",
    run."created_by_id",
    run."project_id",
    run."knowledge_release_id",
    attempt."status",
    attempt."attempt",
    run."status",
    run."attempt"
  INTO
    scoped_run_id,
    scoped_principal_id,
    scoped_project_id,
    scoped_release_id,
    attempt_status,
    attempt_number,
    run_status,
    run_attempt
  FROM "knowledge_tool_budgets" AS budget
  JOIN "runtime_attempts" AS attempt ON attempt."id" = budget."runtime_attempt_id"
  JOIN "runs" AS run ON run."id" = attempt."run_id"
  WHERE budget."runtime_attempt_id" = NEW."runtime_attempt_id"
  FOR SHARE OF budget, attempt, run;

  IF scoped_run_id IS NULL
    OR NEW."run_id" IS DISTINCT FROM scoped_run_id
    OR NEW."principal_id" IS DISTINCT FROM scoped_principal_id
    OR NEW."project_id" IS DISTINCT FROM scoped_project_id
    OR NEW."release_id" IS DISTINCT FROM scoped_release_id
    OR run_status IS DISTINCT FROM 'running'::"RunStatus"
    OR attempt_status NOT IN ('pending', 'submitting', 'running')
    OR attempt_number IS DISTINCT FROM run_attempt
    OR NEW."revoked_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_TOOL_GRANT_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_tool_grant_guard"
BEFORE INSERT OR UPDATE ON "knowledge_tool_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_tool_grant"();

CREATE FUNCTION "guard_knowledge_retrieval_invocation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  budget_record "knowledge_tool_budgets"%ROWTYPE;
  grant_attempt_id TEXT;
  grant_issued_at TIMESTAMP(3);
  grant_expires_at TIMESTAMP(3);
  grant_revoked_at TIMESTAMP(3);
  active_count INTEGER;
  succeeded_count INTEGER;
  durable_start_count INTEGER;
BEGIN
  SELECT * INTO budget_record
  FROM "knowledge_tool_budgets"
  WHERE "runtime_attempt_id" = NEW."runtime_attempt_id"
  FOR UPDATE;

  SELECT "runtime_attempt_id", "issued_at", "expires_at", "revoked_at"
  INTO grant_attempt_id, grant_issued_at, grant_expires_at, grant_revoked_at
  FROM "knowledge_tool_grants"
  WHERE "id" = NEW."last_grant_id"
  FOR SHARE;

  IF budget_record."runtime_attempt_id" IS NULL
    OR grant_attempt_id IS DISTINCT FROM NEW."runtime_attempt_id"
    OR NEW."attempt_count" > budget_record."max_attempts_per_invocation"
  THEN
    RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'in_flight'::"KnowledgeRetrievalInvocationStatus"
      OR NEW."attempt_count" IS DISTINCT FROM 1
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_MUST_START_IN_FLIGHT' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."runtime_attempt_id" IS DISTINCT FROM OLD."runtime_attempt_id"
      OR NEW."invocation_id" IS DISTINCT FROM OLD."invocation_id"
      OR NEW."query_sha256" IS DISTINCT FROM OLD."query_sha256"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" IN ('succeeded', 'discarded') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
    END IF;

    IF OLD."status" = 'in_flight' THEN
      IF NEW."status" NOT IN ('succeeded', 'failed', 'discarded', 'abandoned')
        OR NEW."attempt_count" IS DISTINCT FROM OLD."attempt_count"
        OR NEW."last_started_at" IS DISTINCT FROM OLD."last_started_at"
        OR NEW."last_grant_id" IS DISTINCT FROM OLD."last_grant_id"
      THEN
        RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_SETTLEMENT_INVALID' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."status" IN ('failed', 'abandoned') THEN
      IF NEW."status" IS DISTINCT FROM 'in_flight'::"KnowledgeRetrievalInvocationStatus"
        OR NEW."attempt_count" IS DISTINCT FROM OLD."attempt_count" + 1
        OR NEW."last_started_at" <= OLD."last_started_at"
      THEN
        RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_RETRY_INVALID' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW."status" = 'in_flight' THEN
    IF grant_revoked_at IS NOT NULL
      OR grant_issued_at > NEW."last_started_at"
      OR grant_expires_at <= NEW."last_started_at"
    THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_INVOCATION_GRANT_INVALID' USING ERRCODE = '23514';
    END IF;

    SELECT count(*) INTO active_count
    FROM "knowledge_retrieval_invocations"
    WHERE "runtime_attempt_id" = NEW."runtime_attempt_id"
      AND "status" = 'in_flight'
      AND "id" <> NEW."id";
    IF active_count >= budget_record."max_concurrent_calls" THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_CONCURRENCY_EXCEEDED' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sum("attempt_count"), 0)::INTEGER INTO durable_start_count
    FROM "knowledge_retrieval_invocations"
    WHERE "runtime_attempt_id" = NEW."runtime_attempt_id";
    IF TG_OP = 'INSERT' THEN
      durable_start_count := durable_start_count + NEW."attempt_count";
    ELSE
      durable_start_count := durable_start_count + NEW."attempt_count" - OLD."attempt_count";
    END IF;
    IF budget_record."total_starts" IS DISTINCT FROM durable_start_count THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_START_LEDGER_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" = 'succeeded' AND (TG_OP = 'INSERT' OR OLD."status" <> 'succeeded') THEN
    SELECT count(*) INTO succeeded_count
    FROM "knowledge_retrieval_invocations"
    WHERE "runtime_attempt_id" = NEW."runtime_attempt_id"
      AND "status" = 'succeeded'
      AND "id" <> NEW."id";
    IF succeeded_count >= budget_record."max_successful_calls" THEN
      RAISE EXCEPTION 'KNOWLEDGE_RETRIEVAL_SUCCESS_QUOTA_EXCEEDED' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "knowledge_retrieval_invocation_guard"
BEFORE INSERT OR UPDATE ON "knowledge_retrieval_invocations"
FOR EACH ROW EXECUTE FUNCTION "guard_knowledge_retrieval_invocation"();

COMMIT;
