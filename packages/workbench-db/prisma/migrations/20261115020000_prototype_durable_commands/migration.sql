BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TYPE "PrototypeMutationKind" ADD VALUE IF NOT EXISTS 'revision_revise';
ALTER TYPE "PrototypeMutationKind" ADD VALUE IF NOT EXISTS 'revision_confirmed';
ALTER TYPE "PrototypeMutationKind" ADD VALUE IF NOT EXISTS 'revision_rejected';
ALTER TABLE "prototype_plans"
  ADD COLUMN "root_plan_id" TEXT,
  ADD COLUMN "source_revision_id" TEXT,
  ADD COLUMN "content_version" INTEGER NOT NULL DEFAULT 1 CHECK ("content_version" > 0),
  ADD COLUMN "feedback_ids" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "generation_request" JSONB;
ALTER TABLE "prototype_revisions"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  ADD COLUMN "source_revision_id" TEXT,
  ADD COLUMN "source_document" JSONB;
-- Old revision is a mutable CAS counter, not a content sequence. Preserve row order.
WITH ordered AS (
 SELECT id, row_number() OVER (PARTITION BY plan_id ORDER BY created_at, id) AS version FROM prototype_revisions
) UPDATE prototype_revisions r SET version = ordered.version FROM ordered WHERE r.id = ordered.id;
DROP INDEX "prototype_revisions_plan_revision_key";
CREATE UNIQUE INDEX "prototype_revisions_plan_version_key" ON "prototype_revisions"("plan_id", "version");
CREATE UNIQUE INDEX "prototype_plans_id_project_key" ON "prototype_plans"("id", "project_id");
CREATE UNIQUE INDEX "prototype_revisions_id_project_key" ON "prototype_revisions"("id", "project_id");
CREATE UNIQUE INDEX "prototype_generation_content_version_key" ON "prototype_plans"((COALESCE("root_plan_id", "id")), "content_version");
ALTER TABLE "prototype_plans" ADD CONSTRAINT "prototype_plans_root_project_fkey" FOREIGN KEY ("root_plan_id", "project_id") REFERENCES "prototype_plans"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_plans" ADD CONSTRAINT "prototype_plans_source_revision_project_fkey" FOREIGN KEY ("source_revision_id", "project_id") REFERENCES "prototype_revisions"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_revisions" ADD CONSTRAINT "prototype_revisions_source_project_fkey" FOREIGN KEY ("source_revision_id", "project_id") REFERENCES "prototype_revisions"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_revisions" ADD CONSTRAINT "prototype_revisions_plan_project_fkey" FOREIGN KEY ("plan_id", "project_id") REFERENCES "prototype_plans"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_feedback" ADD CONSTRAINT "prototype_feedback_revision_project_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "prototype_revisions"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_shares" ADD CONSTRAINT "prototype_shares_revision_project_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "prototype_revisions"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "prototype_exports" ADD CONSTRAINT "prototype_exports_revision_project_fkey" FOREIGN KEY ("revision_id", "project_id") REFERENCES "prototype_revisions"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
CREATE TABLE "prototype_workflow_commands" (
 "id" TEXT PRIMARY KEY,
 "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('plan_start', 'plan_cancel', 'export_start', 'export_cancel', 'share_create', 'share_revoke')),
 "target_id" TEXT NOT NULL,
 "payload" JSONB NOT NULL,
 "result" JSONB,
 "attempts" INTEGER NOT NULL DEFAULT 0,
 "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_until" TIMESTAMP(3),
 "delivered_at" TIMESTAMP(3),
 "last_error_code" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "prototype_workflow_commands_delivery_idx" ON "prototype_workflow_commands"("delivered_at", "available_at");
CREATE FUNCTION enforce_prototype_revision_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.version <> OLD.version OR NEW.plan_id <> OLD.plan_id OR NEW.project_id <> OLD.project_id OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id THEN
   RAISE EXCEPTION 'Prototype revision identity and content version are immutable';
 END IF;
 IF OLD.status IN ('ready', 'confirmed', 'rejected') AND (NEW.pages IS DISTINCT FROM OLD.pages OR NEW.source_document IS DISTINCT FROM OLD.source_document OR NEW.document_sha256 <> OLD.document_sha256 OR NEW.title <> OLD.title) THEN
   RAISE EXCEPTION 'Ready prototype revision content is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prototype_revision_immutable BEFORE UPDATE ON prototype_revisions FOR EACH ROW EXECUTE FUNCTION enforce_prototype_revision_immutable();
CREATE FUNCTION enforce_prototype_plan_inputs_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NEW.root_plan_id IS DISTINCT FROM OLD.root_plan_id OR NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR NEW.content_version <> OLD.content_version OR NEW.feedback_ids IS DISTINCT FROM OLD.feedback_ids OR NEW.generation_request IS DISTINCT FROM OLD.generation_request OR NEW.prompt <> OLD.prompt THEN
   RAISE EXCEPTION 'Prototype generation inputs are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prototype_plan_inputs_immutable BEFORE UPDATE ON prototype_plans FOR EACH ROW EXECUTE FUNCTION enforce_prototype_plan_inputs_immutable();
COMMIT;
