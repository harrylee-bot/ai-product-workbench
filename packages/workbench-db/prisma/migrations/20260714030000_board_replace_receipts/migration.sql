-- A Board replace is a full-snapshot CAS command. Persist its exact response in
-- the same transaction so a retry can recover after the commit response is lost.
CREATE TABLE "board_replace_receipts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "board_id" TEXT NOT NULL,
    "expected_revision" INTEGER NOT NULL,
    "result_revision" INTEGER NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_replace_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "board_replace_receipts_revision_check"
      CHECK (
        "expected_revision" >= 0
        AND "result_revision" = "expected_revision" + 1
      ),
    CONSTRAINT "board_replace_receipts_idempotency_key_check"
      CHECK (
        length("idempotency_key") BETWEEN 8 AND 128
        AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'
      ),
    CONSTRAINT "board_replace_receipts_request_hash_format_check"
      CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "board_replace_receipts_response_shape_check"
      CHECK (
        jsonb_typeof("response") = 'object'
        AND "response" ->> 'id' = "board_id"
        AND "response" ->> 'projectId' = "project_id"
        AND "response" -> 'revision' = to_jsonb("result_revision")
      )
);

CREATE UNIQUE INDEX "board_replace_receipts_project_id_idempotency_key_key"
ON "board_replace_receipts"("project_id", "idempotency_key");

CREATE UNIQUE INDEX "board_replace_receipts_board_id_result_revision_key"
ON "board_replace_receipts"("board_id", "result_revision");

CREATE INDEX "board_replace_receipts_created_by_id_idx"
ON "board_replace_receipts"("created_by_id");

ALTER TABLE "board_replace_receipts"
ADD CONSTRAINT "board_replace_receipts_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "board_replace_receipts"
ADD CONSTRAINT "board_replace_receipts_board_id_project_id_fkey"
FOREIGN KEY ("board_id", "project_id") REFERENCES "boards"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "board_replace_receipts"
ADD CONSTRAINT "board_replace_receipts_created_by_id_fkey"
FOREIGN KEY ("created_by_id") REFERENCES "principals"("id")
ON DELETE RESTRICT ON UPDATE RESTRICT;
