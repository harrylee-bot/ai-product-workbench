import { Injectable } from "@nestjs/common";
import { AgentName, AgentRunStatus, AgentStepStatus, Prisma, UserIntent } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { summarizeText, toInputJson } from "./ai-vibe.helpers";

@Injectable()
export class AgentRunLogService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(input: {
    projectId: string;
    conversationId: string;
    userId: string;
    userInput: string;
  }) {
    return this.prisma.agentRunLog.create({
      data: {
        projectId: input.projectId,
        conversationId: input.conversationId,
        userId: input.userId,
        status: AgentRunStatus.running,
        inputSummary: summarizeText(input.userInput),
        traceId: randomUUID(),
      },
    });
  }

  async markRunIntent(runId: string, intent: UserIntent) {
    await this.prisma.agentRunLog.update({
      where: { id: runId },
      data: { intent },
    });
  }

  async completeRun(runId: string, result: unknown, outputSummary: string) {
    const run = await this.prisma.agentRunLog.findUnique({ where: { id: runId } });
    const endedAt = new Date();

    await this.prisma.agentRunLog.update({
      where: { id: runId },
      data: {
        status: AgentRunStatus.succeeded,
        outputSummary: summarizeText(outputSummary),
        result: toInputJson(result),
        endedAt,
        durationMs: run ? endedAt.getTime() - run.startedAt.getTime() : undefined,
      },
    });
  }

  async failRun(runId: string, error: unknown) {
    const run = await this.prisma.agentRunLog.findUnique({ where: { id: runId } });
    const endedAt = new Date();

    await this.prisma.agentRunLog.update({
      where: { id: runId },
      data: {
        status: AgentRunStatus.failed,
        errorMessage: summarizeText(error instanceof Error ? error.message : "AI 执行失败"),
        endedAt,
        durationMs: run ? endedAt.getTime() - run.startedAt.getTime() : undefined,
      },
    });
  }

  async createStep(input: {
    runId: string;
    agentName: AgentName;
    inputSummary: string;
    status?: AgentStepStatus;
  }) {
    return this.prisma.agentStepLog.create({
      data: {
        runId: input.runId,
        agentName: input.agentName,
        status: input.status ?? AgentStepStatus.pending,
        inputSummary: summarizeText(input.inputSummary),
      },
    });
  }

  async startStep(stepId: string) {
    await this.prisma.agentStepLog.update({
      where: { id: stepId },
      data: {
        status: AgentStepStatus.running,
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
    const step = await this.prisma.agentStepLog.findUnique({ where: { id: stepId } });
    const endedAt = new Date();

    await this.prisma.agentStepLog.update({
      where: { id: stepId },
      data: {
        status: AgentStepStatus.succeeded,
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
    const step = await this.prisma.agentStepLog.findUnique({ where: { id: stepId } });
    const endedAt = new Date();

    await this.prisma.agentStepLog.update({
      where: { id: stepId },
      data: {
        status: AgentStepStatus.failed,
        errorMessage: summarizeText(error instanceof Error ? error.message : "Agent 执行失败"),
        endedAt,
        durationMs: step?.startedAt ? endedAt.getTime() - step.startedAt.getTime() : undefined,
      },
    });
  }

  async getRun(runId: string) {
    const run = await this.prisma.agentRunLog.findUnique({
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
        agentName: step.agentName,
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
