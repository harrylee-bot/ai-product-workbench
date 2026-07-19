import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { canvasAgentToolResultSchema } from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { hashRequest } from "../../common/idempotency.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
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
    return { expiredSessions, expiredCommands, expiredInvocationLeases };
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
      const sessions = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT session."id"
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
