import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";
import {
  boardNodeDataSchema,
  canvasAgentToolInputSchemas,
  canvasAgentToolOutputSchemas,
  canvasAgentToolProfiles,
  canvasAgentToolResultSchema,
  canvasClientCommandAckSchema,
  canvasClientCommandAckRequestSchema,
  canvasClientCommandExchangeSchema,
  canvasClientCommandSchema,
  canvasClientStateSyncResponseSchema,
  canvasGetSelectedScreensOutputSchema,
  canvasGetVisibleScreensOutputSchema,
  canvasNavigateCanvasOutputSchema,
  canvasSelectionSchema,
  canvasSelectScreenOutputSchema,
  canvasSnapshotSchema,
  canvasViewScreenOutputSchema,
  canvasQuickEditOutputSchema,
  canvasDuplicateScreenOutputSchema,
  canvasRenameScreenOutputSchema,
  canvasAgentToolRequestSchema,
  canvasAgentToolInvocationSchema,
  type CanvasAgentToolRequest,
  type CanvasAgentToolInvocation,
  type CanvasAgentToolResult,
  type CanvasClientCommand,
  type CanvasClientCommandAck,
  type CanvasClientCommandAckRequest,
  type CanvasClientStateSyncRequest,
  type CanvasScreenReference,
  type CanvasScreenSummary,
  type CanvasSnapshot,
  type PrototypeDocument,
  prototypeDocumentSchema,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
import {
  CanvasToolCapabilityGrantError,
  canvasToolCapabilityGrantPayloadSha256,
  canvasToolPayloadSha256,
  verifyCanvasToolCapabilityGrant,
  type CanvasToolCapabilityGrantPayload,
} from "@workbench/workbench-canvas-tools";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import {
  CANVAS_VISUAL_STORAGE_PORT,
  type CanvasVisualStoragePort,
} from "../../platform/object-storage/object-storage.port.js";
import { readReadyObject } from "../../platform/object-storage/read-ready-object.js";
import { readyObjectIntegrityRecorder } from "../../platform/object-storage/ready-object-integrity.js";
import { CanvasAgentConfig } from "./canvas-agent.config.js";
import {
  canvasCommandConflictProblem,
  canvasInvocationConflictProblem,
  canvasReadonlyProblem,
  canvasRevisionProblem,
  canvasScopeProblem,
  canvasToolValidationProblem,
  canvasUnauthorizedProblem,
  canvasUnavailableProblem,
} from "./canvas-agent.problems.js";

const terminalInvocationStatuses = new Set(["succeeded", "failed", "cancelled"]);
const clientCommandToolNames = new Set(["view_screen", "select_screen", "navigate_canvas"]);
const mutationToolNames = new Set(["quick_edit", "duplicate_screen", "rename_screen"]);

type SessionRow = {
  id: string;
  runtimeAttemptId: string;
  runId: string;
  projectId: string;
  threadId: string;
  principalId: string;
  boardId: string;
  clientSessionId: string;
  projectSessionGeneration: number;
  status: string;
  profile: string;
  declaredTools: Prisma.JsonValue;
  declarationHash: string;
  snapshotSha256: string;
  boardRevision: number;
  canvasStateRevision: number;
  invocationSequence: number;
  selectedNodeIds: Prisma.JsonValue;
  visibleNodeIds: Prisma.JsonValue;
  viewport: Prisma.JsonValue;
  activeMutationToolCallId: string | null;
  expiresAt: Date;
  grant: {
    id: string;
    payloadSha256: string;
    declarationHash: string;
    snapshotSha256: string;
    expiresAt: Date;
    revokedAt: Date | null;
  } | null;
};

type BoardNodeRow = {
  id: string;
  boardId: string;
  projectId: string;
  nodeKey: string;
  parentNodeKey: string | null;
  sortOrder: number;
  kind: string;
  position: Prisma.JsonValue;
  size: Prisma.JsonValue | null;
  artifactId: string | null;
  artifactVersionId: string | null;
  data: Prisma.JsonValue;
};

type BoardRow = {
  id: string;
  projectId: string;
  revision: number;
  viewport: Prisma.JsonValue;
  nodes: BoardNodeRow[];
  edges: Array<{ id: string; edgeKey: string; sourceNodeKey: string; targetNodeKey: string; kind: string; data: Prisma.JsonValue }>;
};

type ScreenRecord = {
  node: BoardNodeRow;
  reference: CanvasScreenReference;
  summary: CanvasScreenSummary;
  document: PrototypeDocument;
  screen: PrototypeDocument["screens"][number];
};

type AuthorizedScope = {
  grant: CanvasToolCapabilityGrantPayload;
  session: SessionRow;
  board: BoardRow;
  snapshot: CanvasSnapshot;
  screens: Map<string, ScreenRecord>;
};

type InvocationRow = {
  id: string;
  agentSessionId: string;
  grantId: string;
  runId: string;
  projectId: string;
  principalId: string;
  toolCallId: string;
  toolName: string;
  sequence: number;
  requestHash: string;
  request: Prisma.JsonValue;
  status: string;
  executionAttempt: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  boardRevisionBefore: number;
  boardRevisionAfter: number | null;
  canvasStateRevisionBefore: number;
  canvasStateRevisionAfter: number | null;
  canvasStateSha256Before: string;
  canvasStateSha256After: string | null;
  response: Prisma.JsonValue | null;
  failureCode: string | null;
  targetBoardNodeId: string | null;
  targetArtifactId: string | null;
  targetArtifactVersionId: string | null;
  targetScreenId: string | null;
  resultArtifactVersionId: string | null;
};

type CanvasProjectionClient = Pick<Prisma.TransactionClient, "artifactVersion">;

type AuthorizedVisualCapabilityRow = {
  storageKey: string;
  mediaType: string;
  sha256: string;
  byteSize: bigint;
  expiresAt: Date;
  snapshotSha256: string;
  boardRevision: number;
  canvasStateRevision: number;
  viewport: Prisma.JsonValue;
  selectedNodeIds: Prisma.JsonValue;
  visibleNodeIds: Prisma.JsonValue;
  profile: string;
};

type LockedProjectMembership = {
  databaseNow: Date;
  role: string;
};

type VisualCapturePublication = {
  storageKey: string;
  mediaType: "image/webp";
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  createdByTransaction: boolean;
};

type CanvasVisualDbClient = Pick<Prisma.TransactionClient, "$queryRaw" | "canvasVisualCapability">;

type VisualCaptureBinding = {
  commandId: string;
  invocationId: string;
  agentSessionId: string;
  grantId: string;
  projectId: string;
  runId: string;
  principalId: string;
  target: CanvasScreenReference;
  databaseNow: Date;
};

@Injectable()
export class CanvasAgentService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly config: CanvasAgentConfig,
    @Inject(CANVAS_VISUAL_STORAGE_PORT) private readonly visualStorage: CanvasVisualStoragePort,
  ) {}

  async execute(
    authorization: string | undefined,
    idempotencyKey: string | undefined,
    request: CanvasAgentToolInvocation,
  ): Promise<CanvasAgentToolResult> {
    const grant = this.verifyGrant(authorization);
    const normalized = await this.normalizeInvocationRequest(grant, request);
    const scope = await this.authorizeScope(grant, normalized);
    const requestHash = this.invocationRequestHash(normalized);
    const reservation = await this.reserveInvocation(scope, normalized, requestHash, idempotencyKey);
    if (reservation.kind === "replay") return reservation.result;

    try {
      const profile = canvasAgentToolProfiles[normalized.toolName];
      if (profile.effect === "client_command") {
        return await this.issueClientCommand(scope, reservation.invocation, normalized);
      }
      if (profile.effect === "read") {
        const data = await this.executeRead(scope, normalized);
        return await this.succeedInvocation(scope, reservation.invocation, normalized, data);
      }
      return await this.executeRunIntent(scope, reservation.invocation, normalized);
    } catch (error) {
      const failure = this.safeFailure(error);
      return this.failInvocation(scope, reservation.invocation, normalized, failure);
    }
  }

  async acknowledge(
    principalId: string,
    projectId: string,
    commandId: string,
    ackInput: CanvasClientCommandAckRequest,
  ): Promise<CanvasClientCommandAck> {
    const wireAck = canvasClientCommandAckRequestSchema.parse(ackInput);
    const { visualCapture, ...durableAckInput } = wireAck;
    const ack = canvasClientCommandAckSchema.parse(durableAckInput);
    if (ack.commandId !== commandId) throw canvasCommandConflictProblem("The ACK commandId does not match the URL");
    const located = await this.db.canvasClientCommand.findUnique({
      where: { id: commandId },
      select: { agentSessionId: true, status: true },
    });
    if (!located) throw canvasScopeProblem("Canvas client command was not found");

    let uncommittedVisualObject: { capabilityId: string; storageKey: string } | null = null;
    let settled: { kind: "acknowledged"; ack: CanvasClientCommandAck } | { kind: "expired" };
    try {
      settled = await this.db.$transaction(async (tx) => {
      const membership = await this.lockActiveProjectMembership(tx, principalId, projectId);
      const lockedSessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT session."id"
        FROM "canvas_agent_sessions" AS session
        JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."agent_session_id" = session."id"
        WHERE session."id" = ${located.agentSessionId}
        FOR UPDATE OF session, tool_grant
      `);
      if (!lockedSessions[0]) throw canvasScopeProblem("Canvas Agent session was not found");
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "canvas_client_commands"
        WHERE "id" = ${commandId}
        FOR UPDATE
      `);
      const current = await tx.canvasClientCommand.findUnique({
        where: { id: commandId },
        include: { invocation: true, agentSession: { include: { grant: true } } },
      });
      if (!current) throw canvasScopeProblem("Canvas client command was not found");
      if (
        current.projectId !== projectId
        || current.agentSession.projectId !== projectId
        || current.agentSession.principalId !== principalId
      ) throw canvasScopeProblem("Canvas client command is outside the current Product session");
      if (
        current.projectId !== ack.projectId
        || current.threadId !== ack.threadId
        || current.clientSessionId !== ack.clientSessionId
        || current.projectSessionGeneration !== ack.projectSessionGeneration
        || current.boardRevision !== ack.boardRevision
        || current.toolCallId !== ack.toolCallId
      ) {
        throw canvasCommandConflictProblem("The ACK scope does not match the persisted Canvas command");
      }
      const storedCommand = canvasClientCommandSchema.parse(current.command);
      const exchange = canvasClientCommandExchangeSchema.safeParse({ command: storedCommand, ack });
      if (!exchange.success) {
        throw canvasToolValidationProblem("CANVAS_ACK_INVALID", "The ACK does not match its persisted command");
      }
      if (current.status === "acknowledged") {
        const previous = current.acknowledgement
          ? canvasClientCommandAckSchema.parse(current.acknowledgement)
          : null;
        if (!previous || hashRequest(previous) !== hashRequest(ack)) {
          throw canvasCommandConflictProblem("The Canvas command was already acknowledged with a different result");
        }
        if (storedCommand.toolName === "view_screen" && previous.status === "applied") {
          if (storedCommand.kind !== "preview.open" || !visualCapture) {
            throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_INVALID", "The Canvas visual capture is not bound to this command");
          }
          const visualPublication = await this.publishVisualCapture(tx, visualCapture, {
            commandId,
            invocationId: current.invocationId,
            agentSessionId: current.agentSessionId,
            grantId: current.agentSession.grant?.id ?? "",
            projectId: current.projectId,
            runId: current.runId,
            principalId,
            target: storedCommand.target,
            databaseNow: membership.databaseNow,
          }, false);
          await this.assertReadyVisualCaptureTx(
            tx,
            storedCommand,
            current.invocationId,
            current.agentSessionId,
            current.projectId,
            current.agentSession.grant?.id ?? null,
            visualCapture,
            visualPublication,
          );
        }
        return { kind: "acknowledged" as const, ack: previous };
      }
      if (
        current.status !== "pending"
        || current.agentSession.status !== "active"
        || current.agentSession.expiresAt.getTime() <= membership.databaseNow.getTime()
        || !current.agentSession.grant
        || current.agentSession.grant.revokedAt !== null
        || current.agentSession.grant.expiresAt.getTime() <= membership.databaseNow.getTime()
      ) throw canvasCommandConflictProblem();

      const now = membership.databaseNow;
      if (current.expiresAt.getTime() <= now.getTime()) {
        await this.expireCommandTx(tx, current, now);
        return { kind: "expired" as const };
      }
      if (current.agentSession.canvasStateRevision !== ack.canvasStateRevision) {
        throw canvasCommandConflictProblem("The Canvas client state must be synchronized before acknowledgement");
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "boards"
        WHERE "id" = ${current.agentSession.boardId}
          AND "project_id" = ${current.projectId}
        FOR SHARE
      `);
      const board = await tx.board.findUnique({
        where: { id: current.agentSession.boardId, projectId: current.projectId },
        include: { nodes: true, edges: true },
      });
      if (!board || board.revision !== ack.boardRevision) {
        throw canvasRevisionProblem("The ACK does not acknowledge the current Board revision");
      }
      const projected = await this.projectSnapshot(
        current.agentSession as unknown as SessionRow,
        board as unknown as BoardRow,
        tx,
      );
      const acknowledgedCanvasStateSha256 = canonicalCanvasStateSha256(projected.snapshot);
      if (ack.status === "applied") {
        this.validateClientResult(
          storedCommand.toolName,
          ack.result,
          projected.snapshot,
          projected.screens,
        );
        if (storedCommand.toolName === "view_screen") {
          if (storedCommand.kind !== "preview.open" || !visualCapture || !current.agentSession.grant) {
            throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_MISSING", "A view_screen ACK must include an image capture");
          }
          const visualPublication = await this.publishVisualCapture(tx, visualCapture, {
            commandId,
            invocationId: current.invocationId,
            agentSessionId: current.agentSessionId,
            grantId: current.agentSession.grant.id,
            projectId: current.projectId,
            runId: current.runId,
            principalId,
            target: storedCommand.target,
            databaseNow: membership.databaseNow,
          });
          if (visualPublication.createdByTransaction) {
            uncommittedVisualObject = {
              capabilityId: visualCapture.visualCapabilityId,
              storageKey: visualPublication.storageKey,
            };
          }
          await this.assertReadyVisualCaptureTx(
            tx,
            storedCommand,
            current.invocationId,
            current.agentSessionId,
            current.projectId,
            current.agentSession.grant?.id ?? null,
            visualCapture,
            visualPublication,
          );
        }
      }

      const invocationStatus = ack.status === "applied" ? "succeeded" : "failed";
      const failureCode = ack.status === "rejected" ? ack.failure.code : null;
      const result = ack.status === "applied"
        ? this.resultFromAck(current.invocation, ack)
        : this.failedResultFromAck(current.invocation, ack);
      const commandUpdated = await tx.canvasClientCommand.updateMany({
        where: { id: current.id, status: "pending" },
        data: {
          status: "acknowledged",
          acknowledgement: ack as unknown as Prisma.InputJsonValue,
          acknowledgedCanvasStateSha256,
          acknowledgedAt: now,
        },
      });
      if (commandUpdated.count !== 1) throw canvasCommandConflictProblem();
      const invocationUpdated = await tx.canvasToolInvocation.updateMany({
        where: { id: current.invocationId, status: "waiting_client" },
        data: {
          status: invocationStatus,
          response: result as unknown as Prisma.InputJsonValue,
          failureCode,
          boardRevisionAfter: ack.boardRevision,
          canvasStateRevisionAfter: ack.canvasStateRevision,
          canvasStateSha256After: acknowledgedCanvasStateSha256,
          completedAt: now,
        },
      });
      if (invocationUpdated.count !== 1) throw canvasCommandConflictProblem();
      if (
        ack.status === "rejected"
        && (
          ack.canvasStateRevision !== current.invocation.canvasStateRevisionBefore
          || acknowledgedCanvasStateSha256 !== current.invocation.canvasStateSha256Before
        )
      ) {
        const revoked = await tx.canvasToolGrant.updateMany({
          where: { id: current.agentSession.grant!.id, revokedAt: null },
          data: { revokedAt: membership.databaseNow },
        });
        if (revoked.count !== 1) {
          throw canvasCommandConflictProblem("Rejected Canvas state transition raced with grant revocation");
        }
      }
      return { kind: "acknowledged" as const, ack };
      });
    } catch (error) {
      if (uncommittedVisualObject) {
        await this.cleanupUncommittedVisualObject(uncommittedVisualObject);
      }
      throw error;
    }
    uncommittedVisualObject = null;
    if (settled.kind === "expired") {
      throw canvasCommandConflictProblem("The Canvas client command has expired");
    }
    return settled.ack;
  }

  async getVisual(
    authorization: string | undefined,
    visualCapabilityId: string,
    ifNoneMatch?: string,
    signal?: AbortSignal,
  ) {
    const grant = this.verifyGrant(authorization);
    const visual = await this.findAuthorizedVisualCapability(grant, visualCapabilityId);
    const object = await readReadyObject(this.visualStorage, {
      storageKey: visual.storageKey,
      sha256: visual.sha256,
      byteSize: safeVisualByteSize(visual.byteSize),
      mediaType: visual.mediaType,
    }, undefined, ifNoneMatch, {
      signal,
      recordIntegrityFailure: readyObjectIntegrityRecorder(this.db),
    });
    return {
      ...object,
      sha256: visual.sha256,
      capabilityExpiresAt: visual.expiresAt,
    };
  }

  /**
   * A signed capability is intentionally not the source of truth for object
   * access.  Session completion, grant revocation, membership removal, and Run
   * cancellation can all happen while the token is still within its TTL.  Lock
   * and re-check every owner row in one statement so those lifecycle changes
   * take effect before a visual object is read.
   */
  private async findAuthorizedVisualCapability(
    grant: CanvasToolCapabilityGrantPayload,
    visualCapabilityId: string,
  ): Promise<AuthorizedVisualCapabilityRow> {
    const payloadSha256 = canvasToolCapabilityGrantPayloadSha256(grant);
    const rows = await this.db.$queryRaw<AuthorizedVisualCapabilityRow[]>(Prisma.sql`
      SELECT
        visual."storage_key" AS "storageKey",
        visual."media_type" AS "mediaType",
        visual."sha256" AS "sha256",
        visual."byte_size" AS "byteSize",
        visual."expires_at" AS "expiresAt",
        session."snapshot_sha256" AS "snapshotSha256",
        session."board_revision" AS "boardRevision",
        session."canvas_state_revision" AS "canvasStateRevision",
        session."viewport" AS "viewport",
        session."selected_node_ids" AS "selectedNodeIds",
        session."visible_node_ids" AS "visibleNodeIds",
        session."profile"::TEXT AS "profile"
      FROM "canvas_visual_capabilities" AS visual
      JOIN "canvas_agent_sessions" AS session
        ON session."id" = visual."agent_session_id"
      JOIN "canvas_tool_grants" AS tool_grant
        ON tool_grant."id" = visual."grant_id"
       AND tool_grant."agent_session_id" = session."id"
      JOIN "runs" AS run
        ON run."id" = visual."run_id"
       AND run."project_id" = visual."project_id"
      JOIN "projects" AS project
        ON project."id" = visual."project_id"
      JOIN "principals" AS principal
        ON principal."id" = visual."principal_id"
      JOIN "project_members" AS membership
        ON membership."project_id" = visual."project_id"
       AND membership."principal_id" = visual."principal_id"
      WHERE visual."id"::TEXT = ${visualCapabilityId}
        AND visual."grant_id"::TEXT = ${grant.grantId}
        AND visual."agent_session_id" = ${grant.agentSessionId}
        AND visual."run_id" = ${grant.runId}
        AND visual."project_id" = ${grant.projectId}
        AND visual."principal_id" = ${grant.principalId}
        AND visual."status" = 'ready'
        AND visual."storage_key" IS NOT NULL
        AND visual."storage_deleted_at" IS NULL
        AND visual."media_type" IS NOT NULL
        AND visual."sha256" IS NOT NULL
        AND visual."byte_size" IS NOT NULL
        AND visual."expires_at" > CURRENT_TIMESTAMP
        AND session."project_id" = visual."project_id"
        AND session."run_id" = visual."run_id"
        AND session."thread_id" = ${grant.threadId}
        AND session."principal_id" = visual."principal_id"
        AND session."board_id" = ${grant.boardId}
        AND session."runtime_attempt_id" = ${grant.runtimeAttemptId}
        AND session."status" = 'active'
        AND session."expires_at" > CURRENT_TIMESTAMP
        AND session."declaration_hash" = ${grant.declarationSha256}
        AND tool_grant."payload_sha256" = ${payloadSha256}
        AND tool_grant."declaration_hash" = ${grant.declarationSha256}
        AND tool_grant."revoked_at" IS NULL
        AND tool_grant."expires_at" > CURRENT_TIMESTAMP
        AND run."thread_id" = ${grant.threadId}
        AND run."created_by_id" = ${grant.principalId}
        AND run."status" = 'running'
        AND project."status" = 'active'
        AND principal."status" = 'active'
      FOR SHARE OF visual, session, tool_grant, run, project, principal, membership
    `);
    const visual = rows[0];
    if (!visual || !visual.storageKey || !visual.mediaType || !visual.sha256 || visual.byteSize === null) {
      throw canvasUnauthorizedProblem();
    }
    this.assertGrantSnapshot(grant, visual);
    return visual;
  }

  async synchronizeClientState(
    principalId: string,
    projectId: string,
    state: CanvasClientStateSyncRequest,
  ) {
    return this.db.$transaction(async (tx) => {
      const membership = await this.lockActiveProjectMembership(tx, principalId, projectId);

      const sessions = await tx.$queryRaw<Array<{
        id: string;
        boardRevision: number;
        canvasStateRevision: number;
        selectedNodeIds: Prisma.JsonValue;
        visibleNodeIds: Prisma.JsonValue;
        viewport: Prisma.JsonValue;
      }>>(Prisma.sql`
        SELECT
          "id",
          "board_revision" AS "boardRevision",
          "canvas_state_revision" AS "canvasStateRevision",
          "selected_node_ids" AS "selectedNodeIds",
          "visible_node_ids" AS "visibleNodeIds",
          "viewport"
        FROM "canvas_agent_sessions"
        WHERE "principal_id" = ${principalId}
          AND "project_id" = ${projectId}
          AND "board_id" = ${state.boardId}
          AND "client_session_id" = ${state.clientSessionId}
          AND "project_session_generation" = ${state.projectSessionGeneration}
          AND "status" = 'active'
          AND "expires_at" > CURRENT_TIMESTAMP
        ORDER BY "id" ASC
        FOR UPDATE
      `);
      if (sessions.length === 0) {
        return canvasClientStateSyncResponseSchema.parse({
          protocol: "workbench.canvas-client-state.v1",
          activeSession: false,
          canvasStateRevision: state.canvasStateRevision,
        });
      }

      const boards = await tx.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
        SELECT "revision"
        FROM "boards"
        WHERE "id" = ${state.boardId}
          AND "project_id" = ${projectId}
        FOR SHARE
      `);
      if (boards[0]?.revision !== state.boardRevision) {
        throw canvasRevisionProblem("The Canvas Board changed before client state synchronization");
      }
      if (sessions.some((session) => session.boardRevision !== state.boardRevision)) {
        throw canvasRevisionProblem("The active Canvas Agent session belongs to an older Board revision");
      }

      const selectedNodeIds = state.selectedScreens.map((screen) => screen.boardNodeId);
      const visibleNodeIds = state.visibleScreens.map((screen) => screen.boardNodeId);
      await this.assertClientStateReferences(
        tx,
        projectId,
        state.boardId,
        [...state.selectedScreens, ...state.visibleScreens],
      );
      let activeSessionCount = sessions.length;
      for (const session of sessions) {
        const nextState = { selectedNodeIds, visibleNodeIds, viewport: state.viewport };
        const currentState = {
          selectedNodeIds: parseIdArray(session.selectedNodeIds),
          visibleNodeIds: parseIdArray(session.visibleNodeIds),
          viewport: parseViewport(session.viewport),
        };
        const stateMatches = hashRequest(nextState) === hashRequest(currentState)
          && state.canvasStateRevision === session.canvasStateRevision;
        if (stateMatches) {
          continue;
        }
        if (state.canvasStateRevision <= session.canvasStateRevision) {
          throw canvasRevisionProblem(
            state.canvasStateRevision < session.canvasStateRevision
              ? "The browser Canvas state revision regressed"
              : "One Canvas state revision cannot describe different browser state",
          );
        }
        const command = state.causedByCommandId
          ? await tx.canvasClientCommand.findUnique({
              where: { id: state.causedByCommandId },
              include: { invocation: true },
            })
          : null;
        const parsedCommand = command ? canvasClientCommandSchema.safeParse(command.command) : null;
        const causalTransition = Boolean(
          command
          && parsedCommand?.success
          && command.agentSessionId === session.id
          && command.projectId === projectId
          && command.clientSessionId === state.clientSessionId
          && command.projectSessionGeneration === state.projectSessionGeneration
          && command.boardRevision === state.boardRevision
          && command.canvasStateRevision === session.canvasStateRevision
          && command.status === "pending"
          && command.expiresAt.getTime() > membership.databaseNow.getTime()
          && command.invocation.status === "waiting_client"
          && command.invocation.agentSessionId === session.id
          && command.invocation.canvasStateRevisionBefore === session.canvasStateRevision
          && commandAllowsCanvasStateTransition(
            parsedCommand.data,
            { ...currentState, canvasStateRevision: session.canvasStateRevision },
            { ...nextState, canvasStateRevision: state.canvasStateRevision },
          )
        );
        if (!causalTransition) {
          await this.revokeGrantForUncausedClientState(tx, session.id, membership.databaseNow);
          activeSessionCount -= 1;
          continue;
        }
        const updated = await tx.canvasAgentSession.updateMany({
          where: {
            id: session.id,
            status: "active",
            canvasStateRevision: session.canvasStateRevision,
          },
          data: {
            canvasStateRevision: state.canvasStateRevision,
            selectedNodeIds: selectedNodeIds as unknown as Prisma.InputJsonValue,
            visibleNodeIds: visibleNodeIds as unknown as Prisma.InputJsonValue,
            viewport: state.viewport as unknown as Prisma.InputJsonValue,
          },
        });
        if (updated.count !== 1) {
          throw canvasCommandConflictProblem("Canvas state synchronization raced with session completion");
        }
      }
      return canvasClientStateSyncResponseSchema.parse({
        protocol: "workbench.canvas-client-state.v1",
        activeSession: activeSessionCount > 0,
        canvasStateRevision: state.canvasStateRevision,
      });
    });
  }

  private async revokeGrantForUncausedClientState(
    tx: Prisma.TransactionClient,
    agentSessionId: string,
    databaseNow: Date,
  ): Promise<void> {
    const revoked = await tx.canvasToolGrant.updateMany({
      where: { agentSessionId, revokedAt: null },
      data: { revokedAt: databaseNow },
    });
    if (revoked.count !== 1) {
      throw canvasCommandConflictProblem("Canvas state revocation raced with grant completion");
    }
  }

  async listCommands(
    principalId: string,
    projectId: string,
    clientSessionId: string | undefined,
    projectSessionGeneration: number | undefined,
    after: string | undefined,
    requestedLimit: number | undefined,
  ) {
    if (!clientSessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(clientSessionId)) {
      throw validationProblem("clientSessionId is required and must be a valid Canvas client session id");
    }
    if (!projectSessionGeneration || !Number.isSafeInteger(projectSessionGeneration)) {
      throw validationProblem("projectSessionGeneration is required");
    }
    const limit = Math.min(Math.max(requestedLimit ?? 100, 1), 100);
    const cursor = after ? decodeCommandCursor(after) : null;
    return this.db.$transaction(async (tx) => {
      const membership = await this.lockActiveProjectMembership(tx, principalId, projectId);
      const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT session."id"
        FROM "canvas_agent_sessions" AS session
        JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."agent_session_id" = session."id"
        WHERE session."principal_id" = ${principalId}
          AND session."project_id" = ${projectId}
          AND session."client_session_id" = ${clientSessionId}
          AND session."project_session_generation" = ${projectSessionGeneration}
          AND session."status" = 'active'
          AND session."expires_at" > ${membership.databaseNow}
          AND tool_grant."revoked_at" IS NULL
          AND tool_grant."expires_at" > ${membership.databaseNow}
        ORDER BY session."id" ASC
        FOR SHARE OF session, tool_grant
      `);
      const rows = sessions.length === 0
        ? []
        : await tx.canvasClientCommand.findMany({
            where: {
              projectId,
              clientSessionId,
              projectSessionGeneration,
              agentSessionId: { in: sessions.map((session) => session.id) },
              status: "pending",
              expiresAt: { gt: membership.databaseNow },
              ...(cursor ? {
                OR: [
                  { createdAt: { gt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                ],
              } : {}),
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: limit + 1,
          });
      const hasNextPage = rows.length > limit;
      const page = hasNextPage ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      return {
        items: page.map((row) => canvasClientCommandSchema.parse(row.command)),
        nextCursor: hasNextPage && last ? encodeCommandCursor(last.createdAt, last.id) : null,
      };
    });
  }

  private async assertClientStateReferences(
    tx: Prisma.TransactionClient,
    projectId: string,
    boardId: string,
    references: CanvasScreenReference[],
  ) {
    const byNodeKey = new Map<string, CanvasScreenReference>();
    for (const reference of references) {
      const existing = byNodeKey.get(reference.boardNodeId);
      if (existing && !sameReference(existing, reference)) {
        throw canvasToolValidationProblem(
          "CANVAS_STATE_REFERENCE_INVALID",
          "One Board node cannot identify multiple Canvas screens",
        );
      }
      byNodeKey.set(reference.boardNodeId, reference);
    }
    if (byNodeKey.size === 0) return;

    const nodes = await tx.boardNode.findMany({
      where: {
        boardId,
        projectId,
        nodeKey: { in: [...byNodeKey.keys()] },
      },
    });
    const versionIds = [...new Set(nodes.flatMap((node) => (
      node.artifactVersionId ? [node.artifactVersionId] : []
    )))];
    const versions = await tx.artifactVersion.findMany({
      where: { projectId, id: { in: versionIds }, status: "ready" },
      include: { artifact: true },
    });
    const versionById = new Map(versions.map((version) => [version.id, version]));
    const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
    for (const reference of byNodeKey.values()) {
      const node = nodeByKey.get(reference.boardNodeId);
      const nodeData = node ? boardNodeDataSchema.safeParse(node.data) : null;
      const version = node?.artifactVersionId
        ? versionById.get(node.artifactVersionId)
        : null;
      const document = version && version.contentBlobId === null
        ? prototypeDocumentSchema.safeParse(version.content)
        : null;
      if (
        !node
        || node.kind !== "artifact"
        || node.artifactId !== reference.artifactId
        || node.artifactVersionId !== reference.artifactVersionId
        || !nodeData?.success
        || nodeData.data.nodeType !== "artifact"
        || nodeData.data.screenId !== reference.screenId
        || !version
        || version.artifactId !== reference.artifactId
        || version.artifact.kind !== "prototype"
        || !document?.success
        || !document.data.screens.some((screen) => screen.id === reference.screenId)
      ) {
        throw canvasToolValidationProblem(
          "CANVAS_STATE_REFERENCE_INVALID",
          "The synchronized Canvas state contains a screen outside the current Board",
          409,
        );
      }
    }
  }

  private async lockActiveProjectMembership(
    tx: Prisma.TransactionClient,
    principalId: string,
    projectId: string,
  ): Promise<LockedProjectMembership> {
    const identities = await tx.$queryRaw<Array<{
      databaseNow: Date;
      principalStatus: string;
      projectStatus: string;
    }>>(Prisma.sql`
      SELECT
        CURRENT_TIMESTAMP AS "databaseNow",
        project."status"::TEXT AS "projectStatus",
        principal."status"::TEXT AS "principalStatus"
      FROM "projects" AS project
      JOIN "principals" AS principal
        ON principal."id" = ${principalId}
      WHERE project."id" = ${projectId}
      FOR SHARE OF project, principal
    `);
    const identity = identities[0];
    if (
      !identity
      || identity.projectStatus !== "active"
      || identity.principalStatus !== "active"
    ) {
      throw canvasScopeProblem("The authenticated principal is not an active member of this Project");
    }

    const memberships = await tx.$queryRaw<Array<{ role: string }>>(Prisma.sql`
      SELECT "role"::TEXT AS "role"
      FROM "project_members"
      WHERE "project_id" = ${projectId}
        AND "principal_id" = ${principalId}
      FOR SHARE
    `);
    const membership = memberships[0];
    if (!membership) {
      throw canvasScopeProblem("The authenticated principal is not an active member of this Project");
    }
    return { databaseNow: identity.databaseNow, role: membership.role };
  }

  private verifyGrant(authorization: string | undefined): CanvasToolCapabilityGrantPayload {
    if (!this.config.grantSecret) throw canvasUnavailableProblem();
    const token = bearerToken(authorization);
    try {
      return verifyCanvasToolCapabilityGrant(token, this.config.grantSecret, {
        maximumTtlSeconds: this.config.grantMaximumTtlSeconds,
      });
    } catch (error) {
      if (error instanceof CanvasToolCapabilityGrantError) throw canvasUnauthorizedProblem();
      throw error;
    }
  }

  private async normalizeInvocationRequest(
    grant: CanvasToolCapabilityGrantPayload,
    request: CanvasAgentToolInvocation,
  ): Promise<CanvasAgentToolRequest> {
    const wire = canvasAgentToolInvocationSchema.parse(request);
    const session = await this.db.canvasAgentSession.findUnique({ where: { id: grant.agentSessionId } });
    if (!session) throw canvasScopeProblem("Canvas Agent session was not found");
    const requestDigest = createHash("sha256")
      .update(`workbench.canvas-agent-request.v1\u0000${wire.toolCallId}`)
      .digest("hex");
    const profile = canvasAgentToolProfiles[wire.toolName];
    return canvasAgentToolRequestSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      context: {
        protocol: "workbench.canvas-agent-tool.v1",
        principalId: grant.principalId,
        projectId: grant.projectId,
        threadId: grant.threadId,
        runId: grant.runId,
        runtimeAttemptId: grant.runtimeAttemptId,
        agentSessionId: grant.agentSessionId,
        toolCallId: wire.toolCallId,
        requestId: `canvas-request-${requestDigest.slice(0, 48)}`,
        traceId: `canvas-trace-${requestDigest.slice(0, 48)}`,
        clientSessionId: session.clientSessionId,
        projectSessionGeneration: session.projectSessionGeneration,
        boardId: session.boardId,
        boardRevision: session.boardRevision,
        canvasStateRevision: session.canvasStateRevision,
        declarationSha256: session.declarationHash,
        capabilities: profile.requiredCapabilities,
      },
      toolName: wire.toolName,
      input: wire.input,
    });
  }

  private async authorizeScope(
    grant: CanvasToolCapabilityGrantPayload,
    request: CanvasAgentToolRequest,
  ): Promise<AuthorizedScope> {
    const context = request.context;
    if (
      grant.principalId !== context.principalId
      || grant.projectId !== context.projectId
      || grant.threadId !== context.threadId
      || grant.runId !== context.runId
      || grant.runtimeAttemptId !== context.runtimeAttemptId
      || grant.agentSessionId !== context.agentSessionId
      || grant.boardId !== context.boardId
      || grant.declarationSha256 !== context.declarationSha256
    ) {
      throw canvasUnauthorizedProblem();
    }
    const session = await this.db.canvasAgentSession.findUnique({
      where: { id: context.agentSessionId },
      include: { grant: true },
    });
    if (!session) throw canvasScopeProblem("Canvas Agent session was not found");
    this.assertGrantSession(grant, session);
    if (
      session.projectSessionGeneration !== context.projectSessionGeneration
      || session.boardRevision !== context.boardRevision
      || session.canvasStateRevision !== context.canvasStateRevision
      || session.clientSessionId !== context.clientSessionId
      || session.status !== "active"
      || session.expiresAt.getTime() <= Date.now()
    ) {
      throw canvasRevisionProblem("The Canvas Agent snapshot is stale or the project session changed");
    }
    const membership = await this.db.projectMember.findUnique({
      where: {
        projectId_principalId: {
          projectId: session.projectId,
          principalId: session.principalId,
        },
      },
      include: { project: true, principal: true },
    });
    if (!membership || membership.project.status !== "active" || membership.principal.status !== "active") {
      throw canvasScopeProblem();
    }
    const declaredTools = parseDeclaredTools(session.declaredTools);
    if (!declaredTools.includes(request.toolName)) {
      throw canvasReadonlyProblem();
    }
    const profile = canvasAgentToolProfiles[request.toolName];
    if (!profile.requiredCapabilities.every((capability) => context.capabilities.includes(capability))) {
      throw canvasReadonlyProblem();
    }
    if (
      canvasToolEffectRequiresWriteAccess(profile.effect)
      && (session.profile === "read" || membership.role === "viewer")
    ) throw canvasReadonlyProblem();
    if (
      profile.blockedByActiveMutation
      && session.activeMutationToolCallId !== null
      && session.activeMutationToolCallId !== request.context.toolCallId
    ) {
      throw canvasInvocationConflictProblem("Another Canvas mutation is active for this session");
    }
    const board = await this.db.board.findUnique({
      where: { id: session.boardId, projectId: session.projectId },
      include: { nodes: true, edges: true },
    });
    if (!board) throw canvasScopeProblem("The Canvas Board was not found");
    if (board.revision !== context.boardRevision) throw canvasRevisionProblem();
    const boardRow = board as unknown as BoardRow;
    const projected = await this.projectSnapshot(session, boardRow);
    if (projected.snapshot.boardRevision !== context.boardRevision) throw canvasRevisionProblem();
    if (projected.snapshot.canvasStateRevision !== context.canvasStateRevision) throw canvasRevisionProblem();
    await this.assertCurrentCanvasStateLineage(
      grant,
      session as unknown as SessionRow,
      projected.snapshot,
      request.context.toolCallId,
    );
    if (
      (profile.requiresExistingScreen && projected.screens.size === 0)
      || (profile.requiresSingleEditableSelection && projected.snapshot.selectedScreens.length !== 1)
    ) {
      throw canvasToolValidationProblem("CANVAS_TARGET_UNAVAILABLE", "The requested Canvas tool requires an available editable screen", 409);
    }
    return { grant, session: session as unknown as SessionRow, board: boardRow, ...projected };
  }

  private assertGrantSession(grant: CanvasToolCapabilityGrantPayload, session: {
    id: string;
    runtimeAttemptId: string;
    runId: string;
    projectId: string;
    threadId: string;
    principalId: string;
    boardId: string;
    profile: string;
    declarationHash?: string;
    snapshotSha256?: string;
    boardRevision: number;
    canvasStateRevision: number;
    selectedNodeIds: Prisma.JsonValue;
    visibleNodeIds: Prisma.JsonValue;
    viewport: Prisma.JsonValue;
    grant?: {
      id: string;
      payloadSha256: string;
      declarationHash?: string;
      snapshotSha256?: string;
      expiresAt: Date;
      revokedAt: Date | null;
    } | null;
  }, now = new Date()) {
    if (
      session.id !== grant.agentSessionId
      || session.runtimeAttemptId !== grant.runtimeAttemptId
      || session.runId !== grant.runId
      || session.projectId !== grant.projectId
      || session.threadId !== grant.threadId
      || session.principalId !== grant.principalId
      || session.boardId !== grant.boardId
    ) throw canvasUnauthorizedProblem();
    if (session.declarationHash && session.declarationHash !== grant.declarationSha256) throw canvasUnauthorizedProblem();
    // Mutable Canvas state may advance only through an ACK-verified command.
    // The immutable grant remains bound to the original complete snapshot;
    // its persisted payload hash proves every original state hash without
    // incorrectly requiring the current causal successor to equal that state.
    if (
      session.snapshotSha256 !== grant.snapshotSha256
      || session.boardRevision !== grant.boardRevision
      || session.profile !== grant.profile
    ) throw canvasUnauthorizedProblem();
    if (!session.grant) throw canvasUnauthorizedProblem();
    if (
      session.grant.id !== grant.grantId
      || session.grant.payloadSha256 !== canvasToolCapabilityGrantPayloadSha256(grant)
      || (session.grant.declarationHash !== undefined && session.grant.declarationHash !== grant.declarationSha256)
      || (
        session.snapshotSha256 !== undefined
        && session.grant.snapshotSha256 !== undefined
        && session.snapshotSha256 !== session.grant.snapshotSha256
      )
      || session.grant.revokedAt !== null
      || session.grant.expiresAt.getTime() <= now.getTime()
    ) throw canvasUnauthorizedProblem();
  }

  private assertGrantSnapshot(
    grant: CanvasToolCapabilityGrantPayload,
    state: {
      snapshotSha256?: string;
      boardRevision: number;
      canvasStateRevision: number;
      viewport: Prisma.JsonValue;
      selectedNodeIds: Prisma.JsonValue;
      visibleNodeIds: Prisma.JsonValue;
      profile: string;
    },
  ): void {
    if (!this.grantMatchesCanvasState(grant, state)) throw canvasUnauthorizedProblem();
  }

  private grantMatchesCanvasState(
    grant: CanvasToolCapabilityGrantPayload,
    state: {
      snapshotSha256?: string;
      boardRevision: number;
      canvasStateRevision: number;
      viewport: Prisma.JsonValue;
      selectedNodeIds: Prisma.JsonValue;
      visibleNodeIds: Prisma.JsonValue;
      profile: string;
    },
  ): boolean {
    return !(
      state.snapshotSha256 !== grant.snapshotSha256
      || state.boardRevision !== grant.boardRevision
      || state.canvasStateRevision !== grant.canvasStateRevision
      || canvasToolPayloadSha256(state.viewport) !== grant.viewportSha256
      || canvasToolPayloadSha256(state.selectedNodeIds) !== grant.selectedNodeIdsSha256
      || canvasToolPayloadSha256(state.visibleNodeIds) !== grant.visibleNodeIdsSha256
      || state.profile !== grant.profile
    );
  }

  private async assertCurrentCanvasStateLineage(
    grant: CanvasToolCapabilityGrantPayload,
    session: SessionRow,
    snapshot: CanvasSnapshot,
    toolCallId: string,
  ): Promise<void> {
    if (this.grantMatchesCanvasState(grant, session)) return;
    const digest = canonicalCanvasStateSha256(snapshot);
    const lineage = await this.db.canvasToolInvocation.findFirst({
      where: {
        agentSessionId: session.id,
        OR: [
          {
            status: "succeeded",
            toolName: { in: [...clientCommandToolNames] },
            canvasStateRevisionAfter: session.canvasStateRevision,
            canvasStateSha256After: digest,
          },
          {
            status: "waiting_client",
            toolCallId,
            canvasStateRevisionBefore: { lt: session.canvasStateRevision },
            clientCommand: { is: { status: "pending" } },
          },
        ],
      },
      select: { id: true },
    });
    if (!lineage) {
      throw canvasRevisionProblem("The current Canvas state has no acknowledged command lineage");
    }
  }

  private async projectSnapshot(
    session: SessionRow,
    board: BoardRow,
    client: CanvasProjectionClient = this.db,
  ): Promise<{
    snapshot: CanvasSnapshot;
    screens: Map<string, ScreenRecord>;
  }> {
    const refs = board.nodes.filter((node) => node.kind === "artifact" && node.artifactId && node.artifactVersionId);
    const versionIds = [...new Set(refs.map((node) => node.artifactVersionId!))];
    const versions = versionIds.length
      ? await client.artifactVersion.findMany({
          where: { projectId: board.projectId, id: { in: versionIds }, status: "ready" },
          include: { artifact: true },
        })
      : [];
    const versionById = new Map(versions.map((version) => [version.id, version]));
    const screens = new Map<string, ScreenRecord>();
    for (const node of refs) {
      const dataResult = boardNodeDataSchema.safeParse(node.data);
      if (!dataResult.success || dataResult.data.nodeType !== "artifact" || !dataResult.data.screenId) continue;
      const screenId = dataResult.data.screenId;
      const version = versionById.get(node.artifactVersionId!);
      if (!version || version.artifact.kind !== "prototype" || version.contentBlobId !== null) continue;
      const documentResult = prototypeDocumentSchema.safeParse(version.content);
      if (!documentResult.success) continue;
      const screen = documentResult.data.screens.find((candidate) => candidate.id === screenId);
      if (!screen) continue;
      const reference: CanvasScreenReference = {
        boardNodeId: node.nodeKey,
        artifactId: node.artifactId!,
        artifactVersionId: node.artifactVersionId!,
        screenId: screen.id,
      };
      const summary: CanvasScreenSummary = {
        reference,
        name: screen.name,
        route: screen.route,
        phase: "complete",
        viewport: screen.viewport,
      };
      screens.set(node.nodeKey, { node, reference, summary, document: documentResult.data, screen });
    }
    const viewport = parseViewport(session.viewport);
    const visibleNodeIds = parseIdArray(session.visibleNodeIds);
    const selectedNodeIds = parseIdArray(session.selectedNodeIds);
    const resolveNode = (nodeKey: string) => screens.get(nodeKey);
    const visibleScreens = visibleNodeIds.flatMap((nodeKey) => resolveNode(nodeKey)?.reference ?? []);
    const selectedScreens = selectedNodeIds.flatMap((nodeKey) => resolveNode(nodeKey)?.reference ?? []);
    const capturedAt = new Date();
    const orderedScreens = [...screens.values()].sort((left, right) => (
      screenReferenceKey(left.reference).localeCompare(screenReferenceKey(right.reference))
    ));
    const snapshot = canvasSnapshotSchema.parse({
      protocol: "workbench.canvas-snapshot.v1",
      projectId: session.projectId,
      threadId: session.threadId,
      runId: session.runId,
      boardId: board.id,
      clientSessionId: session.clientSessionId,
      projectSessionGeneration: session.projectSessionGeneration,
      boardRevision: board.revision,
      canvasStateRevision: session.canvasStateRevision,
      capturedAt: capturedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      viewport,
      screens: orderedScreens.map((entry) => entry.summary),
      visibleScreens,
      selectedScreens,
    });
    return { snapshot, screens };
  }

  private async reserveInvocation(
    scope: AuthorizedScope,
    request: CanvasAgentToolRequest,
    requestHash: string,
    idempotencyKey: string | undefined,
  ): Promise<{ kind: "new"; invocation: InvocationRow } | { kind: "replay"; result: CanvasAgentToolResult }> {
    if (idempotencyKey !== undefined) validateIdempotencyKey(idempotencyKey);
    // Worker wrappers derive the HTTP Idempotency-Key from toolCallId.  The
    // durable uniqueness authority remains (agentSessionId, toolCallId), so a
    // header mismatch never changes the replay identity.
    const target = targetFromRequest(request);
    const lease = this.newInvocationLease();
    const profile = canvasAgentToolProfiles[request.toolName];
    const canvasStateSha256Before = canonicalCanvasStateSha256(scope.snapshot);
    return this.db.$transaction(async (tx) => {
      // Keep Project authorization ahead of Canvas and Board locks. Project
      // membership mutations lock the Project first, while Run finalization
      // locks the Run before its Canvas session.
      const membership = await this.lockActiveProjectMembership(
        tx,
        scope.session.principalId,
        scope.session.projectId,
      );
      if (
        canvasToolEffectRequiresWriteAccess(profile.effect)
        && (scope.session.profile === "read" || membership.role === "viewer")
      ) throw canvasReadonlyProblem();

      const locked = await tx.$queryRaw<Array<{
        status: string;
        activeMutationToolCallId: string | null;
        expiresAt: Date;
        boardRevision: number;
        canvasStateRevision: number;
        selectedNodeIds: Prisma.JsonValue;
        visibleNodeIds: Prisma.JsonValue;
        viewport: Prisma.JsonValue;
        waitingClientToolCallId: string | null;
        grantId: string;
        grantPayloadSha256: string;
        grantRevokedAt: Date | null;
        grantExpiresAt: Date;
      }>>(Prisma.sql`
        SELECT
          session."status"::TEXT AS "status",
          session."active_mutation_tool_call_id" AS "activeMutationToolCallId",
          session."expires_at" AS "expiresAt",
          session."board_revision" AS "boardRevision",
          session."canvas_state_revision" AS "canvasStateRevision",
          session."selected_node_ids" AS "selectedNodeIds",
          session."visible_node_ids" AS "visibleNodeIds",
          session."viewport" AS "viewport",
          (
            SELECT pending."tool_call_id"
            FROM "canvas_tool_invocations" AS pending
            WHERE pending."agent_session_id" = session."id"
              AND pending."status" = 'waiting_client'
            ORDER BY pending."sequence" ASC
            LIMIT 1
          ) AS "waitingClientToolCallId",
          tool_grant."id" AS "grantId",
          tool_grant."payload_sha256" AS "grantPayloadSha256",
          tool_grant."revoked_at" AS "grantRevokedAt",
          tool_grant."expires_at" AS "grantExpiresAt"
        FROM "canvas_agent_sessions" AS session
        JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."agent_session_id" = session."id"
        WHERE session."id" = ${scope.session.id}
        FOR UPDATE OF session, tool_grant
      `);
      const lockedSession = locked[0];
      const now = membership.databaseNow.getTime();
      if (
        !lockedSession
        || lockedSession.status !== "active"
        || lockedSession.expiresAt.getTime() <= now
        || lockedSession.grantId !== scope.grant.grantId
        || lockedSession.grantPayloadSha256 !== canvasToolCapabilityGrantPayloadSha256(scope.grant)
        || lockedSession.grantRevokedAt !== null
        || lockedSession.grantExpiresAt.getTime() <= now
      ) {
        throw canvasScopeProblem();
      }
      const boards = await tx.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
        SELECT "revision"
        FROM "boards"
        WHERE "id" = ${scope.board.id}
          AND "project_id" = ${scope.session.projectId}
        FOR SHARE
      `);
      if (
        boards[0]?.revision !== scope.board.revision
        || lockedSession.boardRevision !== scope.session.boardRevision
        || lockedSession.canvasStateRevision !== scope.session.canvasStateRevision
        || hashRequest(lockedSession.selectedNodeIds) !== hashRequest(scope.session.selectedNodeIds)
        || hashRequest(lockedSession.visibleNodeIds) !== hashRequest(scope.session.visibleNodeIds)
        || hashRequest(lockedSession.viewport) !== hashRequest(scope.session.viewport)
      ) {
        throw canvasRevisionProblem("The Canvas snapshot changed before the tool invocation was reserved");
      }
      const existing = await tx.canvasToolInvocation.findUnique({
        where: { agentSessionId_toolCallId: { agentSessionId: scope.session.id, toolCallId: request.context.toolCallId } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) throw canvasInvocationConflictProblem("toolCallId was reused with a different request");
        const replay = await this.replayInvocation(tx, existing as unknown as InvocationRow, request);
        if (replay) return { kind: "replay" as const, result: replay };
        if (existing.status !== "in_flight" || !existing.leaseToken || !existing.leaseExpiresAt) {
          throw canvasInvocationConflictProblem("Canvas invocation is not in a recoverable state");
        }
        // A repeated, byte-identical toolCall transfers the lease immediately.
        // Every effect commits through a lease-token CAS, so the prior owner is
        // fenced even when it is still running after its response channel died.
        const transferred = await tx.canvasToolInvocation.updateMany({
          where: {
            id: existing.id,
            status: "in_flight",
            leaseToken: existing.leaseToken,
          },
          data: {
            executionAttempt: { increment: 1 },
            leaseToken: lease.token,
            leaseExpiresAt: lease.expiresAt,
          },
        });
        if (transferred.count !== 1) {
          const latest = await tx.canvasToolInvocation.findUnique({ where: { id: existing.id } });
          if (latest) {
            const settled = await this.replayInvocation(tx, latest as unknown as InvocationRow, request);
            if (settled) return { kind: "replay" as const, result: settled };
          }
          throw canvasInvocationConflictProblem("Canvas invocation lease changed concurrently");
        }
        return {
          kind: "new" as const,
          invocation: {
            ...existing,
            executionAttempt: existing.executionAttempt + 1,
            leaseToken: lease.token,
            leaseExpiresAt: lease.expiresAt,
          } as unknown as InvocationRow,
        };
      }
      if (
        lockedSession.waitingClientToolCallId
        && lockedSession.waitingClientToolCallId !== request.context.toolCallId
      ) {
        throw canvasInvocationConflictProblem("A Canvas client command is still waiting for acknowledgement");
      }
      if (
        mutationToolNames.has(request.toolName)
        && lockedSession.activeMutationToolCallId !== null
        && lockedSession.activeMutationToolCallId !== request.context.toolCallId
      ) {
        throw canvasInvocationConflictProblem("Another Canvas mutation is active for this session");
      }
      const sequencedSession = await tx.canvasAgentSession.update({
        where: { id: scope.session.id },
        data: {
          invocationSequence: { increment: 1 },
          ...(mutationToolNames.has(request.toolName)
            ? { activeMutationToolCallId: request.context.toolCallId }
            : {}),
        },
        select: { invocationSequence: true },
      });
      const created = await tx.canvasToolInvocation.create({
        data: {
          id: randomUUID(),
          agentSessionId: scope.session.id,
          grantId: scope.grant.grantId,
          runId: scope.session.runId,
          projectId: scope.session.projectId,
          principalId: scope.grant.principalId,
          toolCallId: request.context.toolCallId,
          toolName: request.toolName,
          sequence: sequencedSession.invocationSequence,
          requestHash,
          request: request as unknown as Prisma.InputJsonValue,
          leaseToken: lease.token,
          leaseExpiresAt: lease.expiresAt,
          boardRevisionBefore: scope.board.revision,
          canvasStateRevisionBefore: scope.session.canvasStateRevision,
          canvasStateSha256Before,
          ...(target ? {
            targetBoardNodeId: target.boardNodeId,
            targetArtifactId: target.artifactId,
            targetArtifactVersionId: target.artifactVersionId,
            targetScreenId: target.screenId,
          } : {}),
        },
      });
      return { kind: "new" as const, invocation: created as unknown as InvocationRow };
    });
  }

  private newInvocationLease(now = new Date()) {
    return {
      token: randomUUID(),
      expiresAt: new Date(now.getTime() + this.config.invocationLeaseSeconds * 1_000),
    };
  }

  private async replayInvocation(
    tx: Prisma.TransactionClient,
    invocation: InvocationRow,
    request: CanvasAgentToolRequest,
  ): Promise<CanvasAgentToolResult | null> {
    if (terminalInvocationStatuses.has(invocation.status) && invocation.response !== null) {
      return canvasAgentToolResultSchema.parse(invocation.response);
    }
    if (invocation.status === "waiting_client") {
      const command = await tx.canvasClientCommand.findUnique({ where: { invocationId: invocation.id } });
      if (!command) throw canvasInvocationConflictProblem("Waiting Canvas command is missing");
      if (command.status === "pending" && command.expiresAt.getTime() <= Date.now()) {
        return this.expireCommandTx(tx, { ...command, invocation }, new Date());
      }
      if (command.status !== "pending") {
        throw canvasInvocationConflictProblem("Waiting Canvas command is not pending");
      }
      const parsed = canvasClientCommandSchema.parse(command.command);
      return this.waitingClientResult(invocation, parsed.commandId);
    }
    return null;
  }

  private async issueClientCommand(
    scope: AuthorizedScope,
    invocation: InvocationRow,
    request: CanvasAgentToolRequest,
  ): Promise<CanvasAgentToolResult> {
    const commandId = randomUUID();
    await this.db.$transaction(async (tx) => {
      const membership = await this.lockActiveProjectMembership(
        tx,
        scope.session.principalId,
        scope.session.projectId,
      );
      const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT session."id"
        FROM "canvas_agent_sessions" AS session
        JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."agent_session_id" = session."id"
        WHERE session."id" = ${scope.session.id}
        FOR UPDATE OF session, tool_grant
      `);
      if (!sessions[0]) {
        throw canvasInvocationConflictProblem("Canvas session ended before command dispatch");
      }
      const session = await tx.canvasAgentSession.findUnique({
        where: { id: scope.session.id },
        include: { grant: true },
      });
      if (
        !session
        || session.status !== "active"
        || session.expiresAt.getTime() <= membership.databaseNow.getTime()
        || session.boardRevision !== scope.session.boardRevision
        || session.canvasStateRevision !== scope.session.canvasStateRevision
        || hashRequest(session.selectedNodeIds) !== hashRequest(scope.session.selectedNodeIds)
        || hashRequest(session.visibleNodeIds) !== hashRequest(scope.session.visibleNodeIds)
        || hashRequest(session.viewport) !== hashRequest(scope.session.viewport)
      ) {
        throw canvasInvocationConflictProblem("Canvas session ended before command dispatch");
      }
      this.assertGrantSession(scope.grant, session, membership.databaseNow);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "boards"
        WHERE "id" = ${scope.board.id}
          AND "project_id" = ${scope.session.projectId}
        FOR SHARE
      `);
      const board = await tx.board.findUnique({
        where: { id: scope.board.id, projectId: scope.session.projectId },
        include: { nodes: true, edges: true },
      });
      if (!board || board.revision !== scope.board.revision) {
        throw canvasRevisionProblem("The Canvas Board changed before command dispatch");
      }
      const projected = await this.projectSnapshot(
        session as unknown as SessionRow,
        board as unknown as BoardRow,
        tx,
      );
      const expectedCanvasStateSha256 = canonicalCanvasStateSha256(projected.snapshot);
      if (expectedCanvasStateSha256 !== invocation.canvasStateSha256Before) {
        throw canvasRevisionProblem("The Canvas state changed before command dispatch");
      }
      const currentScope: AuthorizedScope = {
        ...scope,
        session: session as unknown as SessionRow,
        board: board as unknown as BoardRow,
        ...projected,
      };
      const expiresAt = new Date(Math.min(
        session.expiresAt.getTime(),
        membership.databaseNow.getTime() + this.config.commandTtlSeconds * 1_000,
      ));
      const base = {
        protocol: "workbench.canvas-client-command.v1" as const,
        commandId,
        agentSessionId: session.id,
        toolCallId: request.context.toolCallId,
        requestId: request.context.requestId,
        projectId: session.projectId,
        threadId: session.threadId,
        runId: session.runId,
        boardId: board.id,
        clientSessionId: session.clientSessionId,
        projectSessionGeneration: session.projectSessionGeneration,
        boardRevision: board.revision,
        expectedCanvasStateRevision: session.canvasStateRevision,
        issuedAt: membership.databaseNow.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const visualCapabilityId = request.toolName === "view_screen" ? randomUUID() : null;
      let command: CanvasClientCommand;
      if (request.toolName === "view_screen") {
        const input = canvasAgentToolInputSchemas.view_screen.parse(request.input);
        const target = this.requireTarget(currentScope, input.target, false);
        command = canvasClientCommandSchema.parse({
          ...base,
          kind: "preview.open",
          toolName: "view_screen",
          target: input.target,
          view: { ...this.screenView(target), visualCapabilityId },
        });
      } else if (request.toolName === "select_screen") {
        const input = canvasAgentToolInputSchemas.select_screen.parse(request.input);
        input.targets.forEach((target) => this.requireTarget(currentScope, target, false));
        command = canvasClientCommandSchema.parse({
          ...base,
          kind: "selection.change",
          toolName: "select_screen",
          targets: input.targets,
          mode: input.mode,
        });
      } else if (request.toolName === "navigate_canvas") {
        const input = canvasAgentToolInputSchemas.navigate_canvas.parse(request.input);
        if (input.target.kind === "screen") this.requireTarget(currentScope, input.target.screen, false);
        command = canvasClientCommandSchema.parse({
          ...base,
          kind: "viewport.navigate",
          toolName: "navigate_canvas",
          target: input.target,
          behavior: input.behavior,
        });
      } else {
        throw canvasToolValidationProblem("CANVAS_CLIENT_TOOL_INVALID", "The requested tool is not a Canvas client command");
      }
      await tx.canvasClientCommand.create({
        data: {
          id: commandId,
          agentSessionId: scope.session.id,
          invocationId: invocation.id,
          projectId: scope.session.projectId,
          threadId: scope.session.threadId,
          runId: scope.session.runId,
          clientSessionId: scope.session.clientSessionId,
          projectSessionGeneration: scope.session.projectSessionGeneration,
          toolCallId: request.context.toolCallId,
          boardRevision: scope.board.revision,
          canvasStateRevision: scope.session.canvasStateRevision,
          expectedCanvasStateSha256,
          command: command as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
      });
      if (visualCapabilityId && request.toolName === "view_screen") {
        const input = canvasAgentToolInputSchemas.view_screen.parse(request.input);
        await tx.canvasVisualCapability.create({
          data: {
            id: visualCapabilityId,
            agentSessionId: scope.session.id,
            grantId: scope.grant.grantId,
            invocationId: invocation.id,
            commandId,
            projectId: scope.session.projectId,
            runId: scope.session.runId,
            principalId: scope.session.principalId,
            targetBoardNodeId: input.target.boardNodeId,
            targetArtifactId: input.target.artifactId,
            targetVersionId: input.target.artifactVersionId,
            targetScreenId: input.target.screenId,
            expiresAt,
          },
        });
      }
      const transitioned = await tx.canvasToolInvocation.updateMany({
        where: {
          id: invocation.id,
          status: "in_flight",
          leaseToken: invocation.leaseToken,
        },
        data: {
          status: "waiting_client",
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (transitioned.count !== 1) {
        throw canvasInvocationConflictProblem("Canvas invocation lease was transferred before command dispatch");
      }
    });
    return this.waitingClientResult(invocation, commandId);
  }

  private async executeRead(
    scope: AuthorizedScope,
    request: CanvasAgentToolRequest,
  ): Promise<unknown> {
    if (request.toolName === "get_visible_screens") {
      const limit = request.input.limit ?? 50;
      const visible = scope.snapshot.visibleScreens.flatMap((reference) => {
        const record = scope.screens.get(reference.boardNodeId);
        return record ? [record.summary] : [];
      });
      const start = request.input.cursor ? decodeCursor(request.input.cursor) : 0;
      const page = visible.slice(start, start + limit);
      return canvasGetVisibleScreensOutputSchema.parse({
        items: page,
        nextCursor: start + page.length < visible.length ? encodeCursor(start + page.length) : null,
        truncated: start + page.length < visible.length,
        viewport: scope.snapshot.viewport,
      });
    }
    const selected = scope.snapshot.selectedScreens.flatMap((reference) => {
      const record = scope.screens.get(reference.boardNodeId);
      return record ? [record.summary] : [];
    });
    return canvasGetSelectedScreensOutputSchema.parse({
      kind: selected.length === 0 ? "none" : selected.length === 1 ? "single" : "multiple",
      items: selected,
      truncated: false,
    });
  }

  private screenView(record: ScreenRecord) {
    const nodes = record.document.nodes.filter((node) => node.screenId === record.screen.id);
    const nodeIds = new Set(nodes.map((node) => node.id));
    return canvasViewScreenOutputSchema.parse({
      view: {
        screen: record.summary,
        structure: {
          nodeCount: nodes.length,
          actionCount: record.document.actions.filter((action) => nodeIds.has(action.nodeId)).length,
          stateCount: record.document.states.filter((state) => state.screenId === record.screen.id).length,
          motionCount: record.document.motions.filter((motion) => nodeIds.has(motion.nodeId)).length,
        },
        visualCapabilityId: null,
      },
    }).view;
  }

  private async executeRunIntent(
    scope: AuthorizedScope,
    invocation: InvocationRow,
    request: CanvasAgentToolRequest,
  ): Promise<CanvasAgentToolResult> {
    const input = request.toolName === "quick_edit"
      ? canvasAgentToolInputSchemas.quick_edit.parse(request.input)
      : request.toolName === "rename_screen"
        ? canvasAgentToolInputSchemas.rename_screen.parse(request.input)
        : request.toolName === "duplicate_screen"
          ? canvasAgentToolInputSchemas.duplicate_screen.parse(request.input)
          : null;
    if (!input) throw canvasToolValidationProblem("CANVAS_RUN_INTENT_INVALID", "The requested tool is not a Run intent");
    const renameTitle = request.toolName === "rename_screen"
      ? canvasAgentToolInputSchemas.rename_screen.parse(request.input).title
      : null;
    const target = this.requireTarget(scope, input.target, true);
    const runId = scope.grant.runId;
    if (runId === null) {
      throw canvasToolValidationProblem("CANVAS_RUN_REQUIRED", `${request.toolName} requires a Run-bound Canvas session`);
    }

    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "runs"
        WHERE "id" = ${runId}
          AND "project_id" = ${scope.session.projectId}
        FOR UPDATE
      `);
      const run = await tx.run.findUnique({
        where: { id: runId, projectId: scope.session.projectId },
      });
      if (!run) throw canvasScopeProblem("The Run bound to this Canvas session was not found");
      if (run.status !== "running") {
        throw canvasToolValidationProblem("CANVAS_EDIT_RUN_NOT_ACTIVE", `${request.toolName} requires the active edit Run`, 409);
      }
      const sessions = await tx.$queryRaw<Array<{
        status: string;
        activeMutationToolCallId: string | null;
        expiresAt: Date;
        canvasStateRevision: number;
        selectedNodeIds: Prisma.JsonValue;
        visibleNodeIds: Prisma.JsonValue;
      }>>(Prisma.sql`
        SELECT
          "status"::TEXT AS "status",
          "active_mutation_tool_call_id" AS "activeMutationToolCallId",
          "expires_at" AS "expiresAt",
          "canvas_state_revision" AS "canvasStateRevision",
          "selected_node_ids" AS "selectedNodeIds",
          "visible_node_ids" AS "visibleNodeIds"
        FROM "canvas_agent_sessions"
        WHERE "id" = ${scope.session.id}
        FOR UPDATE
      `);
      const session = sessions[0];
      if (
        !session
        || session.status !== "active"
        || session.activeMutationToolCallId !== request.context.toolCallId
        || session.expiresAt.getTime() <= Date.now()
        || session.canvasStateRevision !== scope.session.canvasStateRevision
        || hashRequest(session.selectedNodeIds) !== hashRequest(scope.session.selectedNodeIds)
        || hashRequest(session.visibleNodeIds) !== hashRequest(scope.session.visibleNodeIds)
      ) throw canvasInvocationConflictProblem("Canvas Run intent no longer owns the active mutation slot");
      const boards = await tx.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
        SELECT "revision"
        FROM "boards"
        WHERE "id" = ${scope.board.id}
          AND "project_id" = ${scope.session.projectId}
        FOR SHARE
      `);
      if (boards[0]?.revision !== scope.board.revision) {
        throw canvasRevisionProblem("The Canvas Board changed before the Run intent was accepted");
      }
      const parsedRun = startRunRequestSchema.safeParse(run.request);
      if (!parsedRun.success || parsedRun.data.workflow !== "edit") {
        throw canvasToolValidationProblem("CANVAS_EDIT_WORKFLOW_REQUIRED", `${request.toolName} is only available in an edit workflow`);
      }
      if (
        parsedRun.data.artifactTargets.length !== 1
        || parsedRun.data.artifactTargets[0]?.artifactId !== target.reference.artifactId
        || parsedRun.data.artifactTargets[0]?.artifactVersionId !== target.reference.artifactVersionId
        || parsedRun.data.artifactTargets[0]?.screenIds.length !== 1
        || parsedRun.data.artifactTargets[0]?.screenIds[0] !== target.reference.screenId
      ) {
        throw canvasToolValidationProblem(
          "CANVAS_EDIT_TARGET_MISMATCH",
          `${request.toolName} must target the exact single screen selected by the edit Run`,
        );
      }

      const conflictingTools = request.toolName === "quick_edit"
        ? ["rename_screen", "duplicate_screen"]
        : ["quick_edit"];
      const conflictingIntent = await tx.canvasToolInvocation.findFirst({
        where: {
          agentSessionId: scope.session.id,
          status: "succeeded",
          toolName: { in: conflictingTools },
        },
        select: { id: true },
      });
      if (conflictingIntent) {
        throw canvasInvocationConflictProblem("Canvas quick edits and structural intents cannot be mixed in one Run");
      }

      const data = request.toolName === "quick_edit"
        ? canvasQuickEditOutputSchema.parse({ runId: run.id, target: target.reference, accepted: true })
        : request.toolName === "rename_screen"
          ? canvasRenameScreenOutputSchema.parse({
              runId: run.id,
              target: target.reference,
              title: renameTitle,
              accepted: true,
            })
          : canvasDuplicateScreenOutputSchema.parse({ runId: run.id, target: target.reference, accepted: true });
      const result = canvasAgentToolResultSchema.parse({
        protocol: "workbench.canvas-agent-tool.v1",
        agentSessionId: scope.session.id,
        toolCallId: request.context.toolCallId,
        toolName: request.toolName,
        status: "succeeded",
        boardRevision: scope.board.revision,
        canvasStateRevision: scope.session.canvasStateRevision,
        responseSha256: hashRequest(data),
        data,
        failure: null,
        approvalId: null,
        clientCommandId: null,
      });
      const released = await tx.canvasAgentSession.updateMany({
        where: {
          id: scope.session.id,
          status: "active",
          activeMutationToolCallId: request.context.toolCallId,
        },
        data: { activeMutationToolCallId: null },
      });
      if (released.count !== 1) throw canvasInvocationConflictProblem();
      const settled = await tx.canvasToolInvocation.updateMany({
        where: {
          id: invocation.id,
          status: "in_flight",
          leaseToken: invocation.leaseToken,
        },
        data: {
          status: "succeeded",
          response: result as unknown as Prisma.InputJsonValue,
          satisfiesRunTarget: true,
          boardRevisionAfter: result.boardRevision,
          canvasStateRevisionAfter: result.canvasStateRevision,
          canvasStateSha256After: invocation.canvasStateSha256Before,
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (settled.count !== 1) {
        throw canvasInvocationConflictProblem("Canvas Run intent lease was transferred before acceptance");
      }
      return result;
    });
  }

  private requireTarget(scope: AuthorizedScope, target: CanvasScreenReference, editable: boolean): ScreenRecord {
    const record = scope.screens.get(target.boardNodeId);
    if (
      !record
      || record.reference.artifactId !== target.artifactId
      || record.reference.artifactVersionId !== target.artifactVersionId
      || record.reference.screenId !== target.screenId
    ) throw canvasToolValidationProblem("SCREEN_NOT_FOUND", "The screen target is not present in the current Canvas snapshot", 404);
    if (editable) {
      const selected = scope.snapshot.selectedScreens;
      if (selected.length !== 1 || !sameReference(selected[0]!, target)) {
        throw canvasToolValidationProblem("CANVAS_SELECTION_REQUIRED", "The mutation target must be the exact single selected screen", 409);
      }
    }
    return record;
  }

  private async succeedInvocation(
    scope: AuthorizedScope,
    invocation: InvocationRow,
    request: CanvasAgentToolRequest,
    data: unknown,
  ): Promise<CanvasAgentToolResult> {
    const outputSchema = canvasAgentToolOutputSchemas[request.toolName];
    const parsedData = outputSchema.parse(data);
    const result = canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: scope.session.id,
      toolCallId: request.context.toolCallId,
      toolName: request.toolName,
      status: "succeeded",
      boardRevision: scope.board.revision,
      canvasStateRevision: scope.session.canvasStateRevision,
      responseSha256: hashRequest(parsedData),
      data: parsedData,
      failure: null,
      approvalId: null,
      clientCommandId: null,
    });
    await this.db.$transaction(async (tx) => {
      if (mutationToolNames.has(request.toolName)) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "canvas_agent_sessions"
          WHERE "id" = ${scope.session.id}
          FOR UPDATE
        `);
      }
      const settled = await tx.canvasToolInvocation.updateMany({
        where: {
          id: invocation.id,
          status: "in_flight",
          leaseToken: invocation.leaseToken,
        },
        data: {
          status: "succeeded",
          response: result as unknown as Prisma.InputJsonValue,
          boardRevisionAfter: result.boardRevision,
          canvasStateRevisionAfter: result.canvasStateRevision,
          canvasStateSha256After: invocation.canvasStateSha256Before,
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (settled.count !== 1) {
        throw canvasInvocationConflictProblem("Canvas invocation lease was transferred before completion");
      }
      if (mutationToolNames.has(request.toolName)) {
        await tx.canvasAgentSession.updateMany({
          where: { id: scope.session.id, activeMutationToolCallId: request.context.toolCallId },
          data: { activeMutationToolCallId: null },
        });
      }
    });
    return result;
  }

  private async failInvocation(
    scope: AuthorizedScope,
    invocation: InvocationRow,
    request: CanvasAgentToolRequest,
    failure: { code: string; message: string; retryable: boolean },
  ): Promise<CanvasAgentToolResult> {
    const result = canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: scope.session.id,
      toolCallId: request.context.toolCallId,
      toolName: request.toolName,
      status: "failed",
      boardRevision: scope.board.revision,
      canvasStateRevision: scope.session.canvasStateRevision,
      responseSha256: hashRequest(failure),
      data: null,
      failure,
      approvalId: null,
      clientCommandId: null,
    });
    await this.db.$transaction(async (tx) => {
      if (mutationToolNames.has(request.toolName)) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "canvas_agent_sessions"
          WHERE "id" = ${scope.session.id}
          FOR UPDATE
        `);
      }
      const settled = await tx.canvasToolInvocation.updateMany({
        where: {
          id: invocation.id,
          status: "in_flight",
          leaseToken: invocation.leaseToken,
        },
        data: {
          status: "failed",
          response: result as unknown as Prisma.InputJsonValue,
          failureCode: failure.code,
          boardRevisionAfter: result.boardRevision,
          canvasStateRevisionAfter: result.canvasStateRevision,
          canvasStateSha256After: invocation.canvasStateSha256Before,
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (settled.count !== 1) {
        throw canvasInvocationConflictProblem("Canvas invocation lease was transferred before failure settlement");
      }
      if (mutationToolNames.has(request.toolName)) {
        await tx.canvasAgentSession.updateMany({
          where: { id: scope.session.id, activeMutationToolCallId: request.context.toolCallId },
          data: { activeMutationToolCallId: null },
        });
      }
    });
    return result;
  }

  private async publishVisualCapture(
    client: CanvasVisualDbClient,
    capture: NonNullable<CanvasClientCommandAckRequest["visualCapture"]>,
    binding: VisualCaptureBinding,
    allowPublication = true,
  ): Promise<VisualCapturePublication> {
    if (!capture) throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_MISSING", "A view_screen ACK must include an image capture");
    const raw = decodeBase64Capture(capture.dataBase64);
    if (raw.byteLength !== capture.byteSize || createHash("sha256").update(raw).digest("hex") !== capture.sha256) {
      throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_DIGEST_INVALID", "The Canvas visual capture digest does not match its bytes");
    }
    const normalized = await normalizeVisualCapture(raw);
    await client.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "canvas_visual_capabilities"
      WHERE "id" = ${capture.visualCapabilityId}::uuid
      FOR UPDATE
    `);
    const current = await client.canvasVisualCapability.findUnique({
      where: { id: capture.visualCapabilityId },
      select: {
        id: true,
        commandId: true,
        invocationId: true,
        agentSessionId: true,
        grantId: true,
        projectId: true,
        runId: true,
        principalId: true,
        targetBoardNodeId: true,
        targetArtifactId: true,
        targetVersionId: true,
        targetScreenId: true,
        status: true,
        storageKey: true,
        mediaType: true,
        sha256: true,
        byteSize: true,
        width: true,
        height: true,
        expiresAt: true,
        storageDeletedAt: true,
      },
    });
    if (
      !current
      || current.commandId !== binding.commandId
      || current.invocationId !== binding.invocationId
      || current.agentSessionId !== binding.agentSessionId
      || current.grantId !== binding.grantId
      || current.projectId !== binding.projectId
      || current.runId !== binding.runId
      || current.principalId !== binding.principalId
      || current.targetBoardNodeId !== binding.target.boardNodeId
      || current.targetArtifactId !== binding.target.artifactId
      || current.targetVersionId !== binding.target.artifactVersionId
      || current.targetScreenId !== binding.target.screenId
    ) {
      throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_INVALID", "The Canvas visual capture is not bound to this command");
    }
    if (current.status === "ready") {
      if (!current.storageKey || current.storageDeletedAt !== null) {
        throw canvasCommandConflictProblem("The Canvas visual capability object is no longer available");
      }
      const publication: VisualCapturePublication = {
        storageKey: current.storageKey,
        mediaType: "image/webp",
        sha256: normalized.sha256,
        byteSize: normalized.bytes.byteLength,
        width: normalized.width,
        height: normalized.height,
        createdByTransaction: false,
      };
      if (!sameVisualPublication(current, publication)) {
        throw canvasCommandConflictProblem("The Canvas visual capability already contains a different capture");
      }
      return publication;
    }
    if (
      !allowPublication
      || current.status !== "pending"
      || current.expiresAt.getTime() <= binding.databaseNow.getTime()
    ) {
      throw canvasCommandConflictProblem("The Canvas visual capability is no longer pending");
    }

    const storageKey = `canvas-visuals/${capture.visualCapabilityId}/${normalized.sha256}-${randomUUID()}.webp`;
    const publication: VisualCapturePublication = {
      storageKey,
      mediaType: "image/webp",
      sha256: normalized.sha256,
      byteSize: normalized.bytes.byteLength,
      width: normalized.width,
      height: normalized.height,
      createdByTransaction: true,
    };
    await this.visualStorage.putObject({
      key: storageKey,
      body: normalized.bytes,
      byteSize: normalized.bytes.byteLength,
      mediaType: "image/webp",
      sha256: normalized.sha256,
    });
    try {
      const updated = await client.canvasVisualCapability.updateMany({
        where: {
          id: capture.visualCapabilityId,
          status: "pending",
          commandId: binding.commandId,
          invocationId: binding.invocationId,
          agentSessionId: binding.agentSessionId,
          grantId: binding.grantId,
          projectId: binding.projectId,
          runId: binding.runId,
          principalId: binding.principalId,
          targetBoardNodeId: binding.target.boardNodeId,
          targetArtifactId: binding.target.artifactId,
          targetVersionId: binding.target.artifactVersionId,
          targetScreenId: binding.target.screenId,
          expiresAt: { gt: binding.databaseNow },
        },
        data: {
          status: "ready",
          storageKey: publication.storageKey,
          mediaType: publication.mediaType,
          sha256: publication.sha256,
          byteSize: BigInt(publication.byteSize),
          width: publication.width,
          height: publication.height,
        },
      });
      if (updated.count === 1) return publication;
    } catch (error) {
      await this.visualStorage.deleteObject(storageKey).catch(() => undefined);
      throw error;
    }
    await this.visualStorage.deleteObject(storageKey).catch(() => undefined);
    throw canvasCommandConflictProblem("The Canvas visual capability is no longer pending");
  }

  private async cleanupUncommittedVisualObject(input: {
    capabilityId: string;
    storageKey: string;
  }): Promise<void> {
    let current: { status: string; storageKey: string | null } | null;
    try {
      current = await this.db.canvasVisualCapability.findUnique({
        where: { id: input.capabilityId },
        select: { status: true, storageKey: true },
      });
    } catch {
      // An ambiguous commit must favor retaining an orphan over deleting a
      // possibly committed object. Bucket lifecycle handles abandoned keys.
      return;
    }
    if (current?.status === "ready" && current.storageKey === input.storageKey) return;
    await this.visualStorage.deleteObject(input.storageKey).catch(() => undefined);
  }

  private async assertReadyVisualCaptureTx(
    tx: Prisma.TransactionClient,
    command: CanvasClientCommand,
    invocationId: string,
    agentSessionId: string,
    projectId: string,
    grantId: string | null,
    capture: CanvasClientCommandAckRequest["visualCapture"],
    publication: VisualCapturePublication | null,
  ): Promise<void> {
    if (command.kind !== "preview.open" || !capture || capture.visualCapabilityId !== command.view.visualCapabilityId) {
      throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_INVALID", "The Canvas visual capture is not bound to this command");
    }
    const visual = await tx.canvasVisualCapability.findUnique({ where: { id: capture.visualCapabilityId } });
    if (
      !visual
      || visual.commandId !== command.commandId
      || visual.invocationId !== invocationId
      || visual.agentSessionId !== agentSessionId
      || visual.projectId !== projectId
      || visual.grantId !== grantId
      || visual.targetBoardNodeId !== command.target.boardNodeId
      || visual.targetArtifactId !== command.target.artifactId
      || visual.targetVersionId !== command.target.artifactVersionId
      || visual.targetScreenId !== command.target.screenId
      || visual.status !== "ready"
      || !visual.storageKey
      || !visual.sha256
      || visual.byteSize === null
      || visual.mediaType !== "image/webp"
    ) throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_NOT_READY", "The Canvas visual capture is not ready");
    if (publication && !sameVisualPublication(visual, publication)) {
      throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_DIGEST_INVALID", "The ready Canvas visual capture does not match the published object");
    }
  }

  private waitingClientResult(invocation: InvocationRow, commandId: string): CanvasAgentToolResult {
    return canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: invocation.agentSessionId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      status: "waiting_client",
      boardRevision: invocation.boardRevisionBefore,
      canvasStateRevision: invocation.canvasStateRevisionBefore,
      responseSha256: hashRequest({ commandId, status: "waiting_client" }),
      data: null,
      failure: null,
      approvalId: null,
      clientCommandId: commandId,
    });
  }

  private resultFromAck(invocation: InvocationRow, ack: CanvasClientCommandAck): CanvasAgentToolResult {
    const data = canvasAgentToolOutputSchemas[invocation.toolName as keyof typeof canvasAgentToolOutputSchemas].parse(ack.result);
    return canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: invocation.agentSessionId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      status: "succeeded",
      boardRevision: ack.boardRevision,
      canvasStateRevision: ack.canvasStateRevision,
      responseSha256: hashRequest(data),
      data,
      failure: null,
      approvalId: null,
      clientCommandId: null,
    });
  }

  private failedResultFromAck(invocation: InvocationRow, ack: CanvasClientCommandAck): CanvasAgentToolResult {
    if (ack.status !== "rejected") throw new Error("CANVAS_ACK_RESULT_STATUS_INVALID");
    return canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: invocation.agentSessionId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      status: "failed",
      boardRevision: ack.boardRevision,
      canvasStateRevision: ack.canvasStateRevision,
      responseSha256: hashRequest(ack.failure),
      data: null,
      failure: ack.failure,
      approvalId: null,
      clientCommandId: null,
    });
  }

  private validateClientResult(
    toolName: string,
    result: unknown,
    snapshot: CanvasSnapshot,
    screens: Map<string, ScreenRecord>,
  ): void {
    if (toolName === "view_screen") {
      const parsed = canvasViewScreenOutputSchema.parse(result);
      if (!parsed.view.visualCapabilityId) {
        throw canvasToolValidationProblem(
          "CANVAS_VISUAL_CAPTURE_REQUIRED",
          "A view_screen result must carry a server-bound visual capability",
          409,
        );
      }
      return;
    }
    if (toolName === "select_screen") {
      const parsed = canvasSelectScreenOutputSchema.parse(result);
      const selected = snapshot.selectedScreens.flatMap((reference) => {
        const record = screens.get(reference.boardNodeId);
        return record ? [record.summary] : [];
      });
      const expected = canvasSelectionSchema.parse({
        kind: selected.length === 0 ? "none" : selected.length === 1 ? "single" : "multiple",
        items: selected,
        truncated: false,
      });
      if (hashRequest(parsed.selection) !== hashRequest(expected)) {
        throw canvasToolValidationProblem(
          "CANVAS_ACK_STATE_MISMATCH",
          "The select_screen ACK does not match the synchronized Canvas selection",
          409,
        );
      }
      return;
    }
    if (toolName === "navigate_canvas") {
      const parsed = canvasNavigateCanvasOutputSchema.parse(result);
      if (hashRequest(parsed.viewport) !== hashRequest(snapshot.viewport)) {
        throw canvasToolValidationProblem(
          "CANVAS_ACK_STATE_MISMATCH",
          "The navigate_canvas ACK does not match the synchronized Canvas viewport",
          409,
        );
      }
      return;
    }
    throw canvasToolValidationProblem("CANVAS_ACK_TOOL_INVALID", "The client ACK tool is not an interactive Canvas tool");
  }

  private invocationRequestHash(request: CanvasAgentToolRequest): string {
    // Snapshot revisions and transport tracing ids are intentionally excluded:
    // a replay may arrive after the Canvas has advanced, while toolCallId and
    // the semantic input remain the durable idempotency identity.
    const {
      requestId: _requestId,
      traceId: _traceId,
      boardRevision: _boardRevision,
      canvasStateRevision: _canvasStateRevision,
      ...stableContext
    } = request.context;
    return hashRequest({ ...request, context: stableContext });
  }

  private safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
    if (error && typeof error === "object" && "getResponse" in error && typeof (error as { getResponse?: unknown }).getResponse === "function") {
      const response = (error as { getResponse: () => unknown }).getResponse();
      if (response && typeof response === "object") {
        const body = response as { code?: unknown; detail?: unknown };
        if (typeof body.code === "string" && typeof body.detail === "string") {
          return { code: body.code, message: body.detail, retryable: false };
        }
      }
    }
    return { code: "CANVAS_TOOL_FAILED", message: "The Canvas tool failed", retryable: true };
  }

  private async expireCommandTx(
    tx: Prisma.TransactionClient,
    command: {
      id: string;
      invocationId: string;
      invocation: Pick<InvocationRow,
        | "agentSessionId"
        | "boardRevisionBefore"
        | "canvasStateRevisionBefore"
        | "canvasStateSha256Before"
        | "toolCallId"
        | "toolName"
      >;
    },
    now: Date,
  ): Promise<CanvasAgentToolResult> {
    const failure = {
      code: "COMMAND_EXPIRED",
      message: "The Canvas client command has expired",
      retryable: false,
    };
    const result = canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: command.invocation.agentSessionId,
      toolCallId: command.invocation.toolCallId,
      toolName: command.invocation.toolName,
      status: "failed",
      boardRevision: command.invocation.boardRevisionBefore,
      canvasStateRevision: command.invocation.canvasStateRevisionBefore,
      responseSha256: hashRequest(failure),
      data: null,
      failure,
      approvalId: null,
      clientCommandId: null,
    });
    const commandExpired = await tx.canvasClientCommand.updateMany({
      where: { id: command.id, status: "pending" },
      data: { status: "expired" },
    });
    const invocationExpired = await tx.canvasToolInvocation.updateMany({
      where: { id: command.invocationId, status: "waiting_client" },
      data: {
        status: "failed",
        failureCode: "COMMAND_EXPIRED",
        response: result as unknown as Prisma.InputJsonValue,
        boardRevisionAfter: command.invocation.boardRevisionBefore,
        canvasStateRevisionAfter: command.invocation.canvasStateRevisionBefore,
        canvasStateSha256After: command.invocation.canvasStateSha256Before,
        completedAt: now,
      },
    });
    await tx.canvasVisualCapability.updateMany({
      where: { commandId: command.id, status: "pending" },
      data: { status: "expired", failureCode: "COMMAND_EXPIRED" },
    });
    if (commandExpired.count !== 1 || invocationExpired.count !== 1) {
      throw canvasCommandConflictProblem("Canvas command expiry raced with acknowledgement");
    }
    const session = await tx.canvasAgentSession.findUnique({
      where: { id: command.invocation.agentSessionId },
      select: { canvasStateRevision: true },
    });
    if (session && session.canvasStateRevision !== command.invocation.canvasStateRevisionBefore) {
      const revoked = await tx.canvasToolGrant.updateMany({
        where: { agentSessionId: command.invocation.agentSessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) {
        throw canvasCommandConflictProblem("Expired provisional Canvas state raced with grant revocation");
      }
    }
    return result;
  }
}

function bearerToken(value: string | undefined): string {
  if (!value || value.length > 4_103) throw canvasUnauthorizedProblem();
  const [scheme, token, extra] = value.split(" ");
  if (scheme !== "Bearer" || !token || extra !== undefined) throw canvasUnauthorizedProblem();
  return token;
}

export function canvasToolEffectRequiresWriteAccess(
  effect: "read" | "client_command" | "mutation" | "run",
): boolean {
  return effect === "mutation" || effect === "run";
}

function parseDeclaredTools(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) throw canvasScopeProblem("Canvas session tool declaration is malformed");
  return value.filter((candidate): candidate is string => typeof candidate === "string");
}

function parseIdArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is string => typeof candidate === "string");
}

function parseViewport(value: Prisma.JsonValue) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.x === "number" && typeof candidate.y === "number" && typeof candidate.zoom === "number") {
      return { x: candidate.x, y: candidate.y, zoom: candidate.zoom };
    }
  }
  return { x: 0, y: 0, zoom: 1 };
}

type CanvasMutableState = {
  canvasStateRevision: number;
  selectedNodeIds: string[];
  visibleNodeIds: string[];
  viewport: { x: number; y: number; zoom: number };
};

function commandAllowsCanvasStateTransition(
  command: CanvasClientCommand,
  current: CanvasMutableState,
  next: CanvasMutableState,
): boolean {
  if (command.expectedCanvasStateRevision !== current.canvasStateRevision) return false;
  const selectedChanged = !sameIdSet(current.selectedNodeIds, next.selectedNodeIds);
  const visibleChanged = !sameIdSet(current.visibleNodeIds, next.visibleNodeIds);
  const viewportChanged = hashRequest(current.viewport) !== hashRequest(next.viewport);
  const stateChanged = selectedChanged || visibleChanged || viewportChanged;
  if (next.canvasStateRevision !== current.canvasStateRevision + (stateChanged ? 1 : 0)) return false;

  if (command.kind === "preview.open") return !stateChanged;
  if (command.kind === "selection.change") {
    if (visibleChanged || viewportChanged) return false;
    const expected = new Set(current.selectedNodeIds);
    const targets = command.targets.map((target) => target.boardNodeId);
    if (command.mode === "replace") {
      expected.clear();
      targets.forEach((target) => expected.add(target));
    } else if (command.mode === "add") {
      targets.forEach((target) => expected.add(target));
    } else if (command.mode === "remove") {
      targets.forEach((target) => expected.delete(target));
    } else {
      targets.forEach((target) => {
        if (expected.has(target)) expected.delete(target);
        else expected.add(target);
      });
    }
    return sameIdSet([...expected], next.selectedNodeIds);
  }
  return !selectedChanged;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

function targetFromRequest(request: CanvasAgentToolRequest): CanvasScreenReference | null {
  if ("target" in request.input && request.toolName !== "navigate_canvas") return request.input.target;
  return null;
}

function sameReference(left: CanvasScreenReference, right: CanvasScreenReference): boolean {
  return left.boardNodeId === right.boardNodeId
    && left.artifactId === right.artifactId
    && left.artifactVersionId === right.artifactVersionId
    && left.screenId === right.screenId;
}

function decodeBase64Capture(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== value) {
    throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_BASE64_INVALID", "The Canvas visual capture encoding is invalid");
  }
  return bytes;
}

async function normalizeVisualCapture(input: Buffer): Promise<{
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
}> {
  const source = sharp(input, { failOn: "error", limitInputPixels: 16_000_000 });
  const metadata = await source.metadata().catch(() => null);
  if (
    !metadata
    || !metadata.width
    || !metadata.height
    || metadata.width < 1
    || metadata.height < 1
    || metadata.width > 8_192
    || metadata.height > 8_192
    || (metadata.pages ?? 1) > 1
  ) throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_FORMAT_INVALID", "The Canvas visual capture is not a supported static image");

  const attempts = [
    { width: 1_600, height: 1_600, quality: 82 },
    { width: 1_400, height: 1_400, quality: 72 },
    { width: 1_200, height: 1_200, quality: 62 },
    { width: 1_000, height: 1_000, quality: 52 },
  ];
  for (const attempt of attempts) {
    const encoded = await sharp(input, { failOn: "error", limitInputPixels: 16_000_000 })
      .rotate()
      .resize({
        width: attempt.width,
        height: attempt.height,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: attempt.quality, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    if (encoded.data.byteLength <= 1_048_576) {
      return {
        bytes: encoded.data,
        sha256: createHash("sha256").update(encoded.data).digest("hex"),
        width: encoded.info.width,
        height: encoded.info.height,
      };
    }
  }
  throw canvasToolValidationProblem("CANVAS_VISUAL_CAPTURE_TOO_LARGE", "The Canvas visual capture remains too large after bounded re-encoding");
}

function safeVisualByteSize(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > 1_048_576) {
    throw new Error("CANVAS_VISUAL_BYTE_SIZE_INVALID");
  }
  return number;
}

function sameVisualPublication(
  value: {
    storageKey: string | null;
    mediaType: string | null;
    sha256: string | null;
    byteSize: bigint | number | null;
    width: number | null;
    height: number | null;
  },
  publication: VisualCapturePublication,
): boolean {
  return value.storageKey === publication.storageKey
    && value.mediaType === publication.mediaType
    && value.sha256 === publication.sha256
    && value.byteSize !== null
    && Number(value.byteSize) === publication.byteSize
    && value.width === publication.width
    && value.height === publication.height;
}

function screenReferenceKey(reference: CanvasScreenReference): string {
  return [
    reference.boardNodeId,
    reference.artifactId,
    reference.artifactVersionId,
    reference.screenId,
  ].join("\u0000");
}

export function canonicalCanvasStateSha256(snapshotInput: CanvasSnapshot): string {
  const snapshot = canvasSnapshotSchema.parse(snapshotInput);
  const screens = [...snapshot.screens].sort((left, right) => (
    screenReferenceKey(left.reference).localeCompare(screenReferenceKey(right.reference))
  ));
  return hashRequest({
    protocol: "workbench.canvas-state-digest.v1",
    projectId: snapshot.projectId,
    threadId: snapshot.threadId,
    runId: snapshot.runId,
    boardId: snapshot.boardId,
    clientSessionId: snapshot.clientSessionId,
    projectSessionGeneration: snapshot.projectSessionGeneration,
    boardRevision: snapshot.boardRevision,
    canvasStateRevision: snapshot.canvasStateRevision,
    viewport: snapshot.viewport,
    screens,
    visibleScreens: snapshot.visibleScreens,
    selectedScreens: snapshot.selectedScreens,
  });
}

function encodeCursor(value: number): string {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): number {
  try {
    const decoded = Number(Buffer.from(value, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(decoded) || decoded < 0) throw new Error("invalid cursor");
    return decoded;
  } catch {
    throw validationProblem("The Canvas screen cursor is invalid");
  }
}

function encodeCommandCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

function decodeCommandCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error("invalid cursor");
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || !parsed.id) throw new Error("invalid cursor");
    return { createdAt, id: parsed.id };
  } catch {
    throw validationProblem("The Canvas command cursor is invalid");
  }
}

function extractSelectedNodeIds(result: unknown): string[] {
  const parsed = canvasSelectScreenOutputSchema.safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.selection.items.map((item) => item.reference.boardNodeId);
}
