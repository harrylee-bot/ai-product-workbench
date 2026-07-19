CREATE TYPE "CanvasAgentSessionStatus" AS ENUM (
  'active',
  'completed',
  'cancelled',
  'expired'
);

CREATE TYPE "CanvasToolInvocationStatus" AS ENUM (
  'in_flight',
  'waiting_client',
  'succeeded',
  'waiting_approval',
  'failed',
  'cancelled'
);

CREATE TYPE "CanvasClientCommandStatus" AS ENUM (
  'pending',
  'acknowledged',
  'expired',
  'cancelled'
);

CREATE TABLE "canvas_agent_sessions" (
  "id" TEXT NOT NULL,
  "runtime_attempt_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "board_id" TEXT NOT NULL,
  "client_session_id" VARCHAR(128) NOT NULL,
  "project_session_generation" INTEGER NOT NULL,
  "status" "CanvasAgentSessionStatus" NOT NULL DEFAULT 'active',
  "profile" VARCHAR(40) NOT NULL,
  "declared_tools" JSONB NOT NULL,
  "declaration_hash" CHAR(64) NOT NULL,
  "board_revision" INTEGER NOT NULL,
  "canvas_state_revision" INTEGER NOT NULL DEFAULT 0,
  "invocation_sequence" INTEGER NOT NULL DEFAULT 0,
  "selected_node_ids" JSONB NOT NULL,
  "visible_node_ids" JSONB NOT NULL,
  "viewport" JSONB NOT NULL,
  "active_mutation_tool_call_id" VARCHAR(512),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "canvas_agent_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canvas_agent_sessions_revision_check" CHECK (
    "project_session_generation" > 0
    AND "board_revision" >= 0
    AND "canvas_state_revision" >= 0
    AND "invocation_sequence" >= 0
  ),
  CONSTRAINT "canvas_agent_sessions_profile_check" CHECK (
    "profile" IN ('zero', 'read', 'edit', 'multi')
  ),
  CONSTRAINT "canvas_agent_sessions_json_shape_check" CHECK (
    jsonb_typeof("declared_tools") = 'array'
    AND jsonb_typeof("selected_node_ids") = 'array'
    AND jsonb_typeof("visible_node_ids") = 'array'
    AND jsonb_typeof("viewport") = 'object'
  ),
  CONSTRAINT "canvas_agent_sessions_hash_check" CHECK (
    "declaration_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "canvas_agent_sessions_client_session_check" CHECK (
    "client_session_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  CONSTRAINT "canvas_agent_sessions_expiry_check" CHECK (
    "expires_at" > "created_at"
  )
);

CREATE TABLE "canvas_tool_grants" (
  "id" UUID NOT NULL,
  "agent_session_id" TEXT NOT NULL,
  "payload_sha256" CHAR(64) NOT NULL,
  "declaration_hash" CHAR(64) NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "canvas_tool_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canvas_tool_grants_hash_check" CHECK (
    "payload_sha256" ~ '^[0-9a-f]{64}$'
    AND "declaration_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "canvas_tool_grants_expiry_check" CHECK (
    "expires_at" > "issued_at"
    AND ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
  )
);

