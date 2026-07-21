import {
  Injectable,
  Inject,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { canvasAgentToolResultSchema } from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest } from "../../common/idempotency.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import {
  CANVAS_VISUAL_STORAGE_PORT,
  type CanvasVisualStoragePort,
} from "../../platform/object-storage/object-storage.port.js";
import { READY_OBJECT_INTEGRITY_QUARANTINE_CODE } from "../../platform/object-storage/ready-object-integrity.js";
import { CanvasAgentConfig } from "./canvas-agent.config.js";

type ActiveInvocationStatus = "in_flight" | "waiting_client" | "waiting_approval";

type InvocationCandidate = {
  id: string;
  agentSessionId: string;
  toolCallId: string;
  toolName: string;
  status: ActiveInvocationStatus;
  boardRevisionBefore: number;
  boardRevisionAfter: number | null;
  canvasStateRevisionBefore: number;
  canvasStateRevisionAfter: number | null;
};

type SessionExpiryCandidate = {
  id: string;
  failureCode: SessionFailureCode;
};

type SessionFailureCode = "GRANT_EXPIRED" | "GRANT_REVOKED" | "SESSION_EXPIRED";
type ReconciliationFailureCode = SessionFailureCode | "COMMAND_EXPIRED" | "INVOCATION_LEASE_EXPIRED";

type CommandExpiryCandidate = InvocationCandidate & {
  commandId: string;
  invocationId: string;
};

type VisualExpiryCandidate = {
  id: string;
};

type LockedVisualExpiryCandidate = {
  id: string;
  status: "pending" | "ready" | "failed" | "expired";
  storageKey: string | null;
  storageDeletedAt: Date | null;
  failureCode: string | null;
  integrityHeld: boolean;
  lifecycleFailureCode: string | null;
};

export type CanvasAgentExpiryReconciliation = {
  expiredSessions: number;
  expiredCommands: number;
  expiredInvocationLeases: number;
};

