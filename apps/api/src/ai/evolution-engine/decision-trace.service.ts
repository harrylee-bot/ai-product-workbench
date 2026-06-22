import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Strategy } from "../decision-engine/decision.types";
import type { ReviewBoardResult } from "../review-board/review.types";

export type TraceOutcome = "success" | "failure" | "partial";

export type DecisionTraceMetrics = {
  qaPassed: boolean;
  userFeedbackScore: number;
  executionTime: number;
};

export type CreateDecisionTraceInput = {
  projectId: string;
  sourceType: string;
  sourceId?: string;
  input: string;
  intent: string;
  strategies: Strategy[];
  selectedStrategyId: string;
  reviewResult: ReviewBoardResult;
  scores: unknown;
  objections: unknown;
  output: unknown;
  createdBy: string;
};

@Injectable()
export class DecisionTraceService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: CreateDecisionTraceInput) {
    return this.prisma.decisionTrace.create({
      data: {
        projectId: input.projectId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        intent: input.intent,
        strategies: input.strategies as unknown as Prisma.InputJsonValue,
        selectedStrategy: input.selectedStrategyId,
        selectedStrategyId: input.selectedStrategyId,
        reviewResult: input.reviewResult as unknown as Prisma.InputJsonValue,
        finalOutcome: "partial",
        metrics: {
          qaPassed: false,
          userFeedbackScore: 0,
          executionTime: 0,
        } satisfies DecisionTraceMetrics,
        scores: input.scores as Prisma.InputJsonValue,
        objections: input.objections as Prisma.InputJsonValue,
        input: {
          content: input.input,
          intent: input.intent,
        } as Prisma.InputJsonValue,
        output: input.output as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
  }

  async complete(input: {
    traceId: string;
    finalOutcome: TraceOutcome;
    metrics: DecisionTraceMetrics;
    evolution: unknown;
  }) {
    const current = await this.prisma.decisionTrace.findUnique({ where: { id: input.traceId } });
    const output = isRecord(current?.output)
      ? { ...current.output, evolution: input.evolution }
      : { evolution: input.evolution };

    return this.prisma.decisionTrace.update({
      where: { id: input.traceId },
      data: {
        finalOutcome: input.finalOutcome,
        metrics: input.metrics as unknown as Prisma.InputJsonValue,
        output: output as Prisma.InputJsonValue,
      },
    });
  }

  resolveOutcome(metrics: DecisionTraceMetrics): TraceOutcome {
    if (metrics.qaPassed && metrics.userFeedbackScore >= 0.7) return "success";
    if (!metrics.qaPassed) return "failure";
    return "partial";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
