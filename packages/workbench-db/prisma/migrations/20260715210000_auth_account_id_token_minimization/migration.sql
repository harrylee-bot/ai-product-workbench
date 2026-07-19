-- The generic OIDC callback does not need an ID token after identity mapping.
-- Better Auth 1.6.23 encrypts access/refresh tokens but writes this field as-is.
UPDATE "auth_accounts"
SET "id_token" = NULL
WHERE "id_token" IS NOT NULL;

ALTER TABLE "auth_accounts"
ADD CONSTRAINT "auth_accounts_id_token_not_stored"
CHECK ("id_token" IS NULL);