CREATE TABLE "canvas_tool_invocations" (
  "id" TEXT NOT NULL,
  "agent_session_id" TEXT NOT NULL,
  "grant_id" UUID NOT NULL,
  "run_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "tool_call_id" VARCHAR(512) NOT NULL,
  "tool_name" VARCHAR(80) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "request" JSONB NOT NULL,
  "status" "CanvasToolInvocationStatus" NOT NULL DEFAULT 'in_flight',
  "execution_attempt" INTEGER NOT NULL DEFAULT 1,
  "lease_token" VARCHAR(128),
  "lease_expires_at" TIMESTAMPTZ(6),
  "board_revision_before" INTEGER NOT NULL,
  "board_revision_after" INTEGER,
  "canvas_state_revision_before" INTEGER NOT NULL,
  "canvas_state_revision_after" INTEGER,
  "response" JSONB,
  "failure_code" VARCHAR(120),
  "target_board_node_id" VARCHAR(128),
  "target_artifact_id" VARCHAR(128),
  "target_artifact_version_id" VARCHAR(128),
  "target_screen_id" VARCHAR(128),
  "result_artifact_version_id" VARCHAR(128),
  "satisfies_run_target" BOOLEAN NOT NULL DEFAULT false,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "canvas_tool_invocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canvas_tool_invocations_request_shape_check" CHECK (
    jsonb_typeof("request") = 'object'
    AND "request_hash" ~ '^[0-9a-f]{64}$'
    AND "sequence" > 0
  ),
  CONSTRAINT "canvas_tool_invocations_revision_check" CHECK (
    "board_revision_before" >= 0
    AND ("board_revision_after" IS NULL OR "board_revision_after" >= "board_revision_before")
    AND "canvas_state_revision_before" >= 0
    AND (
      "canvas_state_revision_after" IS NULL
      OR "canvas_state_revision_after" >= "canvas_state_revision_before"
    )
  ),
  CONSTRAINT "canvas_tool_invocations_completion_check" CHECK (
    (
      "status" IN ('in_flight', 'waiting_client', 'waiting_approval')
      AND "completed_at" IS NULL
    )
    OR (
      "status" IN ('succeeded', 'failed', 'cancelled')
      AND "completed_at" IS NOT NULL
      AND "response" IS NOT NULL
    )
  ),
  CONSTRAINT "canvas_tool_invocations_failure_check" CHECK (
    ("status" = 'failed' AND "failure_code" IS NOT NULL)
    OR ("status" <> 'failed' AND "failure_code" IS NULL)
  ),
  CONSTRAINT "canvas_tool_invocations_lease_check" CHECK (
    "execution_attempt" > 0
    AND (
      (
        "status" = 'in_flight'
        AND "lease_token" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
      )
      OR (
        "status" <> 'in_flight'
        AND "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
      )
    )
  ),
  CONSTRAINT "canvas_tool_invocations_result_check" CHECK (
    "result_artifact_version_id" IS NULL
    OR (
      "status" = 'succeeded'
      AND "satisfies_run_target"
    )
  )
);

CREATE TABLE "canvas_client_commands" (
  "id" TEXT NOT NULL,
  "agent_session_id" TEXT NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "client_session_id" VARCHAR(128) NOT NULL,
  "project_session_generation" INTEGER NOT NULL,
  "tool_call_id" VARCHAR(512) NOT NULL,
  "status" "CanvasClientCommandStatus" NOT NULL DEFAULT 'pending',
  "board_revision" INTEGER NOT NULL,
  "canvas_state_revision" INTEGER NOT NULL,
  "command" JSONB NOT NULL,
  "acknowledgement" JSONB,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "acknowledged_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "canvas_client_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canvas_client_commands_revision_check" CHECK (
    "project_session_generation" > 0
    AND "board_revision" >= 0
    AND "canvas_state_revision" >= 0
  ),
  CONSTRAINT "canvas_client_commands_command_shape_check" CHECK (
    jsonb_typeof("command") = 'object'
    AND ("acknowledgement" IS NULL OR jsonb_typeof("acknowledgement") = 'object')
  ),
  CONSTRAINT "canvas_client_commands_ack_check" CHECK (
    (
      "status" = 'acknowledged'
      AND "acknowledgement" IS NOT NULL
      AND "acknowledged_at" IS NOT NULL
    )
    OR (
      "status" <> 'acknowledged'
      AND "acknowledgement" IS NULL
      AND "acknowledged_at" IS NULL
    )
  ),
  CONSTRAINT "canvas_client_commands_expiry_check" CHECK (
    "expires_at" > "created_at"
  )
);

CREATE UNIQUE INDEX "canvas_agent_sessions_runtime_attempt_id_key"
ON "canvas_agent_sessions"("runtime_attempt_id");

CREATE UNIQUE INDEX "canvas_agent_sessions_id_run_id_key"
ON "canvas_agent_sessions"("id", "run_id");

CREATE INDEX "canvas_agent_sessions_run_id_status_idx"
ON "canvas_agent_sessions"("run_id", "status");

CREATE INDEX "canvas_agent_sessions_project_id_status_idx"
ON "canvas_agent_sessions"("project_id", "status");

