import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PatchOperation } from "../ai/decision-engine/decision.types";
import { PrismaService } from "../prisma/prisma.service";
import { ConstraintService, constraintContextToJson } from "../constraint/constraint.service";
import type { ConstraintContext } from "../constraint/constraint.types";
import { EMPTY_CONSTRAINT_CONTEXT } from "../constraint/constraint.types";
import {
  reviewFromScores,
  type FusionDecisionPlan,
  type FusionDecisionResult,
  type FusionStrategy,
  type FusionStrategyName,
  type StrategyScore,
} from "./decision.types";

@Injectable()
export class FusionDecisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly constraints: ConstraintService,
  ) {}

  async generate(input: {
    projectId: string;
    userInput: string;
    intent: string;
    constraintContext?: ConstraintContext;
    createdBy: string;
  }): Promise<FusionDecisionResult> {
    const constraintContext =
      input.constraintContext ?? (await this.constraints.context(input.projectId));
    const context = hasAnyConstraint(constraintContext) ? constraintContext : EMPTY_CONSTRAINT_CONTEXT;
    const strategies = generateStrategies(input.intent, input.userInput);
    const scores = Object.fromEntries(
      strategies.map((strategy) => [strategy.id, scoreStrategy(strategy, context)]),
    );
    const selectedStrategy = selectBest(strategies, scores);
    const decisionPlan: FusionDecisionPlan = {
      strategies,
      selectedStrategyId: selectedStrategy.id,
      reasoning: buildReasoning(selectedStrategy, scores[selectedStrategy.id], context),
      scores,
      constraintContext: context,
    };

    await this.persistStrategies({
      projectId: input.projectId,
      sourceInput: input.userInput,
      decisionPlan,
      createdBy: input.createdBy,
    });

    return {
      decisionPlan,
      reviewBoard: reviewFromScores(decisionPlan),
      selection: {
        selectedStrategyId: selectedStrategy.id,
        reason: decisionPlan.reasoning.join(" "),
      },
      selectedStrategy,
    };
  }

  select(plan: FusionDecisionPlan) {
    const selected = plan.strategies.find((strategy) => strategy.id === plan.selectedStrategyId) ??
      selectBest(plan.strategies, plan.scores);
    return {
      selectedStrategyId: selected.id,
      reason: buildReasoning(selected, plan.scores[selected.id], plan.constraintContext).join(" "),
    };
  }

  private async persistStrategies(input: {
    projectId: string;
    sourceInput: string;
    decisionPlan: FusionDecisionPlan;
    createdBy: string;
  }) {
    await this.prisma.strategy.createMany({
      data: input.decisionPlan.strategies.map((strategy) => ({
        projectId: input.projectId,
        strategyKey: strategy.id,
        name: strategy.name,
        description: strategy.description,
        patchOperations: strategy.patchOperations as unknown as Prisma.InputJsonValue,
        impact: strategy.impact,
        score: input.decisionPlan.scores[strategy.id]?.weightedScore ?? 0,
        scoreBreakdown: input.decisionPlan.scores[strategy.id] as unknown as Prisma.InputJsonValue,
        constraintSnapshot: constraintContextToJson(input.decisionPlan.constraintContext),
        selected: strategy.id === input.decisionPlan.selectedStrategyId,
        sourceInput: input.sourceInput,
        createdBy: input.createdBy,
      })),
    });
  }
}

function generateStrategies(intent: string, content: string): FusionStrategy[] {
  const title = deriveTitle(content);
  const hash = createHash("sha1").update(`${intent}:${content}`).digest("hex").slice(0, 8);
  return [
    strategy(`strategy_${hash}_conservative`, "conservative", "保守方案：只补齐必要约束和状态目标，优先降低执行风险。", "low", [
      { op: "update", path: "/state/businessGoal", value: `围绕「${title}」补齐最小可执行目标。` },
      {
        op: "add",
        path: "/state/rules/-",
        value: { type: "constraint_applied", content: "所有变更必须遵守三系统融合约束。" },
      },
    ]),
    strategy(`strategy_${hash}_balanced`, "balanced", "平衡方案：同时增强 PRD、原型和状态表达，兼顾收益与可行性。", "medium", [
      { op: "add", path: "/prd/acceptanceCriteria/-", value: "用户可看到 Constraint、Decision、Evolution 的完整链路。" },
      { op: "add", path: "/prototype/pages/-", value: { name: "三系统融合视图", purpose: "展示三系统融合结果。" } },
    ]),
    strategy(`strategy_${hash}_aggressive`, "aggressive", "进取方案：扩大产品结构和交互范围，提升业务价值但引入更高风险。", "medium", [
      { op: "add", path: "/state/pages/-", value: { name: "约束视图", responsibility: "展示知识约束上下文。" } },
      { op: "add", path: "/state/pages/-", value: { name: "决策视图", responsibility: "展示多策略评分和选择理由。" } },
      { op: "add", path: "/state/pages/-", value: { name: "进化视图", responsibility: "展示策略权重和进化影响。" } },
    ]),
    strategy(`strategy_${hash}_full`, "full_rewrite", "完整重写方案：重建产品状态骨架，只在约束允许且收益明显时选择。", "high", [
      { op: "replace", path: "/state/title", value: title },
      { op: "replace", path: "/state/businessGoal", value: `以「${title}」重建智能产品操作系统三系统融合链路。` },
      {
        op: "replace",
        path: "/state/rules",
        value: [
          { type: "must_follow", content: "每次决策前必须先运行约束系统。" },
          { type: "must_follow", content: "决策系统必须生成并评分多个策略。" },
          { type: "must_follow", content: "进化系统必须记录每次执行结果。" },
        ],
      },
    ]),
  ];
}

