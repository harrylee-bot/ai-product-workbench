import { Injectable } from "@nestjs/common";
import { RuntimeStepName, RuntimeRunStatus, RuntimeStepStatus, Prisma, UserIntent } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { summarizeText, toInputJson } from "./ai-vibe.helpers";

@Injectable()
export class RuntimeRunLogService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(input: {
    projectId: string;
    conversationId: string;
    userId: string;
    userInput: string;
  }) {
    return this.prisma.runtimeRunLog.create({
      data: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        userId: input.userId,
        status: RuntimeRunStatus.running,
        inputSummary: summarizeText(input.userInput),
        traceId: randomUUID(),
      },
    });
  }

  async markRunIntent(runId: string, intent: UserIntent) {
    await this.prisma.runtimeRunLog.update({
      where: { id: runId },
      data: { intent },
    });
  }

  async completeRun(runId: string, result: unknown, outputSummary: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({ where: { id: runId } });
    const endedAt = new Date();

    const update = await this.prisma.runtimeRunLog.updateMany({
      where: { id: runId, status: RuntimeRunStatus.running },
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

  async failRun(runId: string, error: unknown) {
    const run = await this.prisma.runtimeRunLog.findUnique({ where: { id: runId } });
    const endedAt = new Date();

    const update = await this.prisma.runtimeRunLog.updateMany({
      where: { id: runId, status: RuntimeRunStatus.running },
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

  async recordStreamEvent(input: {
    runId: string;
    projectId: string;
    eventType: string;
    payload: unknown;
  }) {
    return this.prisma.vibeStreamEventLog.create({
      data: {
        runId: input.runId,
        projectId: input.projectId,
        eventType: input.eventType,
        payload: toInputJson(input.payload),
      },
    });
  }

  /**
   * @deprecated 当前在 vibe 流中未被调用（死代码）。
   *
   * 原因：DeerFlow-first 改造后，步骤进度以 step_started / step_completed / step_failed
   * 流式事件下发，并持久化到 vibe_stream_event_logs（SSE 订阅时回放）。runtimeStepLog
   * 表（agent_step_logs）的写入因此悬空。
   *
   * 未直接删除是因为：a) getRun 仍 include steps 用于静态恢复快照；b) 接线需要把
   * RuntimeStepName 枚举从旧的自研 agent 名（orchestrator/intent_agent/...）迁移为
   * DeerFlow-first 实际步骤标签（knowledge_retrieval/requirement_packaging/...），
   * 该 Postgres 枚举迁移需在 DB 可用环境下验证，暂缓。
   *
   * 待迁移完成后，在 vibe.service 的 step emit 处同步调用以填充 agent_step_logs，
   * 让已完成 run 的执行轨在静态恢复时也有结构化步骤数据。
   */
  async createStep(input: {
    runId: string;
    runtimeName: RuntimeStepName;
    inputSummary: string;
    status?: RuntimeStepStatus;
  }) {
    return this.prisma.runtimeStepLog.create({
      data: {
        runId: input.runId,
        runtimeName: input.runtimeName,
        status: input.status ?? RuntimeStepStatus.pending,
        inputSummary: summarizeText(input.inputSummary),
      },
    });
  }

  async startStep(stepId: string) {
    await this.prisma.runtimeStepLog.update({
      where: { id: stepId },
      data: {
        status: RuntimeStepStatus.running,
        startedAt: new Date(),
      },
    });
  }

  async completeStep(
    stepId: string,
    output: unknown,
    options: {
      modelCallLogId?: string;
      tokenUsage?: Prisma.InputJsonValue;
      modelName?: string;
      modelProviderId?: string;
    } = {},
  ) {
    const step = await this.prisma.runtimeStepLog.findUnique({ where: { id: stepId } });
    const endedAt = new Date();

    await this.prisma.runtimeStepLog.update({
      where: { id: stepId },
      data: {
        status: RuntimeStepStatus.succeeded,
        outputSummary: summarizeText(JSON.stringify(output)),
        modelCallLogId: options.modelCallLogId,
        tokenUsage: options.tokenUsage,
        modelName: options.modelName,
        modelProviderId: options.modelProviderId,
        endedAt,
        durationMs: step?.startedAt ? endedAt.getTime() - step.startedAt.getTime() : undefined,
      },
    });
  }

  async failStep(stepId: string, error: unknown) {
    const step = await this.prisma.runtimeStepLog.findUnique({ where: { id: stepId } });
    const endedAt = new Date();

    await this.prisma.runtimeStepLog.update({
      where: { id: stepId },
      data: {
        status: RuntimeStepStatus.failed,
        errorMessage: summarizeText(error instanceof Error ? error.message : "Runtime 执行失败"),
        endedAt,
        durationMs: step?.startedAt ? endedAt.getTime() - step.startedAt.getTime() : undefined,
      },
    });
  }

  async getRun(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      include: {
        steps: {
          orderBy: { startedAt: "asc" },
        },
      },
    });

    if (!run) return null;

    return {
      id: run.id,
      projectId: run.projectId,
      conversationId: run.conversationId,
      userId: run.userId,
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
      steps: run.steps.map((step) => ({
        id: step.id,
        runtimeName: step.runtimeName,
        status: step.status,
        inputSummary: step.inputSummary,
        outputSummary: step.outputSummary,
        modelCallLogId: step.modelCallLogId,
        modelName: step.modelName,
        tokenUsage: step.tokenUsage,
        startedAt: step.startedAt?.toISOString(),
        endedAt: step.endedAt?.toISOString(),
        durationMs: step.durationMs,
        errorMessage: step.errorMessage,
      })),
    };
  }
}
