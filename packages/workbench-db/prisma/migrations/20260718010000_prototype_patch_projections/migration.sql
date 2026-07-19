CREATE TYPE "PrototypePatchProjectionStatus" AS ENUM (
  'active',
  'paused',
  'degraded',
  'finalized',
  'discarded'
);

CREATE TYPE "PrototypePatchApplicationOutcome" AS ENUM (
  'applied',
  'degraded'
);

CREATE UNIQUE INDEX "runtime_attempts_id_run_id_key"
ON "runtime_attempts"("id", "run_id");

CREATE UNIQUE INDEX "run_events_id_run_id_key"
ON "run_events"("id", "run_id");

CREATE TABLE "prototype_patch_projections" (
  "artifact_version_id" TEXT NOT NULL,
  "screen_id" VARCHAR(128) NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "checksum" CHAR(64) NOT NULL,
  "status" "PrototypePatchProjectionStatus" NOT NULL DEFAULT 'active',
  "degraded_reason" VARCHAR(120),
  "finalized_at" TIMESTAMPTZ(6),
  "discarded_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "prototype_patch_projections_pkey"
    PRIMARY KEY ("artifact_version_id", "screen_id"),
  CONSTRAINT "prototype_patch_projections_revision_check"
    CHECK ("revision" >= 0),
  CONSTRAINT "prototype_patch_projections_checksum_check"
    CHECK ("checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prototype_patch_projections_state_check"
    CHECK (
      ("status" = 'degraded' AND "degraded_reason" IS NOT NULL
        AND "finalized_at" IS NULL AND "discarded_at" IS NULL)
      OR ("status" = 'finalized' AND "degraded_reason" IS NULL
        AND "finalized_at" IS NOT NULL AND "discarded_at" IS NULL)
      OR ("status" = 'discarded' AND "finalized_at" IS NULL
        AND "discarded_at" IS NOT NULL)
      OR ("status" IN ('active', 'paused') AND "degraded_reason" IS NULL
        AND "finalized_at" IS NULL AND "discarded_at" IS NULL)
    )
);

CREATE UNIQUE INDEX "prototype_patch_projections_scope_key"
ON "prototype_patch_projections"(
  "artifact_version_id",
  "screen_id",
  "run_id",
  "artifact_id",
  "project_id"
);

CREATE UNIQUE INDEX "prototype_patch_projections_run_version_screen_key"
ON "prototype_patch_projections"("run_id", "artifact_version_id", "screen_id");

CREATE INDEX "prototype_patch_projections_run_id_status_idx"
ON "prototype_patch_projections"("run_id", "status");

CREATE INDEX "prototype_patch_projections_project_id_status_idx"
ON "prototype_patch_projections"("project_id", "status");

ALTER TABLE "prototype_patch_projections"
ADD CONSTRAINT "prototype_patch_projections_version_fkey"
FOREIGN KEY ("artifact_version_id", "artifact_id", "project_id")
REFERENCES "artifact_versions"("id", "artifact_id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "prototype_patch_projections"
ADD CONSTRAINT "prototype_patch_projections_run_fkey"
FOREIGN KEY ("run_id", "project_id")
REFERENCES "runs"("id", "project_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE TABLE "prototype_patch_applications" (
  "id" TEXT NOT NULL,
  "runtime_attempt_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "artifact_version_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "screen_id" VARCHAR(128) NOT NULL,
  "source_event_id" VARCHAR(1024) NOT NULL,
  "outcome" "PrototypePatchApplicationOutcome" NOT NULL,
  "degraded_reason" VARCHAR(120),
  "base_revision" INTEGER NOT NULL,
  "next_revision" INTEGER NOT NULL,
  "request_sha256" CHAR(64) NOT NULL,
  "operations" JSONB NOT NULL,
  "resulting_checksum" CHAR(64) NOT NULL,
  "run_event_id" TEXT NOT NULL,
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prototype_patch_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prototype_patch_applications_source_event_id_check"
    CHECK (length(btrim("source_event_id")) BETWEEN 1 AND 1024),
  CONSTRAINT "prototype_patch_applications_revision_check"
    CHECK ("base_revision" >= 0 AND "next_revision" = "base_revision" + 1),
  CONSTRAINT "prototype_patch_applications_request_sha256_check"
    CHECK ("request_sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prototype_patch_applications_resulting_checksum_check"
    CHECK ("resulting_checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "prototype_patch_applications_operations_check"
    CHECK (
      jsonb_typeof("operations") = 'array'
      AND jsonb_array_length("operations") BETWEEN 1 AND 128
      AND pg_column_size("operations") <= 262144
    ),
  CONSTRAINT "prototype_patch_applications_outcome_check"
    CHECK (
      ("outcome" = 'applied' AND "degraded_reason" IS NULL)
      OR ("outcome" = 'degraded' AND "degraded_reason" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "prototype_patch_applications_runtime_attempt_source_key"
ON "prototype_patch_applications"("runtime_attempt_id", "source_event_id");

CREATE UNIQUE INDEX "prototype_patch_applications_run_event_id_key"
ON "prototype_patch_applications"("run_event_id");

CREATE UNIQUE INDEX "prototype_patch_applications_run_event_scope_key"
ON "prototype_patch_applications"("run_event_id", "run_id");

CREATE UNIQUE INDEX "prototype_patch_applications_applied_revision_key"
ON "prototype_patch_applications"(
  "artifact_version_id",
  "screen_id",
  "next_revision"
)
WHERE "outcome" = 'applied';

CREATE INDEX "prototype_patch_applications_run_id_applied_at_idx"
ON "prototype_patch_applications"("run_id", "applied_at");

CREATE INDEX "prototype_patch_applications_next_revision_idx"
ON "prototype_patch_applications"(
  "artifact_version_id",
  "screen_id",
  "next_revision"
);

CREATE INDEX "prototype_patch_applications_base_revision_idx"
ON "prototype_patch_applications"(
  "artifact_version_id",
  "screen_id",
  "base_revision"
);

ALTER TABLE "prototype_patch_applications"
ADD CONSTRAINT "prototype_patch_applications_projection_fkey"
FOREIGN KEY (
  "artifact_version_id",
  "screen_id",
  "run_id",
  "artifact_id",
  "project_id"
)
REFERENCES "prototype_patch_projections"(
  "artifact_version_id",
  "screen_id",
  "run_id",
  "artifact_id",
  "project_id"
)
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "prototype_patch_applications"
ADD CONSTRAINT "prototype_patch_applications_runtime_attempt_fkey"
FOREIGN KEY ("runtime_attempt_id", "run_id")
REFERENCES "runtime_attempts"("id", "run_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "prototype_patch_applications"
ADD CONSTRAINT "prototype_patch_applications_run_event_fkey"
FOREIGN KEY ("run_event_id", "run_id")
REFERENCES "run_events"("id", "run_id")
ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "guard_prototype_patch_projection"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  version_status "ArtifactVersionStatus";
  version_run_id TEXT;
  version_content JSONB;
  artifact_kind "ArtifactKind";
  owner_run_status "RunStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_DELETE_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT
    version."status",
    version."created_by_run_id",
    version."content",
    artifact."kind",
    owner_run."status"
  INTO
    version_status,
    version_run_id,
    version_content,
    artifact_kind,
    owner_run_status
  FROM "artifact_versions" AS version
  JOIN "artifacts" AS artifact
    ON artifact."id" = version."artifact_id"
   AND artifact."project_id" = version."project_id"
  JOIN "runs" AS owner_run
    ON owner_run."id" = NEW."run_id"
   AND owner_run."project_id" = NEW."project_id"
  WHERE version."id" = NEW."artifact_version_id"
    AND version."artifact_id" = NEW."artifact_id"
    AND version."project_id" = NEW."project_id"
  FOR SHARE OF version, owner_run;

  IF version_status IS DISTINCT FROM 'staging'::"ArtifactVersionStatus"
    OR version_run_id IS DISTINCT FROM NEW."run_id"
    OR artifact_kind IS DISTINCT FROM 'prototype'::"ArtifactKind"
    OR version_content IS NULL
    OR jsonb_typeof(version_content) <> 'object'
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(version_content->'screens') AS screen
      WHERE screen->>'id' = NEW."screen_id"
    )
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_OWNER_INVALID' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active'::"PrototypePatchProjectionStatus"
      OR owner_run_status <> 'running'::"RunStatus"
    THEN
      RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_INITIAL_STATE_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."artifact_version_id" IS DISTINCT FROM OLD."artifact_version_id"
    OR NEW."screen_id" IS DISTINCT FROM OLD."screen_id"
    OR NEW."artifact_id" IS DISTINCT FROM OLD."artifact_id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('finalized', 'discarded') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_TERMINAL' USING ERRCODE = '23514';
  END IF;

  IF NEW."revision" < OLD."revision"
    OR (
      NEW."revision" > OLD."revision" + 1
      AND NOT (OLD."status" = 'degraded' AND NEW."status" = 'active')
    )
    OR (
      NEW."revision" = OLD."revision"
      AND NEW."checksum" IS DISTINCT FROM OLD."checksum"
      AND NOT (OLD."status" = 'degraded' AND NEW."status" = 'active')
    )
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_REVISION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (OLD."status" = 'active' AND NEW."status" IN ('active', 'paused', 'degraded', 'finalized', 'discarded'))
    OR (OLD."status" = 'paused' AND NEW."status" IN ('active', 'degraded', 'discarded'))
    OR (OLD."status" = 'degraded' AND NEW."status" IN ('active', 'discarded'))
  )
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'paused' AND owner_run_status <> 'waiting_input'::"RunStatus" THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_PAUSE_STATE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IN ('active', 'degraded', 'finalized')
    AND owner_run_status <> 'running'::"RunStatus"
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_RUN_STATE_INVALID' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "prototype_patch_projections_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "prototype_patch_projections"
FOR EACH ROW EXECUTE FUNCTION "guard_prototype_patch_projection"();

CREATE FUNCTION "guard_prototype_patch_application"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  projection_revision INTEGER;
  projection_checksum CHAR(64);
  projection_status "PrototypePatchProjectionStatus";
  version_status "ArtifactVersionStatus";
  version_runtime_draft_index INTEGER;
  owner_run_status "RunStatus";
  owner_run_attempt INTEGER;
  attempt_status "RuntimeAttemptStatus";
  attempt_number INTEGER;
  event_type TEXT;
  event_source_id TEXT;
  event_payload JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_APPLICATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'PROTOTYPE_PATCH_APPLICATION_DELETE_FORBIDDEN' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  SELECT projection."revision", projection."checksum", projection."status"
  INTO projection_revision, projection_checksum, projection_status
  FROM "prototype_patch_projections" AS projection
  WHERE projection."artifact_version_id" = NEW."artifact_version_id"
    AND projection."screen_id" = NEW."screen_id"
    AND projection."run_id" = NEW."run_id"
    AND projection."artifact_id" = NEW."artifact_id"
    AND projection."project_id" = NEW."project_id"
  FOR SHARE;

  SELECT version."status", version."runtime_draft_index"
  INTO version_status, version_runtime_draft_index
  FROM "artifact_versions" AS version
  WHERE version."id" = NEW."artifact_version_id"
    AND version."artifact_id" = NEW."artifact_id"
    AND version."project_id" = NEW."project_id"
    AND version."created_by_run_id" = NEW."run_id"
  FOR SHARE;

  SELECT owner_run."status", owner_run."attempt", attempt."status", attempt."attempt"
  INTO owner_run_status, owner_run_attempt, attempt_status, attempt_number
  FROM "runs" AS owner_run
  JOIN "runtime_attempts" AS attempt
    ON attempt."id" = NEW."runtime_attempt_id"
   AND attempt."run_id" = owner_run."id"
  WHERE owner_run."id" = NEW."run_id"
  FOR SHARE OF owner_run, attempt;

  SELECT event."type", event."source_id", event."payload"
  INTO event_type, event_source_id, event_payload
  FROM "run_events" AS event
  WHERE event."id" = NEW."run_event_id"
    AND event."run_id" = NEW."run_id"
  FOR SHARE;

  IF projection_revision IS NULL
    OR version_status IS DISTINCT FROM 'staging'::"ArtifactVersionStatus"
    OR owner_run_status IS DISTINCT FROM 'running'::"RunStatus"
    OR attempt_status IS DISTINCT FROM 'running'::"RuntimeAttemptStatus"
    OR attempt_number IS DISTINCT FROM owner_run_attempt
    OR event_source_id IS DISTINCT FROM NEW."source_event_id"
    OR event_payload->>'sourceEventId' IS DISTINCT FROM NEW."source_event_id"
    OR event_payload->>'runtimeAttemptId' IS DISTINCT FROM NEW."runtime_attempt_id"
    OR event_payload->'attempt' IS DISTINCT FROM to_jsonb(owner_run_attempt)
    OR event_payload->'artifactIndex' IS DISTINCT FROM to_jsonb(version_runtime_draft_index)
    OR event_payload->>'artifactId' IS DISTINCT FROM NEW."artifact_id"
    OR event_payload->>'artifactVersionId' IS DISTINCT FROM NEW."artifact_version_id"
    OR event_payload->>'screenId' IS DISTINCT FROM NEW."screen_id"
    OR event_payload->'baseRevision' IS DISTINCT FROM to_jsonb(NEW."base_revision")
    OR event_payload->'nextRevision' IS DISTINCT FROM to_jsonb(NEW."next_revision")
    OR event_payload->>'requestSha256' IS DISTINCT FROM NEW."request_sha256"
    OR event_payload->'operations' IS DISTINCT FROM NEW."operations"
    OR event_payload->>'resultingChecksum' IS DISTINCT FROM NEW."resulting_checksum"
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_APPLICATION_SCOPE_INVALID' USING ERRCODE = '23514';
  END IF;

  IF NEW."outcome" = 'applied'::"PrototypePatchApplicationOutcome" THEN
    IF event_type <> 'artifact.prototype.patch.created'
      OR projection_status <> 'active'::"PrototypePatchProjectionStatus"
      OR projection_revision <> NEW."next_revision"
      OR projection_checksum IS DISTINCT FROM NEW."resulting_checksum"
      OR event_payload ? 'reason'
      OR event_payload ? 'revision'
    THEN
      RAISE EXCEPTION 'PROTOTYPE_PATCH_APPLICATION_RESULT_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF event_type <> 'artifact.prototype.patch.degraded'
      OR projection_status <> 'degraded'::"PrototypePatchProjectionStatus"
      OR event_payload->>'reason' IS DISTINCT FROM NEW."degraded_reason"
      OR event_payload->'revision' IS DISTINCT FROM to_jsonb(projection_revision)
    THEN
      RAISE EXCEPTION 'PROTOTYPE_PATCH_APPLICATION_DEGRADED_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "prototype_patch_applications_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "prototype_patch_applications"
FOR EACH ROW EXECUTE FUNCTION "guard_prototype_patch_application"();

CREATE FUNCTION "guard_runtime_prototype_patch_ready"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_kind "ArtifactKind";
  expected_screen_count INTEGER;
  projection_count INTEGER;
  non_finalized_count INTEGER;
BEGIN
  IF NEW."status" <> 'ready'::"ArtifactVersionStatus"
    OR OLD."status" = 'ready'::"ArtifactVersionStatus"
    OR NEW."created_by_run_id" IS NULL
    OR NEW."runtime_draft_index" IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT artifact."kind"
  INTO artifact_kind
  FROM "artifacts" AS artifact
  WHERE artifact."id" = NEW."artifact_id"
    AND artifact."project_id" = NEW."project_id";

  IF artifact_kind <> 'prototype'::"ArtifactKind" THEN
    RETURN NEW;
  END IF;

  IF NEW."content" IS NULL
    OR jsonb_typeof(NEW."content") <> 'object'
    OR jsonb_typeof(NEW."content"->'screens') <> 'array'
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_READY_CONTENT_INVALID' USING ERRCODE = '23514';
  END IF;

  expected_screen_count := jsonb_array_length(NEW."content"->'screens');
  SELECT count(*), count(*) FILTER (WHERE projection."status" <> 'finalized')
  INTO projection_count, non_finalized_count
  FROM "prototype_patch_projections" AS projection
  WHERE projection."artifact_version_id" = NEW."id";

  IF projection_count <> expected_screen_count
    OR non_finalized_count <> 0
    OR EXISTS (
      SELECT 1
      FROM "prototype_patch_projections" AS projection
      WHERE projection."artifact_version_id" = NEW."id"
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(NEW."content"->'screens') AS screen
          WHERE screen->>'id' = projection."screen_id"
        )
    )
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_PROJECTION_NOT_FINALIZED' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "run_events" AS checkpoint_event
    WHERE checkpoint_event."run_id" = NEW."created_by_run_id"
      AND checkpoint_event."type" = 'artifact.draft.created'
      AND checkpoint_event."payload"->>'artifactVersionId' = NEW."id"
      AND checkpoint_event."payload"->>'artifactId' = NEW."artifact_id"
      AND checkpoint_event."payload"->>'kind' = 'prototype'
      AND checkpoint_event."payload"->'artifactIndex' = to_jsonb(NEW."runtime_draft_index")
      AND checkpoint_event."payload"->'attempt' = (
        SELECT to_jsonb(owner_run."attempt")
        FROM "runs" AS owner_run
        WHERE owner_run."id" = NEW."created_by_run_id"
      )
      AND checkpoint_event."payload"->>'checksum' = NEW."checksum"
      AND (
        SELECT count(*)
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(checkpoint_event."payload"->'screens') = 'array'
              THEN checkpoint_event."payload"->'screens'
            ELSE '[]'::jsonb
          END
        ) AS checkpoint_screen
      ) = expected_screen_count
      AND NOT EXISTS (
        SELECT 1
        FROM "prototype_patch_projections" AS projection
        WHERE projection."artifact_version_id" = NEW."id"
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(checkpoint_event."payload"->'screens') = 'array'
                  THEN checkpoint_event."payload"->'screens'
                ELSE '[]'::jsonb
              END
            ) AS checkpoint_screen
            WHERE checkpoint_screen->>'id' = projection."screen_id"
              AND checkpoint_screen->'revision' = to_jsonb(projection."revision")
              AND checkpoint_screen->>'checksum' = projection."checksum"
          )
      )
  ) THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_READY_CHECKPOINT_DIVERGED' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "artifact_versions_prototype_patch_ready_guard"
BEFORE UPDATE OF "status" ON "artifact_versions"
FOR EACH ROW EXECUTE FUNCTION "guard_runtime_prototype_patch_ready"();

CREATE FUNCTION "guard_prototype_patch_run_event"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND (
    EXISTS (
      SELECT 1
      FROM "prototype_patch_applications" AS application
      WHERE application."run_event_id" = OLD."id"
    )
    OR (
      OLD."type" = 'artifact.draft.created'
      AND OLD."payload"->>'kind' = 'prototype'
      AND OLD."payload"->>'artifactVersionId' IS NOT NULL
    )
  )
  THEN
    RAISE EXCEPTION 'PROTOTYPE_PATCH_RUN_EVENT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "run_events_prototype_patch_guard"
BEFORE UPDATE OR DELETE ON "run_events"
FOR EACH ROW EXECUTE FUNCTION "guard_prototype_patch_run_event"();
