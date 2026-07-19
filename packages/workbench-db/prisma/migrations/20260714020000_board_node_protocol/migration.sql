BEGIN;

ALTER TABLE "board_nodes"
ADD COLUMN "parent_node_key" TEXT;

CREATE INDEX "board_nodes_board_id_parent_node_key_idx"
ON "board_nodes"("board_id", "parent_node_key");

ALTER TABLE "board_nodes"
ADD CONSTRAINT "board_nodes_parent_node_fkey"
FOREIGN KEY ("board_id", "parent_node_key")
REFERENCES "board_nodes"("board_id", "node_key")
ON DELETE NO ACTION ON UPDATE RESTRICT
DEFERRABLE INITIALLY DEFERRED,
ADD CONSTRAINT "board_nodes_parent_not_self_check"
CHECK ("parent_node_key" IS NULL OR "parent_node_key" <> "node_key"),
ADD CONSTRAINT "board_nodes_kind_check"
CHECK ("kind" IN ('artifact', 'frame', 'drawing')),
ADD CONSTRAINT "board_nodes_data_protocol_check"
CHECK (
  jsonb_typeof("data") = 'object'
  AND ("data"->>'protocol') IS NOT DISTINCT FROM 'workbench.board-node.v1'
  AND ("data"->>'nodeType') IS NOT DISTINCT FROM "kind"
),
ADD CONSTRAINT "board_nodes_artifact_kind_check"
CHECK (
  (
    "kind" = 'artifact'
    AND ("artifact_id" IS NOT NULL OR "artifact_version_id" IS NOT NULL)
  )
  OR (
    "kind" <> 'artifact'
    AND "artifact_id" IS NULL
    AND "artifact_version_id" IS NULL
  )
),
ADD CONSTRAINT "board_nodes_sized_content_check"
CHECK ("kind" = 'artifact' OR "size" IS NOT NULL);

CREATE FUNCTION "guard_board_node_parent_hierarchy"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_kind TEXT;
  contains_cycle BOOLEAN;
BEGIN
  IF NEW."kind" IS DISTINCT FROM 'frame' AND EXISTS (
    SELECT 1
    FROM "board_nodes" AS child
    WHERE child."board_id" = NEW."board_id"
      AND child."parent_node_key" = NEW."node_key"
  ) THEN
    RAISE EXCEPTION 'BOARD_NODE_PARENT_NOT_FRAME' USING ERRCODE = '23514';
  END IF;

  IF NEW."parent_node_key" IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT parent."kind"
  INTO parent_kind
  FROM "board_nodes" AS parent
  WHERE parent."board_id" = NEW."board_id"
    AND parent."node_key" = NEW."parent_node_key";

  IF parent_kind IS DISTINCT FROM 'frame' THEN
    RAISE EXCEPTION 'BOARD_NODE_PARENT_NOT_FRAME' USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE ancestors("node_key", "parent_node_key") AS (
    SELECT node."node_key", node."parent_node_key"
    FROM "board_nodes" AS node
    WHERE node."board_id" = NEW."board_id"
      AND node."node_key" = NEW."parent_node_key"
    UNION
    SELECT parent."node_key", parent."parent_node_key"
    FROM "board_nodes" AS parent
    JOIN ancestors ON ancestors."parent_node_key" = parent."node_key"
    WHERE parent."board_id" = NEW."board_id"
  )
  SELECT EXISTS (
    SELECT 1 FROM ancestors WHERE "node_key" = NEW."node_key"
  )
  INTO contains_cycle;

  IF contains_cycle THEN
    RAISE EXCEPTION 'BOARD_NODE_PARENT_CYCLE' USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "board_nodes_parent_hierarchy_guard"
AFTER INSERT OR UPDATE OF "board_id", "node_key", "parent_node_key", "kind"
ON "board_nodes"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_board_node_parent_hierarchy"();

COMMIT;