CREATE INDEX "canvas_agent_sessions_thread_id_status_idx"
ON "canvas_agent_sessions"("thread_id", "status");

CREATE INDEX "canvas_agent_sessions_principal_id_created_at_idx"
ON "canvas_agent_sessions"("principal_id", "created_at");

CREATE INDEX "canvas_agent_sessions_board_id_board_revision_idx"
ON "canvas_agent_sessions"("board_id", "board_revision");

CREATE UNIQUE INDEX "canvas_tool_grants_agent_session_id_key"
ON "canvas_tool_grants"("agent_session_id");

CREATE UNIQUE INDEX "canvas_tool_grants_payload_sha256_key"
ON "canvas_tool_grants"("payload_sha256");

CREATE INDEX "canvas_tool_grants_expires_at_idx"
ON "canvas_tool_grants"("expires_at");

CREATE UNIQUE INDEX "canvas_tool_invocations_agent_session_id_tool_call_id_key"
ON "canvas_tool_invocations"("agent_session_id", "tool_call_id");

CREATE UNIQUE INDEX "canvas_tool_invocations_agent_session_id_sequence_key"
ON "canvas_tool_invocations"("agent_session_id", "sequence");

CREATE INDEX "canvas_tool_invocations_run_id_status_idx"
ON "canvas_tool_invocations"("run_id", "status");

CREATE INDEX "canvas_tool_invocations_project_id_created_at_idx"
ON "canvas_tool_invocations"("project_id", "created_at");

CREATE INDEX "canvas_tool_invocations_principal_id_created_at_idx"
ON "canvas_tool_invocations"("principal_id", "created_at");

CREATE INDEX "canvas_tool_invocations_grant_id_idx"
ON "canvas_tool_invocations"("grant_id");

CREATE INDEX "canvas_tool_invocations_target_artifact_version_id_idx"
ON "canvas_tool_invocations"("target_artifact_version_id");

CREATE INDEX "canvas_tool_invocations_result_artifact_version_id_project_id_idx"
ON "canvas_tool_invocations"("result_artifact_version_id", "project_id");

CREATE INDEX "canvas_tool_invocations_status_lease_expires_at_idx"
ON "canvas_tool_invocations"("status", "lease_expires_at");

CREATE UNIQUE INDEX "canvas_client_commands_invocation_id_key"
ON "canvas_client_commands"("invocation_id");

CREATE UNIQUE INDEX "canvas_client_commands_agent_session_id_tool_call_id_key"
ON "canvas_client_commands"("agent_session_id", "tool_call_id");

CREATE INDEX "canvas_client_commands_project_client_status_created_idx"
ON "canvas_client_commands"("project_id", "client_session_id", "status", "created_at");

CREATE INDEX "canvas_client_commands_run_id_status_idx"
ON "canvas_client_commands"("run_id", "status");

