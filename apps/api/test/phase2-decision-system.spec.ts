import { describe, expect, it } from "vitest";
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

    const selection = selector.select(plan.strategies, board);
    const selected = plan.strategies.find((strategy) => strategy.id === selection.selectedStrategyId);
    expect(selected).toBeDefined();
    expect(selection.reason).toContain("weightedScore");

    const draft = patchBuilder.build(selected!);
    expect(draft.strategyId).toBe(selected!.id);
    expect(draft.operations).toEqual(selected!.patchOperations);
    expect(draft.targetDomains.length).toBeGreaterThan(0);
  });
});
