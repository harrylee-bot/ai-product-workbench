import type { ConstraintContext } from "../../constraint/constraint.types";

export type PatchOperation = {
  op: "add" | "update" | "delete" | "replace";
  path: string;
  value?: unknown;
};

export type PatchDraft = {
  id: string;
  strategyId: string;
  constraints?: ConstraintContext;
  knowledgeRefs?: Array<{
    id: string;
    title: string;
    type?: string;
    sourceId?: string;
  }>;
  operations: PatchOperation[];
  targetDomains: Array<"prd" | "prototype" | "state">;
};