CREATE INDEX "canvas_client_commands_expires_at_status_idx"
ON "canvas_client_commands"("expires_at", "status");

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_runtime_attempt_id_fkey"
FOREIGN KEY ("runtime_attempt_id") REFERENCES "runtime_attempts"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "runs"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_thread_id_project_id_fkey"
FOREIGN KEY ("thread_id", "project_id") REFERENCES "threads"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_principal_id_fkey"
FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_board_id_project_id_fkey"
FOREIGN KEY ("board_id", "project_id") REFERENCES "boards"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_tool_grants"
ADD CONSTRAINT "canvas_tool_grants_agent_session_id_fkey"
FOREIGN KEY ("agent_session_id") REFERENCES "canvas_agent_sessions"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_tool_invocations"
ADD CONSTRAINT "canvas_tool_invocations_agent_session_id_run_id_fkey"
FOREIGN KEY ("agent_session_id", "run_id") REFERENCES "canvas_agent_sessions"("id", "run_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_tool_invocations"
ADD CONSTRAINT "canvas_tool_invocations_grant_id_fkey"
FOREIGN KEY ("grant_id") REFERENCES "canvas_tool_grants"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "canvas_tool_invocations"
ADD CONSTRAINT "canvas_tool_invocations_result_version_project_fkey"
FOREIGN KEY ("result_artifact_version_id", "project_id")
REFERENCES "artifact_versions"("id", "project_id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "canvas_client_commands"
ADD CONSTRAINT "canvas_client_commands_agent_session_id_run_id_fkey"
FOREIGN KEY ("agent_session_id", "run_id") REFERENCES "canvas_agent_sessions"("id", "run_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_client_commands"
ADD CONSTRAINT "canvas_client_commands_invocation_id_fkey"
FOREIGN KEY ("invocation_id") REFERENCES "canvas_tool_invocations"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "guard_canvas_agent_session_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_run_id TEXT;
  scoped_project_id TEXT;
  scoped_thread_id TEXT;
  scoped_principal_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."runtime_attempt_id" IS DISTINCT FROM OLD."runtime_attempt_id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
      OR NEW."principal_id" IS DISTINCT FROM OLD."principal_id"
      OR NEW."board_id" IS DISTINCT FROM OLD."board_id"
      OR NEW."client_session_id" IS DISTINCT FROM OLD."client_session_id"
      OR NEW."project_session_generation" IS DISTINCT FROM OLD."project_session_generation"
      OR NEW."profile" IS DISTINCT FROM OLD."profile"
      OR NEW."declared_tools" IS DISTINCT FROM OLD."declared_tools"
      OR NEW."declaration_hash" IS DISTINCT FROM OLD."declaration_hash"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    THEN
      RAISE EXCEPTION 'CANVAS_AGENT_SESSION_SCOPE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" <> 'active' AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."board_revision" IS DISTINCT FROM OLD."board_revision"
      OR NEW."canvas_state_revision" IS DISTINCT FROM OLD."canvas_state_revision"
      OR NEW."invocation_sequence" IS DISTINCT FROM OLD."invocation_sequence"
      OR NEW."selected_node_ids" IS DISTINCT FROM OLD."selected_node_ids"
      OR NEW."visible_node_ids" IS DISTINCT FROM OLD."visible_node_ids"
      OR NEW."viewport" IS DISTINCT FROM OLD."viewport"
      OR NEW."active_mutation_tool_call_id" IS DISTINCT FROM OLD."active_mutation_tool_call_id"
    ) THEN
      RAISE EXCEPTION 'CANVAS_AGENT_SESSION_TERMINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'active'
      AND NEW."status" NOT IN ('active', 'completed', 'cancelled', 'expired')
    THEN
      RAISE EXCEPTION 'CANVAS_AGENT_SESSION_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW."board_revision" < OLD."board_revision"
      OR NEW."canvas_state_revision" < OLD."canvas_state_revision"
      OR NEW."invocation_sequence" < OLD."invocation_sequence"
      OR NEW."invocation_sequence" > OLD."invocation_sequence" + 1
    THEN
      RAISE EXCEPTION 'CANVAS_AGENT_SESSION_REVISION_REGRESSION' USING ERRCODE = '23514';
    END IF;
    IF (
      NEW."selected_node_ids" IS DISTINCT FROM OLD."selected_node_ids"
      OR NEW."visible_node_ids" IS DISTINCT FROM OLD."visible_node_ids"
      OR NEW."viewport" IS DISTINCT FROM OLD."viewport"
    ) AND (
      OLD."status" <> 'active'
      OR NEW."status" <> 'active'
      OR NEW."canvas_state_revision" <= OLD."canvas_state_revision"
    ) THEN
      RAISE EXCEPTION 'CANVAS_AGENT_SESSION_STATE_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT attempt."run_id", run."project_id", run."thread_id", run."created_by_id"
  INTO attempt_run_id, scoped_project_id, scoped_thread_id, scoped_principal_id
  FROM "runtime_attempts" AS attempt
  JOIN "runs" AS run ON run."id" = attempt."run_id"
  WHERE attempt."id" = NEW."runtime_attempt_id";

  IF attempt_run_id IS DISTINCT FROM NEW."run_id"
    OR scoped_project_id IS DISTINCT FROM NEW."project_id"
    OR scoped_thread_id IS DISTINCT FROM NEW."thread_id"
    OR scoped_principal_id IS DISTINCT FROM NEW."principal_id"
  THEN
    RAISE EXCEPTION 'CANVAS_AGENT_SESSION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_agent_session_scope_guard"
BEFORE INSERT OR UPDATE ON "canvas_agent_sessions"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_agent_session_scope"();

CREATE FUNCTION "guard_canvas_tool_grant_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  session_hash TEXT;
  session_expiry TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."agent_session_id" IS DISTINCT FROM OLD."agent_session_id"
      OR NEW."payload_sha256" IS DISTINCT FROM OLD."payload_sha256"
      OR NEW."declaration_hash" IS DISTINCT FROM OLD."declaration_hash"
      OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
      OR OLD."revoked_at" IS NOT NULL
      OR (NEW."revoked_at" IS NOT NULL AND NEW."revoked_at" < OLD."issued_at")
    THEN
      RAISE EXCEPTION 'CANVAS_TOOL_GRANT_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "declaration_hash", "expires_at"
  INTO session_hash, session_expiry
  FROM "canvas_agent_sessions"
  WHERE "id" = NEW."agent_session_id";
  IF session_hash IS DISTINCT FROM NEW."declaration_hash"
    OR session_expiry IS DISTINCT FROM NEW."expires_at"
  THEN
    RAISE EXCEPTION 'CANVAS_TOOL_GRANT_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_tool_grant_scope_guard"
BEFORE INSERT OR UPDATE ON "canvas_tool_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_tool_grant_scope"();

CREATE FUNCTION "guard_canvas_tool_invocation_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  session_project_id TEXT;
  session_principal_id TEXT;
  session_tools JSONB;
  grant_session_id TEXT;
  publishing_result BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    publishing_result := (
      NEW."result_artifact_version_id" IS DISTINCT FROM OLD."result_artifact_version_id"
      AND OLD."result_artifact_version_id" IS NULL
      AND NEW."result_artifact_version_id" IS NOT NULL
      AND OLD."status" = 'succeeded'
      AND NEW."status" = 'succeeded'
      AND OLD."satisfies_run_target"
      AND NEW."satisfies_run_target"
    );
    IF NEW."agent_session_id" IS DISTINCT FROM OLD."agent_session_id"
      OR NEW."grant_id" IS DISTINCT FROM OLD."grant_id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."principal_id" IS DISTINCT FROM OLD."principal_id"
      OR NEW."tool_call_id" IS DISTINCT FROM OLD."tool_call_id"
      OR NEW."tool_name" IS DISTINCT FROM OLD."tool_name"
      OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
      OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
      OR NEW."request" IS DISTINCT FROM OLD."request"
      OR NEW."board_revision_before" IS DISTINCT FROM OLD."board_revision_before"
      OR NEW."canvas_state_revision_before" IS DISTINCT FROM OLD."canvas_state_revision_before"
      OR NEW."target_board_node_id" IS DISTINCT FROM OLD."target_board_node_id"
      OR NEW."target_artifact_id" IS DISTINCT FROM OLD."target_artifact_id"
      OR NEW."target_artifact_version_id" IS DISTINCT FROM OLD."target_artifact_version_id"
      OR NEW."target_screen_id" IS DISTINCT FROM OLD."target_screen_id"
      OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_SCOPE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" IN ('succeeded', 'failed', 'cancelled') AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."response" IS DISTINCT FROM OLD."response"
      OR NEW."failure_code" IS DISTINCT FROM OLD."failure_code"
      OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
      OR NEW."satisfies_run_target" IS DISTINCT FROM OLD."satisfies_run_target"
      OR (
        NOT publishing_result
        AND (
          NEW."board_revision_after" IS DISTINCT FROM OLD."board_revision_after"
          OR NEW."canvas_state_revision_after" IS DISTINCT FROM OLD."canvas_state_revision_after"
        )
      )
    ) THEN
      RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_TERMINAL' USING ERRCODE = '23514';
    END IF;
    IF NEW."result_artifact_version_id" IS DISTINCT FROM OLD."result_artifact_version_id" THEN
      IF NOT publishing_result THEN
        RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_RESULT_IMMUTABLE' USING ERRCODE = '23514';
      END IF;

      PERFORM 1
      FROM "artifact_versions"
      WHERE "id" = NEW."result_artifact_version_id"
        AND "project_id" = NEW."project_id"
        AND "artifact_id" = NEW."target_artifact_id"
        AND "created_by_run_id" = NEW."run_id"
        AND "status" = 'ready';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_RESULT_INVALID' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF (OLD."status" = 'in_flight' AND NEW."status" NOT IN (
      'in_flight', 'waiting_client', 'waiting_approval', 'succeeded', 'failed', 'cancelled'
    )) OR (OLD."status" = 'waiting_client' AND NEW."status" NOT IN (
      'waiting_client', 'succeeded', 'failed', 'cancelled'
    )) OR (OLD."status" = 'waiting_approval' AND NEW."status" NOT IN (
      'waiting_approval', 'succeeded', 'failed', 'cancelled'
    )) THEN
      RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW."execution_attempt" < OLD."execution_attempt"
      OR NEW."execution_attempt" > OLD."execution_attempt" + 1
      OR (
        NEW."execution_attempt" = OLD."execution_attempt" + 1
        AND (OLD."status" <> 'in_flight' OR NEW."status" <> 'in_flight')
      )
      OR (
        NEW."execution_attempt" = OLD."execution_attempt"
        AND NEW."status" = 'in_flight'
        AND (
          NEW."lease_token" IS DISTINCT FROM OLD."lease_token"
          OR NEW."lease_expires_at" IS DISTINCT FROM OLD."lease_expires_at"
        )
      )
    THEN
      RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_LEASE_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT session."project_id", session."principal_id", session."declared_tools", tool_grant."agent_session_id"
  INTO session_project_id, session_principal_id, session_tools, grant_session_id
  FROM "canvas_agent_sessions" AS session
  JOIN "canvas_tool_grants" AS tool_grant ON tool_grant."id" = NEW."grant_id"
  WHERE session."id" = NEW."agent_session_id";

  IF session_project_id IS DISTINCT FROM NEW."project_id"
    OR session_principal_id IS DISTINCT FROM NEW."principal_id"
    OR grant_session_id IS DISTINCT FROM NEW."agent_session_id"
    OR NOT session_tools ? NEW."tool_name"
  THEN
    RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_tool_invocation_scope_guard"
