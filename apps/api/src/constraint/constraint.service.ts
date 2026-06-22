import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { Constraint, ConstraintContext, ConstraintRule, ConstraintScope } from "./constraint.types";

@Injectable()
export class ConstraintService {
  constructor(private readonly prisma: PrismaService) {}

  async build(input: {
    projectId: string;
    userInput: string;
    createdBy: string;
  }): Promise<ConstraintContext> {
    const constraints = buildDefaultConstraints(input.userInput);
    const rows = await this.prisma.constraintRule.createManyAndReturn({
      data: constraints.map((constraint) => ({
        projectId: input.projectId,
        rule: constraint.rule,
        scope: constraint.scope,
        condition: constraint.condition,
        effect: constraint.effect,
        weight: constraint.weight,
        sourceKnowledgeId: constraint.sourceKnowledgeId,
        sourceInput: input.userInput,
        createdBy: input.createdBy,
      })),
    });

    return groupConstraints(rows.map(toConstraint));
  }

  async context(projectId: string): Promise<ConstraintContext> {
    const rows = await this.prisma.constraintRule.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    return groupConstraints(rows.map(toConstraint));
  }

  validatePatchPlan(context: ConstraintContext, operations: Array<{ path: string }>) {
    const mustPreview = context.mustFollow.some((constraint) =>
      /patch preview|补丁预览/i.test(constraint.effect),
    );
    const directDbMutation = operations.some((operation) => operation.path.startsWith("/database"));
    const avoidsDirectDb = context.avoid.some((constraint) =>
      /direct database mutation|直接修改数据库/i.test(constraint.effect),
    );

    return {
      constraintsApplied: true,
      requiresPatchPreview: mustPreview,
      blocksDirectDatabaseMutation: avoidsDirectDb && !directDbMutation,
      hasOperations: operations.length > 0,
    };
  }
}

function buildDefaultConstraints(input: string): Array<Omit<Constraint, "id">> {
  const mentionsRewrite = /重构|rewrite|rebuild|重建/i.test(input);
  return [
    {
      rule: "must_follow",
      scope: "decision",
      condition: "所有用户输入必须进入决策系统。",
      effect: "生成多个策略，并按加权得分选择最优策略。",
      weight: 1,
      sourceKnowledgeId: "fusion:decision-required",
    },
    {
      rule: "must_follow",
      scope: "patch",
      condition: "任何操作只要改变产品状态、需求文档、原型或系统图。",
      effect: "执行前必须进入补丁预览。",
      weight: 1,
      sourceKnowledgeId: "fusion:patch-preview-required",
    },
    {
      rule: "avoid",
      scope: "patch",
      condition: "补丁操作直接指向数据库、鉴权、令牌或核心安全模块。",
      effect: "避免直接修改数据库和受保护模块。",
      weight: 0.95,
      sourceKnowledgeId: "fusion:avoid-direct-mutation",
    },
    {
      rule: mentionsRewrite ? "warn" : "prefer",
      scope: "decision",
      condition: mentionsRewrite
        ? "用户要求大范围重构或重建。"
        : "用户意图可以通过渐进方式处理。",
      effect: mentionsRewrite
        ? "高影响策略需要更强的风险惩罚。"
        : "业务价值接近时优先选择低风险策略。",
      weight: mentionsRewrite ? 0.8 : 0.6,
      sourceKnowledgeId: mentionsRewrite ? "fusion:rewrite-risk-warning" : "fusion:prefer-low-risk",
    },
  ];
}

function groupConstraints(constraints: Constraint[]): ConstraintContext {
  return {
    mustFollow: constraints.filter((constraint) => constraint.rule === "must_follow"),
    prefer: constraints.filter((constraint) => constraint.rule === "prefer"),
    avoid: constraints.filter((constraint) => constraint.rule === "avoid"),
    warn: constraints.filter((constraint) => constraint.rule === "warn"),
  };
}

function toConstraint(row: {
  id: string;
  rule: string;
  scope: string;
  condition: string;
  effect: string;
  weight: number;
  sourceKnowledgeId: string;
}): Constraint {
  return {
    id: row.id,
    rule: row.rule as ConstraintRule,
    scope: row.scope as ConstraintScope,
    condition: row.condition,
    effect: row.effect,
    weight: row.weight,
    sourceKnowledgeId: row.sourceKnowledgeId,
  };
}

export function constraintContextToJson(context: ConstraintContext): Prisma.InputJsonValue {
  return context as unknown as Prisma.InputJsonValue;
}
