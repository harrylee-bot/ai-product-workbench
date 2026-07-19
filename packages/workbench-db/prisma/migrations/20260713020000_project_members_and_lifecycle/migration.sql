-- Project access is explicit. Workspace membership only makes a principal
-- eligible to be added to a Project; it no longer grants access to every
-- Project in that Workspace.
BEGIN;

-- pg_trgm is an infrastructure prerequisite. The application migrator only
-- creates indexes that consume its public operator class.

CREATE INDEX "projects_active_title_trgm_idx"
ON "projects" USING GIN ("title" public.gin_trgm_ops)
WHERE "status" = 'active';
CREATE INDEX "projects_active_summary_trgm_idx"
ON "projects" USING GIN ("summary" public.gin_trgm_ops)
WHERE "status" = 'active' AND "summary" IS NOT NULL;

CREATE TYPE "ProjectRole" AS ENUM ('owner', 'editor', 'viewer');

CREATE TABLE "project_members" (
  "project_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "role" "ProjectRole" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "principal_id")
);

CREATE INDEX "project_members_principal_id_role_project_id_idx"
ON "project_members"("principal_id", "role", "project_id");
CREATE INDEX "project_members_workspace_id_principal_id_idx"
ON "project_members"("workspace_id", "principal_id");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "projects" AS project
    LEFT JOIN "workspace_members" AS member
      ON member."workspace_id" = project."workspace_id"
     AND member."principal_id" = project."created_by_id"
    WHERE member."principal_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'PROJECT_CREATOR_NOT_WORKSPACE_MEMBER' USING ERRCODE = '23514';
  END IF;
END;
$$;

INSERT INTO "project_members" (
  "project_id", "workspace_id", "principal_id", "role", "updated_at"
)
SELECT "id", "workspace_id", "created_by_id", 'owner'::"ProjectRole", clock_timestamp()
FROM "projects";

ALTER TABLE "project_members"
ADD CONSTRAINT "project_members_project_id_workspace_id_fkey"
FOREIGN KEY ("project_id", "workspace_id")
REFERENCES "projects"("id", "workspace_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "project_members_workspace_id_principal_id_fkey"
FOREIGN KEY ("workspace_id", "principal_id")
REFERENCES "workspace_members"("workspace_id", "principal_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

-- Project membership identity is append/remove only. Moving a row could make
-- the deferred owner check inspect only the destination Project and leave the
-- source Project without an owner.
CREATE FUNCTION "guard_project_member_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."principal_id" IS DISTINCT FROM OLD."principal_id"
  THEN
    RAISE EXCEPTION 'PROJECT_MEMBER_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_members_identity_guard"
BEFORE UPDATE ON "project_members"
FOR EACH ROW EXECUTE FUNCTION "guard_project_member_identity"();

-- A live Project must always have at least one owner. Both Project creation
-- and ownership transfers are checked at transaction commit so they remain
-- atomic without requiring a temporary invalid state.
CREATE FUNCTION "enforce_project_owner"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  checked_project_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'projects' THEN
    checked_project_id := COALESCE(NEW."id", OLD."id");
  ELSE
    checked_project_id := COALESCE(NEW."project_id", OLD."project_id");
  END IF;

  PERFORM 1
  FROM "projects"
  WHERE "id" = checked_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM "project_members"
       WHERE "project_id" = checked_project_id AND "role" = 'owner'
     ) THEN
    RAISE EXCEPTION 'PROJECT_OWNER_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "projects_owner_required"
AFTER INSERT ON "projects"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_project_owner"();

CREATE CONSTRAINT TRIGGER "project_members_owner_required"
AFTER INSERT OR UPDATE OR DELETE ON "project_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_project_owner"();

-- Private duplication has its own immutable receipt. It never reuses a
-- public Share token or Remix lineage and is always constrained to one
-- Workspace.
CREATE TABLE "project_duplicates" (
  "target_project_id" TEXT NOT NULL,
  "source_project_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_duplicates_pkey" PRIMARY KEY ("target_project_id"),
  CONSTRAINT "project_duplicates_distinct_projects_check"
    CHECK ("source_project_id" <> "target_project_id"),
  CONSTRAINT "project_duplicates_idempotency_key_check"
    CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
  CONSTRAINT "project_duplicates_request_hash_format_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "project_duplicates_source_creator_idempotency_key"
ON "project_duplicates"("source_project_id", "created_by_id", "idempotency_key");
CREATE UNIQUE INDEX "project_duplicates_target_project_id_workspace_id_key"
ON "project_duplicates"("target_project_id", "workspace_id");
CREATE INDEX "project_duplicates_source_project_id_created_at_idx"
ON "project_duplicates"("source_project_id", "created_at");
CREATE INDEX "project_duplicates_created_by_id_idx"
ON "project_duplicates"("created_by_id");
CREATE INDEX "project_duplicates_workspace_id_created_at_idx"
ON "project_duplicates"("workspace_id", "created_at");

ALTER TABLE "project_duplicates"
ADD CONSTRAINT "project_duplicates_source_project_id_workspace_id_fkey"
FOREIGN KEY ("source_project_id", "workspace_id")
REFERENCES "projects"("id", "workspace_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_duplicates_target_project_id_workspace_id_fkey"
FOREIGN KEY ("target_project_id", "workspace_id")
REFERENCES "projects"("id", "workspace_id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_duplicates_created_by_id_fkey"
FOREIGN KEY ("created_by_id")
REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_project_duplicate_actor_membership"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_members"
    WHERE "workspace_id" = NEW."workspace_id"
      AND "principal_id" = NEW."created_by_id"
  ) THEN
    RAISE EXCEPTION 'PROJECT_DUPLICATE_ACTOR_NOT_WORKSPACE_MEMBER' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_duplicates_actor_membership_guard"
BEFORE INSERT ON "project_duplicates"
FOR EACH ROW EXECUTE FUNCTION "guard_project_duplicate_actor_membership"();

CREATE FUNCTION "guard_project_duplicate_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PROJECT_DUPLICATE_RECEIPT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "project_duplicates_immutable_guard"
BEFORE UPDATE OR DELETE ON "project_duplicates"
FOR EACH ROW EXECUTE FUNCTION "guard_project_duplicate_mutation"();

COMMIT;
