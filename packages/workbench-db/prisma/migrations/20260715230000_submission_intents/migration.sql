CREATE TYPE "SubmissionIntentStatus" AS ENUM ('pending', 'submitting', 'submitted', 'cancelled');
CREATE TYPE "SubmissionIntentAttachmentKind" AS ENUM ('existing', 'upload');

CREATE TABLE "submission_intents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "status" "SubmissionIntentStatus" NOT NULL DEFAULT 'pending',
    "request" JSONB NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "run_idempotency_key" TEXT NOT NULL,
    "run_id" TEXT,
    "last_failure_code" VARCHAR(120),
    "last_failure_detail" VARCHAR(2000),
    "last_failure_retryable" BOOLEAN,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "submission_intents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "submission_intents_request_object_check"
      CHECK (jsonb_typeof("request") = 'object'),
    CONSTRAINT "submission_intents_request_hash_check"
      CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "submission_intents_idempotency_key_check"
      CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
    CONSTRAINT "submission_intents_run_idempotency_key_check"
      CHECK (length("run_idempotency_key") BETWEEN 8 AND 128 AND "run_idempotency_key" ~ '^[A-Za-z0-9._:-]+$'),
    CONSTRAINT "submission_intents_revision_check"
      CHECK ("revision" >= 0),
    CONSTRAINT "submission_intents_failure_check"
      CHECK (
        ("last_failure_code" IS NULL AND "last_failure_detail" IS NULL AND "last_failure_retryable" IS NULL)
        OR
        ("last_failure_code" IS NOT NULL AND "last_failure_detail" IS NOT NULL AND "last_failure_retryable" IS NOT NULL)
      ),
    CONSTRAINT "submission_intents_submitted_lifecycle_check"
      CHECK (
        ("status" = 'submitted') = ("run_id" IS NOT NULL AND "submitted_at" IS NOT NULL)
      ),
    CONSTRAINT "submission_intents_cancelled_lifecycle_check"
      CHECK (
        ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
      ),
    CONSTRAINT "submission_intents_terminal_timestamp_check"
      CHECK (
        ("submitted_at" IS NULL OR "submitted_at" >= "created_at")
        AND ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at")
      )
);

CREATE TABLE "submission_intent_attachments" (
    "submission_intent_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "SubmissionIntentAttachmentKind" NOT NULL,
    "file_asset_id" TEXT,
    "client_fingerprint" VARCHAR(256),
    "file_name" VARCHAR(500),
    "declared_media_type" VARCHAR(255),
    "byte_size" BIGINT,
    "last_modified" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_intent_attachments_pkey" PRIMARY KEY ("submission_intent_id", "position"),
    CONSTRAINT "submission_intent_attachments_position_check"
      CHECK ("position" BETWEEN 0 AND 49),
    CONSTRAINT "submission_intent_attachments_kind_check"
      CHECK (
        (
          "kind" = 'existing'
          AND "file_asset_id" IS NOT NULL
          AND "client_fingerprint" IS NULL
          AND "file_name" IS NULL
          AND "declared_media_type" IS NULL
          AND "byte_size" IS NULL
          AND "last_modified" IS NULL
        )
        OR
        (
          "kind" = 'upload'
          AND "client_fingerprint" IS NOT NULL
          AND "file_name" IS NOT NULL
          AND "declared_media_type" IS NOT NULL
          AND "byte_size" IS NOT NULL
          AND "last_modified" IS NOT NULL
        )
      ),
    CONSTRAINT "submission_intent_attachments_fingerprint_check"
      CHECK (
        "client_fingerprint" IS NULL
        OR (
          length("client_fingerprint") BETWEEN 1 AND 256
          AND "client_fingerprint" ~ '[^[:space:]]'
          AND "client_fingerprint" !~ '[[:cntrl:]]'
        )
      ),
    CONSTRAINT "submission_intent_attachments_file_name_check"
      CHECK (
        "file_name" IS NULL
        OR (
          length("file_name") BETWEEN 1 AND 500
          AND "file_name" ~ '[^[:space:]]'
          AND "file_name" !~ '[/\\]'
          AND "file_name" !~ '[[:cntrl:]]'
          AND "file_name" NOT IN ('.', '..')
        )
      ),
    CONSTRAINT "submission_intent_attachments_media_type_check"
      CHECK (
        "declared_media_type" IS NULL
        OR "declared_media_type" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'
      ),
    CONSTRAINT "submission_intent_attachments_byte_size_check"
      CHECK ("byte_size" IS NULL OR "byte_size" BETWEEN 1 AND 26214400),
    CONSTRAINT "submission_intent_attachments_last_modified_check"
      CHECK ("last_modified" IS NULL OR "last_modified" BETWEEN 0 AND 9007199254740991)
);

CREATE UNIQUE INDEX "submission_intents_id_project_id_key"
  ON "submission_intents"("id", "project_id");
