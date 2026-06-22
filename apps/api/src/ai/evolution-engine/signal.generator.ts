import { Injectable } from "@nestjs/common";
import type { TraceOutcome } from "./decision-trace.service";

export type EvolutionSignal = {
  strategyId: string;
  signalType: "promote" | "demote" | "neutral";
  weightDelta: number;
  reason: string;
};

@Injectable()
export class SignalGenerator {
  generate(input: {
    strategyId: string;
    outcome: TraceOutcome;
    recentFailures: number;
    userFeedbackScore: number;
  }): EvolutionSignal {
    if (input.outcome === "success") {
      return {
        strategyId: input.strategyId,
        signalType: "promote",
        weightDelta: 0.12,
        reason: "QA passed and user feedback indicates satisfaction.",
      };
    }

    if (input.outcome === "failure") {
      const strong = input.recentFailures >= 3;
      return {
        strategyId: input.strategyId,
        signalType: "demote",
        weightDelta: strong ? -0.24 : -0.12,
        reason: strong
          ? "High-frequency failure detected for this strategy."
          : "QA failed for this execution.",
      };
    }

    return {
      strategyId: input.strategyId,
      signalType: "neutral",
      weightDelta: input.userFeedbackScore >= 0.5 ? 0.02 : -0.02,
      reason: "Execution produced a partial outcome; keep learning signal small.",
    };
  }
}
