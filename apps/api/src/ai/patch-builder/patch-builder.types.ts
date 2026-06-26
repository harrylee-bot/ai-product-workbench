export type PatchOperation = {
  op: "add" | "update" | "delete" | "replace";
  path: string;
  value?: unknown;
};

export type PatchStrategyName =
  | "conservative_fix"
  | "ux_improve"
  | "structure_rewrite"
  | "full_regenerate"
  | "conservative"
  | "balanced"
  | "aggressive"
  | "full_rewrite";

export type PatchStrategy = {
  id: string;
  name: PatchStrategyName;
  description: string;
  patchOperations: PatchOperation[];
  impact: "low" | "medium" | "high";
};
