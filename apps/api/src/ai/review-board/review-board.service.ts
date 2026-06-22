import { Injectable } from "@nestjs/common";
import type { DecisionPlan } from "../decision-engine/decision.types";
import { AgentReviewer } from "./agent.reviewer";
import { REVIEW_AGENTS, type ReviewBoardResult } from "./review.types";

@Injectable()
export class ReviewBoardService {
  private readonly reviewer = new AgentReviewer();

  review(plan: DecisionPlan): ReviewBoardResult {
    const reviews = REVIEW_AGENTS.map((agentName) => this.reviewer.review(agentName, plan.strategies));
    const preferenceCounts = reviews.reduce<Record<string, number>>((counts, review) => {
      counts[review.preferredStrategyId] = (counts[review.preferredStrategyId] ?? 0) + 1;
      return counts;
    }, {});
    const conflicts = new Set(reviews.map((review) => review.preferredStrategyId)).size;

    if (conflicts < 2) {
      throw new Error("Review Board must include conflicting agent preferences.");
    }

    const ranked = Object.entries(preferenceCounts).sort((a, b) => b[1] - a[1]);
    const selectedStrategyId = ranked[0]?.[0] ?? plan.strategies[0]?.id;
    const confidence = Math.min(0.95, 0.55 + ((ranked[0]?.[1] ?? 1) / reviews.length) * 0.35);

    return {
      reviews,
      finalDecision: {
        selectedStrategyId,
        confidence: Number(confidence.toFixed(2)),
      },
    };
  }
}