CREATE UNIQUE INDEX "submission_intents_thread_id_idempotency_key_key"
  ON "submission_intents"("thread_id", "idempotency_key");
CREATE UNIQUE INDEX "submission_intents_thread_id_run_idempotency_key_key"
  ON "submission_intents"("thread_id", "run_idempotency_key");
CREATE UNIQUE INDEX "submission_intents_run_id_key"
  ON "submission_intents"("run_id");
CREATE UNIQUE INDEX "submission_intents_run_id_thread_id_key"
  ON "submission_intents"("run_id", "thread_id");
CREATE UNIQUE INDEX "submission_intents_active_creator_key"
  ON "submission_intents"("thread_id", "created_by_id")
  WHERE "status" IN ('pending', 'submitting');
CREATE INDEX "submission_intents_project_id_created_by_id_status_updated_at_idx"
  ON "submission_intents"("project_id", "created_by_id", "status", "updated_at");
CREATE INDEX "submission_intents_created_by_id_created_at_idx"
  ON "submission_intents"("created_by_id", "created_at");

CREATE UNIQUE INDEX "submission_intent_attachments_submission_intent_id_file_asset_id_key"
  ON "submission_intent_attachments"("submission_intent_id", "file_asset_id");
CREATE UNIQUE INDEX "submission_intent_attachments_submission_intent_id_client_fingerprint_key"
  ON "submission_intent_attachments"("submission_intent_id", "client_fingerprint");
CREATE INDEX "submission_intent_attachments_file_asset_id_idx"
  ON "submission_intent_attachments"("file_asset_id");
CREATE INDEX "submission_intent_attachments_project_id_idx"
  ON "submission_intent_attachments"("project_id");

ALTER TABLE "submission_intents"
  ADD CONSTRAINT "submission_intents_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "submission_intents"
  ADD CONSTRAINT "submission_intents_thread_id_project_id_fkey"
  FOREIGN KEY ("thread_id", "project_id") REFERENCES "threads"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "submission_intents"
  ADD CONSTRAINT "submission_intents_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "submission_intents"
  ADD CONSTRAINT "submission_intents_run_id_thread_id_fkey"
  FOREIGN KEY ("run_id", "thread_id") REFERENCES "runs"("id", "thread_id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "submission_intent_attachments"
  ADD CONSTRAINT "submission_intent_attachments_submission_intent_id_project_id_fkey"
  FOREIGN KEY ("submission_intent_id", "project_id") REFERENCES "submission_intents"("id", "project_id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "submission_intent_attachments"
  ADD CONSTRAINT "submission_intent_attachments_file_asset_id_project_id_fkey"
  FOREIGN KEY ("file_asset_id", "project_id") REFERENCES "file_assets"("id", "project_id") ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "submission_intents_mutation_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."project_id",
    NEW."thread_id",
    NEW."created_by_id",
    NEW."request",
    NEW."request_hash",
    NEW."idempotency_key",
    NEW."run_idempotency_key",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."project_id",
    OLD."thread_id",
    OLD."created_by_id",
    OLD."request",
    OLD."request_hash",
    OLD."idempotency_key",
    OLD."run_idempotency_key",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'SubmissionIntent request identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'SubmissionIntent revision must increment by exactly one' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'pending' AND NEW."status" NOT IN ('pending', 'submitting', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid pending SubmissionIntent transition' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'submitting' AND NEW."status" NOT IN ('submitting', 'pending', 'submitted') THEN
    RAISE EXCEPTION 'Invalid submitting SubmissionIntent transition' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('submitted', 'cancelled') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Terminal SubmissionIntent status is immutable' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "submission_intents_mutation_guard"
BEFORE UPDATE ON "submission_intents"
FOR EACH ROW EXECUTE FUNCTION "submission_intents_mutation_guard"();

CREATE OR REPLACE FUNCTION "submission_intent_attachments_mutation_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW."submission_intent_id",
    NEW."project_id",
    NEW."position",
    NEW."kind",
    NEW."client_fingerprint",
    NEW."file_name",
    NEW."declared_media_type",
    NEW."byte_size",
    NEW."last_modified",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."submission_intent_id",
    OLD."project_id",
    OLD."position",
    OLD."kind",
    OLD."client_fingerprint",
    OLD."file_name",
    OLD."declared_media_type",
    OLD."byte_size",
    OLD."last_modified",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'SubmissionIntent attachment source is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW."file_asset_id" IS DISTINCT FROM OLD."file_asset_id"
     AND NOT (
       OLD."kind" = 'upload'
       AND OLD."file_asset_id" IS NULL
       AND NEW."file_asset_id" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'SubmissionIntent upload slot may be bound exactly once' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "submission_intent_attachments_mutation_guard"
BEFORE UPDATE ON "submission_intent_attachments"
FOR EACH ROW EXECUTE FUNCTION "submission_intent_attachments_mutation_guard"();
