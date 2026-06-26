export type ConstraintRule = "must_follow" | "prefer" | "avoid" | "warn";

export type ConstraintScope = "runtime" | "state" | "qa";

export type Constraint = {
  id: string;
  rule: ConstraintRule;
  scope: ConstraintScope;
  condition: string;
  effect: string;
  weight: number;
  sourceKnowledgeId: string;
};

export type ConstraintContext = {
  mustFollow: Constraint[];
  prefer: Constraint[];
  avoid: Constraint[];
  warn: Constraint[];
};
