CREATE TABLE "deerflow_thread_bindings" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "deerflow_thread_id" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "deerflow_thread_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deerflow_thread_bindings_conversation_id_key"
  ON "deerflow_thread_bindings"("conversation_id");

CREATE UNIQUE INDEX "deerflow_thread_bindings_deerflow_thread_id_key"
  ON "deerflow_thread_bindings"("deerflow_thread_id");

CREATE INDEX "deerflow_thread_bindings_project_id_idx"
  ON "deerflow_thread_bindings"("project_id");

CREATE INDEX "deerflow_thread_bindings_user_id_idx"
  ON "deerflow_thread_bindings"("user_id");

ALTER TABLE "deerflow_thread_bindings"
  ADD CONSTRAINT "deerflow_thread_bindings_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deerflow_thread_bindings"
  ADD CONSTRAINT "deerflow_thread_bindings_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deerflow_thread_bindings"
  ADD CONSTRAINT "deerflow_thread_bindings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
