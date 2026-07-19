-- Persist the latest replay projection on the run so API reads do not need to
-- rebuild lifecycle state from the complete event stream.
CREATE TYPE "RunPhase" AS ENUM (
  'understanding',
  'retrieving_knowledge',
  'planning',
  'generating',
  'validating',
  'publishing'
);

ALTER TABLE "runs"
ADD COLUMN "phase" "RunPhase",
ADD COLUMN "phase_label" TEXT,
ADD COLUMN "progress" DOUBLE PRECISION,
ADD COLUMN "error_retryable" BOOLEAN,
ADD COLUMN "cancellation_reason" TEXT,
ADD CONSTRAINT "runs_progress_range_check"
CHECK ("progress" IS NULL OR ("progress" >= 0 AND "progress" <= 1));

UPDATE "runs"
SET "error_retryable" = FALSE
WHERE "error_code" IS NOT NULL
  AND "error_detail" IS NOT NULL;
