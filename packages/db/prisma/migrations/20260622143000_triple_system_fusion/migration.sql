CREATE TABLE "constraint_rules" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "rule" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "condition" TEXT NOT NULL,
  "effect" TEXT NOT NULL,
  "weight" DOUBLE PRECISION NOT NULL,
  "source_knowledge_id" TEXT NOT NULL,
  "source_input" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "constraint_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "strategies" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "strategy_key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "patch_operations" JSONB NOT NULL,
  "impact" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "score_breakdown" JSONB NOT NULL,
  "constraint_snapshot" JSONB NOT NULL,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "source_input" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "evolution_signals" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "trace_id" TEXT,
  "strategy_id" TEXT NOT NULL,
  "signal_type" TEXT NOT NULL,
  "weight_delta" DOUBLE PRECISION NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "evolution_signals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "constraint_rules_project_id_idx" ON "constraint_rules"("project_id");
CREATE INDEX "constraint_rules_rule_idx" ON "constraint_rules"("rule");
CREATE INDEX "constraint_rules_scope_idx" ON "constraint_rules"("scope");
CREATE INDEX "constraint_rules_source_knowledge_id_idx" ON "constraint_rules"("source_knowledge_id");
CREATE INDEX "constraint_rules_created_at_idx" ON "constraint_rules"("created_at");

CREATE INDEX "strategies_project_id_idx" ON "strategies"("project_id");
CREATE INDEX "strategies_strategy_key_idx" ON "strategies"("strategy_key");
CREATE INDEX "strategies_name_idx" ON "strategies"("name");
CREATE INDEX "strategies_impact_idx" ON "strategies"("impact");
CREATE INDEX "strategies_selected_idx" ON "strategies"("selected");
CREATE INDEX "strategies_created_at_idx" ON "strategies"("created_at");

CREATE INDEX "evolution_signals_project_id_idx" ON "evolution_signals"("project_id");
CREATE INDEX "evolution_signals_trace_id_idx" ON "evolution_signals"("trace_id");
CREATE INDEX "evolution_signals_strategy_id_idx" ON "evolution_signals"("strategy_id");
CREATE INDEX "evolution_signals_signal_type_idx" ON "evolution_signals"("signal_type");
CREATE INDEX "evolution_signals_created_at_idx" ON "evolution_signals"("created_at");

ALTER TABLE "constraint_rules"
  ADD CONSTRAINT "constraint_rules_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "strategies"
  ADD CONSTRAINT "strategies_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "evolution_signals"
  ADD CONSTRAINT "evolution_signals_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
