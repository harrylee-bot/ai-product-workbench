import type { Strategy, StrategyName } from "../decision-engine/decision.types";
import type { AgentReview } from "./review.types";

type ReviewScores = AgentReview["scores"];

const PREFERRED_BY_AGENT: Record<string, StrategyName> = {
  "产品策略官": "structure_rewrite",
  "体验专家": "ux_improve",
  "技术架构师": "conservative_fix",
  "风险控制官": "conservative_fix",
  "增长分析师": "full_regenerate",
};

export class AgentReviewer {
  review(agentName: string, strategies: Strategy[]): AgentReview {
    const preferredName = PREFERRED_BY_AGENT[agentName] ?? "conservative_fix";
    const preferred = strategies.find((strategy) => strategy.name === preferredName) ?? strategies[0];
    const riskBase = preferred.impact === "high" ? 7 : preferred.impact === "medium" ? 4 : 2;

    return {
      agentName,
      preferredStrategyId: preferred.id,
      scores: this.score(agentName, preferred, riskBase),
      objections: this.objections(agentName, preferred),
    };
  }

  private score(agentName: string, strategy: Strategy, riskBase: number) {
    const byAgent: Record<string, ReviewScores> = {
      "产品策略官": {
        usability: strategy.name === "structure_rewrite" ? 8 : 6,
        feasibility: strategy.impact === "high" ? 5 : 7,
        risk: riskBase,
        businessValue: strategy.name === "structure_rewrite" ? 9 : 7,
      },
      "体验专家": {
        usability: strategy.name === "ux_improve" ? 9 : 6,
        feasibility: strategy.impact === "high" ? 5 : 7,
        risk: riskBase + 1,
        businessValue: 8,
      },
      "技术架构师": {
        usability: 6,
        feasibility: strategy.name === "conservative_fix" ? 9 : 6,
        risk: Math.max(1, riskBase - 1),
        businessValue: 6,
      },
      "风险控制官": {
        usability: 5,
        feasibility: strategy.name === "conservative_fix" ? 9 : 6,
        risk: strategy.name === "conservative_fix" ? 1 : riskBase + 2,
        businessValue: 5,
      },
      "增长分析师": {
        usability: strategy.name === "full_regenerate" ? 7 : 6,
        feasibility: strategy.impact === "high" ? 5 : 6,
        risk: riskBase + 1,
        businessValue: strategy.name === "full_regenerate" ? 10 : 7,
      },
    };

    return byAgent[agentName] ?? byAgent["产品策略官"];
  }

  private objections(agentName: string, strategy: Strategy) {
    if (strategy.impact === "high") {
      return [`${agentName} 认为该策略影响面较大，必须通过补丁预览核查风险。`];
    }
    if (strategy.name === "conservative_fix") {
      return [`${agentName} 认为该策略风险低，但业务增量可能有限。`];
    }
    return [`${agentName} 建议确认${strategyLabel(strategy.name)}的目标域和回滚路径。`];
  }
}

function strategyLabel(name: StrategyName) {
  const labels: Record<StrategyName, string> = {
    conservative_fix: "保守修正",
    ux_improve: "体验优化",
    structure_rewrite: "结构重写",
    full_regenerate: "完整重建",
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写策略",
  };
  return labels[name];
}
