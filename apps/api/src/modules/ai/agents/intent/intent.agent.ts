import { Injectable } from "@nestjs/common";
import type { ConstraintContext } from "../../../../constraint/constraint.types";
import type { FusionDecisionPlan } from "../../../../decision/decision.types";

export type AgentInput = {
  userInput: string;
  constraintContext: ConstraintContext;
  decisionContext: FusionDecisionPlan;
};

@Injectable()
export class IntentAgent {
  run(input?: AgentInput) {
    return {
      intent: "new_requirement" as const,
      constrained: Boolean(input?.constraintContext.mustFollow.length),
      strategyCount: input?.decisionContext.strategies.length ?? 0,
    };
  }
}
