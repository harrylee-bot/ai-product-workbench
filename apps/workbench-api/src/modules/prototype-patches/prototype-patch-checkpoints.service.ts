import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  canonicalJson,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  prototypeDocumentSchema,
  runPrototypePatchCheckpointSchema,
  type RunPrototypePatchCheckpoint,
} from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import {
  notFoundProblem,
  prototypePatchCheckpointConflictProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";

type CheckpointRow = {
  projectId: string;
  runId: string;
  requestId: string;
  attempt: number;
  runtimeAttemptId: string;
  artifactIndex: number;
  artifactId: string;
  artifactVersionId: string;
  status: string;
  document: Prisma.JsonValue;
  documentChecksum: string;
  lastSequence: number;
  screenId: string;
  screenRevision: number;
  screenChecksum: string;
};

@Injectable()
export class PrototypePatchCheckpointsService {
  constructor(private readonly db: WorkbenchDbService) {}

  async get(
    principalId: string,
    runId: string,
    artifactVersionId: string,
    screenId?: string,
  ): Promise<RunPrototypePatchCheckpoint> {
    const rows = await this.db.$queryRaw<CheckpointRow[]>(Prisma.sql`
      SELECT
        candidate_run."project_id" AS "projectId",
        candidate_run."id" AS "runId",
        candidate_run."request_id" AS "requestId",
        candidate_run."attempt",
        runtime_attempt."id" AS "runtimeAttemptId",
        version."runtime_draft_index" AS "artifactIndex",
        version."artifact_id" AS "artifactId",
        version."id" AS "artifactVersionId",
        version."status"::TEXT AS "status",
        version."content" AS "document",
        version."checksum" AS "documentChecksum",
        candidate_run."event_sequence" AS "lastSequence",
        projection."screen_id" AS "screenId",
        projection."revision" AS "screenRevision",
        projection."checksum" AS "screenChecksum"
      FROM "runs" AS candidate_run
      JOIN "threads" AS thread
        ON thread."id" = candidate_run."thread_id"
       AND thread."project_id" = candidate_run."project_id"
       AND thread."status" = 'active'
      JOIN "projects" AS project
        ON project."id" = candidate_run."project_id"
       AND project."status" = 'active'
      JOIN "project_members" AS member
        ON member."project_id" = project."id"
       AND member."principal_id" = ${principalId}
      JOIN "principals" AS principal
        ON principal."id" = member."principal_id"
       AND principal."status" = 'active'
      JOIN "runtime_attempts" AS runtime_attempt
        ON runtime_attempt."run_id" = candidate_run."id"
       AND runtime_attempt."attempt" = candidate_run."attempt"
      JOIN "artifact_versions" AS version
        ON version."id" = ${artifactVersionId}
       AND version."project_id" = candidate_run."project_id"
       AND version."created_by_run_id" = candidate_run."id"
       AND version."runtime_draft_index" IS NOT NULL
       AND version."status" IN ('staging', 'ready')
       AND version."content" IS NOT NULL
       AND version."content_blob_id" IS NULL
      JOIN "artifacts" AS artifact
        ON artifact."id" = version."artifact_id"
       AND artifact."project_id" = version."project_id"
       AND artifact."kind" = 'prototype'
      JOIN "prototype_patch_projections" AS projection
        ON projection."artifact_version_id" = version."id"
       AND projection."artifact_id" = version."artifact_id"
       AND projection."project_id" = version."project_id"
       AND projection."run_id" = candidate_run."id"
       AND projection."status" IN ('active', 'paused', 'degraded', 'finalized')
      WHERE candidate_run."id" = ${runId}
        AND (
          CAST(${screenId ?? null} AS TEXT) IS NULL
          OR projection."screen_id" = CAST(${screenId ?? null} AS TEXT)
        )
      ORDER BY projection."screen_id" ASC
    `);
    const first = rows[0];
    if (!first) throw notFoundProblem("Prototype patch checkpoint");
    if (sha256Canonical(first.document) !== first.documentChecksum) {
      throw checkpointConflict(
        "PROTOTYPE_PATCH_CHECKPOINT_DOCUMENT_DIVERGED",
        "The stored Prototype document does not match its checksum",
      );
    }
    for (const row of rows) {
      assertSameCheckpoint(first, row);
    }

    const parsedDocument = prototypeDocumentSchema.safeParse(first.document);
    if (!parsedDocument.success) {
      throw checkpointConflict(
        "PROTOTYPE_PATCH_CHECKPOINT_DOCUMENT_INVALID",
        "The stored Prototype document is invalid",
      );
    }
    const document = parsedDocument.data;
    const rowScreenIds = new Set<string>();
    for (const row of rows) {
      if (rowScreenIds.has(row.screenId)) {
        throw checkpointConflict(
          "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_SET_DIVERGED",
          "The checkpoint contains duplicate screen projections",
        );
      }
      rowScreenIds.add(row.screenId);
      let expectedChecksum: string;
      try {
        expectedChecksum = computePrototypeScreenProjectionChecksum(
          projectPrototypeScreen(document, row.screenId, row.screenRevision),
          sha256Text,
        );
      } catch {
        throw checkpointConflict(
          "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_DIVERGED",
          "A checkpoint screen projection is not present in the Prototype document",
        );
      }
      if (expectedChecksum !== row.screenChecksum) {
        throw checkpointConflict(
          "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_DIVERGED",
          "A checkpoint screen projection does not match its checksum",
        );
      }
    }
    if (screenId) {
      if (rows.length !== 1 || rows[0]?.screenId !== screenId) {
        throw checkpointConflict(
          "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_SET_DIVERGED",
          "The filtered checkpoint does not contain exactly the requested screen",
        );
      }
    } else {
      const documentScreenIds = new Set(document.screens.map((screen) => screen.id));
      if (
        rowScreenIds.size !== documentScreenIds.size
        || [...documentScreenIds].some((id) => !rowScreenIds.has(id))
      ) {
        throw checkpointConflict(
          "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_SET_DIVERGED",
          "The checkpoint screen set does not match the Prototype document",
        );
      }
    }

    return runPrototypePatchCheckpointSchema.parse({
      protocol: "workbench.prototype-patch-checkpoint.v1",
      projectId: first.projectId,
      runId: first.runId,
      requestId: first.requestId,
      attempt: first.attempt,
      runtimeAttemptId: first.runtimeAttemptId,
      artifactIndex: first.artifactIndex,
      artifactId: first.artifactId,
      artifactVersionId: first.artifactVersionId,
      status: first.status,
      document,
      documentChecksum: first.documentChecksum,
      screens: rows.map((row) => ({
        screenId: row.screenId,
        revision: row.screenRevision,
        checksum: row.screenChecksum,
      })),
      lastSequence: first.lastSequence,
    });
  }
}

function assertSameCheckpoint(first: CheckpointRow, row: CheckpointRow) {
  if (
    row.projectId !== first.projectId
    || row.runId !== first.runId
    || row.requestId !== first.requestId
    || row.attempt !== first.attempt
    || row.runtimeAttemptId !== first.runtimeAttemptId
    || row.artifactIndex !== first.artifactIndex
    || row.artifactId !== first.artifactId
    || row.artifactVersionId !== first.artifactVersionId
    || row.status !== first.status
    || row.documentChecksum !== first.documentChecksum
    || row.lastSequence !== first.lastSequence
    || canonicalJson(row.document) !== canonicalJson(first.document)
  ) {
    throw checkpointConflict(
      "PROTOTYPE_PATCH_CHECKPOINT_SCOPE_DIVERGED",
      "The checkpoint rows do not belong to one coherent snapshot",
    );
  }
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function checkpointConflict(code: string, detail: string) {
  return prototypePatchCheckpointConflictProblem(code, detail);
}
