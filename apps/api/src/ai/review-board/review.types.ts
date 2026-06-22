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
  "Product Strategist",
  "UX Expert",
  "Tech Architect",
  "Risk Controller",
  "Growth Analyst",
] as const;
