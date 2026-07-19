BEGIN;

ALTER TABLE "canvas_agent_sessions"
ADD COLUMN "snapshot_sha256" CHAR(64) NOT NULL DEFAULT repeat('0', 64);

ALTER TABLE "canvas_tool_grants"
ADD COLUMN "snapshot_sha256" CHAR(64) NOT NULL DEFAULT repeat('0', 64);

-- Capabilities created before this migration were not bound to a complete
-- Canvas snapshot. Fence them before making the new digest mandatory.
UPDATE "canvas_tool_grants"
SET "revoked_at" = GREATEST("issued_at", clock_timestamp())
WHERE "revoked_at" IS NULL;

UPDATE "canvas_agent_sessions"
SET "status" = 'cancelled',
    "active_mutation_tool_call_id" = NULL,
    "updated_at" = clock_timestamp()
WHERE "status" = 'active';

ALTER TABLE "canvas_agent_sessions"
ALTER COLUMN "snapshot_sha256" DROP DEFAULT;

ALTER TABLE "canvas_tool_grants"
ALTER COLUMN "snapshot_sha256" DROP DEFAULT;

ALTER TABLE "canvas_agent_sessions"
ADD CONSTRAINT "canvas_agent_sessions_snapshot_sha256_check"
CHECK ("snapshot_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "canvas_tool_grants"
ADD CONSTRAINT "canvas_tool_grants_snapshot_sha256_check"
CHECK ("snapshot_sha256" ~ '^[0-9a-f]{64}$');

CREATE FUNCTION "guard_canvas_agent_session_snapshot_digest"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."snapshot_sha256" IS DISTINCT FROM OLD."snapshot_sha256" THEN
    RAISE EXCEPTION 'CANVAS_AGENT_SESSION_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_agent_session_snapshot_digest_guard"
BEFORE UPDATE ON "canvas_agent_sessions"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_agent_session_snapshot_digest"();

CREATE FUNCTION "guard_canvas_tool_grant_snapshot_digest"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  session_snapshot_sha256 TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."snapshot_sha256" IS DISTINCT FROM OLD."snapshot_sha256"
  THEN
    RAISE EXCEPTION 'CANVAS_TOOL_GRANT_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  SELECT "snapshot_sha256"
  INTO session_snapshot_sha256
  FROM "canvas_agent_sessions"
  WHERE "id" = NEW."agent_session_id";

  IF session_snapshot_sha256 IS DISTINCT FROM NEW."snapshot_sha256" THEN
    RAISE EXCEPTION 'CANVAS_TOOL_GRANT_SNAPSHOT_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_tool_grant_snapshot_digest_guard"
BEFORE INSERT OR UPDATE ON "canvas_tool_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_tool_grant_snapshot_digest"();

COMMIT;
