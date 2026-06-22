CREATE TABLE "companies" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "budget" DOUBLE PRECISION NOT NULL,
  "strategy" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "departments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "budget_allocation" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agents" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "capabilities" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_initiatives" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "source_input" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "goal" TEXT NOT NULL,
  "features" JSONB NOT NULL,
  "ceo_approved" BOOLEAN NOT NULL DEFAULT false,
  "priority" TEXT NOT NULL,
  "allocated_budget" DOUBLE PRECISION NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_initiatives_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "engineering_plans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "initiative_id" TEXT NOT NULL,
  "modules" JSONB NOT NULL,
  "apis" JSONB NOT NULL,
  "system_changes" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "engineering_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "design_plans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "initiative_id" TEXT NOT NULL,
  "layouts" JSONB NOT NULL,
  "ux_flows" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "design_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_qa_reports" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "initiative_id" TEXT NOT NULL,
  "issues" JSONB NOT NULL,
  "risk_level" TEXT NOT NULL,
  "recommendations" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_qa_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "growth_plans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "initiative_id" TEXT NOT NULL,
  "optimizations" JSONB NOT NULL,
  "experiments" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "growth_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_evolution_plans" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "initiative_id" TEXT NOT NULL,
  "structural_changes" JSONB NOT NULL,
  "agent_changes" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_evolution_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "company_runtime_runs" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "initiative_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT,
  "input" TEXT NOT NULL,
  "ceo_plan" JSONB NOT NULL,
  "product_initiative" JSONB NOT NULL,
  "engineering_plan" JSONB NOT NULL,
  "design_plan" JSONB NOT NULL,
  "qa_report" JSONB NOT NULL,
  "growth_plan" JSONB NOT NULL,
  "evolution_plan" JSONB NOT NULL,
  "budget_allocation" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "company_runtime_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "companies_project_id_idx" ON "companies"("project_id");
CREATE INDEX "companies_status_idx" ON "companies"("status");
CREATE INDEX "companies_created_at_idx" ON "companies"("created_at");

CREATE UNIQUE INDEX "departments_company_id_type_key" ON "departments"("company_id", "type");
CREATE INDEX "departments_project_id_idx" ON "departments"("project_id");
CREATE INDEX "departments_company_id_idx" ON "departments"("company_id");
CREATE INDEX "departments_type_idx" ON "departments"("type");
CREATE INDEX "departments_status_idx" ON "departments"("status");

CREATE INDEX "agents_project_id_idx" ON "agents"("project_id");
CREATE INDEX "agents_company_id_idx" ON "agents"("company_id");
CREATE INDEX "agents_department_id_idx" ON "agents"("department_id");
CREATE INDEX "agents_status_idx" ON "agents"("status");

CREATE INDEX "product_initiatives_project_id_idx" ON "product_initiatives"("project_id");
CREATE INDEX "product_initiatives_company_id_idx" ON "product_initiatives"("company_id");
CREATE INDEX "product_initiatives_ceo_approved_idx" ON "product_initiatives"("ceo_approved");
CREATE INDEX "product_initiatives_priority_idx" ON "product_initiatives"("priority");
CREATE INDEX "product_initiatives_created_at_idx" ON "product_initiatives"("created_at");

CREATE INDEX "engineering_plans_project_id_idx" ON "engineering_plans"("project_id");
CREATE INDEX "engineering_plans_company_id_idx" ON "engineering_plans"("company_id");
CREATE INDEX "engineering_plans_initiative_id_idx" ON "engineering_plans"("initiative_id");
CREATE INDEX "engineering_plans_created_at_idx" ON "engineering_plans"("created_at");

CREATE INDEX "design_plans_project_id_idx" ON "design_plans"("project_id");
CREATE INDEX "design_plans_company_id_idx" ON "design_plans"("company_id");
CREATE INDEX "design_plans_initiative_id_idx" ON "design_plans"("initiative_id");
CREATE INDEX "design_plans_created_at_idx" ON "design_plans"("created_at");

