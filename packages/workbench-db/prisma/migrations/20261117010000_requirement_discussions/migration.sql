-- CreateTable
CREATE TABLE "requirement_sessions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'discussing',
    "generation_request" JSONB NOT NULL,
    "summary_version" INTEGER NOT NULL DEFAULT 0,
    "current_turn_id" TEXT,
    "confirmation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requirement_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_turns" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "input_revision" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "model_id" TEXT NOT NULL DEFAULT 'deepseek-flash',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "requirement_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_summaries" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "input_revision" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "card" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "knowledge_release_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_confirmations" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "summary_version" INTEGER NOT NULL,
    "input_revision" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "baseline" JSONB NOT NULL,
    "generation_request" JSONB NOT NULL,
    "input_snapshot" JSONB NOT NULL,
    "plan_id" TEXT,
    "run_id" TEXT,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_action_receipts" (
    "id" TEXT NOT NULL,
    "principal_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_action_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requirement_sessions_principal_id_project_id_updated_at_idx" ON "requirement_sessions"("principal_id", "project_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_sessions_thread_id_principal_id_idempotency_key_key" ON "requirement_sessions"("thread_id", "principal_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "requirement_turns_status_created_at_idx" ON "requirement_turns"("status", "created_at");

-- CreateIndex
CREATE INDEX "requirement_turns_principal_id_project_id_created_at_idx" ON "requirement_turns"("principal_id", "project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_turns_session_id_idempotency_key_key" ON "requirement_turns"("session_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_summaries_session_id_version_key" ON "requirement_summaries"("session_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_confirmations_session_id_idempotency_key_key" ON "requirement_confirmations"("session_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_confirmations_session_id_summary_version_key" ON "requirement_confirmations"("session_id", "summary_version");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_action_receipts_session_id_idempotency_key_key" ON "requirement_action_receipts"("session_id", "idempotency_key");


-- Keep existing Thread/Entry identities; private requirement entries are visible
-- only to their author and to the authorized generation pipeline.
ALTER TABLE thread_entries ADD COLUMN requirement_session_id TEXT;
ALTER TABLE thread_entries ADD COLUMN audience_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE requirement_sessions ADD FOREIGN KEY(thread_id,project_id) REFERENCES threads(id,project_id) ON DELETE CASCADE;
ALTER TABLE requirement_sessions ADD FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE requirement_summaries ADD FOREIGN KEY(session_id) REFERENCES requirement_sessions(id) ON DELETE CASCADE;
ALTER TABLE requirement_summaries ADD FOREIGN KEY(knowledge_release_id) REFERENCES knowledge_releases(id) ON DELETE RESTRICT;
ALTER TABLE requirement_confirmations ADD FOREIGN KEY(plan_id) REFERENCES prototype_plans(id) ON DELETE RESTRICT;
ALTER TABLE requirement_confirmations ADD FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT;
ALTER TABLE requirement_action_receipts ADD FOREIGN KEY(session_id) REFERENCES requirement_sessions(id) ON DELETE CASCADE;
ALTER TABLE thread_entries ADD FOREIGN KEY(requirement_session_id) REFERENCES requirement_sessions(id) ON DELETE RESTRICT;
ALTER TABLE requirement_sessions ADD CHECK (state IN ('discussing','analyzing','needs_clarification','ready_to_confirm','confirmed','generating'));
ALTER TABLE requirement_turns ADD CHECK (status IN ('queued','running','succeeded','failed','cancelled','superseded'));
ALTER TABLE requirement_turns ADD CHECK (model_id='deepseek-flash' AND attempt BETWEEN 0 AND 3);
ALTER TABLE requirement_confirmations ADD CHECK (status IN ('pending','started','invalidated'));
CREATE UNIQUE INDEX requirement_one_active_turn ON requirement_turns(session_id) WHERE status IN ('queued','running');
CREATE FUNCTION requirement_immutable_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'requirement summary is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER requirement_summary_immutable BEFORE UPDATE ON requirement_summaries FOR EACH ROW EXECUTE FUNCTION requirement_immutable_summary();
CREATE FUNCTION requirement_confirmation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'status'-'plan_id'-'run_id'-'last_failure_code'-'dispatch_attempts'-'next_attempt_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'plan_id'-'run_id'-'last_failure_code'-'dispatch_attempts'-'next_attempt_at')
 OR OLD.status IN ('started','invalidated') AND NEW IS DISTINCT FROM OLD THEN
 RAISE EXCEPTION 'confirmed requirement baseline is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER requirement_confirmation_immutable BEFORE UPDATE ON requirement_confirmations FOR EACH ROW EXECUTE FUNCTION requirement_confirmation_immutable();

ALTER TABLE requirement_sessions ADD COLUMN context JSONB NOT NULL DEFAULT '{"kind":"new"}'::jsonb;
ALTER TABLE requirement_sessions ADD UNIQUE(id,project_id,principal_id);
ALTER TABLE requirement_turns ADD FOREIGN KEY(session_id,project_id,principal_id) REFERENCES requirement_sessions(id,project_id,principal_id) ON DELETE CASCADE;
ALTER TABLE requirement_confirmations ADD FOREIGN KEY(session_id,project_id,principal_id) REFERENCES requirement_sessions(id,project_id,principal_id) ON DELETE CASCADE;
ALTER TABLE requirement_confirmations ADD FOREIGN KEY(session_id,summary_version) REFERENCES requirement_summaries(session_id,version) ON DELETE RESTRICT;
ALTER TABLE requirement_sessions ADD CHECK (revision>=0 AND summary_version>=0);
ALTER TABLE requirement_summaries ADD CHECK (version>0 AND input_revision>=0 AND checksum ~ '^[a-f0-9]{64}$');
ALTER TABLE requirement_confirmations ADD CHECK ((status='started')=(run_id IS NOT NULL));

ALTER TABLE requirement_confirmations ADD COLUMN last_failure_code TEXT;
ALTER TABLE requirement_confirmations ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requirement_confirmations ADD COLUMN next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE requirement_summaries ADD COLUMN context_snapshot JSONB NOT NULL;
