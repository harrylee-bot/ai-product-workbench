BEGIN;

CREATE TYPE "CanvasVisualCapabilityStatus" AS ENUM ('pending', 'ready', 'failed', 'expired');

CREATE TABLE "canvas_visual_capabilities" (
  "id" UUID NOT NULL,
  "agent_session_id" TEXT NOT NULL,
  "grant_id" UUID NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "target_board_node_id" VARCHAR(128) NOT NULL,
  "target_artifact_id" VARCHAR(128) NOT NULL,
  "target_version_id" VARCHAR(128) NOT NULL,
  "target_screen_id" VARCHAR(128) NOT NULL,
  "storage_key" TEXT,
  "status" "CanvasVisualCapabilityStatus" NOT NULL DEFAULT 'pending',
  "media_type" VARCHAR(80),
  "sha256" CHAR(64),
  "byte_size" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "failure_code" VARCHAR(120),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "storage_deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canvas_visual_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "canvas_visual_capabilities_storage_key_key"
  ON "canvas_visual_capabilities" ("storage_key");
CREATE UNIQUE INDEX "canvas_visual_capabilities_invocation_id_key"
  ON "canvas_visual_capabilities" ("invocation_id");
CREATE UNIQUE INDEX "canvas_visual_capabilities_command_id_key"
  ON "canvas_visual_capabilities" ("command_id");
CREATE INDEX "canvas_visual_capabilities_status_expires_at_idx"
  ON "canvas_visual_capabilities" ("status", "expires_at");
CREATE INDEX "canvas_visual_capabilities_project_id_created_at_idx"
  ON "canvas_visual_capabilities" ("project_id", "created_at");
CREATE INDEX "canvas_visual_capabilities_run_id_status_idx"
  ON "canvas_visual_capabilities" ("run_id", "status");

ALTER TABLE "canvas_visual_capabilities"
  ADD CONSTRAINT "canvas_visual_capabilities_agent_session_id_fkey"
  FOREIGN KEY ("agent_session_id") REFERENCES "canvas_agent_sessions"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "canvas_visual_capabilities"
  ADD CONSTRAINT "canvas_visual_capabilities_grant_id_fkey"
  FOREIGN KEY ("grant_id") REFERENCES "canvas_tool_grants"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "canvas_visual_capabilities"
  ADD CONSTRAINT "canvas_visual_capabilities_invocation_id_fkey"
  FOREIGN KEY ("invocation_id") REFERENCES "canvas_tool_invocations"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "canvas_visual_capabilities"
  ADD CONSTRAINT "canvas_visual_capabilities_command_id_fkey"
  FOREIGN KEY ("command_id") REFERENCES "canvas_client_commands"("id")
  ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "canvas_visual_capabilities"
  ADD CONSTRAINT "canvas_visual_capabilities_payload_check" CHECK (
    ("status" = 'pending' AND "storage_key" IS NULL AND "media_type" IS NULL AND "sha256" IS NULL AND "byte_size" IS NULL)
    OR
    ("status" = 'ready'
      AND "storage_key" IS NOT NULL
      AND "media_type" IN ('image/webp', 'image/jpeg', 'image/png')
      AND "sha256" ~ '^[0-9a-f]{64}$'
      AND "byte_size" BETWEEN 1 AND 1048576
      AND "width" BETWEEN 1 AND 2048
      AND "height" BETWEEN 1 AND 2048)
    OR
    ("status" IN ('failed', 'expired'))
  );

CREATE FUNCTION "guard_canvas_visual_capability_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invocation_tool TEXT;
  command_json JSONB;
BEGIN
  SELECT "tool_name" INTO invocation_tool
  FROM "canvas_tool_invocations"
  WHERE "id" = NEW."invocation_id";
  IF invocation_tool IS DISTINCT FROM 'view_screen' THEN
    RAISE EXCEPTION 'CANVAS_VISUAL_CAPABILITY_TOOL_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT "command" INTO command_json
  FROM "canvas_client_commands"
  WHERE "id" = NEW."command_id";
  IF command_json->>'kind' IS DISTINCT FROM 'preview.open'
     OR command_json->'view'->>'visualCapabilityId' IS DISTINCT FROM NEW."id"::TEXT
  THEN
    RAISE EXCEPTION 'CANVAS_VISUAL_CAPABILITY_COMMAND_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."status" = 'ready' AND OLD."status" NOT IN ('pending', 'ready') THEN
    RAISE EXCEPTION 'CANVAS_VISUAL_CAPABILITY_TERMINAL_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'ready' AND (
    NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
    OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
    OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
    OR NEW."media_type" IS DISTINCT FROM OLD."media_type"
    OR NEW."width" IS DISTINCT FROM OLD."width"
    OR NEW."height" IS DISTINCT FROM OLD."height"
  ) THEN
    RAISE EXCEPTION 'CANVAS_VISUAL_CAPABILITY_PAYLOAD_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "canvas_visual_capability_scope_guard"
BEFORE INSERT OR UPDATE ON "canvas_visual_capabilities"
FOR EACH ROW EXECUTE FUNCTION "guard_canvas_visual_capability_scope"();

COMMIT;
