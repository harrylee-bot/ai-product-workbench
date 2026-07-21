import { createHash } from "node:crypto";
import {
  PROTOTYPE_PATCH_MAX_REVISION,
  PrototypePatchError,
  canonicalJson,
  assertPrototypePatchPayloadSize,
  prototypePatchCheckpointScreenSchema,
  prototypeDocumentSchema,
  runEventSourceIdSchema,
  runtimePrototypePatchInputSchema,
  type PrototypeDocument,
  type PrototypePatchCheckpointScreen,
  type PrototypePatchDegradedReason,
  type RuntimeProgressEvent,
  type RuntimeArtifactDraft,
} from "@workbench/workbench-contracts";
import { Prisma, type PrismaClient } from "@workbench/workbench-db";
import { applyAndVerifyPrototypePatch, prototypeScreenProjectionChecksum } from "./prototype-patch-applier.js";
import { RunEventStore } from "./run-event.store.js";
import { lockRunStatus } from "./run-state-lock.js";
import type { RuntimePrototypePatchBaseline } from "../runtime/runtime.port.js";

type PrototypePatchProgressEvent = Extract<
  RuntimeProgressEvent,
  { type: "artifact.prototype.patch" }
>;

type ProjectionRow = {
  artifactVersionId: string;
  screenId: string;
  artifactId: string;
  projectId: string;
  runId: string;
  revision: number;
  checksum: string;
  status: "active" | "paused" | "degraded" | "finalized" | "discarded";
  degradedReason: string | null;
};

type StagingVersionRow = {
  id: string;
  artifactId: string;
  projectId: string;
  status: string;
  content: Prisma.JsonValue | null;
  checksum: string;
  runtimeDraftIndex: number | null;
  artifactKind: string;
};

export type PrototypeCheckpointScreenState = {
  id: string;
  name: string;
  route: string;
  viewport: { width: number; height: number };
  revision: number;
  checksum: string;
};

export class PrototypePatchService {
  private readonly events: RunEventStore;

  constructor(private readonly db: PrismaClient) {
    this.events = new RunEventStore(db);
  }

  async persistPatch(
    runId: string,
    runtimeAttemptId: string,
    progressEvent: PrototypePatchProgressEvent,
  ) {
    return this.db.$transaction((tx) => this.persistPatchTx(
      tx,
      runId,
      runtimeAttemptId,
      progressEvent,
    ));
  }

  async persistPatchTx(
    tx: Prisma.TransactionClient,
    runId: string,
    runtimeAttemptId: string,
    progressEvent: PrototypePatchProgressEvent,
  ) {
    const patch = runtimePrototypePatchInputSchema.parse(progressEvent.patch);
    assertSourceEventId(progressEvent.sourceEventId);
    const requestSha256 = sha256Canonical({
      sourceEventId: progressEvent.sourceEventId,
      patch,
    });

    // Exact replay is resolved before lifecycle checks. A lost response may
    // be retried after the Run/Attempt becomes terminal; the immutable
    // application receipt is the authority for that replay.
    let replay = await tx.prototypePatchApplication.findUnique({
      where: {
        runtimeAttemptId_sourceEventId: {
          runtimeAttemptId,
          sourceEventId: progressEvent.sourceEventId,
        },
      },
      select: {
        id: true,
        runId: true,
        outcome: true,
        requestSha256: true,
        runEventId: true,
      },
    });
    if (replay) {
      if (replay.runId !== runId || replay.requestSha256 !== requestSha256) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");
      }
      return { created: false, ...replay };
    }

