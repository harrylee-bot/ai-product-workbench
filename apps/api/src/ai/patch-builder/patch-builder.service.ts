import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { PatchOperation, Strategy } from "../decision-engine/decision.types";
import type { ConstraintContext } from "../../constraint/constraint.types";
import type { KnowledgeReference } from "../ai-vibe.types";

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

@Injectable()
export class PatchBuilderService {
  build(
    strategy: Strategy,
    constraints?: ConstraintContext,
    knowledgeReferences: KnowledgeReference[] = [],
  ): PatchDraft {
    return {
      id: `draft_${randomUUID()}`,
      strategyId: strategy.id,
      constraints,
      knowledgeRefs: knowledgeReferences.slice(0, 8).map((reference) => ({
        id: reference.id,
        title: reference.title,
        type: reference.type,
        sourceId: reference.sourceId,
      })),
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
