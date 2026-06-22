-- CreateEnum
CREATE TYPE "ModelProviderType" AS ENUM ('openai_compatible');

-- CreateEnum
CREATE TYPE "ModelTaskType" AS ENUM ('intent_detection', 'knowledge_classification', 'requirement_analysis', 'product_design', 'prd_generation', 'prototype_design', 'prototype_code_generation', 'patch_planning', 'qa_check', 'knowledge_extraction', 'general_chat');

-- CreateEnum
CREATE TYPE "ModelResponseFormat" AS ENUM ('text', 'json');

-- CreateEnum
CREATE TYPE "ModelCallStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ModelProviderType" NOT NULL DEFAULT 'openai_compatible',
    "base_url" TEXT NOT NULL,
    "api_key_encrypted" TEXT NOT NULL,
    "default_headers" JSONB,
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_configs" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "context_window" INTEGER,
    "max_output_tokens" INTEGER,
    "supports_streaming" BOOLEAN NOT NULL DEFAULT true,
    "supports_json_mode" BOOLEAN NOT NULL DEFAULT false,
    "default_temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "default_max_tokens" INTEGER,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_task_profiles" (
    "id" TEXT NOT NULL,
    "task_type" "ModelTaskType" NOT NULL,
    "model_config_id" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION,
    "max_tokens" INTEGER,
    "response_format" "ModelResponseFormat" NOT NULL DEFAULT 'text',
    "retry_count" INTEGER NOT NULL DEFAULT 1,
    "timeout_ms" INTEGER,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_task_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_call_logs" (
    "id" TEXT NOT NULL,
    "trace_id" TEXT,
    "run_id" TEXT,
    "agent_name" TEXT,
    "task_type" "ModelTaskType" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model_config_id" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "status" "ModelCallStatus" NOT NULL,
    "input_summary" TEXT,
    "output_summary" TEXT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "model_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_providers_is_default_idx" ON "model_providers"("is_default");

-- CreateIndex
CREATE INDEX "model_providers_is_enabled_idx" ON "model_providers"("is_enabled");

-- CreateIndex
CREATE INDEX "model_configs_provider_id_idx" ON "model_configs"("provider_id");

-- CreateIndex
CREATE INDEX "model_configs_is_enabled_idx" ON "model_configs"("is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "model_task_profiles_task_type_key" ON "model_task_profiles"("task_type");

-- CreateIndex
CREATE INDEX "model_task_profiles_task_type_idx" ON "model_task_profiles"("task_type");

-- CreateIndex
CREATE INDEX "model_task_profiles_is_enabled_idx" ON "model_task_profiles"("is_enabled");

-- CreateIndex
CREATE INDEX "model_call_logs_trace_id_idx" ON "model_call_logs"("trace_id");

-- CreateIndex
CREATE INDEX "model_call_logs_run_id_idx" ON "model_call_logs"("run_id");

-- CreateIndex
CREATE INDEX "model_call_logs_agent_name_idx" ON "model_call_logs"("agent_name");

-- CreateIndex
CREATE INDEX "model_call_logs_task_type_idx" ON "model_call_logs"("task_type");

-- CreateIndex
CREATE INDEX "model_call_logs_status_idx" ON "model_call_logs"("status");

-- CreateIndex
CREATE INDEX "model_call_logs_created_at_idx" ON "model_call_logs"("created_at");

-- AddForeignKey
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_task_profiles" ADD CONSTRAINT "model_task_profiles_model_config_id_fkey" FOREIGN KEY ("model_config_id") REFERENCES "model_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_call_logs" ADD CONSTRAINT "model_call_logs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_call_logs" ADD CONSTRAINT "model_call_logs_model_config_id_fkey" FOREIGN KEY ("model_config_id") REFERENCES "model_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
