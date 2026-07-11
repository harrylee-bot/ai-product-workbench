-- Durable run identity and fencing for the conversation Agent runtime.
BEGIN;

ALTER TABLE "agent_run_logs"
  ADD COLUMN IF NOT EXISTS "request_id" TEXT,
  ADD COLUMN IF NOT EXISTS "lease_token" TEXT,
  ADD COLUMN IF NOT EXISTS "heartbeat_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "external_run_id" TEXT;

-- Runs left behind by a previous process predate leases and cannot safely own a
-- future commit. Mark them failed before installing the single-flight guard.
UPDATE "agent_run_logs"
SET
  "status" = 'failed',
  "ended_at" = COALESCE("ended_at", CURRENT_TIMESTAMP),
  "error_message" = COALESCE("error_message", 'RUN_RECOVERED_WITHOUT_LEASE')
WHERE "status" = 'running'
  AND "lease_token" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_logs_conversation_id_request_id_key"
  ON "agent_run_logs"("conversation_id", "request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_logs_one_running_per_conversation_key"
  ON "agent_run_logs"("conversation_id")
  WHERE "status" = 'running';
CREATE INDEX IF NOT EXISTS "agent_run_logs_conversation_id_status_idx"
  ON "agent_run_logs"("conversation_id", "status");
CREATE INDEX IF NOT EXISTS "agent_run_logs_lease_expires_at_idx"
  ON "agent_run_logs"("lease_expires_at");

COMMIT;
