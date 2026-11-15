BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TYPE "PrototypeMutationKind" ADD VALUE IF NOT EXISTS 'plan_retry';
COMMIT;
