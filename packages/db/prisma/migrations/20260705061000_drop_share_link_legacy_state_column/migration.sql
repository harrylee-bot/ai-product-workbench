-- Remove a legacy product-design pointer that can remain in older deployed
-- databases. Share links now bind to conversation design state only.

ALTER TABLE "share_links" DROP COLUMN IF EXISTS "product_design_state_id" CASCADE;
