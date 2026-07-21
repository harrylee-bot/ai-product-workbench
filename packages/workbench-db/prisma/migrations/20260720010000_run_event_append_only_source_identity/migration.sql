BEGIN;

-- The runtime and the database must reject the same source-id language. Do not
-- rewrite historical event identity during a migration: an invalid legacy row
-- requires an explicit operator backfill before this release can proceed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "run_events"
    WHERE "source_id" IS NOT NULL
      AND NOT (
        length("source_id") BETWEEN 1 AND 128
        AND "source_id" ~ '^[A-Za-z0-9._:-]+$'
      )
  ) THEN
    RAISE EXCEPTION 'RUN_EVENT_SOURCE_ID_BACKFILL_REQUIRED' USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "run_events"
ALTER COLUMN "source_id" TYPE VARCHAR(128)
USING "source_id"::VARCHAR(128);

ALTER TABLE "run_events"
ADD CONSTRAINT "run_events_source_id_format_check"
CHECK (
  "source_id" IS NULL
  OR (
    length("source_id") BETWEEN 1 AND 128
    AND "source_id" ~ '^[A-Za-z0-9._:-]+$'
  )
);

-- RunEvent is an append-only audit stream. The row guard permits only the
-- internal ON DELETE CASCADE fired by deleting the owning Run; a direct row
-- mutation remains rejected even for application code that bypasses Prisma.
CREATE FUNCTION "guard_run_event_append_only"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RUN_EVENT_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "run_events_append_only_guard"
BEFORE UPDATE OR DELETE ON "run_events"
FOR EACH ROW EXECUTE FUNCTION "guard_run_event_append_only"();

CREATE FUNCTION "guard_run_event_truncate"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'RUN_EVENT_APPEND_ONLY' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "run_events_truncate_guard"
BEFORE TRUNCATE ON "run_events"
FOR EACH STATEMENT EXECUTE FUNCTION "guard_run_event_truncate"();

COMMIT;
