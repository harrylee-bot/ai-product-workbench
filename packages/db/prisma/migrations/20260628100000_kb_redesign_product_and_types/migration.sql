-- Extend knowledge taxonomy for product-architecture and UI-design assets.
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'product_architecture';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'page_inventory';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'ui_style_guide';
ALTER TYPE "KnowledgeType" ADD VALUE IF NOT EXISTS 'prototype_asset_ref';

-- Add product-level knowledge scope for cross-project product reuse.
ALTER TYPE "KnowledgeScope" ADD VALUE IF NOT EXISTS 'product';

-- Allow Product CRUD actions to be audited.
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'product';

CREATE TABLE IF NOT EXISTS "products" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "product_id" TEXT;
ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "source_product_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_product_id_fkey'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_items_source_product_id_fkey'
  ) THEN
    ALTER TABLE "knowledge_items"
      ADD CONSTRAINT "knowledge_items_source_product_id_fkey"
      FOREIGN KEY ("source_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "products_name_idx" ON "products"("name");
CREATE INDEX IF NOT EXISTS "products_created_at_idx" ON "products"("created_at");
CREATE INDEX IF NOT EXISTS "projects_product_id_idx" ON "projects"("product_id");
CREATE INDEX IF NOT EXISTS "knowledge_items_scope_source_project_id_idx" ON "knowledge_items"("scope", "source_project_id");
CREATE INDEX IF NOT EXISTS "knowledge_items_scope_source_product_id_idx" ON "knowledge_items"("scope", "source_product_id");

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_versions_knowledge_item_id_version_key"
  ON "knowledge_versions"("knowledge_item_id", "version");
