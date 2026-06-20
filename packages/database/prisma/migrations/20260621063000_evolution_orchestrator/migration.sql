CREATE TABLE "orchestration_runs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "module_states" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "orchestration_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "orchestration_runs_project_id_idx" ON "orchestration_runs"("project_id");
CREATE INDEX "orchestration_runs_status_idx" ON "orchestration_runs"("status");
CREATE INDEX "orchestration_runs_trigger_type_idx" ON "orchestration_runs"("trigger_type");
CREATE INDEX "orchestration_runs_created_at_idx" ON "orchestration_runs"("created_at");

ALTER TABLE "orchestration_runs"
ADD CONSTRAINT "orchestration_runs_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
