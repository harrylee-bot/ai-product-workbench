CREATE TABLE "product_interaction_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "content" TEXT,
  "metadata" JSONB,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_interaction_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_insights" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "issue_type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "affected_area" JSONB NOT NULL,
  "root_cause" TEXT NOT NULL,
  "suggestion" TEXT NOT NULL,
  "source_events" JSONB NOT NULL,
  "generated_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_insights_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_review_reports" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "issues" JSONB NOT NULL,
  "conflicts" JSONB NOT NULL,
  "improvements" JSONB NOT NULL,
  "consensus_score" DOUBLE PRECISION NOT NULL,
  "agent_outputs" JSONB NOT NULL,
  "generated_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_review_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "evolution_plans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "patch_operations" JSONB NOT NULL,
  "prd_changes" JSONB NOT NULL,
  "prototype_changes" JSONB NOT NULL,
  "impacted_areas" JSONB NOT NULL,
  "source_insight_ids" JSONB NOT NULL,
  "source_review_id" TEXT,
  "generated_by" TEXT NOT NULL,
  "executed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "evolution_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "evolution_patch_executions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "evolution_plan_id" TEXT NOT NULL,
  "patch_record_id" TEXT,
  "result" TEXT NOT NULL,
  "applied_operations" JSONB NOT NULL,
  "new_state_version" INTEGER,
  "rollback_id" TEXT,
  "error_message" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "evolution_patch_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_interaction_events_project_id_idx" ON "product_interaction_events"("project_id");
CREATE INDEX "product_interaction_events_type_idx" ON "product_interaction_events"("type");
CREATE INDEX "product_interaction_events_target_type_idx" ON "product_interaction_events"("target_type");
CREATE INDEX "product_interaction_events_created_at_idx" ON "product_interaction_events"("created_at");

CREATE INDEX "product_insights_project_id_idx" ON "product_insights"("project_id");
CREATE INDEX "product_insights_issue_type_idx" ON "product_insights"("issue_type");
CREATE INDEX "product_insights_severity_idx" ON "product_insights"("severity");
CREATE INDEX "product_insights_created_at_idx" ON "product_insights"("created_at");

CREATE INDEX "product_review_reports_project_id_idx" ON "product_review_reports"("project_id");
CREATE INDEX "product_review_reports_consensus_score_idx" ON "product_review_reports"("consensus_score");
CREATE INDEX "product_review_reports_created_at_idx" ON "product_review_reports"("created_at");

CREATE INDEX "evolution_plans_project_id_idx" ON "evolution_plans"("project_id");
CREATE INDEX "evolution_plans_priority_idx" ON "evolution_plans"("priority");
CREATE INDEX "evolution_plans_created_at_idx" ON "evolution_plans"("created_at");

CREATE INDEX "evolution_patch_executions_project_id_idx" ON "evolution_patch_executions"("project_id");
CREATE INDEX "evolution_patch_executions_evolution_plan_id_idx" ON "evolution_patch_executions"("evolution_plan_id");
CREATE INDEX "evolution_patch_executions_patch_record_id_idx" ON "evolution_patch_executions"("patch_record_id");
CREATE INDEX "evolution_patch_executions_result_idx" ON "evolution_patch_executions"("result");
CREATE INDEX "evolution_patch_executions_created_at_idx" ON "evolution_patch_executions"("created_at");

ALTER TABLE "product_interaction_events" ADD CONSTRAINT "product_interaction_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_insights" ADD CONSTRAINT "product_insights_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_review_reports" ADD CONSTRAINT "product_review_reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evolution_plans" ADD CONSTRAINT "evolution_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evolution_patch_executions" ADD CONSTRAINT "evolution_patch_executions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evolution_patch_executions" ADD CONSTRAINT "evolution_patch_executions_evolution_plan_id_fkey" FOREIGN KEY ("evolution_plan_id") REFERENCES "evolution_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