    // The first lookup preserves the fast exact-replay path even after the
    // lifecycle becomes terminal. For two concurrent first deliveries, a
    // transaction-scoped lock serializes only this receipt identity; the
    // second lookup observes the winner before any lifecycle validation.
    await lockPrototypePatchReceiptIdentity(
      tx,
      runtimeAttemptId,
      progressEvent.sourceEventId,
    );
    replay = await tx.prototypePatchApplication.findUnique({
      where: {
        runtimeAttemptId_sourceEventId: {
          runtimeAttemptId,
          sourceEventId: progressEvent.sourceEventId,
        },
      },
      select: {
        id: true,
        runId: true,
        outcome: true,
        requestSha256: true,
        runEventId: true,
      },
    });
    if (replay) {
      if (replay.runId !== runId || replay.requestSha256 !== requestSha256) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_SOURCE_CONFLICT");
      }
      return { created: false, ...replay };
    }

    assertPrototypePatchPayloadSize(patch);
    if (await lockRunStatus(tx, runId) !== "running") {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_RUN_STATE_INVALID");
    }
    const run = await tx.run.findUniqueOrThrow({
      where: { id: runId },
      select: { id: true, projectId: true, attempt: true },
    });
    const attempt = await lockRuntimeAttempt(tx, runtimeAttemptId, runId);
    if (attempt.status !== "running" || attempt.attempt !== run.attempt) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_ATTEMPT_INVALID");
    }
    const version = await lockStagingPrototypeVersion(tx, runId, patch.artifactIndex);
    if (version.projectId !== run.projectId) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_VERSION_SCOPE_INVALID");
    }
    let projection = await lockProjection(tx, version.id, patch.screenId);
    if (!projection || projection.runId !== runId) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_CHECKPOINT_UNAVAILABLE");
    }

      if (projection.status === "paused") {
        projection = await this.activateProjectionTx(tx, projection);
      }
      if (projection.status === "degraded") {
        return this.persistDegradedTx(
          tx,
          run,
          attempt.id,
          version,
          projection,
          progressEvent,
          patch,
          requestSha256,
          "checkpoint_unavailable",
        );
      }
      if (projection.status !== "active") {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_PROJECTION_TERMINAL");
      }
      if (patch.baseRevision !== projection.revision) {
        return this.persistDegradedTx(
          tx,
          run,
          attempt.id,
          version,
          projection,
          progressEvent,
          patch,
          requestSha256,
          "revision_gap",
        );
      }

      const document = prototypeDocumentSchema.parse(version.content);
      let applied: ReturnType<typeof applyAndVerifyPrototypePatch>;
      try {
        const {
          screenId,
          baseRevision,
          nextRevision,
          operations,
          resultingChecksum,
        } = patch;
        applied = applyAndVerifyPrototypePatch(document, {
          screenId,
          baseRevision,
          nextRevision,
          operations,
          resultingChecksum,
        });
      } catch (error) {
        if (!(error instanceof PrototypePatchError)) throw error;
        return this.persistDegradedTx(
          tx,
          run,
          attempt.id,
          version,
          projection,
          progressEvent,
          patch,
          requestSha256,
          "patch_rejected",
        );
      }
      if (applied.checksum !== patch.resultingChecksum) {
        return this.persistDegradedTx(
          tx,
          run,
          attempt.id,
          version,
          projection,
          progressEvent,
          patch,
          requestSha256,
          "checksum_mismatch",
        );
      }

      await tx.artifactVersion.update({
        where: { id: version.id },
        data: {
          content: applied.document as Prisma.InputJsonValue,
          checksum: sha256Canonical(applied.document),
        },
      });
      await tx.prototypePatchProjection.update({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: projection.artifactVersionId,
            screenId: projection.screenId,
          },
        },
        data: {
          revision: patch.nextRevision,
          checksum: applied.checksum,
          status: "active",
          degradedReason: null,
        },
      });
      const payload = {
        attempt: run.attempt,
        runtimeAttemptId: attempt.id,
        artifactIndex: patch.artifactIndex,
        artifactId: version.artifactId,
        artifactVersionId: version.id,
        sourceEventId: progressEvent.sourceEventId,
        requestSha256,
        screenId: patch.screenId,
        baseRevision: patch.baseRevision,
        nextRevision: patch.nextRevision,
        operations: patch.operations,
        resultingChecksum: patch.resultingChecksum,
      };
      const appended = await this.events.appendOnce(
        tx,
        runId,
        "artifact.prototype.patch.created",
        payload,
        progressEvent.sourceEventId,
      );
      const application = await tx.prototypePatchApplication.create({
        data: {
          runtimeAttemptId: attempt.id,
          runId,
          artifactVersionId: version.id,
          artifactId: version.artifactId,
          projectId: version.projectId,
          screenId: patch.screenId,
          sourceEventId: progressEvent.sourceEventId,
          outcome: "applied",
          degradedReason: null,
          baseRevision: patch.baseRevision,
          nextRevision: patch.nextRevision,
          requestSha256,
          operations: patch.operations as Prisma.InputJsonArray,
          resultingChecksum: patch.resultingChecksum,
          runEventId: appended.event.id,
        },
        select: { id: true, runId: true, outcome: true, runEventId: true },
      });
    return { created: true, requestSha256, ...application };
  }

  async synchronizeCheckpointTx(
    tx: Prisma.TransactionClient,
    input: {
      runId: string;
      artifactVersionId: string;
      artifactId: string;
      projectId: string;
      document: PrototypeDocument;
      mode?: "runtime_checkpoint" | "trusted_final";
      checkpointScreens?: readonly PrototypePatchCheckpointScreen[];
    },
  ): Promise<PrototypeCheckpointScreenState[]> {
    if (await lockRunStatus(tx, input.runId) !== "running") {
      throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_RUN_STATE_INVALID");
    }
    const document = prototypeDocumentSchema.parse(input.document);
    const requestedScreens = checkpointScreenMap(
      document,
      input.checkpointScreens,
      input.mode === "trusted_final",
    );
    const existing = await lockVersionProjections(tx, input.artifactVersionId);
    const existingByScreen = new Map(existing.map((projection) => [projection.screenId, projection]));
    const documentScreenIds = new Set(document.screens.map((screen) => screen.id));
    if (existing.some((projection) => !documentScreenIds.has(projection.screenId))) {
      throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_SCREEN_SET_CONFLICT");
    }

    const states: PrototypeCheckpointScreenState[] = [];
    for (const screen of document.screens) {
      const current = existingByScreen.get(screen.id);
      if (!current) {
        const revision = 0;
        const checksum = prototypeScreenProjectionChecksum(document, screen.id, revision);
        assertRequestedCheckpointScreen(requestedScreens, screen.id, revision, checksum);
        await tx.prototypePatchProjection.create({
          data: {
            artifactVersionId: input.artifactVersionId,
            artifactId: input.artifactId,
            projectId: input.projectId,
            runId: input.runId,
            screenId: screen.id,
            revision,
            checksum,
          },
        });
        states.push(checkpointScreenState(screen, revision, checksum));
        continue;
      }
      if (current.runId !== input.runId || current.artifactId !== input.artifactId || current.projectId !== input.projectId) {
        throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_SCOPE_CONFLICT");
      }
      if (current.status === "finalized" || current.status === "discarded") {
        throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_TERMINAL");
      }

      let revision: number;
      if (current.status === "degraded") {
        const latestDegraded = await tx.prototypePatchApplication.aggregate({
          where: {
            artifactVersionId: current.artifactVersionId,
            screenId: current.screenId,
            outcome: "degraded",
          },
          _max: { nextRevision: true },
        });
        if (latestDegraded._max.nextRevision === null) {
          throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_DEGRADED_LEDGER_MISSING");
        }
        revision = Math.max(current.revision, latestDegraded._max.nextRevision);
      } else {
        revision = current.revision;
        const currentChecksum = prototypeScreenProjectionChecksum(document, screen.id, revision);
        if (currentChecksum !== current.checksum) {
          if (revision >= PROTOTYPE_PATCH_MAX_REVISION) {
            throw new Error("RUNTIME_PROTOTYPE_PATCH_REVISION_EXHAUSTED");
          }
          revision += 1;
        }
      }
      const checksum = prototypeScreenProjectionChecksum(document, screen.id, revision);
      assertRequestedCheckpointScreen(requestedScreens, screen.id, revision, checksum);
      if (
        checksum !== current.checksum
        || current.status !== "active"
        || revision !== current.revision
      ) {
        await tx.prototypePatchProjection.update({
          where: {
            artifactVersionId_screenId: {
              artifactVersionId: current.artifactVersionId,
              screenId: current.screenId,
            },
          },
          data: {
            revision,
            checksum,
            status: "active",
            degradedReason: null,
          },
        });
      }
      states.push(checkpointScreenState(screen, revision, checksum));
    }
    return states;
  }

  async loadRunBaselinesTx(
    tx: Prisma.TransactionClient,
    runId: string,
  ): Promise<RuntimePrototypePatchBaseline[]> {
    if (await lockRunStatus(tx, runId) !== "running") {
      throw new Error("RUNTIME_PROTOTYPE_BASELINE_RUN_STATE_INVALID");
    }
    const versions = await lockRunStagingPrototypeVersions(tx, runId);
    const baselines: RuntimePrototypePatchBaseline[] = [];
    for (const version of versions) {
      if (
        version.runtimeDraftIndex === null
        || version.runtimeDraftIndex < 0
        || version.runtimeDraftIndex > 19
        || version.content === null
      ) {
        throw new Error("RUNTIME_PROTOTYPE_BASELINE_VERSION_INVALID");
      }
      const document = prototypeDocumentSchema.parse(version.content);
      if (sha256Canonical(document) !== version.checksum) {
        throw new Error("RUNTIME_PROTOTYPE_BASELINE_DOCUMENT_DIVERGED");
      }
      const projections = await lockVersionProjections(tx, version.id);
      const documentScreenIds = new Set(document.screens.map((screen) => screen.id));
      if (
        projections.length !== documentScreenIds.size
        || projections.some((projection) => !documentScreenIds.has(projection.screenId))
      ) {
        throw new Error("RUNTIME_PROTOTYPE_BASELINE_SCREEN_SET_DIVERGED");
      }
      const screens: RuntimePrototypePatchBaseline["screens"] = [];
      for (const projection of projections) {
        if (
          projection.runId !== runId
          || projection.artifactId !== version.artifactId
          || projection.projectId !== version.projectId
          || (projection.status !== "active" && projection.status !== "degraded")
        ) {
          throw new Error("RUNTIME_PROTOTYPE_BASELINE_SCOPE_INVALID");
        }
        const checksum = prototypeScreenProjectionChecksum(
          document,
          projection.screenId,
          projection.revision,
        );
        if (checksum !== projection.checksum) {
          throw new Error("RUNTIME_PROTOTYPE_BASELINE_SCREEN_DIVERGED");
        }
        let recoveryRevision: number | null = null;
        if (projection.status === "degraded") {
          const latestDegraded = await tx.prototypePatchApplication.aggregate({
            where: {
              artifactVersionId: projection.artifactVersionId,
              screenId: projection.screenId,
              outcome: "degraded",
            },
            _max: { nextRevision: true },
          });
          if (latestDegraded._max.nextRevision === null) {
            throw new Error("RUNTIME_PROTOTYPE_BASELINE_DEGRADED_LEDGER_INVALID");
          }
          recoveryRevision = Math.max(
            projection.revision,
            latestDegraded._max.nextRevision,
          );
        }
        screens.push({
          screenId: projection.screenId,
          revision: projection.revision,
          checksum: projection.checksum,
          status: projection.status,
          recoveryRevision,
        });
      }
      baselines.push({
        artifactIndex: version.runtimeDraftIndex,
        artifactVersionId: version.id,
        document,
        screens,
      });
    }
    return baselines;
  }

  async pauseRunTx(tx: Prisma.TransactionClient, runId: string) {
    await tx.prototypePatchProjection.updateMany({
      where: { runId, status: "active" },
      data: { status: "paused" },
    });
  }

  async activateRunTx(tx: Prisma.TransactionClient, runId: string) {
    await tx.prototypePatchProjection.updateMany({
      where: { runId, status: "paused" },
      data: { status: "active" },
    });
  }

  async discardRunTx(tx: Prisma.TransactionClient, runId: string, discardedAt: Date) {
    await tx.prototypePatchProjection.updateMany({
      where: { runId, status: { in: ["active", "paused", "degraded"] } },
      data: { status: "discarded", discardedAt },
    });
  }

  async finalizeVersionTx(
    tx: Prisma.TransactionClient,
    artifactVersionId: string,
    documentInput: unknown,
    finalizedAt: Date,
  ) {
    const document = prototypeDocumentSchema.parse(documentInput);
    const projections = await lockVersionProjections(tx, artifactVersionId);
    if (projections.length !== document.screens.length) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_PROJECTION_INCOMPLETE");
    }
    const byScreen = new Map(projections.map((projection) => [projection.screenId, projection]));
    for (const screen of document.screens) {
      const projection = byScreen.get(screen.id);
      if (!projection || projection.status !== "active") {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_PROJECTION_NOT_FINALIZABLE");
      }
      const checksum = prototypeScreenProjectionChecksum(document, screen.id, projection.revision);
      if (checksum !== projection.checksum) {
        throw new Error("RUNTIME_PROTOTYPE_PATCH_PROJECTION_DIVERGED");
      }
    }
    const finalized = await tx.prototypePatchProjection.updateMany({
      where: { artifactVersionId, status: "active" },
      data: { status: "finalized", finalizedAt },
    });
    if (finalized.count !== projections.length) {
      throw new Error("RUNTIME_PROTOTYPE_PATCH_PROJECTION_FINALIZE_CONFLICT");
    }
  }

  private async activateProjectionTx(
    tx: Prisma.TransactionClient,
    projection: ProjectionRow,
  ): Promise<ProjectionRow> {
    return tx.prototypePatchProjection.update({
      where: {
        artifactVersionId_screenId: {
          artifactVersionId: projection.artifactVersionId,
          screenId: projection.screenId,
        },
      },
      data: { status: "active" },
    }) as Promise<ProjectionRow>;
  }

  private async persistDegradedTx(
    tx: Prisma.TransactionClient,
    run: { id: string; attempt: number },
    runtimeAttemptId: string,
    version: StagingVersionRow,
    projection: ProjectionRow,
    progressEvent: PrototypePatchProgressEvent,
    patch: ReturnType<typeof runtimePrototypePatchInputSchema.parse>,
    requestSha256: string,
    reason: PrototypePatchDegradedReason,
  ) {
    if (projection.status !== "degraded") {
      await tx.prototypePatchProjection.update({
        where: {
          artifactVersionId_screenId: {
            artifactVersionId: projection.artifactVersionId,
            screenId: projection.screenId,
          },
        },
        data: { status: "degraded", degradedReason: reason },
      });
    }
    const payload = {
      attempt: run.attempt,
      runtimeAttemptId,
      artifactIndex: patch.artifactIndex,
      artifactId: version.artifactId,
      artifactVersionId: version.id,
      screenId: patch.screenId,
      sourceEventId: progressEvent.sourceEventId,
      revision: projection.revision,
      reason,
      requestSha256,
      baseRevision: patch.baseRevision,
      nextRevision: patch.nextRevision,
      operations: patch.operations,
      resultingChecksum: patch.resultingChecksum,
    };
    const appended = await this.events.appendOnce(
      tx,
      run.id,
      "artifact.prototype.patch.degraded",
      payload,
      progressEvent.sourceEventId,
    );
    const application = await tx.prototypePatchApplication.create({
      data: {
        runtimeAttemptId,
        runId: run.id,
        artifactVersionId: version.id,
        artifactId: version.artifactId,
        projectId: version.projectId,
        screenId: patch.screenId,
        sourceEventId: progressEvent.sourceEventId,
        outcome: "degraded",
        degradedReason: reason,
        baseRevision: patch.baseRevision,
        nextRevision: patch.nextRevision,
        requestSha256,
        operations: patch.operations as Prisma.InputJsonArray,
        resultingChecksum: patch.resultingChecksum,
        runEventId: appended.event.id,
      },
      select: { id: true, runId: true, outcome: true, runEventId: true },
    });
    return { created: true, requestSha256, ...application };
  }
}

