-- Communication preferences are explicit opt-ins owned by exactly one Principal.
-- No row is equivalent to both preferences being false at virtual revision 0.
CREATE TABLE "principal_communication_preferences" (
    "principal_id" TEXT NOT NULL,
    "product_updates_email" BOOLEAN NOT NULL DEFAULT FALSE,
    "research_invitations" BOOLEAN NOT NULL DEFAULT FALSE,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "principal_communication_preferences_pkey" PRIMARY KEY ("principal_id"),
    CONSTRAINT "principal_communication_preferences_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "principal_communication_preferences_principal_id_fkey"
        FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
