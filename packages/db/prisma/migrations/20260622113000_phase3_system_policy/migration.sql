ALTER TABLE "decision_traces"
  ADD COLUMN "intent" TEXT,
  ADD COLUMN "strategies" JSONB,
  ADD COLUMN "selected_strategy_id" TEXT,
  ADD COLUMN "review_result" JSONB,
  ADD COLUMN "final_outcome" TEXT,
  ADD COLUMN "metrics" JSONB;

CREATE INDEX "decision_traces_selected_strategy_id_idx" ON "decision_traces"("selected_strategy_id");
CREATE INDEX "decision_traces_final_outcome_idx" ON "decision_traces"("final_outcome");

CREATE TABLE "system_policies" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "strategy_weights" JSONB NOT NULL,
  "agent_weights" JSONB NOT NULL,
  "decision_bias" JSONB NOT NULL,
  "source_trace_id" TEXT,
  "signal" JSONB NOT NULL,
  "previous_policy" JSONB,
  "rollback_of_policy_id" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_policies_project_id_version_key" ON "system_policies"("project_id", "version");
CREATE INDEX "system_policies_project_id_idx" ON "system_policies"("project_id");
CREATE INDEX "system_policies_source_trace_id_idx" ON "system_policies"("source_trace_id");
CREATE INDEX "system_policies_rollback_of_policy_id_idx" ON "system_policies"("rollback_of_policy_id");
CREATE INDEX "system_policies_created_at_idx" ON "system_policies"("created_at");

ALTER TABLE "system_policies"
  ADD CONSTRAINT "system_policies_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
