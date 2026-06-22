export type AgentReview = {
  agentName: string;
  scores: {
    usability: number;
    feasibility: number;
    risk: number;
    businessValue: number;
  };
  preferredStrategyId: string;
  objections: string[];
};

export type ReviewBoardResult = {
  reviews: AgentReview[];
  finalDecision: {
    selectedStrategyId: string;
    confidence: number;
  };
};

export const REVIEW_AGENTS = [
  "产品策略官",
  "体验专家",
  "技术架构师",
  "风险控制官",
  "增长分析师",
] as const;