function checkpointScreenState(
  screen: PrototypeDocument["screens"][number],
  revision: number,
  checksum: string,
): PrototypeCheckpointScreenState {
  return {
    id: screen.id,
    name: screen.name,
    route: screen.route,
    viewport: screen.viewport,
    revision,
    checksum,
  };
}

async function lockRuntimeAttempt(
  tx: Prisma.TransactionClient,
  runtimeAttemptId: string,
  runId: string,
) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    attempt: number;
    status: string;
  }>>(Prisma.sql`
    SELECT "id", "attempt", "status"::TEXT AS "status"
    FROM "runtime_attempts"
    WHERE "id" = ${runtimeAttemptId}
      AND "run_id" = ${runId}
    FOR UPDATE
  `);
  const attempt = rows[0];
  if (!attempt) throw new Error("RUNTIME_PROTOTYPE_PATCH_ATTEMPT_INVALID");
  return attempt;
}

async function lockStagingPrototypeVersion(
  tx: Prisma.TransactionClient,
  runId: string,
  artifactIndex: number,
): Promise<StagingVersionRow> {
  const rows = await tx.$queryRaw<StagingVersionRow[]>(Prisma.sql`
    SELECT
      version."id",
      version."artifact_id" AS "artifactId",
      version."project_id" AS "projectId",
      version."status"::TEXT AS "status",
      version."content",
      version."checksum",
      version."runtime_draft_index" AS "runtimeDraftIndex",
      artifact."kind"::TEXT AS "artifactKind"
    FROM "artifact_versions" AS version
    JOIN "artifacts" AS artifact
      ON artifact."id" = version."artifact_id"
     AND artifact."project_id" = version."project_id"
    WHERE version."created_by_run_id" = ${runId}
      AND version."runtime_draft_index" = ${artifactIndex}
    FOR UPDATE OF version
  `);
  const version = rows[0];
  if (
    !version
    || version.status !== "staging"
    || version.artifactKind !== "prototype"
    || version.runtimeDraftIndex !== artifactIndex
    || version.content === null
  ) {
    throw new Error("RUNTIME_PROTOTYPE_PATCH_VERSION_INVALID");
  }
  return version;
}

