import type { Strategy, StrategyName } from "../decision-engine/decision.types";
import type { AgentReview } from "./review.types";

type ReviewScores = AgentReview["scores"];

const PREFERRED_BY_AGENT: Record<string, StrategyName> = {
  "Product Strategist": "structure_rewrite",
  "UX Expert": "ux_improve",
  "Tech Architect": "conservative_fix",
  "Risk Controller": "conservative_fix",
  "Growth Analyst": "full_regenerate",
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
      "Product Strategist": {
        usability: strategy.name === "structure_rewrite" ? 8 : 6,
        feasibility: strategy.impact === "high" ? 5 : 7,
        risk: riskBase,
        businessValue: strategy.name === "structure_rewrite" ? 9 : 7,
      },
      "UX Expert": {
        usability: strategy.name === "ux_improve" ? 9 : 6,
        feasibility: strategy.impact === "high" ? 5 : 7,
        risk: riskBase + 1,
        businessValue: 8,
      },
      "Tech Architect": {
        usability: 6,
        feasibility: strategy.name === "conservative_fix" ? 9 : 6,
        risk: Math.max(1, riskBase - 1),
        businessValue: 6,
      },
      "Risk Controller": {
        usability: 5,
        feasibility: strategy.name === "conservative_fix" ? 9 : 6,
        risk: strategy.name === "conservative_fix" ? 1 : riskBase + 2,
        businessValue: 5,
      },
      "Growth Analyst": {
        usability: strategy.name === "full_regenerate" ? 7 : 6,
        feasibility: strategy.impact === "high" ? 5 : 6,
        risk: riskBase + 1,
        businessValue: strategy.name === "full_regenerate" ? 10 : 7,
      },
    };

    return byAgent[agentName] ?? byAgent["Product Strategist"];
  }

  private objections(agentName: string, strategy: Strategy) {
    if (strategy.impact === "high") {
      return [`${agentName} 认为该策略影响面较大，必须通过 Patch Preview 核查风险。`];
    }
    if (strategy.name === "conservative_fix") {
      return [`${agentName} 认为该策略风险低，但业务增量可能有限。`];
    }
    return [`${agentName} 建议确认 ${strategy.name} 的目标域和回滚路径。`];
  }
}
