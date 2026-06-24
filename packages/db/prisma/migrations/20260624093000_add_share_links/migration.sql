CREATE TYPE "ShareScope" AS ENUM ('prd', 'prototype', 'both');

CREATE TYPE "ShareLinkStatus" AS ENUM ('active', 'revoked');

CREATE TABLE "share_links" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "scope" "ShareScope" NOT NULL DEFAULT 'both',
  "status" "ShareLinkStatus" NOT NULL DEFAULT 'active',
  "title" TEXT,
  "prd_document_id" TEXT,
  "prototype_artifact_id" TEXT,
  "product_design_state_id" TEXT,
  "expires_at" TIMESTAMP(3),
  "view_count" INTEGER NOT NULL DEFAULT 0,
  "last_viewed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");
CREATE INDEX "share_links_project_id_idx" ON "share_links"("project_id");
CREATE INDEX "share_links_status_idx" ON "share_links"("status");
CREATE INDEX "share_links_created_at_idx" ON "share_links"("created_at");

ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
