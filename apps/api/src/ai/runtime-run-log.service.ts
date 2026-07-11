import { ConflictException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { RuntimeRunStatus, UserIntent } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { summarizeText, toInputJson } from "./ai-vibe.helpers";

@Injectable()
export class RuntimeRunLogService implements OnModuleInit {
  private readonly logger = new Logger(RuntimeRunLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.recoverExpiredRuns().catch((error) => {
      this.logger.error(`恢复过期 Agent run 失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async createRun(input: {
    conversationId: string;
    userId: string;
    userInput: string;
    requestId?: string;
  }) {
    const requestId = input.requestId?.trim() || undefined;
    if (requestId) {
      const existing = await this.prisma.runtimeRunLog.findFirst({
        where: { conversationId: input.conversationId, requestId },
      });
      if (existing) throw runConflict("RUN_REQUEST_ALREADY_EXISTS", existing);
    }

    await this.recoverExpiredRuns(input.conversationId);
    const now = new Date();
    const leaseToken = randomUUID();
    try {
      return await this.prisma.runtimeRunLog.create({
        data: {
          conversationId: input.conversationId,
          userId: input.userId,
          requestId,
          leaseToken,
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + readRunLeaseMs()),
          status: RuntimeRunStatus.running,
          inputSummary: summarizeText(input.userInput),
          traceId: randomUUID(),
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = requestId
        ? await this.prisma.runtimeRunLog.findFirst({
            where: { conversationId: input.conversationId, requestId },
          })
        : null;
      const active = existing ?? await this.prisma.runtimeRunLog.findFirst({
        where: { conversationId: input.conversationId, status: RuntimeRunStatus.running },
        orderBy: { startedAt: "desc" },
      });
      throw runConflict(existing ? "RUN_REQUEST_ALREADY_EXISTS" : "CONVERSATION_RUN_ACTIVE", active);
    }
  }

  async renewLease(runId: string, leaseToken: string) {
    const now = new Date();
    const update = await this.prisma.runtimeRunLog.updateMany({
      where: { id: runId, status: RuntimeRunStatus.running, leaseToken },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + readRunLeaseMs()),
      },
    });
    return update.count > 0;
  }

  async setExternalRunId(runId: string, leaseToken: string, externalRunId: string) {
    const update = await this.prisma.runtimeRunLog.updateMany({
      where: { id: runId, status: RuntimeRunStatus.running, leaseToken },
      data: { externalRunId },
    });
    return update.count > 0;
  }

  async markRunIntent(runId: string, intent: UserIntent) {
    await this.prisma.runtimeRunLog.update({
      where: { id: runId },
      data: { intent },
    });
  }

  async completeRun(runId: string, result: unknown, outputSummary: string, leaseToken?: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({ where: { id: runId } });
    const endedAt = new Date();

    const update = await this.prisma.runtimeRunLog.updateMany({
      where: {
        id: runId,
        status: RuntimeRunStatus.running,
        ...(leaseToken ? { leaseToken } : {}),
      },
      data: {
        status: RuntimeRunStatus.succeeded,
        outputSummary: summarizeText(outputSummary),
        result: toInputJson(result),
        endedAt,
        durationMs: run ? endedAt.getTime() - run.startedAt.getTime() : undefined,
      },
    });
    return update.count > 0;
  }

  async failRun(runId: string, error: unknown, leaseToken?: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({ where: { id: runId } });
    const endedAt = new Date();

    const update = await this.prisma.runtimeRunLog.updateMany({
      where: {
        id: runId,
        status: RuntimeRunStatus.running,
        ...(leaseToken ? { leaseToken } : {}),
      },
      data: {
        status: RuntimeRunStatus.failed,
        errorMessage: summarizeText(error instanceof Error ? error.message : "AI 执行失败"),
        endedAt,
        durationMs: run ? endedAt.getTime() - run.startedAt.getTime() : undefined,
      },
    });
    return update.count > 0;
  }

  async cancelRun(input: {
    runId: string;
    canceledBy: string;
    reason: string;
  }) {
    const run = await this.prisma.runtimeRunLog.findUnique({ where: { id: input.runId } });
    if (!run) return null;

    if (run.status !== RuntimeRunStatus.running) {
      return { changed: false, run };
    }

    const endedAt = new Date();
    const update = await this.prisma.runtimeRunLog.updateMany({
      where: { id: input.runId, status: RuntimeRunStatus.running },
      data: {
        status: RuntimeRunStatus.cancelled,
        outputSummary: summarizeText("用户已停止执行"),
        result: toInputJson({
          canceled: true,
          status: RuntimeRunStatus.cancelled,
          reason: input.reason,
          canceledBy: input.canceledBy,
          messageStatus: "not_created",
        }),
        errorMessage: null,
        endedAt,
        durationMs: endedAt.getTime() - run.startedAt.getTime(),
      },
    });

    const current = update.count > 0
      ? await this.prisma.runtimeRunLog.findUnique({ where: { id: input.runId } })
      : await this.prisma.runtimeRunLog.findUnique({ where: { id: input.runId } });

    return { changed: update.count > 0, run: current ?? run };
  }

  async cancelLatestRunningRunForConversation(input: {
    conversationId: string;
    canceledBy: string;
    reason: string;
  }) {
    const run = await this.prisma.runtimeRunLog.findFirst({
      where: {
        conversationId: input.conversationId,
        status: RuntimeRunStatus.running,
      },
      orderBy: { startedAt: "desc" },
    });

    if (!run) return null;

    return this.cancelRun({
      runId: run.id,
      canceledBy: input.canceledBy,
      reason: input.reason,
    });
  }

  async isRunCancelled(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return run?.status === RuntimeRunStatus.cancelled;
  }

  async isRunRunning(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return run?.status === RuntimeRunStatus.running;
  }

  async recoverExpiredRuns(conversationId?: string) {
    const endedAt = new Date();
    const update = await this.prisma.runtimeRunLog.updateMany({
      where: {
        status: RuntimeRunStatus.running,
        ...(conversationId ? { conversationId } : {}),
        OR: [
          { leaseExpiresAt: { lt: endedAt } },
          { leaseExpiresAt: null },
        ],
      },
      data: {
        status: RuntimeRunStatus.failed,
        errorMessage: "RUN_LEASE_EXPIRED",
        endedAt,
      },
    });
    return update?.count ?? 0;
  }

  async recordStreamEvent(input: {
    runId: string;
    conversationId: string;
    eventType: string;
    payload: unknown;
  }) {
    return this.prisma.vibeStreamEventLog.create({
      data: {
        runId: input.runId,
        conversationId: input.conversationId,
        eventType: input.eventType,
        payload: toInputJson(input.payload),
      },
    });
  }

  async getRun(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
    });

    if (!run) return null;

    return {
      id: run.id,
      conversationId: run.conversationId,
      userId: run.userId,
      requestId: run.requestId,
      heartbeatAt: run.heartbeatAt?.toISOString(),
      leaseExpiresAt: run.leaseExpiresAt?.toISOString(),
      externalRunId: run.externalRunId,
      intent: run.intent,
      status: run.status,
      inputSummary: run.inputSummary,
      outputSummary: run.outputSummary,
      result: run.result,
      errorMessage: run.errorMessage,
      traceId: run.traceId,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString(),
      durationMs: run.durationMs,
    };
  }
}

function readRunLeaseMs() {
  const parsed = Number(process.env.AGENT_RUN_LEASE_MS ?? 45_000);
  return Number.isFinite(parsed) && parsed >= 15_000 ? parsed : 45_000;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function runConflict(
  code: "RUN_REQUEST_ALREADY_EXISTS" | "CONVERSATION_RUN_ACTIVE",
  run: { id: string; status: RuntimeRunStatus } | null,
) {
  return new ConflictException({
    code,
    message: code === "RUN_REQUEST_ALREADY_EXISTS"
      ? "该请求已经提交，请刷新会话查看现有结果。"
      : "当前会话已有运行中的任务，请等待完成或先停止。",
    runId: run?.id,
    status: run?.status,
  });
}
