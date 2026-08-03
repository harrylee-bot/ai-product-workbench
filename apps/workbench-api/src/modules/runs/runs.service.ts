import { createHash, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import type {
  Run,
  RunEvent,
  RunList,
  RunStatus,
  StartRunRequest,
} from "@workbench/workbench-contracts";
import {
  canonicalJson,
  isoDateTimeSchema,
  materializeRuntimeDesignPresetSnapshot,
  materializeRuntimeDesignStyleSnapshot,
  opaqueIdSchema,
  runSourceBlobLimit,
  runEventSchema,
  runSchema,
  runStatusSchema,
  runtimeCancelQueue,
  runtimeExecuteQueue,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
import {
  activeRunConflictProblem,
  idempotencyConflictProblem,
  notFoundProblem,
  runImportSourceStateConflictProblem,
  runDesignStyleStateConflictProblem,
  runRetryConflictProblem,
  runStateConflictProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { WorkbenchQueueService } from "../../platform/queue/workbench-queue.service.js";
import { AccessService } from "../access/access.service.js";
import { artifactVersionScreenIds } from "../artifacts/artifact-screen-reference.js";
import { DesignPresetsService } from "../design-presets/design-presets.service.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { RuntimeModelsService } from "../runtime/runtime-models.service.js";
import { publicRunEventPayload, RunEventStore } from "./run-event.store.js";
import { mapRun, orderedRunSourceSnapshots } from "./run.mapper.js";

const activeStatuses = ["queued", "running", "waiting_input", "cancelling"] as const;
const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const runtimeProviderCancellationUnconfirmedCode =
  "RUNTIME_PROVIDER_CANCELLATION_UNCONFIRMED";
type RunCursor = { createdAt: string; id: string };
type AuthorizedEventPollRow = {
  runId: string;
  requestId: string;
  projectId: string;
  threadId: string;
  traceId: string;
  status: string;
  eventId: string | null;
  sequence: number | null;
  eventType: string | null;
  payload: unknown;
  occurredAt: Date | null;
};

@Injectable()
export class RunsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
    private readonly events: RunEventStore,
    private readonly queue: WorkbenchQueueService,
    private readonly runtimeModels: RuntimeModelsService,
    private readonly designPresets: DesignPresetsService,
  ) {}

  async start(
    principalId: string,
    threadId: string,
    idempotencyKey: string,
    request: StartRunRequest,
  ): Promise<Run> {
    const normalizedRequest = startRunRequestSchema.parse(request);
    assertRunWorkflowInputs(normalizedRequest);
    return this.create(principalId, threadId, idempotencyKey, normalizedRequest, null);
  }

  async retry(principalId: string, sourceRunId: string, idempotencyKey: string): Promise<Run> {
    const source = await this.access.findRun(principalId, sourceRunId, "edit");
    if (source.status !== "failed" || source.errorRetryable !== true) {
      throw runRetryConflictProblem("Only a failed Run explicitly marked retryable can be retried");
    }
    if (source.errorCode === runtimeProviderCancellationUnconfirmedCode) {
      const runtimeAttempt = await this.db.runtimeAttempt.findUnique({
        where: {
          runId_attempt: {
            runId: source.id,
            attempt: source.attempt,
          },
        },
        select: {
          providerCancellationResolution: {
            select: { runtimeAttemptId: true },
          },
        },
      });
      if (!runtimeAttempt?.providerCancellationResolution) {
        throw runRetryConflictProblem(
          "Provider cancellation must converge before the failed Run can be retried",
        );
      }
    }
    // A retry replays the immutable source request. Clearing the Canvas
    // snapshot here would make the application request diverge from the DB
    // retry invariant and could apply work to a different board revision.
    const request = startRunRequestSchema.parse(source.request);
    assertRunWorkflowInputs(request);
    return this.create(principalId, source.threadId, idempotencyKey, request, source.id);
  }

  private async create(
    principalId: string,
    threadId: string,
    idempotencyKey: string,
    request: StartRunRequest,
    retryOfRunId: string | null,
  ): Promise<Run> {
    validateIdempotencyKey(idempotencyKey);
    const thread = await this.access.findThread(principalId, threadId, "edit");
    const existing = await this.db.run.findUnique({
      where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
      include: { sourceSnapshots: orderedRunSourceSnapshots },
    });
    if (existing) {
      return this.resolveIdempotentRun(
        existing,
        runRequestHash(request, existing.designStyleSnapshotSha256),
        retryOfRunId,
      );
    }

    if (request.designStyle.kind === "preset") {
      this.designPresets.resolve({
        presetId: request.designStyle.presetId,
        version: request.designStyle.version,
        checksum: request.designStyle.checksum,
      });
    }
    await this.runtimeModels.assertAvailable(request.modelId, request.workflow);

    try {
      const run = await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, thread.projectId, principalId, "edit");
        const duplicate = await tx.run.findUnique({
          where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
          include: { sourceSnapshots: orderedRunSourceSnapshots },
        });
        if (duplicate) {
          if (
            duplicate.requestHash !== runRequestHash(request, duplicate.designStyleSnapshotSha256)
            || duplicate.retryOfRunId !== retryOfRunId
          ) throw idempotencyConflictProblem();
          return duplicate;
        }

        const lockedThreads = await tx.$queryRaw<Array<{ status: string }>>(
          Prisma.sql`SELECT "status"::text AS "status" FROM "threads" WHERE "id" = ${threadId} FOR UPDATE`,
        );
        if (lockedThreads[0]?.status !== "active") throw notFoundProblem("Thread");

        const active = await tx.run.findFirst({
          where: { threadId, status: { in: [...activeStatuses] } },
          select: { id: true },
        });
        if (active) throw activeRunConflictProblem(active.id);

        const sources = retryOfRunId
          ? await this.copyRetrySourceSnapshots(tx, retryOfRunId, request.sourceIds)
          : await this.resolveSourceSnapshots(tx, thread.projectId, request.sourceIds);
        await this.assertReadyArtifactTargets(
          tx,
          thread.projectId,
          request,
        );
        await this.assertCanvasSnapshot(
          tx,
          thread.projectId,
          threadId,
          request.canvasSnapshot ?? null,
        );
        const designStyle = await this.resolveDesignStyle(
          tx,
          thread.projectId,
          request.designStyle,
        );
        const requestHash = runRequestHash(request, designStyle.snapshotSha256);

        const knowledgeRelease = await tx.knowledgeRelease.findFirst({
          where: {
            status: "ready",
            OR: [{ workspaceId: thread.project.workspaceId }, { workspaceId: null }],
          },
          orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        });
        const sequencedThread = await tx.thread.update({
          where: { id: threadId },
          data: { entrySequence: { increment: 1 }, revision: { increment: 1 } },
        });
        await tx.threadEntry.create({
          data: {
            threadId,
            sequence: sequencedThread.entrySequence,
            role: "user",
            kind: "message",
            content: {
              protocol: "workbench.entry.v1",
              type: "user.prompt",
              text: request.prompt,
              sourceIds: request.sourceIds,
            },
          },
        });

        const created = await tx.run.create({
          data: {
            projectId: thread.projectId,
            threadId,
            retryOfRunId,
            createdById: principalId,
            knowledgeReleaseId: knowledgeRelease?.id,
            designStyleArtifactVersionId: designStyle.artifactVersionId,
            designStyleSnapshot: designStyle.snapshot as Prisma.InputJsonValue | undefined,
            designStyleSnapshotSha256: designStyle.snapshotSha256,
            idempotencyKey,
            requestHash,
            request: request as Prisma.InputJsonValue,
            requestId: randomUUID(),
            status: "queued",
            modelId: request.modelId,
            traceId: randomUUID(),
          },
        });
        if (sources.length > 0) {
          await tx.runSourceSnapshot.createMany({
            data: sources.map((source, position) => ({
              id: `run_source_${randomUUID()}`,
              runId: created.id,
              projectId: thread.projectId,
              position,
              sourceId: source.sourceId,
              kind: source.kind,
              label: source.label,
              checksum: source.checksum,
              descriptor: source.descriptor as Prisma.InputJsonValue,
              snapshot: source.snapshot as Prisma.InputJsonValue,
            })),
          });
        }
        await this.events.append(tx, created.id, "run.queued", { position: null });
        await this.queue.sendInTransaction(tx, runtimeExecuteQueue, { runId: created.id }, {
          singletonKey: created.id,
          group: { id: threadId },
        });
        return tx.run.findUniqueOrThrow({
          where: { id: created.id },
          include: { sourceSnapshots: orderedRunSourceSnapshots },
        });
      });
      return mapRun(run);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.db.run.findUnique({
          where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
          include: { sourceSnapshots: orderedRunSourceSnapshots },
        });
        if (duplicate) {
          return this.resolveIdempotentRun(
            duplicate,
            runRequestHash(request, duplicate.designStyleSnapshotSha256),
            retryOfRunId,
          );
        }
        const active = await this.db.run.findFirst({
          where: { threadId, status: { in: [...activeStatuses] } },
          select: { id: true },
        });
        if (active) throw activeRunConflictProblem(active.id);
      }
      throw error;
    }
  }

  private async resolveDesignStyle(
    tx: Prisma.TransactionClient,
    projectId: string,
    designStyle: StartRunRequest["designStyle"],
  ) {
    if (designStyle.kind === "automatic") {
      return { artifactVersionId: null, snapshot: undefined, snapshotSha256: null };
    }

    if (designStyle.kind === "preset") {
      const snapshot = materializeRuntimeDesignPresetSnapshot(this.designPresets.resolve({
        presetId: designStyle.presetId,
        version: designStyle.version,
        checksum: designStyle.checksum,
      }));
      return {
        artifactVersionId: null,
        snapshot,
        snapshotSha256: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
      };
    }

    const versions = await tx.$queryRaw<Array<{
      id: string;
      artifactId: string;
      status: string;
      kind: string;
      schemaVersion: number;
      checksum: string;
    }>>(
      Prisma.sql`
        SELECT
          version."id",
          version."artifact_id" AS "artifactId",
          version."status"::text AS "status",
          artifact."kind"::text AS "kind",
          version."schema_version" AS "schemaVersion",
          version."checksum"
        FROM "artifact_versions" AS version
        JOIN "artifacts" AS artifact
          ON artifact."id" = version."artifact_id"
         AND artifact."project_id" = version."project_id"
        WHERE version."id" = ${designStyle.artifactVersionId}
          AND version."project_id" = ${projectId}
        FOR SHARE OF version, artifact
      `,
    );
    const locked = versions[0];
    if (
      !locked
      || locked.status !== "ready"
      || locked.kind !== "design_system"
      || locked.schemaVersion !== 1
    ) throw notFoundProblem("Artifact version");

    const version = await tx.artifactVersion.findUnique({
      where: { id: locked.id },
      include: { assets: { orderBy: { assetId: "asc" } } },
    });
    if (!version || version.content === null || version.contentBlobId !== null) {
      throw runDesignStyleStateConflictProblem();
    }
    let snapshot;
    try {
      snapshot = materializeRuntimeDesignStyleSnapshot({
        projectId,
        artifactId: locked.artifactId,
        artifactVersionId: locked.id,
        checksum: locked.checksum,
        document: version.content,
        assetPins: version.assets,
      });
    } catch {
      throw runDesignStyleStateConflictProblem();
    }
    const contentChecksum = createHash("sha256").update(canonicalJson(version.content)).digest("hex");
    if (contentChecksum !== locked.checksum) throw runDesignStyleStateConflictProblem();
    return {
      artifactVersionId: locked.id,
      snapshot,
      snapshotSha256: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    };
  }

  async get(principalId: string, runId: string): Promise<Run> {
    const run = await this.access.findRun(principalId, runId, "read");
    return mapRun(run);
  }

  private async assertReadyArtifactTargets(
    tx: Prisma.TransactionClient,
    projectId: string,
    request: StartRunRequest,
  ) {
    const { artifactTargets } = request;
    if (artifactTargets.length === 0) return;

    // Lock in deterministic id order while the persisted request retains caller order.
    const orderedIds = artifactTargets.map((target) => target.artifactVersionId).sort();
    const versions = await tx.$queryRaw<Array<{
      artifactId: string;
      content: Prisma.JsonValue | null;
      contentBlobId: string | null;
      id: string;
      kind: string;
      schemaVersion: number;
    }>>(Prisma.sql`
      SELECT
        version."id",
        version."artifact_id" AS "artifactId",
        version."schema_version" AS "schemaVersion",
        version."content",
        version."content_blob_id" AS "contentBlobId",
        artifact."kind"::TEXT AS "kind"
      FROM "artifact_versions" AS version
      JOIN "artifacts" AS artifact
        ON artifact."id" = version."artifact_id"
       AND artifact."project_id" = version."project_id"
      WHERE version."project_id" = ${projectId}
        AND version."id" IN (${Prisma.join(orderedIds)})
        AND version."status" = 'ready'
      ORDER BY version."id"
      FOR SHARE OF version, artifact
    `);
    const byId = new Map(versions.map((version) => [version.id, version]));
    for (const target of artifactTargets) {
      const version = byId.get(target.artifactVersionId);
      if (!version || version.artifactId !== target.artifactId) {
        throw notFoundProblem("Artifact version");
      }
      if (
        request.workflow === "generate"
        && (
          version.kind !== "prototype"
          || version.schemaVersion !== 1
          || version.content === null
          || version.contentBlobId !== null
        )
      ) {
        throw validationProblem(
          "Generate Prototype sources must be ready inline Prototype ArtifactVersions",
          { artifactTargets: ["Select screens from a ready inline Prototype in this Project"] },
        );
      }
      if (target.screenIds.length === 0) continue;
      if (
        version.kind !== "prototype"
        || version.schemaVersion !== 1
        || version.content === null
        || version.contentBlobId !== null
      ) {
        throw validationProblem("screenIds require a ready inline Prototype ArtifactVersion");
      }
      const screenIds = artifactVersionScreenIds({
        artifact: { kind: version.kind },
        content: version.content,
        contentBlobId: version.contentBlobId,
      });
      if (!screenIds || target.screenIds.some((screenId) => !screenIds.has(screenId))) {
        throw notFoundProblem("Prototype screen");
      }
    }
  }

  private async assertCanvasSnapshot(
    tx: Prisma.TransactionClient,
    projectId: string,
    threadId: string,
    snapshot: StartRunRequest["canvasSnapshot"] | null,
  ) {
    if (!snapshot) return;
    const now = Date.now();
    const capturedAt = Date.parse(snapshot.capturedAt);
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (
      snapshot.projectId !== projectId
      || snapshot.threadId !== threadId
      || snapshot.runId !== null
      || snapshot.projectSessionGeneration <= 0
      || capturedAt > now + 5_000
      || expiresAt <= now
      || expiresAt - capturedAt > 120_000
    ) throw validationProblem("Canvas snapshot scope or lifetime is invalid");

    const board = await tx.board.findUnique({
      where: { projectId },
      include: { nodes: true },
    });
    if (
      !board
      || board.id !== snapshot.boardId
      || board.revision !== snapshot.boardRevision
    ) throw revisionConflictProblem();

    const references = new Map(board.nodes.flatMap((node) => {
      const data = asJsonRecord(node.data);
      const screenId = typeof data?.screenId === "string" ? data.screenId : null;
      if (!node.artifactId || !node.artifactVersionId || !screenId) return [];
      const reference = {
        boardNodeId: node.nodeKey,
        artifactId: node.artifactId,
        artifactVersionId: node.artifactVersionId,
        screenId,
      };
      return [[canvasReferenceKey(reference), reference] as const];
    }));
    const supplied = [
      ...snapshot.screens.map((screen) => screen.reference),
      ...snapshot.visibleScreens,
      ...snapshot.selectedScreens,
    ];
    if (supplied.some((reference) => !references.has(canvasReferenceKey(reference)))) {
      throw validationProblem("Canvas snapshot contains a screen outside the current Board");
    }
  }

  async list(
    principalId: string,
    threadId: string,
    cursor?: string,
    requestedLimit?: number,
  ): Promise<RunList> {
    const decodedCursor = cursor ? decodeRunCursor(cursor) : undefined;
    await this.access.findThread(principalId, threadId, "read");
    const limit = Math.min(Math.max(requestedLimit ?? 30, 1), 100);
    const items = await this.db.run.findMany({
      where: {
        threadId,
        ...(decodedCursor
          ? {
              OR: [
                { createdAt: { lt: new Date(decodedCursor.createdAt) } },
                { createdAt: new Date(decodedCursor.createdAt), id: { lt: decodedCursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { sourceSnapshots: orderedRunSourceSnapshots },
    });
    const hasNextPage = items.length > limit;
    const page = hasNextPage ? items.slice(0, limit) : items;
    const last = page.at(-1);
    return {
      items: page.map(mapRun),
      nextCursor: hasNextPage && last
        ? encodeRunCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    };
  }

  async listEvents(principalId: string, runId: string, afterSequence: number): Promise<RunEvent[]> {
    await this.access.findRun(principalId, runId, "read");
    return this.events.listAfter(runId, afterSequence);
  }

  async authorizeEventStream(principalId: string, runId: string) {
    await this.access.findRun(principalId, runId, "read");
  }

  async pollAuthorizedEventStream(
    principalId: string,
    runId: string,
    afterSequence: number,
  ): Promise<{ events: RunEvent[]; status: RunStatus } | null> {
    const rows = await this.db.$queryRaw<AuthorizedEventPollRow[]>(Prisma.sql`
      SELECT
        candidate_run."id" AS "runId",
        candidate_run."request_id" AS "requestId",
        candidate_run."project_id" AS "projectId",
        candidate_run."thread_id" AS "threadId",
        candidate_run."trace_id" AS "traceId",
        candidate_run."status"::text AS "status",
        event."id" AS "eventId",
        event."sequence",
        event."type" AS "eventType",
        event."payload",
        event."occurred_at" AS "occurredAt"
      FROM "runs" AS candidate_run
      JOIN "threads" AS thread
        ON thread."id" = candidate_run."thread_id"
       AND thread."status" = 'active'
      JOIN "projects" AS project
        ON project."id" = candidate_run."project_id"
       AND project."status" = 'active'
      JOIN "project_members" AS member
        ON member."project_id" = candidate_run."project_id"
       AND member."principal_id" = ${principalId}
      JOIN "principals" AS principal
        ON principal."id" = member."principal_id"
       AND principal."status" = 'active'
      LEFT JOIN LATERAL (
        SELECT
          run_event."id",
          run_event."sequence",
          run_event."type",
          run_event."payload",
          run_event."occurred_at"
        FROM "run_events" AS run_event
        WHERE run_event."run_id" = candidate_run."id"
          AND run_event."sequence" > ${afterSequence}
        ORDER BY run_event."sequence" ASC
        LIMIT 100
      ) AS event ON TRUE
      WHERE candidate_run."id" = ${runId}
      ORDER BY event."sequence" ASC NULLS LAST
    `);
    const run = rows[0];
    if (!run) return null;

    const status = runStatusSchema.parse(run.status);
    const events = rows.flatMap((row) => {
      if (row.eventId === null) return [];
      if (
        row.sequence === null
        || row.eventType === null
        || row.occurredAt === null
      ) {
        throw new Error("Authorized Run event projection is incomplete");
      }
      return [runEventSchema.parse({
        protocol: "workbench.run.v1",
        id: row.eventId,
        projectId: row.projectId,
        threadId: row.threadId,
        runId: row.runId,
        requestId: row.requestId,
        sequence: row.sequence,
        type: row.eventType,
        occurredAt: row.occurredAt.toISOString(),
        traceId: row.traceId,
        payload: publicRunEventPayload(row.eventType, row.payload),
      })];
    });
    return { events, status };
  }

  async cancel(principalId: string, runId: string, idempotencyKey: string): Promise<Run> {
    validateIdempotencyKey(idempotencyKey);
    const authorized = await this.access.findRun(principalId, runId, "edit");
    const requestHash = runCancellationRequestHash(runId);
    const replay = await this.findCancellationReplay(principalId, idempotencyKey);
    if (replay) return resolveCancellationReplay(replay, principalId, runId, requestHash);
    if (terminalStatuses.has(authorized.status) && authorized.status !== "cancelled") {
      throw runStateConflictProblem(authorized.status);
    }

    try {
      return await this.db.$transaction(async (tx) => {
        await lockRunCancellationReceiptIdentity(tx, principalId, idempotencyKey);
        const duplicate = await tx.runCancellationReceipt.findUnique({
          where: { principalId_idempotencyKey: { principalId, idempotencyKey } },
        });
        if (duplicate) {
          return resolveCancellationReplay(duplicate, principalId, runId, requestHash);
        }

        await lockActiveProject(tx, authorized.projectId, principalId, "edit");
        const updated = await tx.run.updateMany({
          where: { id: runId, status: { in: ["queued", "running", "waiting_input"] } },
          data: { status: "cancelling", cancelRequestedAt: new Date() },
        });
        if (updated.count === 1) {
          const latestAttempt = await tx.runtimeAttempt.findFirst({
            where: { runId },
            orderBy: { attempt: "desc" },
            select: { id: true, status: true },
          });
          if (
            latestAttempt
            && ["submitting", "running", "waiting_input"].includes(latestAttempt.status)
          ) {
            await tx.runtimeAttempt.updateMany({
              where: {
                id: latestAttempt.id,
                runId,
                status: { in: ["submitting", "running", "waiting_input"] },
              },
              data: { status: "cancelling" },
            });
          }

          await this.events.append(tx, runId, "run.cancel.requested", {});
          await this.queue.sendInTransaction(tx, runtimeCancelQueue, { runId }, {
            singletonKey: runId,
          });
        }

        const current = await tx.run.findUniqueOrThrow({
          where: { id: runId },
          include: { sourceSnapshots: orderedRunSourceSnapshots },
        });
        if (
          updated.count === 0
          && current.status !== "cancelling"
          && current.status !== "cancelled"
        ) {
          throw runStateConflictProblem(current.status);
        }

        const result = mapRun(current);
        await tx.runCancellationReceipt.create({
          data: {
            runId,
            principalId,
            idempotencyKey,
            requestHash,
            response: result as Prisma.InputJsonValue,
            responseHash: hashRequest(result),
          },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findCancellationReplay(principalId, idempotencyKey);
        if (raced) return resolveCancellationReplay(raced, principalId, runId, requestHash);
      }
      throw error;
    }
  }

  private findCancellationReplay(principalId: string, idempotencyKey: string) {
    return this.db.runCancellationReceipt.findUnique({
      where: { principalId_idempotencyKey: { principalId, idempotencyKey } },
    });
  }

  isTerminal(status: string) {
    return terminalStatuses.has(status);
  }

  private resolveIdempotentRun(
    run: { requestHash: string; retryOfRunId: string | null } & Parameters<typeof mapRun>[0],
    requestHash: string,
    retryOfRunId: string | null,
  ) {
    if (run.requestHash !== requestHash || run.retryOfRunId !== retryOfRunId) {
      throw idempotencyConflictProblem();
    }
    return mapRun(run);
  }

  private async resolveSourceSnapshots(
    tx: Prisma.TransactionClient,
    projectId: string,
    sourceIds: string[],
  ) {
    if (sourceIds.length === 0) return [];
    const lockedIds = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "import_sources"
      WHERE "project_id" = ${projectId}
        AND "id" IN (${Prisma.join([...sourceIds].sort())})
      ORDER BY "id"
      FOR SHARE
    `);
    if (lockedIds.length !== sourceIds.length) throw runImportSourceStateConflictProblem();
    const rows = await tx.importSource.findMany({
      where: { projectId, id: { in: sourceIds } },
      include: { blobs: { orderBy: { position: "asc" }, include: { blob: true } } },
    });
    const byId = new Map(rows.map((source) => [source.id, source]));
    const snapshots = sourceIds.map((sourceId) => {
      const source = byId.get(sourceId);
      if (
        !source
        || source.status !== "ready"
        || source.deletedAt !== null
        || source.descriptor === null
        || source.checksum === null
        || source.blobs.some((entry) => entry.blob.status !== "ready" || entry.blob.deletedAt !== null)
      ) throw runImportSourceStateConflictProblem();
      return {
        sourceId: source.id,
        kind: source.kind,
        label: source.label,
        checksum: source.checksum,
        descriptor: source.descriptor,
        snapshot: {
          protocol: "workbench.import-source-snapshot.v1",
          sourceRevision: source.revision,
          checksum: source.checksum,
          blobs: source.blobs.map((entry) => ({
            blobId: entry.blobId,
            position: entry.position,
            role: entry.role,
            path: entry.path,
            mediaType: entry.mediaType,
            byteSize: Number(entry.byteSize),
            sha256: entry.sha256,
          })),
        },
      };
    });
    this.assertSourceBlobLimit(snapshots);
    return snapshots;
  }

  private async copyRetrySourceSnapshots(
    tx: Prisma.TransactionClient,
    sourceRunId: string,
    sourceIds: string[],
  ) {
    const snapshots = await tx.runSourceSnapshot.findMany({
      where: { runId: sourceRunId },
      orderBy: { position: "asc" },
    });
    if (
      snapshots.length !== sourceIds.length
      || snapshots.some((snapshot, index) => snapshot.sourceId !== sourceIds[index])
    ) throw runRetryConflictProblem("Retry source snapshots do not match the persisted source Run");
    const copied = snapshots.map(({ sourceId, kind, label, checksum, descriptor, snapshot }) => ({
      sourceId,
      kind,
      label,
      checksum,
      descriptor,
      snapshot,
    }));
    this.assertSourceBlobLimit(copied);
    return copied;
  }

  private assertSourceBlobLimit(snapshots: ReadonlyArray<{ snapshot: unknown }>) {
    const blobCount = snapshots.reduce((count, source) => {
      const snapshot = asJsonRecord(source.snapshot as Prisma.JsonValue);
      const blobs = snapshot?.blobs;
      return count + (Array.isArray(blobs) ? blobs.length : runSourceBlobLimit + 1);
    }, 0);
    if (blobCount > runSourceBlobLimit) {
      throw validationProblem(
        `A Run may materialize at most ${runSourceBlobLimit} source blobs`,
        { sourceIds: [`Selected Import Sources materialize ${blobCount} blobs`] },
      );
    }
  }
}

function asJsonRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function canvasReferenceKey(reference: {
  boardNodeId: string;
  artifactId: string;
  artifactVersionId: string;
  screenId: string;
}) {
  return [
    reference.boardNodeId,
    reference.artifactId,
    reference.artifactVersionId,
    reference.screenId,
  ].join("\u0000");
}

export function assertRunWorkflowInputs(
  request: Pick<
    StartRunRequest,
    "artifactTargets" | "generationIntent" | "requestedArtifactKinds" | "workflow"
  >,
): void {
  if (request.workflow === "edit") {
    if (request.generationIntent !== null) {
      throw validationProblem(
        "Only the generate workflow accepts a generation intent",
        { generationIntent: ["Remove generationIntent from Edit requests"] },
      );
    }
    if (request.artifactTargets.length > 0) return;
    throw validationProblem(
      "The edit workflow requires at least one Artifact target",
      { artifactTargets: ["Select at least one ready ArtifactVersion or Prototype screen"] },
    );
  }

  if (request.workflow === "generate") {
    if (request.artifactTargets.length === 0) {
      if (request.generationIntent !== null) {
        throw validationProblem(
          "A generation intent requires explicit source screens",
          { generationIntent: ["Remove generationIntent or select source screens"] },
        );
      }
      return;
    }
    if (request.generationIntent === null) {
      throw validationProblem(
        "Targeted Generate requires an explicit generation intent",
        { generationIntent: ["Choose followup-design or interactive-prototype"] },
      );
    }
    if (!request.requestedArtifactKinds.includes("prototype")) {
      throw validationProblem(
        "Generate Artifact targets require a Prototype output",
        { requestedArtifactKinds: ["Include prototype when selecting source screens"] },
      );
    }
    const missingScreenSelections = request.artifactTargets
      .map((target, index) => target.screenIds.length === 0 ? index : null)
      .filter((index): index is number => index !== null);
    if (missingScreenSelections.length > 0) {
      throw validationProblem(
        "Generate Prototype requires explicit screen selections",
        Object.fromEntries(missingScreenSelections.map((index) => [
          `artifactTargets.${index}.screenIds`,
          ["Select at least one source Prototype screen"],
        ])),
      );
    }
    return;
  }

  if (request.generationIntent !== null) {
    throw validationProblem(
      "Only the generate workflow accepts a generation intent",
      { generationIntent: ["Remove generationIntent from this workflow"] },
    );
  }
  if (request.artifactTargets.length > 0) {
    throw validationProblem(
      "Artifact targets are not valid for the redesign or ideate workflows",
      { artifactTargets: ["Remove Artifact targets or select the edit or Generate Prototype workflow"] },
    );
  }
}

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeRunCursor(value: string): RunCursor {
  try {
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new Error("invalid cursor");
    }
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isRunCursor(parsed)) {
      throw new Error("invalid cursor");
    }
    return parsed;
  } catch {
    throw validationProblem("The Run cursor is invalid");
  }
}

function isRunCursor(value: unknown): value is RunCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return false;
  if (!opaqueIdSchema.safeParse(record.id).success) return false;
  if (typeof record.createdAt !== "string" || record.createdAt.length > 64) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(record.createdAt)) return false;
  return isoDateTimeSchema.safeParse(record.createdAt).success;
}

function runCancellationRequestHash(runId: string) {
  return hashRequest({ protocol: "workbench.run-cancellation.v1", runId });
}

async function lockRunCancellationReceiptIdentity(
  tx: Prisma.TransactionClient,
  principalId: string,
  idempotencyKey: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`run-cancellation:v1:${principalId}:${idempotencyKey}`}, 0)
    )::TEXT AS "receiptLock"
  `);
}

function resolveCancellationReplay(
  receipt: {
    runId: string;
    principalId: string;
    requestHash: string;
    response: unknown;
    responseHash: string;
  },
  principalId: string,
  runId: string,
  requestHash: string,
) {
  if (
    receipt.principalId !== principalId
    || receipt.runId !== runId
    || receipt.requestHash !== requestHash
  ) {
    throw idempotencyConflictProblem();
  }
  if (hashRequest(receipt.response) !== receipt.responseHash) {
    throw new Error("RUN_CANCELLATION_RECEIPT_HASH_INVALID");
  }
  const response = runSchema.parse(receipt.response);
  if (
    response.id !== runId
    || (response.status !== "cancelling" && response.status !== "cancelled")
  ) {
    throw new Error("RUN_CANCELLATION_RECEIPT_RESPONSE_INVALID");
  }
  return response;
}

export function runRequestHash(request: StartRunRequest, designStyleSnapshotSha256: string | null) {
  return designStyleSnapshotSha256 == null
    ? hashRequest(request)
    : hashRequest({ request, designStyleSnapshotSha256 });
}

export { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