CREATE INDEX "company_qa_reports_project_id_idx" ON "company_qa_reports"("project_id");
CREATE INDEX "company_qa_reports_company_id_idx" ON "company_qa_reports"("company_id");
CREATE INDEX "company_qa_reports_initiative_id_idx" ON "company_qa_reports"("initiative_id");
CREATE INDEX "company_qa_reports_risk_level_idx" ON "company_qa_reports"("risk_level");
CREATE INDEX "company_qa_reports_created_at_idx" ON "company_qa_reports"("created_at");

CREATE INDEX "growth_plans_project_id_idx" ON "growth_plans"("project_id");
CREATE INDEX "growth_plans_company_id_idx" ON "growth_plans"("company_id");
CREATE INDEX "growth_plans_initiative_id_idx" ON "growth_plans"("initiative_id");
CREATE INDEX "growth_plans_created_at_idx" ON "growth_plans"("created_at");

CREATE INDEX "company_evolution_plans_project_id_idx" ON "company_evolution_plans"("project_id");
CREATE INDEX "company_evolution_plans_company_id_idx" ON "company_evolution_plans"("company_id");
CREATE INDEX "company_evolution_plans_initiative_id_idx" ON "company_evolution_plans"("initiative_id");
CREATE INDEX "company_evolution_plans_created_at_idx" ON "company_evolution_plans"("created_at");

CREATE INDEX "company_runtime_runs_project_id_idx" ON "company_runtime_runs"("project_id");
CREATE INDEX "company_runtime_runs_company_id_idx" ON "company_runtime_runs"("company_id");
CREATE INDEX "company_runtime_runs_initiative_id_idx" ON "company_runtime_runs"("initiative_id");
CREATE INDEX "company_runtime_runs_source_type_idx" ON "company_runtime_runs"("source_type");
CREATE INDEX "company_runtime_runs_source_id_idx" ON "company_runtime_runs"("source_id");
CREATE INDEX "company_runtime_runs_status_idx" ON "company_runtime_runs"("status");
CREATE INDEX "company_runtime_runs_created_at_idx" ON "company_runtime_runs"("created_at");

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "departments"
  ADD CONSTRAINT "departments_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_department_id_fkey"
  FOREIGN KEY ("department_id") REFERENCES "departments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_initiatives"
  ADD CONSTRAINT "product_initiatives_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_initiatives"
  ADD CONSTRAINT "product_initiatives_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engineering_plans"
  ADD CONSTRAINT "engineering_plans_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engineering_plans"
  ADD CONSTRAINT "engineering_plans_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engineering_plans"
  ADD CONSTRAINT "engineering_plans_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "product_initiatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "design_plans"
  ADD CONSTRAINT "design_plans_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "design_plans"
  ADD CONSTRAINT "design_plans_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "design_plans"
  ADD CONSTRAINT "design_plans_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "product_initiatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_qa_reports"
  ADD CONSTRAINT "company_qa_reports_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_qa_reports"
  ADD CONSTRAINT "company_qa_reports_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_qa_reports"
  ADD CONSTRAINT "company_qa_reports_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "product_initiatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "growth_plans"
  ADD CONSTRAINT "growth_plans_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "growth_plans"
  ADD CONSTRAINT "growth_plans_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "growth_plans"
  ADD CONSTRAINT "growth_plans_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "product_initiatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_evolution_plans"
  ADD CONSTRAINT "company_evolution_plans_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_evolution_plans"
  ADD CONSTRAINT "company_evolution_plans_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_evolution_plans"
  ADD CONSTRAINT "company_evolution_plans_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "product_initiatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_runtime_runs"
  ADD CONSTRAINT "company_runtime_runs_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_runtime_runs"
  ADD CONSTRAINT "company_runtime_runs_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_runtime_runs"
  ADD CONSTRAINT "company_runtime_runs_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "product_initiatives"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
