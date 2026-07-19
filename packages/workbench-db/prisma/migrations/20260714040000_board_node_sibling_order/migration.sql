BEGIN;

ALTER TABLE "board_nodes"
ADD COLUMN "sort_order" INTEGER NOT NULL,
ADD CONSTRAINT "board_nodes_sort_order_check"
CHECK ("sort_order" >= 0);

CREATE INDEX "board_nodes_board_parent_order_idx"
ON "board_nodes"("board_id", "parent_node_key", "sort_order");

CREATE UNIQUE INDEX "board_nodes_root_sort_order_key"
ON "board_nodes"("board_id", "sort_order")
WHERE "parent_node_key" IS NULL;

CREATE UNIQUE INDEX "board_nodes_child_sort_order_key"
ON "board_nodes"("board_id", "parent_node_key", "sort_order")
WHERE "parent_node_key" IS NOT NULL;

COMMIT;
