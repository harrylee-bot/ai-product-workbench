DO $$
DECLARE
  trigger_function RECORD;
BEGIN
  FOR trigger_function IN
    SELECT DISTINCT
      namespace."nspname" AS schema_name,
      procedure."proname" AS function_name,
      pg_get_function_identity_arguments(procedure."oid") AS identity_arguments
    FROM pg_trigger AS trigger
    JOIN pg_proc AS procedure
      ON procedure."oid" = trigger."tgfoid"
    JOIN pg_namespace AS namespace
      ON namespace."oid" = procedure."pronamespace"
    WHERE trigger."tgisinternal" = FALSE
      AND namespace."nspname" = 'public'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency."classid" = 'pg_proc'::regclass
          AND dependency."objid" = procedure."oid"
          AND dependency."deptype" = 'e'
      )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path TO pg_catalog, public',
      trigger_function.schema_name,
      trigger_function.function_name,
      trigger_function.identity_arguments
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger
    JOIN pg_proc AS procedure
      ON procedure."oid" = trigger."tgfoid"
    JOIN pg_namespace AS namespace
      ON namespace."oid" = procedure."pronamespace"
    WHERE trigger."tgisinternal" = FALSE
      AND namespace."nspname" = 'public'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency."classid" = 'pg_proc'::regclass
          AND dependency."objid" = procedure."oid"
          AND dependency."deptype" = 'e'
      )
      AND NOT COALESCE(
        'search_path=pg_catalog, public' = ANY(procedure."proconfig"),
        FALSE
      )
  ) THEN
    RAISE EXCEPTION 'TRIGGER_FUNCTION_SEARCH_PATH_NOT_HARDENED';
  END IF;
END;
$$;