async function lockRunStagingPrototypeVersions(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<StagingVersionRow[]> {
  return tx.$queryRaw<StagingVersionRow[]>(Prisma.sql`
    SELECT
      version."id",
      version."artifact_id" AS "artifactId",
      version."project_id" AS "projectId",
      version."status"::TEXT AS "status",
      version."content",
      version."checksum",
      version."runtime_draft_index" AS "runtimeDraftIndex",
      artifact."kind"::TEXT AS "artifactKind"
    FROM "artifact_versions" AS version
    JOIN "artifacts" AS artifact
      ON artifact."id" = version."artifact_id"
     AND artifact."project_id" = version."project_id"
    WHERE version."created_by_run_id" = ${runId}
      AND version."runtime_draft_index" IS NOT NULL
      AND version."status" = 'staging'
      AND version."content" IS NOT NULL
      AND version."content_blob_id" IS NULL
      AND artifact."kind" = 'prototype'
    ORDER BY version."runtime_draft_index" ASC
    FOR UPDATE OF version
  `);
}

async function lockProjection(
  tx: Prisma.TransactionClient,
  artifactVersionId: string,
  screenId: string,
) {
  const rows = await tx.$queryRaw<ProjectionRow[]>(Prisma.sql`
    SELECT
      "artifact_version_id" AS "artifactVersionId",
      "screen_id" AS "screenId",
      "artifact_id" AS "artifactId",
      "project_id" AS "projectId",
      "run_id" AS "runId",
      "revision",
      "checksum",
      "status"::TEXT AS "status",
      "degraded_reason" AS "degradedReason"
    FROM "prototype_patch_projections"
    WHERE "artifact_version_id" = ${artifactVersionId}
      AND "screen_id" = ${screenId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockVersionProjections(
  tx: Prisma.TransactionClient,
  artifactVersionId: string,
): Promise<ProjectionRow[]> {
  return tx.$queryRaw<ProjectionRow[]>(Prisma.sql`
    SELECT
      "artifact_version_id" AS "artifactVersionId",
      "screen_id" AS "screenId",
      "artifact_id" AS "artifactId",
      "project_id" AS "projectId",
      "run_id" AS "runId",
      "revision",
      "checksum",
      "status"::TEXT AS "status",
      "degraded_reason" AS "degradedReason"
    FROM "prototype_patch_projections"
    WHERE "artifact_version_id" = ${artifactVersionId}
    ORDER BY "screen_id" ASC
    FOR UPDATE
  `);
}

function assertSourceEventId(sourceEventId: string) {
  if (!runEventSourceIdSchema.safeParse(sourceEventId).success) {
    throw new Error("RUNTIME_PROTOTYPE_PATCH_SOURCE_ID_INVALID");
  }
}

async function lockPrototypePatchReceiptIdentity(
  tx: Prisma.TransactionClient,
  runtimeAttemptId: string,
  sourceEventId: string,
) {
  const identity = canonicalJson({ runtimeAttemptId, sourceEventId });
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0::bigint))::TEXT AS "lock_receipt"
  `);
}

function checkpointScreenMap(
  document: PrototypeDocument,
  input: readonly PrototypePatchCheckpointScreen[] | undefined,
  allowDerived: boolean,
) {
  if (input === undefined) {
    if (!allowDerived) throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_METADATA_MISSING");
    return null;
  }
  const parsed = prototypePatchCheckpointScreenSchema.array().max(500).parse(input);
  const byId = new Map(parsed.map((screen) => [screen.screenId, screen]));
  const documentScreenIds = new Set(document.screens.map((screen) => screen.id));
  if (
    byId.size !== parsed.length
    || byId.size !== documentScreenIds.size
    || [...byId.keys()].some((screenId) => !documentScreenIds.has(screenId))
  ) {
    throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_METADATA_SCREEN_SET_INVALID");
  }
  return byId;
}

function assertRequestedCheckpointScreen(
  requested: ReadonlyMap<string, PrototypePatchCheckpointScreen> | null,
  screenId: string,
  revision: number,
  checksum: string,
) {
  if (!requested) return;
  const screen = requested.get(screenId);
  if (!screen || screen.revision !== revision || screen.checksum !== checksum) {
    throw new Error("RUNTIME_PROTOTYPE_CHECKPOINT_METADATA_DIVERGED");
  }
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function isPrototypeDraft(draft: RuntimeArtifactDraft): draft is Extract<RuntimeArtifactDraft, { kind: "prototype" }> {
  return draft.kind === "prototype";
}
