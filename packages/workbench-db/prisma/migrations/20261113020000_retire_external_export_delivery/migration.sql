-- The unimplemented external publishing feature is retired. Existing delivery
-- records must be handled explicitly before removing its storage contract.
DO $retire_external_export_delivery$
BEGIN
  LOCK TABLE "external_export_deliveries" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "external_export_deliveries") THEN
    RAISE EXCEPTION 'EXTERNAL_EXPORT_DELIVERIES_REQUIRE_CLEANUP' USING ERRCODE = '23514';
  END IF;

  DROP TABLE "external_export_deliveries";
  DROP TYPE "ExternalExportDeliveryStatus";
  DROP TYPE "ExternalExportAuthentication";
  DROP TYPE "ExternalExportTarget";
END;
$retire_external_export_delivery$;
