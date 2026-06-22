import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { PatchOperation, Strategy } from "../decision-engine/decision.types";
import type { ConstraintContext } from "../../constraint/constraint.types";

export type PatchDraft = {
  id: string;
  strategyId: string;
  constraints?: ConstraintContext;
  operations: PatchOperation[];
  targetDomains: Array<"prd" | "prototype" | "state">;
};

@Injectable()
export class PatchBuilderService {
  build(strategy: Strategy, constraints?: ConstraintContext): PatchDraft {
    return {
      id: `draft_${randomUUID()}`,
      strategyId: strategy.id,
      constraints,
      operations: strategy.patchOperations.map((operation) => ({ ...operation })),
      targetDomains: inferTargetDomains(strategy.patchOperations),
    };
  }
}

function inferTargetDomains(operations: PatchOperation[]): Array<"prd" | "prototype" | "state"> {
  const domains = new Set<"prd" | "prototype" | "state">();
  operations.forEach((operation) => {
    if (operation.path.startsWith("/prd")) domains.add("prd");
    if (operation.path.startsWith("/prototype")) domains.add("prototype");
    if (operation.path.startsWith("/state")) domains.add("state");
  });
  return Array.from(domains.size ? domains : new Set(["state"]));
}
