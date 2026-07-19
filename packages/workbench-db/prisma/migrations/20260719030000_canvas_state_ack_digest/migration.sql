BEGIN;

ALTER TABLE "canvas_tool_invocations"
ADD COLUMN "canvas_state_sha256_before" CHAR(64) NOT NULL DEFAULT repeat('0', 64),
ADD COLUMN "canvas_state_sha256_after" CHAR(64);

ALTER TABLE "canvas_client_commands"
ADD COLUMN "expected_canvas_state_sha256" CHAR(64) NOT NULL DEFAULT repeat('0', 64),
ADD COLUMN "acknowledged_canvas_state_sha256" CHAR(64);

-- Historical rows predate canonical Canvas-state binding. Keep them readable
-- while making every new terminal transition carry an explicit digest.
UPDATE "canvas_tool_invocations"
SET "canvas_state_sha256_after" = "canvas_state_sha256_before"
WHERE "status" IN ('succeeded', 'failed', 'cancelled');

UPDATE "canvas_client_commands"
SET "acknowledged_canvas_state_sha256" = "expected_canvas_state_sha256"
WHERE "status" = 'acknowledged';

ALTER TABLE "canvas_tool_invocations"
ALTER COLUMN "canvas_state_sha256_before" DROP DEFAULT;

ALTER TABLE "canvas_client_commands"
ALTER COLUMN "expected_canvas_state_sha256" DROP DEFAULT;

ALTER TABLE "canvas_tool_invocations"
ADD CONSTRAINT "canvas_tool_invocations_state_digest_check" CHECK (
  "canvas_state_sha256_before" ~ '^[0-9a-f]{64}$'
  AND (
    "canvas_state_sha256_after" IS NULL
    OR "canvas_state_sha256_after" ~ '^[0-9a-f]{64}$'
  )
  AND (
    ("status" IN ('succeeded', 'failed', 'cancelled') AND "canvas_state_sha256_after" IS NOT NULL)
    OR ("status" NOT IN ('succeeded', 'failed', 'cancelled') AND "canvas_state_sha256_after" IS NULL)
  )
);

ALTER TABLE "canvas_client_commands"
ADD CONSTRAINT "canvas_client_commands_state_digest_check" CHECK (
  "expected_canvas_state_sha256" ~ '^[0-9a-f]{64}$'
  AND (
    "acknowledged_canvas_state_sha256" IS NULL
    OR "acknowledged_canvas_state_sha256" ~ '^[0-9a-f]{64}$'
  )
  AND (
    ("status" = 'acknowledged' AND "acknowledged_canvas_state_sha256" IS NOT NULL)
    OR ("status" <> 'acknowledged' AND "acknowledged_canvas_state_sha256" IS NULL)
  )
);

CREATE FUNCTION "guard_canvas_tool_invocation_state_digest"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."canvas_state_sha256_before" IS DISTINCT FROM OLD."canvas_state_sha256_before" THEN
    RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_STATE_BEFORE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('succeeded', 'failed', 'cancelled')
    AND NEW."canvas_state_sha256_after" IS DISTINCT FROM OLD."canvas_state_sha256_after"
  THEN
    RAISE EXCEPTION 'CANVAS_TOOL_INVOCATION_STATE_AFTER_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_tool_invocation_state_digest_guard"
BEFORE UPDATE ON "canvas_tool_invocations"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_tool_invocation_state_digest"();

CREATE FUNCTION "guard_canvas_client_command_state_digest"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_state_sha256_before TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."expected_canvas_state_sha256" IS DISTINCT FROM OLD."expected_canvas_state_sha256" THEN
      RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_EXPECTED_STATE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" <> 'pending'
      AND NEW."acknowledged_canvas_state_sha256" IS DISTINCT FROM OLD."acknowledged_canvas_state_sha256"
    THEN
      RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_ACK_STATE_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "canvas_state_sha256_before"
  INTO invocation_state_sha256_before
  FROM "canvas_tool_invocations"
  WHERE "id" = NEW."invocation_id";

  IF invocation_state_sha256_before IS DISTINCT FROM NEW."expected_canvas_state_sha256" THEN
    RAISE EXCEPTION 'CANVAS_CLIENT_COMMAND_EXPECTED_STATE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_client_command_state_digest_guard"
BEFORE INSERT OR UPDATE ON "canvas_client_commands"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_client_command_state_digest"();

COMMIT;
