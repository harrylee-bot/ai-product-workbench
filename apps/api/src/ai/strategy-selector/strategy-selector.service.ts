import { Injectable } from "@nestjs/common";
import type { KnowledgeType } from "@prisma/client";
import type { KnowledgeReference } from "../ai-vibe.types";
import type { Strategy } from "../decision-engine/decision.types";
import type { ReviewBoardResult } from "../review-board/review.types";
import type { ConstraintContext } from "../../constraint/constraint.types";

export type StrategySelection = {
  selectedStrategyId: string;
  reason: string;
  scores: Record<string, {
    weightedScore: number;
    reviewScore: number;
    knowledgeBoost: number;
    constraintPenalty: number;
    reviewCount: number;
  }>;
  knowledgeSummary?: string;
};

export type StrategySelectionContext = {
  constraintContext?: ConstraintContext;
  knowledgeReferences?: KnowledgeReference[];
};

@Injectable()
export class StrategySelectorService {
  select(
    strategies: Strategy[],
    reviewBoard: ReviewBoardResult,
    context: StrategySelectionContext = {},
  ): StrategySelection {
    const scores = strategies.map((strategy) => {
      const matchingReviews = reviewBoard.reviews.filter(
        (review) => review.preferredStrategyId === strategy.id,
      );
      if (!matchingReviews.length) {
        return {
          strategy,
          score: Number.NEGATIVE_INFINITY,
          reviewScore: Number.NEGATIVE_INFINITY,
          knowledgeBoost: 0,
          constraintPenalty: 0,
          reviewCount: 0,
        };
      }

      const total = matchingReviews.reduce((sum, review) => {
        const weightedScore =
          review.scores.usability * 0.25 +
          review.scores.feasibility * 0.25 +
          review.scores.businessValue * 0.3 -
          review.scores.risk * 0.2;
        return sum + weightedScore;
      }, 0);
      const reviewScore = total / matchingReviews.length;
      const knowledgeBoost = scoreKnowledgeFit(strategy, context.knowledgeReferences ?? []);
      const constraintPenalty = scoreConstraintPenalty(strategy, context.constraintContext);

      return {
        strategy,
        score: reviewScore + knowledgeBoost - constraintPenalty,
        reviewScore,
        knowledgeBoost,
        constraintPenalty,
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
      scores: Object.fromEntries(scores.map((item) => [
        item.strategy.id,
        {
          weightedScore: Number(item.score.toFixed(3)),
          reviewScore: Number(item.reviewScore.toFixed(3)),
          knowledgeBoost: Number(item.knowledgeBoost.toFixed(3)),
          constraintPenalty: Number(item.constraintPenalty.toFixed(3)),
          reviewCount: item.reviewCount,
        },
      ])),
      knowledgeSummary: knowledgeSummary(context.knowledgeReferences ?? []),
      reason:
        "按加权得分 = 易用性*0.25 + 可行性*0.25 + 业务价值*0.3 - 风险*0.2 计算，" +
        `${strategyLabel(selected.strategy.name)} 得分 ${selected.score.toFixed(2)}，` +
        `${selected.knowledgeBoost ? `知识匹配加成 ${selected.knowledgeBoost.toFixed(2)}，` : ""}` +
        `${selected.constraintPenalty ? `约束风险扣减 ${selected.constraintPenalty.toFixed(2)}，` : ""}` +
        "在已评审策略中最优。",
    };
  }
}

function scoreKnowledgeFit(strategy: Strategy, references: KnowledgeReference[]) {
  if (!references.length) return 0;
  return Number(references.reduce((sum, reference) => {
    const type = reference.type;
    if (strategy.name === "ux_improve" && isOneOf(type, ["design_pattern", "prototype_rule", "reference_case"])) {
      return sum + 0.18;
    }
    if (strategy.name === "structure_rewrite" && isOneOf(type, ["business_concept", "reference_case", "prd_writing_rule"])) {
      return sum + 0.14;
    }
    if (strategy.name === "conservative_fix" && isOneOf(type, ["strong_rule", "default_rule"])) {
      return sum + 0.16;
    }
    if (strategy.name === "full_regenerate" && isOneOf(type, ["strong_rule"])) {
      return sum - 0.18;
    }
    return sum + 0.03;
  }, 0).toFixed(3));
}

function scoreConstraintPenalty(strategy: Strategy, context?: ConstraintContext) {
  if (!context) return 0;
  let penalty = 0;
  if (strategy.impact === "high") {
    penalty += context.avoid.length * 0.3;
    penalty += context.warn.length * 0.18;
  }
  if (strategy.name === "full_regenerate") {
    penalty += context.mustFollow.length * 0.08;
  }
  if (strategy.name === "conservative_fix") {
    penalty -= context.prefer.length * 0.08;
  }
  return Number(Math.max(0, penalty).toFixed(3));
}

function knowledgeSummary(references: KnowledgeReference[]) {
  if (!references.length) return undefined;
  const counts = references.reduce<Record<string, number>>((acc, reference) => {
    acc[reference.type ?? "unknown"] = (acc[reference.type ?? "unknown"] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([type, count]) => `${knowledgeTypeLabel(type)} ${count}`)
    .join("，");
}

function isOneOf(type: KnowledgeType | undefined, values: string[]) {
  return Boolean(type && values.includes(type));
}

function knowledgeTypeLabel(type: string) {
  const labels: Record<string, string> = {
    strong_rule: "强规则",
    default_rule: "默认规则",
    reference_case: "参考案例",
    design_pattern: "设计模式",
    prd_writing_rule: "PRD 规则",
    prototype_rule: "原型规则",
    business_concept: "业务概念",
  };
  return labels[type] ?? type;
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
