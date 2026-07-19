-- Product accounts use Better Auth's username plugin. Both fields stay nullable
-- so existing and future SSO-only identities remain valid.
ALTER TABLE "auth_users"
ADD COLUMN "username" TEXT,
ADD COLUMN "display_username" TEXT;

CREATE UNIQUE INDEX "auth_users_username_key"
ON "auth_users"("username");

ALTER TABLE "auth_users"
ADD CONSTRAINT "auth_users_username_format"
CHECK (
  "username" IS NULL
  OR (
    char_length("username") BETWEEN 3 AND 30
    AND "username" = lower("username")
    AND "username" ~ '^[a-z0-9_.-]+$'
  )
),
ADD CONSTRAINT "auth_users_display_username_length"
CHECK (
  "display_username" IS NULL
  OR char_length(btrim("display_username")) BETWEEN 1 AND 64
);
