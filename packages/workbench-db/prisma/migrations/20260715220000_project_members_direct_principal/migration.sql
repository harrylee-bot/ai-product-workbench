-- Project invitations grant access only to the target Project. A Project
-- membership no longer implies or requires Workspace membership.
BEGIN;

ALTER TABLE "project_members"
DROP CONSTRAINT "project_members_workspace_id_principal_id_fkey",
ADD CONSTRAINT "project_members_principal_id_fkey"
FOREIGN KEY ("principal_id")
REFERENCES "principals"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

COMMIT;
