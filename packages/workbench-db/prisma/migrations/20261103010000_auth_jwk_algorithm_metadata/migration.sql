BEGIN;
SET LOCAL lock_timeout = '5s';

-- Better Auth 1.7 stores the algorithm and optional curve with each new key.
-- NULL retains the library's legacy-key behavior for existing RSA keys.
ALTER TABLE "auth_jwks"
  ADD COLUMN "alg" TEXT,
  ADD COLUMN "crv" TEXT;

COMMIT;