@Injectable()
export class CanvasAgentExpiryReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanvasAgentExpiryReconciler.name);
  private timer: NodeJS.Timeout | null = null;
  private currentRun: Promise<CanvasAgentExpiryReconciliation> | null = null;

  constructor(
    private readonly db: WorkbenchDbService,
    private readonly config: CanvasAgentConfig,
    @Inject(CANVAS_VISUAL_STORAGE_PORT)
    private readonly visualStorage: CanvasVisualStoragePort,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.currentRun?.catch(() => undefined);
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch((error) => this.logFailure(error));
    this.timer = setInterval(
      () => void this.runOnce().catch((error) => this.logFailure(error)),
      this.config.expiryReconciliationIntervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(): Promise<CanvasAgentExpiryReconciliation> {
    if (this.currentRun) return this.currentRun;
    const run = this.reconcile();
    this.currentRun = run;
    void run.finally(() => {
      if (this.currentRun === run) this.currentRun = null;
    }).catch(() => undefined);
    return run;
  }

  private async reconcile(): Promise<CanvasAgentExpiryReconciliation> {
    const expiredSessions = await this.reconcileExpiredSessions();
    const expiredCommands = await this.reconcileExpiredCommands();
    const expiredInvocationLeases = await this.reconcileExpiredInvocationLeases();
    await this.reconcileExpiredVisuals();
    return { expiredSessions, expiredCommands, expiredInvocationLeases };
  }

  /**
   * Visual objects are short-lived capabilities, not durable Blob references.
   * A session can be completed/revoked before the signed token expires, so the
   * object must be retired from both the database and storage.  Each candidate
   * first commits its lifecycle transition under a row lock, then deletes the
   * object, and finally records storageDeletedAt.  A failed storage delete
   * therefore cannot revive access and remains durable work for the next pass.
   * Integrity-quarantined objects are excluded: their incident is the explicit
   * retention owner until a separate forensic/GC process releases the bytes.
   */
  private async reconcileExpiredVisuals(): Promise<void> {
    const candidates = await this.db.$queryRaw<VisualExpiryCandidate[]>(Prisma.sql`
      WITH lifecycle AS (
        SELECT
          visual."id",
          visual."status"::TEXT AS "status",
          visual."storage_key" AS "storageKey",
          visual."storage_deleted_at" AS "storageDeletedAt",
          visual."failure_code" AS "failureCode",
          ${activeIntegrityHold("visual")} AS "integrityHeld",
          CASE
            WHEN visual."expires_at" <= CURRENT_TIMESTAMP THEN 'VISUAL_CAPABILITY_EXPIRED'
            WHEN session."id" IS NULL OR session."status"::TEXT <> 'active' THEN 'VISUAL_SESSION_INACTIVE'
            WHEN session."expires_at" <= CURRENT_TIMESTAMP THEN 'VISUAL_SESSION_EXPIRED'
            WHEN tool_grant."id" IS NULL OR tool_grant."revoked_at" IS NOT NULL THEN 'VISUAL_GRANT_REVOKED'
            WHEN tool_grant."expires_at" <= CURRENT_TIMESTAMP THEN 'VISUAL_GRANT_EXPIRED'
            WHEN run."id" IS NULL OR run."status"::TEXT <> 'running' THEN 'VISUAL_RUN_INACTIVE'
            WHEN project."id" IS NULL OR project."status"::TEXT <> 'active'
              OR principal."id" IS NULL OR principal."status"::TEXT <> 'active'
              OR membership."principal_id" IS NULL THEN 'VISUAL_OWNER_INACTIVE'
            ELSE NULL
          END AS "lifecycleFailureCode"
        FROM "canvas_visual_capabilities" AS visual
        LEFT JOIN "canvas_agent_sessions" AS session
          ON session."id" = visual."agent_session_id"
        LEFT JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."id" = visual."grant_id"
        LEFT JOIN "runs" AS run
          ON run."id" = visual."run_id"
         AND run."project_id" = visual."project_id"
        LEFT JOIN "projects" AS project
          ON project."id" = visual."project_id"
        LEFT JOIN "principals" AS principal
          ON principal."id" = visual."principal_id"
        LEFT JOIN "project_members" AS membership
          ON membership."project_id" = visual."project_id"
         AND membership."principal_id" = visual."principal_id"
      )
      SELECT lifecycle."id"
      FROM lifecycle
      WHERE lifecycle."storageDeletedAt" IS NULL
        AND (
          (
            lifecycle."status" = 'expired'
            OR (
              lifecycle."status" = 'failed'
              AND (
                lifecycle."failureCode" IS DISTINCT FROM ${READY_OBJECT_INTEGRITY_QUARANTINE_CODE}
                OR NOT lifecycle."integrityHeld"
              )
            )
          )
          AND lifecycle."storageKey" IS NOT NULL
          OR (
            lifecycle."status" IN ('pending', 'ready')
            AND lifecycle."lifecycleFailureCode" IS NOT NULL
          )
        )
      ORDER BY lifecycle."id" ASC
      LIMIT ${this.config.expiryReconciliationBatchSize}
    `);
    for (const candidate of candidates ?? []) {
      try {
        await this.reconcileVisual(candidate.id);
      } catch (error) {
        this.logger.error(
          `Canvas visual cleanup failed for ${candidate.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private async reconcileVisual(visualCapabilityId: string): Promise<void> {
    const visualStorage = this.visualStorage;
    const storageKey = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedVisualExpiryCandidate[]>(Prisma.sql`
        SELECT
          visual."id",
          visual."status"::TEXT AS "status",
          visual."storage_key" AS "storageKey",
          visual."storage_deleted_at" AS "storageDeletedAt",
          visual."failure_code" AS "failureCode",
          ${activeIntegrityHold("visual")} AS "integrityHeld",
          CASE
            WHEN visual."expires_at" <= CURRENT_TIMESTAMP THEN 'VISUAL_CAPABILITY_EXPIRED'
            WHEN session."id" IS NULL OR session."status"::TEXT <> 'active' THEN 'VISUAL_SESSION_INACTIVE'
            WHEN session."expires_at" <= CURRENT_TIMESTAMP THEN 'VISUAL_SESSION_EXPIRED'
            WHEN tool_grant."id" IS NULL OR tool_grant."revoked_at" IS NOT NULL THEN 'VISUAL_GRANT_REVOKED'
            WHEN tool_grant."expires_at" <= CURRENT_TIMESTAMP THEN 'VISUAL_GRANT_EXPIRED'
            WHEN run."id" IS NULL OR run."status"::TEXT <> 'running' THEN 'VISUAL_RUN_INACTIVE'
            WHEN project."id" IS NULL OR project."status"::TEXT <> 'active'
              OR principal."id" IS NULL OR principal."status"::TEXT <> 'active'
              OR membership."principal_id" IS NULL THEN 'VISUAL_OWNER_INACTIVE'
            ELSE NULL
          END AS "lifecycleFailureCode"
        FROM "canvas_visual_capabilities" AS visual
        LEFT JOIN "canvas_agent_sessions" AS session
          ON session."id" = visual."agent_session_id"
        LEFT JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."id" = visual."grant_id"
        LEFT JOIN "runs" AS run
          ON run."id" = visual."run_id"
         AND run."project_id" = visual."project_id"
        LEFT JOIN "projects" AS project
          ON project."id" = visual."project_id"
        LEFT JOIN "principals" AS principal
          ON principal."id" = visual."principal_id"
        LEFT JOIN "project_members" AS membership
          ON membership."project_id" = visual."project_id"
         AND membership."principal_id" = visual."principal_id"
        WHERE visual."id" = ${visualCapabilityId}::uuid
        FOR UPDATE OF visual
      `);
      const visual = rows[0];
      if (!visual || visual.storageDeletedAt) return null;
      if (
        visual.failureCode === READY_OBJECT_INTEGRITY_QUARANTINE_CODE
        && visual.integrityHeld
      ) return null;

      const lifecycleInvalid = visual.lifecycleFailureCode !== null;
      if (!lifecycleInvalid && visual.status !== "expired" && visual.status !== "failed") return null;

      if (lifecycleInvalid && visual.status === "pending") {
        const expired = await tx.canvasVisualCapability.updateMany({
          where: { id: visualCapabilityId, status: "pending" },
          data: { status: "expired", failureCode: visual.lifecycleFailureCode },
        });
        if (expired.count !== 1) throw new Error("CANVAS_VISUAL_EXPIRY_CONFLICT");
      } else if (lifecycleInvalid && visual.status === "ready") {
        const expired = await tx.canvasVisualCapability.updateMany({
          where: { id: visualCapabilityId, status: "ready" },
          data: { status: "expired", failureCode: visual.lifecycleFailureCode },
        });
        if (expired.count !== 1) throw new Error("CANVAS_VISUAL_EXPIRY_CONFLICT");
      }

      return visual.storageKey;
    }, { maxWait: 10_000, timeout: 30_000 });

    if (!storageKey) return;
    // Keep the lifecycle transition committed even when the object store is
    // unavailable.  storageDeletedAt remains null, making this row durable
    // work for the next pass instead of exposing a revoked capability again.
    await this.db.$transaction(async (tx) => {
      await lockReadyObjectStorageKey(tx, storageKey);
      const rows = await tx.$queryRaw<Array<{
        id: string;
        storageKey: string | null;
        storageDeletedAt: Date | null;
      }>>(Prisma.sql`
        SELECT
          "id",
          "storage_key" AS "storageKey",
          "storage_deleted_at" AS "storageDeletedAt"
        FROM "canvas_visual_capabilities"
        WHERE "id" = ${visualCapabilityId}::uuid
        FOR UPDATE
      `);
      const current = rows[0];
      if (!current || current.storageDeletedAt) return;
      if (current.storageKey !== storageKey) {
        throw new Error("CANVAS_VISUAL_STORAGE_KEY_CHANGED");
      }
      if (await hasActiveIntegrityHold(tx, storageKey)) return;

      // Keep physical deletion inside the owner-row fence. Integrity
      // recording takes the same advisory and row locks before its upsert.
      await visualStorage.deleteObject(storageKey);
      const completed = await tx.canvasVisualCapability.updateMany({
        where: {
          id: visualCapabilityId,
          storageKey,
          storageDeletedAt: null,
        },
        data: { storageDeletedAt: new Date() },
      });
      if (completed.count === 1) return;
      const completedState = await tx.canvasVisualCapability.findUnique({
        where: { id: visualCapabilityId },
        select: { storageKey: true, storageDeletedAt: true },
      });
      if (completedState?.storageKey !== storageKey || !completedState.storageDeletedAt) {
        throw new Error("CANVAS_VISUAL_STORAGE_DELETE_COMPLETION_CONFLICT");
      }
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private reconcileExpiredSessions(): Promise<number> {
    return this.db.$transaction(async (tx) => {
      // Session is the first lock in every Canvas settlement path. Keeping
      // that order prevents ACK, Run completion, and reconciliation deadlocks.
      const sessions = await tx.$queryRaw<SessionExpiryCandidate[]>(Prisma.sql`
        SELECT
          session."id",
          CASE
            WHEN tool_grant."revoked_at" IS NOT NULL THEN 'GRANT_REVOKED'
            WHEN session."expires_at" <= CURRENT_TIMESTAMP THEN 'SESSION_EXPIRED'
            ELSE 'GRANT_EXPIRED'
          END AS "failureCode"
        FROM "canvas_agent_sessions" AS session
        LEFT JOIN "canvas_tool_grants" AS tool_grant
          ON tool_grant."agent_session_id" = session."id"
        WHERE session."status" = 'active'
          AND (
            session."expires_at" <= CURRENT_TIMESTAMP
            OR tool_grant."id" IS NULL
            OR tool_grant."expires_at" <= CURRENT_TIMESTAMP
            OR tool_grant."revoked_at" IS NOT NULL
          )
        ORDER BY session."expires_at" ASC, session."id" ASC
        LIMIT ${this.config.expiryReconciliationBatchSize}
        FOR UPDATE OF session SKIP LOCKED
      `);
      if (sessions.length === 0) return 0;

      const sessionIds = sessions.map((session) => session.id);
      const expired = await tx.canvasAgentSession.updateMany({
        where: { id: { in: sessionIds }, status: "active" },
        data: { status: "expired", activeMutationToolCallId: null },
      });
      if (expired.count !== sessions.length) {
        throw new Error("CANVAS_AGENT_SESSION_EXPIRY_CONFLICT");
      }

      await tx.canvasClientCommand.updateMany({
        where: { agentSessionId: { in: sessionIds }, status: "pending" },
        data: { status: "cancelled" },
      });

      const invocations = await tx.$queryRaw<InvocationCandidate[]>(Prisma.sql`
        SELECT
          invocation."id",
          invocation."agent_session_id" AS "agentSessionId",
          invocation."tool_call_id" AS "toolCallId",
          invocation."tool_name" AS "toolName",
          invocation."status"::TEXT AS "status",
          invocation."board_revision_before" AS "boardRevisionBefore",
          invocation."board_revision_after" AS "boardRevisionAfter",
          invocation."canvas_state_revision_before" AS "canvasStateRevisionBefore",
          invocation."canvas_state_revision_after" AS "canvasStateRevisionAfter"
        FROM "canvas_tool_invocations" AS invocation
        WHERE invocation."agent_session_id" IN (${Prisma.join(sessionIds)})
          AND invocation."status" IN ('in_flight', 'waiting_client', 'waiting_approval')
        ORDER BY invocation."agent_session_id" ASC, invocation."sequence" ASC, invocation."id" ASC
        FOR UPDATE OF invocation
      `);
      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      for (const invocation of invocations) {
        const session = sessionById.get(invocation.agentSessionId);
        if (!session) throw new Error("CANVAS_AGENT_SESSION_EXPIRY_SCOPE_INVALID");
        await this.failInvocation(tx, invocation, session.failureCode);
      }
      return sessions.length;
    });
  }

  private reconcileExpiredCommands(): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const sessions = await tx.$queryRaw<Array<{
        id: string;
        canvasStateRevision: number;
        databaseNow: Date;
      }>>(Prisma.sql`
        SELECT
          session."id",
          session."canvas_state_revision" AS "canvasStateRevision",
          CURRENT_TIMESTAMP AS "databaseNow"
        FROM "canvas_agent_sessions" AS session
        WHERE EXISTS (
          SELECT 1
          FROM "canvas_client_commands" AS command
          WHERE command."agent_session_id" = session."id"
            AND command."status" = 'pending'
            AND command."expires_at" <= CURRENT_TIMESTAMP
        )
        ORDER BY session."id" ASC
        LIMIT ${this.config.expiryReconciliationBatchSize}
        FOR UPDATE OF session SKIP LOCKED
      `);
      if (sessions.length === 0) return 0;

      const sessionIds = sessions.map((session) => session.id);
      const sessionById = new Map(sessions.map((session) => [session.id, session]));
      const commands = await tx.$queryRaw<CommandExpiryCandidate[]>(Prisma.sql`
        SELECT
          command."id" AS "commandId",
          command."invocation_id" AS "invocationId",
          invocation."id",
          invocation."agent_session_id" AS "agentSessionId",
          invocation."tool_call_id" AS "toolCallId",
          invocation."tool_name" AS "toolName",
          invocation."status"::TEXT AS "status",
          invocation."board_revision_before" AS "boardRevisionBefore",
          invocation."board_revision_after" AS "boardRevisionAfter",
          invocation."canvas_state_revision_before" AS "canvasStateRevisionBefore",
          invocation."canvas_state_revision_after" AS "canvasStateRevisionAfter"
        FROM "canvas_client_commands" AS command
        JOIN "canvas_tool_invocations" AS invocation
          ON invocation."id" = command."invocation_id"
        WHERE command."agent_session_id" IN (${Prisma.join(sessionIds)})
          AND command."status" = 'pending'
          AND command."expires_at" <= CURRENT_TIMESTAMP
        ORDER BY command."expires_at" ASC, command."id" ASC
        LIMIT ${this.config.expiryReconciliationBatchSize}
        FOR UPDATE OF command, invocation SKIP LOCKED
      `);

      for (const command of commands) {
        const expired = await tx.canvasClientCommand.updateMany({
          where: { id: command.commandId, status: "pending" },
          data: { status: "expired" },
        });
        if (expired.count !== 1) throw new Error("CANVAS_CLIENT_COMMAND_EXPIRY_CONFLICT");
        if (command.status === "waiting_client") {
          await this.failInvocation(tx, command, "COMMAND_EXPIRED");
        }
        const session = sessionById.get(command.agentSessionId);
        if (!session) throw new Error("CANVAS_CLIENT_COMMAND_EXPIRY_SCOPE_INVALID");
        if (session.canvasStateRevision !== command.canvasStateRevisionBefore) {
          await tx.canvasToolGrant.updateMany({
            where: { agentSessionId: command.agentSessionId, revokedAt: null },
            data: { revokedAt: session.databaseNow },
          });
        }
      }
      return commands.length;
    });
  }

  private reconcileExpiredInvocationLeases(): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT session."id"
        FROM "canvas_agent_sessions" AS session
        WHERE EXISTS (
          SELECT 1
          FROM "canvas_tool_invocations" AS invocation
          WHERE invocation."agent_session_id" = session."id"
            AND invocation."status" = 'in_flight'
            AND invocation."lease_expires_at" <= CURRENT_TIMESTAMP
        )
        ORDER BY session."id" ASC
        LIMIT ${this.config.expiryReconciliationBatchSize}
        FOR UPDATE OF session SKIP LOCKED
      `);
      if (sessions.length === 0) return 0;

      const sessionIds = sessions.map((session) => session.id);
      const invocations = await tx.$queryRaw<InvocationCandidate[]>(Prisma.sql`
        SELECT
          invocation."id",
          invocation."agent_session_id" AS "agentSessionId",
          invocation."tool_call_id" AS "toolCallId",
          invocation."tool_name" AS "toolName",
          invocation."status"::TEXT AS "status",
          invocation."board_revision_before" AS "boardRevisionBefore",
          invocation."board_revision_after" AS "boardRevisionAfter",
          invocation."canvas_state_revision_before" AS "canvasStateRevisionBefore",
          invocation."canvas_state_revision_after" AS "canvasStateRevisionAfter"
        FROM "canvas_tool_invocations" AS invocation
        WHERE invocation."agent_session_id" IN (${Prisma.join(sessionIds)})
          AND invocation."status" = 'in_flight'
          AND invocation."lease_expires_at" <= CURRENT_TIMESTAMP
        ORDER BY invocation."lease_expires_at" ASC, invocation."id" ASC
        LIMIT ${this.config.expiryReconciliationBatchSize}
        FOR UPDATE OF invocation SKIP LOCKED
      `);

      for (const invocation of invocations) {
        await this.failInvocation(tx, invocation, "INVOCATION_LEASE_EXPIRED");
        await tx.canvasAgentSession.updateMany({
          where: {
            id: invocation.agentSessionId,
            activeMutationToolCallId: invocation.toolCallId,
          },
          data: { activeMutationToolCallId: null },
        });
      }
      return invocations.length;
    });
  }

  private async failInvocation(
    tx: Prisma.TransactionClient,
    invocation: InvocationCandidate,
    failureCode: ReconciliationFailureCode,
  ): Promise<void> {
    const failure = failureFor(failureCode);
    const boardRevision = invocation.boardRevisionAfter ?? invocation.boardRevisionBefore;
    const canvasStateRevision = invocation.canvasStateRevisionAfter
      ?? invocation.canvasStateRevisionBefore;
    const response = canvasAgentToolResultSchema.parse({
      protocol: "workbench.canvas-agent-tool.v1",
      agentSessionId: invocation.agentSessionId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      status: "failed",
      boardRevision,
      canvasStateRevision,
      responseSha256: hashRequest(failure),
      data: null,
      failure,
      approvalId: null,
      clientCommandId: null,
    });
    const failed = await tx.$executeRaw(Prisma.sql`
      UPDATE "canvas_tool_invocations"
      SET
        "status" = 'failed',
        "failure_code" = ${failureCode},
        "response" = ${JSON.stringify(response)}::jsonb,
        "board_revision_after" = ${boardRevision},
        "canvas_state_revision_after" = ${canvasStateRevision},
        "canvas_state_sha256_after" = COALESCE(
          "canvas_state_sha256_after",
          "canvas_state_sha256_before"
        ),
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${invocation.id}
        AND "status"::TEXT = ${invocation.status}
    `);
    if (failed !== 1) throw new Error("CANVAS_TOOL_INVOCATION_EXPIRY_CONFLICT");
  }

  private logFailure(error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(error.message, error.stack);
      return;
    }
    this.logger.error("Canvas Agent expiry reconciliation failed");
  }
}

