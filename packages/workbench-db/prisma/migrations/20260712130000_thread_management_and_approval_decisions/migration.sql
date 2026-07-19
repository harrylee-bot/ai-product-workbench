-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('active', 'archived');

-- Thread ownership, lifecycle, and command idempotency.
ALTER TABLE "threads"
ADD COLUMN "created_by_id" TEXT,
ADD COLUMN "status" "ThreadStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "request_hash" TEXT;

UPDATE "threads" AS thread
SET "created_by_id" = project."created_by_id"
FROM "projects" AS project
WHERE project."id" = thread."project_id";

ALTER TABLE "threads" ALTER COLUMN "created_by_id" SET NOT NULL;

DROP INDEX "threads_project_id_updated_at_idx";
CREATE INDEX "threads_project_id_status_updated_at_idx"
ON "threads"("project_id", "status", "updated_at");
CREATE INDEX "threads_created_by_id_idx" ON "threads"("created_by_id");
CREATE UNIQUE INDEX "threads_project_id_idempotency_key_key"
ON "threads"("project_id", "idempotency_key");

ALTER TABLE "threads"
ADD CONSTRAINT "threads_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Approval decisions are compare-once commands. The original request hash
-- makes an exact retry safe while rejecting key reuse with a different body.
ALTER TABLE "run_approvals"
ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "decision_idempotency_key" TEXT,
ADD COLUMN "decision_request_hash" TEXT;

DROP INDEX "run_approvals_run_id_key_key";
CREATE UNIQUE INDEX "run_approvals_run_id_key_attempt_key"
ON "run_approvals"("run_id", "key", "attempt");
