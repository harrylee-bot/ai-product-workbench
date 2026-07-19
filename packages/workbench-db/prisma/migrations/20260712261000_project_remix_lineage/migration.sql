-- A remix is a new mutable Project derived from one immutable Release through
-- one concrete Share grant. Lineage is append-only provenance, not a live link.
CREATE UNIQUE INDEX "projects_id_workspace_id_key"
ON "projects"("id", "workspace_id");

CREATE UNIQUE INDEX "share_grants_id_release_id_key"
ON "share_grants"("id", "release_id");

CREATE TABLE "project_lineages" (
  "target_project_id" TEXT NOT NULL,
  "source_release_id" TEXT NOT NULL,
  "source_share_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_lineages_pkey" PRIMARY KEY ("target_project_id")
);

CREATE UNIQUE INDEX "project_lineages_target_project_id_workspace_id_key"
ON "project_lineages"("target_project_id", "workspace_id");
CREATE INDEX "project_lineages_source_release_id_idx"
ON "project_lineages"("source_release_id");
CREATE INDEX "project_lineages_source_share_id_idx"
ON "project_lineages"("source_share_id");
CREATE INDEX "project_lineages_created_by_id_idx"
ON "project_lineages"("created_by_id");
CREATE INDEX "project_lineages_workspace_id_created_at_idx"
ON "project_lineages"("workspace_id", "created_at");

ALTER TABLE "project_lineages"
ADD CONSTRAINT "project_lineages_target_project_id_workspace_id_fkey"
FOREIGN KEY ("target_project_id", "workspace_id")
REFERENCES "projects"("id", "workspace_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_lineages_source_release_id_fkey"
FOREIGN KEY ("source_release_id")
REFERENCES "project_releases"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_lineages_source_share_id_source_release_id_fkey"
FOREIGN KEY ("source_share_id", "source_release_id")
REFERENCES "share_grants"("id", "release_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_lineages_created_by_id_fkey"
FOREIGN KEY ("created_by_id")
REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_lineages_workspace_id_fkey"
FOREIGN KEY ("workspace_id")
REFERENCES "workspaces"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_project_lineage_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_LINEAGE_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "project_lineages_immutable_guard"
BEFORE UPDATE OR DELETE ON "project_lineages"
FOR EACH ROW EXECUTE FUNCTION "guard_project_lineage_mutation"();
