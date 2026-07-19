-- Board aggregate commands explicitly increment the Board revision once. Child
-- triggers suppress their fallback bump only when a transaction-local owner
-- names the same Board and its already-persisted result revision.
CREATE FUNCTION "board_revision_owned_by_logical_command"("candidate_board_id" TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  owner_board_id TEXT;
  owner_revision_text TEXT;
  owner_revision BIGINT;
BEGIN
  owner_board_id := NULLIF(
    current_setting('workbench.board_revision_owner', TRUE),
    ''
  );
  owner_revision_text := NULLIF(
    current_setting('workbench.board_revision_owner_revision', TRUE),
    ''
  );

  IF owner_board_id IS DISTINCT FROM candidate_board_id
    OR owner_revision_text IS NULL
    OR owner_revision_text !~ '^(0|[1-9][0-9]{0,9})$'
  THEN
    RETURN FALSE;
  END IF;

  owner_revision := owner_revision_text::BIGINT;
  IF owner_revision > 2147483647 THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM "boards"
    WHERE "id" = candidate_board_id
      AND "revision" = owner_revision::INTEGER
  );
END;
$$;

CREATE OR REPLACE FUNCTION "bump_board_revision_from_new_children"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "boards"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT DISTINCT "board_id"
    FROM board_child_new_rows
    WHERE NOT "board_revision_owned_by_logical_command"("board_id")
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "bump_board_revision_from_old_children"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "boards"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT DISTINCT "board_id"
    FROM board_child_old_rows
    WHERE NOT "board_revision_owned_by_logical_command"("board_id")
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "bump_board_revision_from_changed_children"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "boards"
  SET "revision" = "revision" + 1,
      "updated_at" = clock_timestamp()
  WHERE "id" IN (
    SELECT changed_children."board_id"
    FROM (
      SELECT "board_id" FROM board_child_old_rows
      UNION
      SELECT "board_id" FROM board_child_new_rows
    ) AS changed_children
    WHERE NOT "board_revision_owned_by_logical_command"(changed_children."board_id")
  );
  RETURN NULL;
END;
$$;
