import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { Constraint, ConstraintContext, ConstraintRule, ConstraintScope } from "./constraint.types";

type KnowledgeConstraintSource = {
  knowledgeId?: string;
  title: string;
  snippet?: string;
  content: string;
  type?: string;
};

@Injectable()
export class ConstraintService {
  constructor(private readonly prisma: PrismaService) {}

  async build(input: {
    projectId: string;
    userInput: string;
    createdBy: string;
    knowledgeReferences?: KnowledgeConstraintSource[];
  }): Promise<ConstraintContext> {
    const constraints = [
      ...buildDefaultConstraints(input.userInput),
      ...buildKnowledgeConstraints(input.knowledgeReferences ?? []),
    ];
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

}

function buildDefaultConstraints(input: string): Array<Omit<Constraint, "id">> {
  const mentionsRewrite = /重构|rewrite|rebuild|重建/i.test(input);
  return [
    {
      rule: "must_follow",
      scope: "runtime",
      condition: "所有生成、修改和质检请求必须进入 DeerFlow 2.0 runtime 边界。",
      effect: "产品系统只维护协议、状态机、线程绑定、事件接收和 final action 落库。",
      weight: 1,
      sourceKnowledgeId: "vibe:deerflow-runtime-required",
    },
    {
      rule: "must_follow",
      scope: "runtime",
      condition: "任何操作只要改变产品状态、需求文档、原型或系统图。",
      effect: "落库前必须由 DeerFlow final action 明确变更内容、风险和复核要求。",
      weight: 1,
      sourceKnowledgeId: "fusion:final-action-review-required",
    },
    {
      rule: "avoid",
      scope: "runtime",
      condition: "生成或修改请求直接指向数据库、鉴权、令牌或核心安全模块。",
      effect: "避免直接修改数据库和受保护模块。",
      weight: 0.95,
      sourceKnowledgeId: "fusion:avoid-direct-mutation",
    },
    {
      rule: mentionsRewrite ? "warn" : "prefer",
      scope: "runtime",
      condition: mentionsRewrite
        ? "用户要求大范围重构或重建。"
        : "用户意图可以通过渐进方式处理。",
      effect: mentionsRewrite
        ? "DeerFlow final action 必须显式列出风险、回滚点和验收方式。"
        : "业务价值接近时优先生成低风险、可回滚的状态变更方案。",
      weight: mentionsRewrite ? 0.8 : 0.6,
      sourceKnowledgeId: mentionsRewrite ? "vibe:rewrite-risk-warning" : "vibe:prefer-low-risk",
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

function buildKnowledgeConstraints(references: KnowledgeConstraintSource[]): Array<Omit<Constraint, "id">> {
  return uniqueKnowledgeReferences(references)
    .slice(0, 10)
    .map((reference) => {
      const sourceText = cleanConstraintText(reference.content || reference.snippet || reference.title);
      const effect = knowledgeEffect(reference, sourceText);
      return {
        rule: knowledgeRule(reference.type),
        scope: knowledgeScope(reference, sourceText),
        condition: `命中知识库「${reference.title}」。`,
        effect,
        weight: knowledgeWeight(reference.type),
        sourceKnowledgeId: reference.knowledgeId || `knowledge:${reference.title}`,
      };
    });
}

function uniqueKnowledgeReferences(references: KnowledgeConstraintSource[]) {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = reference.knowledgeId || reference.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function knowledgeRule(type?: string): ConstraintRule {
  if (type === "strong_rule" || type === "prd_writing_rule" || type === "prototype_rule") {
    return "must_follow";
  }
  if (type === "reference_case" || type === "business_concept" || type === "design_pattern") {
    return "prefer";
  }
  return "prefer";
}

function knowledgeScope(reference: KnowledgeConstraintSource, text: string): ConstraintScope {
  const haystack = `${reference.title} ${reference.type ?? ""} ${text}`;
  if (/执行|变更|final action|复核|preview|预览门禁/i.test(haystack)) return "runtime";
  if (/质检|验收|测试|风险|qa/i.test(haystack)) return "qa";
  if (/原型|界面|交互|体验|UI|UX|组件|页面/i.test(haystack)) return "runtime";
  return "state";
}

function knowledgeWeight(type?: string) {
  if (type === "strong_rule") return 1;
  if (type === "prd_writing_rule" || type === "prototype_rule") return 0.9;
  if (type === "default_rule") return 0.78;
  return 0.68;
}

function knowledgeEffect(reference: KnowledgeConstraintSource, text: string) {
  const prefix = reference.type === "strong_rule"
    ? "必须遵守知识库强规则"
    : reference.type === "prd_writing_rule"
      ? "需求文档必须遵守知识库写作规则"
      : reference.type === "prototype_rule"
        ? "原型必须遵守知识库原型规则"
        : "优先参考知识库内容";
  return `${prefix}：${reference.title} - ${text}`;
}

function cleanConstraintText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 320);
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