function strategy(
  id: string,
  name: FusionStrategyName,
  description: string,
  impact: FusionStrategy["impact"],
  patchOperations: PatchOperation[],
): FusionStrategy {
  return { id, name, description, impact, patchOperations };
}

function scoreStrategy(strategy: FusionStrategy, context: ConstraintContext): StrategyScore {
  const base = baseScore(strategy.name);
  let risk = base.risk;
  let feasibility = base.feasibility;
  let businessValue = base.businessValue;
  let constraintPenalty = 0;

  const avoidHighRisk = context.avoid.some((constraint) =>
    /direct|直接修改/i.test(`${constraint.condition} ${constraint.effect}`),
  );
  const preferLowRisk = context.prefer.some((constraint) =>
    /lower-risk|低风险/i.test(constraint.effect),
  );
  const warnsRewrite = context.warn.some((constraint) =>
    /risk penalty|风险惩罚/i.test(constraint.effect),
  );

  if (avoidHighRisk && strategy.impact === "high") {
    risk += 2.5;
    feasibility -= 1;
    constraintPenalty += 0.9;
  }
  if (preferLowRisk && strategy.impact === "low") {
    feasibility += 0.8;
    businessValue += 0.3;
  }
  if (warnsRewrite && strategy.name === "full_rewrite") {
    risk += 2;
    constraintPenalty += 0.7;
  }

  const normalized = {
    usability: clamp10(base.usability),
    feasibility: clamp10(feasibility),
    risk: clamp10(risk),
    businessValue: clamp10(businessValue),
  };
  const weightedScore =
    normalized.usability * 0.25 +
    normalized.feasibility * 0.25 +
    normalized.businessValue * 0.3 -
    normalized.risk * 0.2 -
    constraintPenalty;

  return {
    ...normalized,
    constraintPenalty: Number(constraintPenalty.toFixed(2)),
    weightedScore: Number(weightedScore.toFixed(4)),
  };
}

function baseScore(name: FusionStrategyName) {
  const scores: Record<FusionStrategyName, Omit<StrategyScore, "weightedScore" | "constraintPenalty">> = {
    conservative: { usability: 6, feasibility: 9, risk: 2, businessValue: 6 },
    balanced: { usability: 8, feasibility: 8, risk: 4, businessValue: 8 },
    aggressive: { usability: 8, feasibility: 6, risk: 7, businessValue: 9 },
    full_rewrite: { usability: 7, feasibility: 4, risk: 9, businessValue: 10 },
  };
  return scores[name];
}

function selectBest(strategies: FusionStrategy[], scores: Record<string, StrategyScore>) {
  const selected = [...strategies].sort((a, b) => {
    const scoreDelta = (scores[b.id]?.weightedScore ?? 0) - (scores[a.id]?.weightedScore ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return impactRank(a.impact) - impactRank(b.impact);
  })[0];
  if (!selected) throw new Error("Decision System cannot select from empty strategies.");
  return selected;
}

function buildReasoning(strategy: FusionStrategy, score: StrategyScore, context: ConstraintContext) {
  return [
    `加权得分 = 易用性*0.25 + 可行性*0.25 + 业务价值*0.3 - 风险*0.2，${strategyLabel(strategy.name)} 得分 ${score.weightedScore.toFixed(2)}。`,
    `已应用 ${context.mustFollow.length} 条必须遵守、${context.prefer.length} 条优先考虑、${context.avoid.length} 条避免、${context.warn.length} 条提醒约束。`,
    `选择 ${strategyLabel(strategy.name)}，因为它在当前约束下的收益、可行性和风险最平衡。`,
  ];
}

function strategyLabel(name: FusionStrategyName) {
  const labels: Record<FusionStrategyName, string> = {
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写策略",
  };
  return labels[name];
}

function impactRank(impact: FusionStrategy["impact"]) {
  if (impact === "low") return 1;
  if (impact === "medium") return 2;
  return 3;
}

function clamp10(value: number) {
  return Number(Math.max(1, Math.min(10, value)).toFixed(2));
}

function hasAnyConstraint(context: ConstraintContext) {
  return context.mustFollow.length + context.prefer.length + context.avoid.length + context.warn.length > 0;
}

function deriveTitle(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "智能产品操作系统";
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact;
}
