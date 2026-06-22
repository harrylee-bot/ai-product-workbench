import type { PatchOperation } from "../ai/decision-engine/decision.types";
import type { AgentReview, ReviewBoardResult } from "../ai/review-board/review.types";
import type { ConstraintContext } from "../constraint/constraint.types";

export type FusionStrategyName = "conservative" | "balanced" | "aggressive" | "full_rewrite";

export type FusionStrategy = {
  id: string;
  name: FusionStrategyName;
  description: string;
  patchOperations: PatchOperation[];
  impact: "low" | "medium" | "high";
};

export type StrategyScore = {
  usability: number;
  feasibility: number;
  risk: number;
  businessValue: number;
  weightedScore: number;
  constraintPenalty: number;
};

export type FusionDecisionPlan = {
  strategies: FusionStrategy[];
  selectedStrategyId: string;
  reasoning: string[];
  scores: Record<string, StrategyScore>;
  constraintContext: ConstraintContext;
};

export type FusionDecisionResult = {
  decisionPlan: FusionDecisionPlan;
  reviewBoard: ReviewBoardResult;
  selection: {
    selectedStrategyId: string;
    reason: string;
  };
  selectedStrategy: FusionStrategy;
};

export function reviewFromScores(plan: FusionDecisionPlan): ReviewBoardResult {
  const strategyByName = Object.fromEntries(plan.strategies.map((strategy) => [strategy.name, strategy]));
  const preferredNames: Array<[AgentReview["agentName"], FusionStrategyName]> = [
    ["Product Strategist", "balanced"],
    ["UX Expert", "balanced"],
    ["Tech Architect", "conservative"],
    ["Risk Controller", "conservative"],
    ["Growth Analyst", "aggressive"],
  ];
  const reviews = preferredNames.map(([agentName, preferredName]) => {
    const preferred = strategyByName[preferredName] ?? plan.strategies[0];
    const score = plan.scores[preferred.id];
    return {
      agentName,
      preferredStrategyId: preferred.id,
      scores: {
        usability: score.usability,
        feasibility: score.feasibility,
        risk: score.risk,
        businessValue: score.businessValue,
      },
      objections:
        preferred.impact === "high"
          ? [`${agentName} 要求高影响策略继续保留 Patch Preview 和回滚路径。`]
          : [`${agentName} 已按 Constraint Context 评估 ${preferred.name}。`],
    };
  });

  return {
    reviews,
    finalDecision: {
      selectedStrategyId: plan.selectedStrategyId,
      confidence: Number((0.68 + Math.min(0.22, reviews.length * 0.03)).toFixed(2)),
    },
  };
}
