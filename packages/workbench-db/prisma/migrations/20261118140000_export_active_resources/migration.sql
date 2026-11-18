BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "export_active_executions" (
  "job_id" TEXT NOT NULL REFERENCES "export_jobs" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "lease_id" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("job_id", "lease_id")
);

-- Existing leased executions may still have an open browser or storage connection.
INSERT INTO "export_active_executions" ("job_id", "lease_id", "owner")
SELECT "id", "execution_lease_id", "execution_owner" FROM "export_jobs"
WHERE "execution_lease_id" IS NOT NULL;
COMMIT;
