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
    ["产品策略官", "balanced"],
    ["体验专家", "balanced"],
    ["技术架构师", "conservative"],
    ["风险控制官", "conservative"],
    ["增长分析师", "aggressive"],
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
          ? [`${agentName} 要求高影响策略继续保留补丁预览和回滚路径。`]
          : [`${agentName} 已按约束上下文评估${strategyLabel(preferred.name)}。`],
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

function strategyLabel(name: FusionStrategyName) {
  const labels: Record<FusionStrategyName, string> = {
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写策略",
  };
  return labels[name];
}
