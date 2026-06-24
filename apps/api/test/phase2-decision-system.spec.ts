import { describe, expect, it } from "vitest";
import { KnowledgeType } from "@prisma/client";
import { DecisionEngineService } from "../src/ai/decision-engine/decision-engine.service";
import { PatchBuilderService } from "../src/ai/patch-builder/patch-builder.service";
import { ReviewBoardService } from "../src/ai/review-board/review-board.service";
import { StrategySelectorService } from "../src/ai/strategy-selector/strategy-selector.service";

describe("Phase2 decision system", () => {
  it("generates multiple reviewed strategies and builds a preview-bound patch draft", () => {
    const decisionEngine = new DecisionEngineService();
    const reviewBoard = new ReviewBoardService();
    const selector = new StrategySelectorService();
    const patchBuilder = new PatchBuilderService();

    const plan = decisionEngine.decide({
      intent: "new_requirement",
      content: "优化工作台，让用户先看到多方案决策再确认修改",
    });

    expect(plan.strategies.length).toBeGreaterThanOrEqual(3);
    expect(new Set(plan.strategies.map((strategy) => strategy.name)).size).toBe(plan.strategies.length);
    expect(new Set(plan.strategies.map((strategy) => JSON.stringify(strategy.patchOperations))).size).toBe(
      plan.strategies.length,
    );

    const board = reviewBoard.review(plan);
    expect(board.reviews).toHaveLength(5);
    expect(new Set(board.reviews.map((review) => review.preferredStrategyId)).size).toBeGreaterThan(1);
    expect(new Set(board.reviews.map((review) => JSON.stringify(review.scores))).size).toBeGreaterThan(1);

    const knowledgeReferences = [
      {
        id: "knowledge_ref_design_1",
        knowledgeId: "knowledge-design-1",
        title: "评审型原型设计模式",
        snippet: "原型应覆盖关键状态和预览反馈。",
        content: "原型应覆盖关键状态和预览反馈。",
        type: KnowledgeType.design_pattern,
        sourceType: "knowledge_base" as const,
        sourceId: "knowledge-design-1",
      },
      {
        id: "knowledge_ref_strong_1",
        knowledgeId: "knowledge-strong-1",
        title: "补丁预览强规则",
        snippet: "高影响变更必须先走补丁预览。",
        content: "高影响变更必须先走补丁预览。",
        type: KnowledgeType.strong_rule,
        sourceType: "knowledge_base" as const,
        sourceId: "knowledge-strong-1",
      },
    ];
    const selection = selector.select(plan.strategies, board, { knowledgeReferences });
    const selected = plan.strategies.find((strategy) => strategy.id === selection.selectedStrategyId);
    expect(selected).toBeDefined();
    expect(selection.reason).toContain("加权得分");
    expect(selection.knowledgeSummary).toContain("设计模式");
    expect(selection.scores[selected!.id].knowledgeBoost).not.toBe(0);

    const draft = patchBuilder.build(selected!, undefined, knowledgeReferences);
    expect(draft.strategyId).toBe(selected!.id);
    expect(draft.operations).toEqual(selected!.patchOperations);
    expect(draft.targetDomains.length).toBeGreaterThan(0);
    expect(draft.knowledgeRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "knowledge-design-1" }),
      expect.objectContaining({ sourceId: "knowledge-strong-1" }),
    ]));
  });
});
