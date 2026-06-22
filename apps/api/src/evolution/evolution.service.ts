import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type {
  CreateFusionTraceInput,
  FusionEvolutionSignal,
  FusionSystemPolicy,
  FusionTraceMetrics,
  FusionTraceOutcome,
} from "./evolution.types";

const DEFAULT_POLICY: FusionSystemPolicy = {
  strategyWeights: {
    conservative: 1,
    balanced: 1,
    aggressive: 1,
    full_rewrite: 1,
  },
  agentWeights: {
    product: 1,
    ux: 1,
    tech: 1,
    risk: 1,
    growth: 1,
  },
  decisionBias: {
    riskAversion: 0.5,
    innovationBias: 0.5,
  },
};

@Injectable()
export class FusionEvolutionService {
  constructor(private readonly prisma: PrismaService) {}

  async trace(input: CreateFusionTraceInput) {
    return this.prisma.decisionTrace.create({
      data: {
        projectId: input.projectId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        intent: "new_requirement",
        strategies: input.decisionPlan.strategies as unknown as Prisma.InputJsonValue,
        selectedStrategy: input.decisionPlan.selectedStrategyId,
        selectedStrategyId: input.decisionPlan.selectedStrategyId,
        reviewResult: {
          reasoning: input.decisionPlan.reasoning,
          scores: input.decisionPlan.scores,
        } as Prisma.InputJsonValue,
        finalOutcome: input.outcome,
        metrics: input.metrics as unknown as Prisma.InputJsonValue,
        scores: input.decisionPlan.scores as unknown as Prisma.InputJsonValue,
        objections: input.decisionPlan.constraintContext.warn as unknown as Prisma.InputJsonValue,
        input: {
          content: input.userInput,
          constraintContext: input.decisionPlan.constraintContext,
        } as unknown as Prisma.InputJsonValue,
        output: {
          decisionPlan: input.decisionPlan,
        } as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
  }

  async run(input: CreateFusionTraceInput) {
    const trace = await this.trace(input);
    return this.apply({
      projectId: input.projectId,
      traceId: trace.id,
      strategyId: input.decisionPlan.selectedStrategyId,
      outcome: input.outcome,
      metrics: input.metrics,
      createdBy: input.createdBy,
    });
  }

  async apply(input: {
    projectId: string;
    traceId: string;
    strategyId: string;
    outcome: FusionTraceOutcome;
    metrics: FusionTraceMetrics;
    createdBy: string;
  }) {
    const signal = await this.generateSignal({
      projectId: input.projectId,
      traceId: input.traceId,
      strategyId: input.strategyId,
      outcome: input.outcome,
      metrics: input.metrics,
      createdBy: input.createdBy,
    });
    const policyUpdate = await this.updatePolicy({
      projectId: input.projectId,
      traceId: input.traceId,
      signal,
      outcome: input.outcome,
      createdBy: input.createdBy,
    });

    await this.prisma.decisionTrace.update({
      where: { id: input.traceId },
      data: {
        finalOutcome: input.outcome,
        metrics: input.metrics as unknown as Prisma.InputJsonValue,
        output: {
          evolution: {
            signal,
            policyId: policyUpdate.id,
            policyVersion: policyUpdate.version,
          },
        } as Prisma.InputJsonValue,
      },
    });

    return {
      traceId: input.traceId,
      finalOutcome: input.outcome,
      metrics: {
        qaPassed: input.metrics.qaPassed,
        userFeedbackScore: input.metrics.userSatisfaction,
        executionTime: input.metrics.executionTime,
      },
      signal,
      policy: policyUpdate.policy,
      previousPolicy: policyUpdate.previousPolicy,
      policyId: policyUpdate.id,
      policyVersion: policyUpdate.version,
      strategyDelta: signal.weightDelta,
      agentDeltas: agentDeltas(input.outcome),
      createdAt: policyUpdate.createdAt,
    };
  }

  async policy(projectId: string) {
    const latest = await this.prisma.systemPolicy.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    return latest
      ? {
          id: latest.id,
          version: latest.version,
          policy: rowToPolicy(latest),
          createdAt: latest.createdAt.toISOString(),
        }
      : {
          id: null,
          version: 0,
          policy: DEFAULT_POLICY,
          createdAt: null,
        };
  }

  resolveOutcome(metrics: FusionTraceMetrics): FusionTraceOutcome {
    if (metrics.qaPassed && metrics.userSatisfaction >= 0.7) return "success";
    if (!metrics.qaPassed) return "failure";
    return "partial";
  }

  private async generateSignal(input: {
    projectId: string;
    traceId: string;
    strategyId: string;
    outcome: FusionTraceOutcome;
    metrics: FusionTraceMetrics;
    createdBy: string;
  }): Promise<FusionEvolutionSignal> {
    const recentFailures = await this.prisma.decisionTrace.count({
      where: {
        projectId: input.projectId,
        selectedStrategyId: input.strategyId,
        finalOutcome: "failure",
      },
    });
    const signal = buildSignal(input.strategyId, input.outcome, input.metrics, recentFailures);
    await this.prisma.evolutionSignal.create({
      data: {
        projectId: input.projectId,
        traceId: input.traceId,
        strategyId: signal.strategyId,
        signalType: signal.signalType,
        weightDelta: signal.weightDelta,
        reason: signal.reason,
        createdBy: input.createdBy,
      },
    });
    return signal;
  }

  private async updatePolicy(input: {
    projectId: string;
    traceId: string;
    signal: FusionEvolutionSignal;
    outcome: FusionTraceOutcome;
    createdBy: string;
  }) {
    const latest = await this.prisma.systemPolicy.findFirst({
      where: { projectId: input.projectId },
      orderBy: { version: "desc" },
    });
    const previousPolicy = latest ? rowToPolicy(latest) : DEFAULT_POLICY;
    const nextPolicy = applySignal(previousPolicy, input.signal, input.outcome);
    const row = await this.prisma.systemPolicy.create({
      data: {
        projectId: input.projectId,
        version: (latest?.version ?? 0) + 1,
        strategyWeights: nextPolicy.strategyWeights as Prisma.InputJsonValue,
        agentWeights: nextPolicy.agentWeights as Prisma.InputJsonValue,
        decisionBias: nextPolicy.decisionBias as Prisma.InputJsonValue,
        sourceTraceId: input.traceId,
        signal: input.signal as unknown as Prisma.InputJsonValue,
        previousPolicy: previousPolicy as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });

    return {
      id: row.id,
      version: row.version,
      previousPolicy,
      policy: nextPolicy,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function buildSignal(
  strategyId: string,
  outcome: FusionTraceOutcome,
  metrics: FusionTraceMetrics,
  recentFailures: number,
): FusionEvolutionSignal {
  if (outcome === "success") {
    return {
      strategyId,
      signalType: "promote",
      weightDelta: 0.12,
      reason: "QA passed and user satisfaction was strong.",
    };
  }
  if (outcome === "failure") {
    return {
      strategyId,
      signalType: "demote",
      weightDelta: recentFailures >= 2 ? -0.2 : -0.12,
      reason: "QA failed; strategy should be less preferred until constraints or implementation improve.",
    };
  }
  return {
    strategyId,
    signalType: "neutral",
    weightDelta: metrics.userSatisfaction >= 0.55 ? 0.02 : -0.02,
    reason: "Outcome was partial; policy receives a small adjustment.",
  };
}

function applySignal(
  policy: FusionSystemPolicy,
  signal: FusionEvolutionSignal,
  outcome: FusionTraceOutcome,
): FusionSystemPolicy {
  const strategyWeights = { ...policy.strategyWeights };
  strategyWeights[signal.strategyId] = clamp((strategyWeights[signal.strategyId] ?? 1) + signal.weightDelta);
  const deltas = agentDeltas(outcome);
  return {
    strategyWeights,
    agentWeights: {
      product: clamp(policy.agentWeights.product + deltas.product),
      ux: clamp(policy.agentWeights.ux + deltas.ux),
      tech: clamp(policy.agentWeights.tech + deltas.tech),
      risk: clamp(policy.agentWeights.risk + deltas.risk),
      growth: clamp(policy.agentWeights.growth + deltas.growth),
    },
    decisionBias: {
      riskAversion: clamp(policy.decisionBias.riskAversion + (outcome === "failure" ? 0.03 : -0.01)),
      innovationBias: clamp(policy.decisionBias.innovationBias + (outcome === "success" ? 0.02 : 0)),
    },
  };
}

function agentDeltas(outcome: FusionTraceOutcome) {
  const positive = outcome === "success" ? 0.01 : outcome === "partial" ? 0 : -0.01;
  return {
    product: positive,
    ux: positive,
    tech: positive,
    risk: outcome === "failure" ? 0.01 : positive,
    growth: positive,
  };
}

function rowToPolicy(row: {
  strategyWeights: Prisma.JsonValue;
  agentWeights: Prisma.JsonValue;
  decisionBias: Prisma.JsonValue;
}): FusionSystemPolicy {
  return {
    strategyWeights: {
      ...DEFAULT_POLICY.strategyWeights,
      ...(isRecord(row.strategyWeights) ? toNumberRecord(row.strategyWeights) : {}),
    },
    agentWeights: {
      ...DEFAULT_POLICY.agentWeights,
      ...(isRecord(row.agentWeights) ? toNumberRecord(row.agentWeights) : {}),
    },
    decisionBias: {
      ...DEFAULT_POLICY.decisionBias,
      ...(isRecord(row.decisionBias) ? toNumberRecord(row.decisionBias) : {}),
    },
  };
}

function toNumberRecord(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => [key, typeof raw === "number" ? raw : 1]),
  ) as Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number) {
  return Number(Math.max(0.1, Math.min(3, value)).toFixed(4));
}
