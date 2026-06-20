-- CreateEnum
CREATE TYPE "ProductDesignStateStatus" AS ENUM ('draft', 'clarifying', 'design_ready', 'prd_ready', 'prototype_ready', 'patching', 'qa_failed', 'confirmed');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AgentStepStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "AgentName" AS ENUM ('orchestrator', 'intent_agent', 'knowledge_agent', 'requirement_analyst_agent', 'product_designer_agent', 'prd_writer_agent', 'prototype_designer_agent', 'prototype_code_agent', 'patch_agent', 'qa_agent', 'knowledge_extractor_agent');

-- CreateEnum
CREATE TYPE "UserIntent" AS ENUM ('new_requirement', 'complete_requirement', 'clarification_answer', 'generate_prd', 'generate_prototype', 'patch_document', 'patch_prototype', 'global_adjustment', 'export_word', 'export_html', 'knowledge_update', 'general_question');

-- CreateTable
CREATE TABLE "product_design_states" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "business_goal" TEXT NOT NULL,
    "background" TEXT,
    "target_users" JSONB NOT NULL,
    "user_scenarios" JSONB NOT NULL,
    "pages" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "backend_configs" JSONB NOT NULL,
    "frontend_rules" JSONB NOT NULL,
    "business_rules" JSONB NOT NULL,
    "state_rules" JSONB NOT NULL,
    "exception_scenarios" JSONB NOT NULL,
    "acceptance_criteria" JSONB NOT NULL,
    "assumptions" JSONB NOT NULL,
    "knowledge_refs" JSONB NOT NULL,
    "pending_questions" JSONB NOT NULL,
    "prototype_spec" JSONB,
    "prd_document" JSONB,
    "status" "ProductDesignStateStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_design_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_logs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "intent" "UserIntent",
    "status" "AgentRunStatus" NOT NULL DEFAULT 'running',
    "input_summary" TEXT NOT NULL,
    "output_summary" TEXT,
    "result" JSONB,
    "error_message" TEXT,
    "trace_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "agent_run_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_step_logs" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "agent_name" "AgentName" NOT NULL,
    "status" "AgentStepStatus" NOT NULL DEFAULT 'pending',
    "input_summary" TEXT NOT NULL,
    "output_summary" TEXT,
    "model_call_log_id" TEXT,
    "model_provider_id" TEXT,
    "model_name" TEXT,
    "token_usage" JSONB,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error_message" TEXT,

    CONSTRAINT "agent_step_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vibe_stream_event_logs" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vibe_stream_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_design_states_project_id_version_key" ON "product_design_states"("project_id", "version");

-- CreateIndex
CREATE INDEX "product_design_states_project_id_idx" ON "product_design_states"("project_id");

-- CreateIndex
CREATE INDEX "product_design_states_status_idx" ON "product_design_states"("status");

-- CreateIndex
CREATE INDEX "agent_run_logs_project_id_idx" ON "agent_run_logs"("project_id");

-- CreateIndex
CREATE INDEX "agent_run_logs_conversation_id_idx" ON "agent_run_logs"("conversation_id");

-- CreateIndex
CREATE INDEX "agent_run_logs_user_id_idx" ON "agent_run_logs"("user_id");

-- CreateIndex
CREATE INDEX "agent_run_logs_intent_idx" ON "agent_run_logs"("intent");

-- CreateIndex
CREATE INDEX "agent_run_logs_status_idx" ON "agent_run_logs"("status");

-- CreateIndex
CREATE INDEX "agent_run_logs_trace_id_idx" ON "agent_run_logs"("trace_id");

-- CreateIndex
CREATE INDEX "agent_run_logs_started_at_idx" ON "agent_run_logs"("started_at");

-- CreateIndex
CREATE INDEX "agent_step_logs_run_id_idx" ON "agent_step_logs"("run_id");

-- CreateIndex
CREATE INDEX "agent_step_logs_agent_name_idx" ON "agent_step_logs"("agent_name");

-- CreateIndex
CREATE INDEX "agent_step_logs_status_idx" ON "agent_step_logs"("status");

-- CreateIndex
CREATE INDEX "agent_step_logs_model_call_log_id_idx" ON "agent_step_logs"("model_call_log_id");

-- CreateIndex
CREATE INDEX "vibe_stream_event_logs_run_id_idx" ON "vibe_stream_event_logs"("run_id");

-- CreateIndex
CREATE INDEX "vibe_stream_event_logs_project_id_idx" ON "vibe_stream_event_logs"("project_id");

-- CreateIndex
CREATE INDEX "vibe_stream_event_logs_event_type_idx" ON "vibe_stream_event_logs"("event_type");

-- CreateIndex
CREATE INDEX "vibe_stream_event_logs_created_at_idx" ON "vibe_stream_event_logs"("created_at");

-- AddForeignKey
ALTER TABLE "product_design_states" ADD CONSTRAINT "product_design_states_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_logs" ADD CONSTRAINT "agent_run_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_logs" ADD CONSTRAINT "agent_run_logs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_logs" ADD CONSTRAINT "agent_run_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_step_logs" ADD CONSTRAINT "agent_step_logs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_run_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_step_logs" ADD CONSTRAINT "agent_step_logs_model_call_log_id_fkey" FOREIGN KEY ("model_call_log_id") REFERENCES "model_call_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vibe_stream_event_logs" ADD CONSTRAINT "vibe_stream_event_logs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_run_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vibe_stream_event_logs" ADD CONSTRAINT "vibe_stream_event_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
