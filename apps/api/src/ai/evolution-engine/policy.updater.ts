import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { EvolutionSignal } from "./signal.generator";
import type { TraceOutcome } from "./decision-trace.service";

export type SystemPolicy = {
  strategyWeights: Record<string, number>;
  agentWeights: {
    productStrategist: number;
    uxExpert: number;
    techArchitect: number;
    riskController: number;
    growthAnalyst: number;
  };
  decisionBias: {
    riskAversion: number;
    innovationBias: number;
  };
};

const DEFAULT_POLICY: SystemPolicy = {
  strategyWeights: {
    conservative_fix: 1,
    ux_improve: 1,
    structure_rewrite: 1,
    full_regenerate: 1,
  },
  agentWeights: {
    productStrategist: 1,
    uxExpert: 1,
    techArchitect: 1,
    riskController: 1,
    growthAnalyst: 1,
  },
  decisionBias: {
    riskAversion: 0.5,
    innovationBias: 0.5,
  },
};

const LEARNING_RATE = 1;

@Injectable()
export class PolicyUpdater {
  constructor(private readonly prisma: PrismaService) {}

  async update(input: {
    projectId: string;
    traceId: string;
    signal: EvolutionSignal;
    outcome: TraceOutcome;
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
      signal: input.signal,
      strategyDelta: input.signal.weightDelta,
      agentDeltas: buildAgentDeltas(input.outcome),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async rollback(input: {
    projectId: string;
    policyId: string;
    createdBy: string;
  }) {
    const [target, latest] = await Promise.all([
      this.prisma.systemPolicy.findFirst({
        where: {
          id: input.policyId,
          projectId: input.projectId,
        },
      }),
      this.prisma.systemPolicy.findFirst({
        where: { projectId: input.projectId },
        orderBy: { version: "desc" },
      }),
    ]);

    if (!target) throw new NotFoundException("SystemPolicy 不存在");

    const targetPolicy = rowToPolicy(target);
    const previousPolicy = latest ? rowToPolicy(latest) : DEFAULT_POLICY;
    const row = await this.prisma.systemPolicy.create({
      data: {
        projectId: input.projectId,
        version: (latest?.version ?? 0) + 1,
        strategyWeights: targetPolicy.strategyWeights as Prisma.InputJsonValue,
        agentWeights: targetPolicy.agentWeights as Prisma.InputJsonValue,
        decisionBias: targetPolicy.decisionBias as Prisma.InputJsonValue,
        sourceTraceId: target.sourceTraceId,
        signal: {
          strategyId: "system_policy",
          signalType: "neutral",
          weightDelta: 0,
          reason: `Rollback to policy ${target.id}`,
        } as Prisma.InputJsonValue,
        previousPolicy: previousPolicy as unknown as Prisma.InputJsonValue,
        rollbackOfPolicyId: target.id,
        createdBy: input.createdBy,
      },
    });

    return {
      id: row.id,
      version: row.version,
      policy: targetPolicy,
      previousPolicy,
      rollbackOfPolicyId: target.id,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function applySignal(policy: SystemPolicy, signal: EvolutionSignal, outcome: TraceOutcome): SystemPolicy {
  const strategyWeights = { ...policy.strategyWeights };
  strategyWeights[signal.strategyId] = clamp(
    (strategyWeights[signal.strategyId] ?? 1) + LEARNING_RATE * signal.weightDelta,
  );

  const agentDeltas = buildAgentDeltas(outcome);
  const agentWeights = {
    productStrategist: clamp(policy.agentWeights.productStrategist + agentDeltas.productStrategist),
    uxExpert: clamp(policy.agentWeights.uxExpert + agentDeltas.uxExpert),
    techArchitect: clamp(policy.agentWeights.techArchitect + agentDeltas.techArchitect),
    riskController: clamp(policy.agentWeights.riskController + agentDeltas.riskController),
    growthAnalyst: clamp(policy.agentWeights.growthAnalyst + agentDeltas.growthAnalyst),
  };

  const decisionBias = { ...policy.decisionBias };
  if (outcome === "failure") {
    decisionBias.riskAversion = clamp(decisionBias.riskAversion + 0.03);
  }
  if (outcome === "success" && signal.strategyId.includes("ux")) {
    decisionBias.innovationBias = clamp(decisionBias.innovationBias + 0.02);
  }
  if (outcome === "success" && signal.strategyId.includes("full")) {
    decisionBias.innovationBias = clamp(decisionBias.innovationBias + 0.03);
  }

  return {
    strategyWeights,
    agentWeights,
    decisionBias,
  };
}

function buildAgentDeltas(outcome: TraceOutcome) {
  const delta = outcome === "success" ? 0.01 : -0.01;
  return {
    productStrategist: delta,
    uxExpert: delta,
    techArchitect: delta,
    riskController: outcome === "failure" ? 0.01 : delta,
    growthAnalyst: delta,
  };
}

function rowToPolicy(row: {
  strategyWeights: Prisma.JsonValue;
  agentWeights: Prisma.JsonValue;
  decisionBias: Prisma.JsonValue;
}): SystemPolicy {
  return {
    strategyWeights: isRecord(row.strategyWeights) ? toNumberRecord(row.strategyWeights) : DEFAULT_POLICY.strategyWeights,
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

function clamp(value: number) {
  return Number(Math.max(0.1, Math.min(3, value)).toFixed(4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