BEFORE INSERT OR UPDATE ON "canvas_tool_invocations"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_tool_invocation_scope"();

CREATE FUNCTION "guard_canvas_client_command_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_session_id TEXT;
  invocation_run_id TEXT;
  invocation_project_id TEXT;
  invocation_tool_call_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."agent_session_id" IS DISTINCT FROM OLD."agent_session_id"
      OR NEW."invocation_id" IS DISTINCT FROM OLD."invocation_id"
      OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
      OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
      OR NEW."client_session_id" IS DISTINCT FROM OLD."client_session_id"
      OR NEW."project_session_generation" IS DISTINCT FROM OLD."project_session_generation"
      OR NEW."tool_call_id" IS DISTINCT FROM OLD."tool_call_id"
      OR NEW."board_revision" IS DISTINCT FROM OLD."board_revision"
      OR NEW."canvas_state_revision" IS DISTINCT FROM OLD."canvas_state_revision"
      OR NEW."command" IS DISTINCT FROM OLD."command"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_SCOPE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" <> 'pending' AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."acknowledgement" IS DISTINCT FROM OLD."acknowledgement"
      OR NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at"
    ) THEN
      RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_TERMINAL' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'pending'
      AND NEW."status" NOT IN ('pending', 'acknowledged', 'expired', 'cancelled')
    THEN
      RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_TRANSITION_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "agent_session_id", "run_id", "project_id", "tool_call_id"
  INTO invocation_session_id, invocation_run_id, invocation_project_id, invocation_tool_call_id
  FROM "canvas_tool_invocations"
  WHERE "id" = NEW."invocation_id";

  IF invocation_session_id IS DISTINCT FROM NEW."agent_session_id"
    OR invocation_run_id IS DISTINCT FROM NEW."run_id"
    OR invocation_project_id IS DISTINCT FROM NEW."project_id"
    OR invocation_tool_call_id IS DISTINCT FROM NEW."tool_call_id"
  THEN
    RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_client_command_scope_guard"
BEFORE INSERT OR UPDATE ON "canvas_client_commands"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_client_command_scope"();
