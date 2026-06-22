import { describe, expect, it, vi } from "vitest";
import { ConstraintService } from "../src/constraint/constraint.service";
import { FusionDecisionService } from "../src/decision/decision.service";
import { FusionEvolutionService } from "../src/evolution/evolution.service";
import type { PrismaService } from "../src/prisma/prisma.service";

describe("Triple system fusion", () => {
  it("builds constraint context from knowledge rules", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      constraintRule: {
        createManyAndReturn: vi.fn().mockImplementation(({ data }) => {
          rows.push(...data.map((item: Record<string, unknown>, index: number) => ({
            id: `constraint_${index}`,
            ...item,
          })));
          return Promise.resolve(rows);
        }),
      },
    } as unknown as PrismaService;
    const service = new ConstraintService(prisma);

    const context = await service.build({
      projectId: "project_1",
      userInput: "重构工作台但必须安全",
      createdBy: "user_1",
    });

    expect(context.mustFollow.length).toBeGreaterThanOrEqual(2);
    expect(context.avoid[0]?.effect).toContain("直接修改数据库");
    expect(context.warn.length).toBe(1);
  });

  it("uses constraints to score and select among multiple strategies", async () => {
    const prisma = {
      strategy: {
        createMany: vi.fn().mockResolvedValue({ count: 4 }),
      },
    } as unknown as PrismaService;
    const constraints = {
      context: vi.fn(),
    } as unknown as ConstraintService;
    const decision = new FusionDecisionService(prisma, constraints);

    const result = await decision.generate({
      projectId: "project_1",
      userInput: "重构工作台但必须先预览风险",
      intent: "new_requirement",
      constraintContext: {
        mustFollow: [
          {
            id: "c1",
            rule: "must_follow",
            scope: "patch",
            condition: "补丁变更",
            effect: "执行前必须进入补丁预览。",
            weight: 1,
            sourceKnowledgeId: "k1",
          },
        ],
        prefer: [],
        avoid: [
          {
            id: "c2",
            rule: "avoid",
            scope: "patch",
            condition: "直接修改",
            effect: "避免直接修改数据库和受保护模块。",
            weight: 0.95,
            sourceKnowledgeId: "k2",
          },
        ],
        warn: [
          {
            id: "c3",
            rule: "warn",
            scope: "decision",
            condition: "重写",
            effect: "高影响策略需要更强的风险惩罚。",
            weight: 0.8,
            sourceKnowledgeId: "k3",
          },
        ],
      },
      createdBy: "user_1",
    });

    expect(result.decisionPlan.strategies).toHaveLength(4);
    expect(result.decisionPlan.selectedStrategyId).not.toContain("full");
    expect(result.decisionPlan.reasoning.join(" ")).toContain("必须遵守");
    expect(result.decisionPlan.scores[result.selectedStrategy.id].weightedScore).toBeGreaterThan(0);
    expect(prisma.strategy.createMany).toHaveBeenCalledOnce();
  });

  it("records trace, creates evolution signal, and updates system policy", async () => {
    const prisma = {
      decisionTrace: {
        create: vi.fn().mockResolvedValue({ id: "trace_1" }),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({ id: "trace_1" }),
      },
      evolutionSignal: {
        create: vi.fn().mockResolvedValue({ id: "signal_1" }),
      },
      systemPolicy: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "policy_1",
            version: data.version,
            createdAt: new Date("2026-06-22T00:00:00.000Z"),
          }),
        ),
      },
    } as unknown as PrismaService;
    const evolution = new FusionEvolutionService(prisma);

    const result = await evolution.run({
      projectId: "project_1",
      sourceType: "message",
      sourceId: "message_1",
      userInput: "优化工作台",
      decisionPlan: {
        strategies: [
          {
            id: "strategy_balanced",
            name: "balanced",
            description: "balanced",
            impact: "medium",
            patchOperations: [],
          },
        ],
        selectedStrategyId: "strategy_balanced",
        reasoning: ["selected by score"],
        scores: {
          strategy_balanced: {
            usability: 8,
            feasibility: 8,
            businessValue: 8,
            risk: 4,
            weightedScore: 5.6,
            constraintPenalty: 0,
          },
        },
        constraintContext: { mustFollow: [], prefer: [], avoid: [], warn: [] },
      },
      outcome: "success",
      metrics: {
        qaPassed: true,
        userSatisfaction: 0.86,
        executionTime: 120,
      },
      createdBy: "user_1",
    });

    expect(result.signal.signalType).toBe("promote");
    expect(result.policy.strategyWeights.strategy_balanced).toBeGreaterThan(1);
    expect(prisma.evolutionSignal.create).toHaveBeenCalledOnce();
    expect(prisma.systemPolicy.create).toHaveBeenCalledOnce();
    expect(prisma.decisionTrace.update).toHaveBeenCalledOnce();
  });
});
