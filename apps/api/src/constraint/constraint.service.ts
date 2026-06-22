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
      constraint.effect.toLowerCase().includes("patch preview"),
    );
    const directDbMutation = operations.some((operation) => operation.path.startsWith("/database"));
    const avoidsDirectDb = context.avoid.some((constraint) =>
      constraint.effect.toLowerCase().includes("direct database mutation"),
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
      condition: "Every user input must enter the Decision System.",
      effect: "Generate multiple strategies and select one by weighted score.",
      weight: 1,
      sourceKnowledgeId: "fusion:decision-required",
    },
    {
      rule: "must_follow",
      scope: "patch",
      condition: "Any operation changes product state, PRD, prototype, or system graph.",
      effect: "Route through Patch Preview before apply.",
      weight: 1,
      sourceKnowledgeId: "fusion:patch-preview-required",
    },
    {
      rule: "avoid",
      scope: "patch",
      condition: "Patch operation targets database, auth, jwt, or core safety modules directly.",
      effect: "Avoid direct database mutation and protected module edits.",
      weight: 0.95,
      sourceKnowledgeId: "fusion:avoid-direct-mutation",
    },
    {
      rule: mentionsRewrite ? "warn" : "prefer",
      scope: "decision",
      condition: mentionsRewrite
        ? "User asks for broad rewrite or rebuild."
        : "User intent can be handled incrementally.",
      effect: mentionsRewrite
        ? "High-impact strategies require stronger risk penalty."
        : "Prefer lower-risk strategies when business value is similar.",
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
