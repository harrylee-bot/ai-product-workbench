import { Injectable } from "@nestjs/common";
import type { Strategy } from "../decision-engine/decision.types";
import type { ReviewBoardResult } from "../review-board/review.types";

export type StrategySelection = {
  selectedStrategyId: string;
  reason: string;
};

@Injectable()
export class StrategySelectorService {
  select(strategies: Strategy[], reviewBoard: ReviewBoardResult): StrategySelection {
    const scores = strategies.map((strategy) => {
      const matchingReviews = reviewBoard.reviews.filter(
        (review) => review.preferredStrategyId === strategy.id,
      );
      if (!matchingReviews.length) {
        return { strategy, score: Number.NEGATIVE_INFINITY, reviewCount: 0 };
      }

      const total = matchingReviews.reduce((sum, review) => {
        const weightedScore =
          review.scores.usability * 0.25 +
          review.scores.feasibility * 0.25 +
          review.scores.businessValue * 0.3 -
          review.scores.risk * 0.2;
        return sum + weightedScore;
      }, 0);

      return {
        strategy,
        score: total / matchingReviews.length,
        reviewCount: matchingReviews.length,
      };
    });

    const selected = scores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.reviewCount - a.reviewCount;
    })[0];

    if (!selected?.strategy) {
      throw new Error("Strategy Selector cannot select from an empty strategy list.");
    }

    return {
      selectedStrategyId: selected.strategy.id,
      reason:
        "按加权得分 = 易用性*0.25 + 可行性*0.25 + 业务价值*0.3 - 风险*0.2 计算，" +
        `${strategyLabel(selected.strategy.name)} 得分 ${selected.score.toFixed(2)}，在已评审策略中最优。`,
    };
  }
}

function strategyLabel(name: Strategy["name"]) {
  const labels: Record<Strategy["name"], string> = {
    conservative_fix: "保守修正",
    ux_improve: "体验优化",
    structure_rewrite: "结构重写",
    full_regenerate: "完整重建",
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写策略",
  };
  return labels[name];
}
