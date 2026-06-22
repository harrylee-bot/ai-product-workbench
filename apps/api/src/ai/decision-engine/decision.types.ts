export type PatchOperation = {
  op: "add" | "update" | "delete" | "replace";
  path: string;
  value?: unknown;
};

export type StrategyName =
  | "conservative_fix"
  | "ux_improve"
  | "structure_rewrite"
  | "full_regenerate"
  | "conservative"
  | "balanced"
  | "aggressive"
  | "full_rewrite";

export type Strategy = {
  id: string;
  name: StrategyName;
  description: string;
  patchOperations: PatchOperation[];
  impact: "low" | "medium" | "high";
};

export type DecisionPlan = {
  strategies: Strategy[];
};

export type DecisionInput = {
  intent: string;
  content: string;
};
