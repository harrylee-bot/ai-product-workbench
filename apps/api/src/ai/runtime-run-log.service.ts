import { Injectable } from "@nestjs/common";
import { RuntimeRunStatus, UserIntent } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { summarizeText, toInputJson } from "./ai-vibe.helpers";

@Injectable()
export class RuntimeRunLogService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(input: {
    conversationId: string;
    userId: string;
    userInput: string;
  }) {
    return this.prisma.runtimeRunLog.create({
      data: {
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
