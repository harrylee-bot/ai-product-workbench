ALTER TABLE "run_events"
ADD COLUMN "source_id" TEXT;

CREATE UNIQUE INDEX "run_events_run_id_source_id_key"
ON "run_events"("run_id", "source_id");