function activeIntegrityHold(visualAlias: "visual") {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "ready_object_integrity_incidents" AS integrity_incident
    WHERE integrity_incident."storage_key" = ${Prisma.raw(`${visualAlias}."storage_key"`)}
      AND NOT EXISTS (
        SELECT 1
        FROM "ready_object_integrity_retention_releases" AS integrity_release
        WHERE integrity_release."incident_id" = integrity_incident."id"
          AND integrity_release."released_occurrence_count" >= integrity_incident."occurrence_count"
      )
  )`;
}

async function lockReadyObjectStorageKey(
  tx: Prisma.TransactionClient,
  storageKey: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`workbench:ready-object-integrity:v1:${storageKey}`}, 0)
    )::TEXT AS "lockReceipt"
  `);
}

async function hasActiveIntegrityHold(
  tx: Prisma.TransactionClient,
  storageKey: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ held: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "ready_object_integrity_incidents" AS integrity_incident
      WHERE integrity_incident."storage_key" = ${storageKey}
        AND NOT EXISTS (
          SELECT 1
          FROM "ready_object_integrity_retention_releases" AS integrity_release
          WHERE integrity_release."incident_id" = integrity_incident."id"
            AND integrity_release."released_occurrence_count" >= integrity_incident."occurrence_count"
        )
    ) AS "held"
  `);
  return rows[0]?.held ?? true;
}

function failureFor(code: ReconciliationFailureCode) {
  switch (code) {
    case "COMMAND_EXPIRED":
      return { code, message: "The Canvas client command expired", retryable: false };
    case "GRANT_EXPIRED":
      return { code, message: "The Canvas tool grant expired", retryable: false };
    case "GRANT_REVOKED":
      return { code, message: "The Canvas tool grant was revoked", retryable: false };
    case "INVOCATION_LEASE_EXPIRED":
      return { code, message: "The Canvas tool invocation lease expired", retryable: true };
    case "SESSION_EXPIRED":
      return { code, message: "The Canvas Agent session expired", retryable: false };
  }
}
