import type { FusionDecisionPlan } from "../decision/decision.types";

export type FusionTraceOutcome = "success" | "failure" | "partial";

export type FusionTraceMetrics = {
  qaPassed: boolean;
  userSatisfaction: number;
  executionTime: number;
};

export type FusionEvolutionSignal = {
  strategyId: string;
  signalType: "promote" | "demote" | "neutral";
  weightDelta: number;
  reason: string;
};

export type FusionSystemPolicy = {
  strategyWeights: Record<string, number>;
  agentWeights: {
    product: number;
    ux: number;
    tech: number;
    risk: number;
    growth: number;
  };
  decisionBias: {
    riskAversion: number;
    innovationBias: number;
  };
};

export type CreateFusionTraceInput = {
  projectId: string;
  sourceType: string;
  sourceId?: string;
  userInput: string;
  decisionPlan: FusionDecisionPlan;
  outcome: FusionTraceOutcome;
  metrics: FusionTraceMetrics;
  createdBy: string;
};
