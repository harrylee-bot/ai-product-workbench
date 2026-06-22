import { Injectable } from "@nestjs/common";
import type { DecisionInput, DecisionPlan } from "./decision.types";
import { StrategyGenerator } from "./strategy.generator";

@Injectable()
export class DecisionEngineService {
  private readonly generator = new StrategyGenerator();

  decide(input: DecisionInput): DecisionPlan {
    const strategies = this.generator.generate(input);
    const names = new Set(strategies.map((strategy) => strategy.name));
    const operationSets = new Set(
      strategies.map((strategy) => JSON.stringify(strategy.patchOperations)),
    );

    if (strategies.length < 3) {
      throw new Error("Decision Engine must generate at least 3 strategies.");
    }
    if (names.size !== strategies.length) {
      throw new Error("Decision Engine strategies must be distinct.");
    }
    if (operationSets.size !== strategies.length) {
      throw new Error("Decision Engine strategies must have independent patchOperations.");
    }

    return { strategies };
  }
}
