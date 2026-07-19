BEGIN;

CREATE TYPE "ProjectInvitationStatus" AS ENUM (
  'pending',
  'accepted',
  'revoked',
  'expired'
);

CREATE TYPE "InvitationDeliveryStatus" AS ENUM ('not_configured');

CREATE TABLE "project_invitations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "role" "ProjectRole" NOT NULL,
  "status" "ProjectInvitationStatus" NOT NULL DEFAULT 'pending',
  "delivery_status" "InvitationDeliveryStatus" NOT NULL DEFAULT 'not_configured',
  "created_by_id" TEXT NOT NULL,
  "accepted_by_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "token_key_id" VARCHAR(32) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_invitations_email_normalized_check"
    CHECK (
      length("email") BETWEEN 3 AND 320
      AND "email" = lower(btrim("email"))
      AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  CONSTRAINT "project_invitations_idempotency_key_check"
    CHECK (
      length("idempotency_key") BETWEEN 8 AND 128
      AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
    ),
  CONSTRAINT "project_invitations_request_hash_format_check"
    CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_invitations_token_hash_format_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_invitations_token_key_id_format_check"
    CHECK ("token_key_id" ~ '^[0-9a-f]{16,32}$'),
  CONSTRAINT "project_invitations_revision_check"
    CHECK ("revision" >= 0),
  CONSTRAINT "project_invitations_expiry_check"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "project_invitations_lifecycle_check"
    CHECK (
      (
        "status" IN ('pending', 'expired')
        AND "accepted_by_id" IS NULL
        AND "accepted_at" IS NULL
        AND "revoked_at" IS NULL
      )
      OR (
        "status" = 'accepted'
        AND "accepted_by_id" IS NOT NULL
        AND "accepted_at" IS NOT NULL
        AND "revoked_at" IS NULL
      )
      OR (
        "status" = 'revoked'
        AND "accepted_by_id" IS NULL
        AND "accepted_at" IS NULL
        AND "revoked_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "project_invitations_token_hash_key"
ON "project_invitations"("token_hash");

CREATE UNIQUE INDEX "project_invitations_project_creator_idempotency_key"
ON "project_invitations"("project_id", "created_by_id", "idempotency_key");

-- A Project has at most one live invitation for a normalized email. Expired
-- rows are transitioned before a replacement is created under the Project lock.
CREATE UNIQUE INDEX "project_invitations_one_pending_email"
ON "project_invitations"("project_id", "email")
WHERE "status" = 'pending';

CREATE INDEX "project_invitations_project_status_created_id_idx"
ON "project_invitations"("project_id", "status", "created_at", "id");
CREATE INDEX "project_invitations_workspace_email_idx"
ON "project_invitations"("workspace_id", "email");
CREATE INDEX "project_invitations_created_by_created_at_idx"
ON "project_invitations"("created_by_id", "created_at");
CREATE INDEX "project_invitations_accepted_by_id_idx"
ON "project_invitations"("accepted_by_id");

ALTER TABLE "project_invitations"
ADD CONSTRAINT "project_invitations_project_id_workspace_id_fkey"
FOREIGN KEY ("project_id", "workspace_id")
REFERENCES "projects"("id", "workspace_id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "project_invitations_workspace_id_fkey"
FOREIGN KEY ("workspace_id")
REFERENCES "workspaces"("id")
ON DELETE CASCADE ON UPDATE RESTRICT,
ADD CONSTRAINT "project_invitations_created_by_id_fkey"
FOREIGN KEY ("created_by_id")
REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT,
ADD CONSTRAINT "project_invitations_accepted_by_id_fkey"
FOREIGN KEY ("accepted_by_id")
REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_project_invitation_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
    OR NEW."email" IS DISTINCT FROM OLD."email"
    OR NEW."role" IS DISTINCT FROM OLD."role"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
    OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
    OR NEW."token_key_id" IS DISTINCT FROM OLD."token_key_id"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'PROJECT_INVITATION_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'pending' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'PROJECT_INVITATION_TERMINAL_STATE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'pending'
    AND NEW."status" NOT IN ('pending', 'accepted', 'revoked', 'expired')
  THEN
    RAISE EXCEPTION 'PROJECT_INVITATION_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" < OLD."revision"
    OR NEW."revision" > OLD."revision" + 1
  THEN
    RAISE EXCEPTION 'PROJECT_INVITATION_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;
  IF (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."delivery_status" IS DISTINCT FROM OLD."delivery_status"
    OR NEW."accepted_by_id" IS DISTINCT FROM OLD."accepted_by_id"
    OR NEW."accepted_at" IS DISTINCT FROM OLD."accepted_at"
    OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
  ) AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'PROJECT_INVITATION_REVISION_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_invitations_mutation_guard"
BEFORE UPDATE ON "project_invitations"
FOR EACH ROW EXECUTE FUNCTION "guard_project_invitation_mutation"();

COMMIT;
