CREATE TABLE "product_memories" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" TEXT,
    "change_reason" TEXT NOT NULL,
    "evolution_plan" JSONB NOT NULL,
    "patch_result" JSONB NOT NULL,
    "before_state" JSONB NOT NULL,
    "after_state" JSONB NOT NULL,
    "insights" JSONB NOT NULL,
    "agent_report" JSONB NOT NULL,
    "evolution_plan_id" TEXT,
    "patch_execution_id" TEXT,
    "patch_record_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_memories_project_id_idx" ON "product_memories"("project_id");
CREATE INDEX "product_memories_version_idx" ON "product_memories"("version");
CREATE INDEX "product_memories_category_idx" ON "product_memories"("category");
CREATE INDEX "product_memories_evolution_plan_id_idx" ON "product_memories"("evolution_plan_id");
CREATE INDEX "product_memories_patch_execution_id_idx" ON "product_memories"("patch_execution_id");
CREATE INDEX "product_memories_patch_record_id_idx" ON "product_memories"("patch_record_id");
CREATE INDEX "product_memories_created_at_idx" ON "product_memories"("created_at");

ALTER TABLE "product_memories"
ADD CONSTRAINT "product_memories_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
