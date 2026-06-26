import { describe, expect, it, vi } from "vitest";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";
import { ProductRuntimeService } from "../src/ai/runtime/product-runtime.service";

describe("ProductRuntimeService external runtime routing", () => {
  it("routes PrototypeSpec generation to the configured external runtime", async () => {
    const runtime = { runTask: vi.fn().mockResolvedValue({ status: "completed", output: prototypeSpecOutput(), events: [] }) };
    const service = new ProductRuntimeService(config({ prototypeSpecProvider: "deerflow" }) as never, runtime as never);

    const result = await service.generatePrototypeSpec({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      productDesignState: baseState(),
      targetDevice: "mobile",
    });

    expect(runtime.runTask).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "generate_prototype",
      input: expect.objectContaining({ targetDevice: "mobile" }),
    }), "deerflow");
    expect(result.data.productDesignStateId).toBe("state-1");
    expect(result.data.pages[0]?.components[0]?.id).toBe("hero");
  });

  it("routes PatchPlan generation to Codex runtime for document selections", async () => {
    const runtime = { runTask: vi.fn().mockResolvedValue({ status: "completed", output: patchPlanOutput(), events: [] }) };
    const service = new ProductRuntimeService(config({ patchPlanProvider: "codex" }) as never, runtime as never);

    const result = await service.planPatch({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      userInput: "把按钮文案改成立即签到",
      selectedRegion: {
        type: "document",
        targetId: "prd-1",
        sectionId: "overview",
        label: "需求概述",
      },
      productDesignState: baseState(),
    });

    expect(runtime.runTask).toHaveBeenCalledWith(expect.objectContaining({
      taskType: "patch_prd",
      input: expect.objectContaining({ userInput: "把按钮文案改成立即签到" }),
    }), "codex");
    expect(result.data.operations[0]).toEqual(expect.objectContaining({
      op: "replace",
      path: "businessRules.0.description",
    }));
  });

  it("routes QA review to the configured external runtime", async () => {
    const runtime = { runTask: vi.fn().mockResolvedValue({ status: "completed", output: qaOutput(), events: [] }) };
    const service = new ProductRuntimeService(config({ qaProvider: "deerflow" }) as never, runtime as never);

    const result = await service.runQa({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      productDesignState: baseState(),
    });

    expect(runtime.runTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: "qa_review" }), "deerflow");
    expect(result.data.status).toBe("warning");
    expect(result.data.issues[0]?.checkType).toBe("state_prd_consistency");
  });

  it("throws runtime errors when local fallback is disabled", async () => {
    const runtime = { runTask: vi.fn().mockRejectedValue(new Error("runtime down")) };
    const service = new ProductRuntimeService(
      config({ patchPlanProvider: "codex", runtimeFallbackToLocal: false }) as never,
      runtime as never,
    );

    await expect(service.planPatch({
      runId: "run-1",
      projectId: "project-1",
      traceId: "trace-1",
      userId: "user-1",
      userInput: "改一下",
      selectedRegion: { type: "document", targetId: "prd-1" },
      productDesignState: baseState(),
    })).rejects.toThrow("runtime down");
  });
});

function config(overrides: Partial<{
  prototypeSpecProvider: "local" | "codex" | "deerflow";
  patchPlanProvider: "local" | "codex" | "deerflow";
  qaProvider: "local" | "codex" | "deerflow";
  prototypeCodeProvider: "local" | "codex" | "deerflow";
  runtimeFallbackToLocal: boolean;
}> = {}) {
  return {
    prototypeSpecProvider: () => overrides.prototypeSpecProvider ?? "local",
    patchPlanProvider: () => overrides.patchPlanProvider ?? "local",
    qaProvider: () => overrides.qaProvider ?? "local",
    prototypeCodeProvider: () => overrides.prototypeCodeProvider ?? "local",
    runtimeFallbackToLocal: () => overrides.runtimeFallbackToLocal ?? true,
  };
}

function prototypeSpecOutput() {
  return {
    id: "spec-runtime",
    title: "签到活动移动端原型",
    targetDevice: "mobile",
    styleGuide: { tone: "clean", layoutDensity: "comfortable", borderRadius: "small" },
    pages: [{
      id: "home",
      name: "签到首页",
      device: "mobile",
      layout: "mobile_page",
      sourcePaths: ["pages.0"],
      order: 1,
      components: [{
        id: "hero",
        name: "签到卡片",
        type: "card",
        content: "连续签到领积分",
        sourcePaths: ["features.0"],
      }],
    }],
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: [],
  };
}

function patchPlanOutput() {
  return {
    patchType: "document",
    targetNodes: ["overview"],
    impactScope: ["businessRules", "prdDocument"],
    operations: [{
      op: "replace",
      path: "businessRules.0.description",
      value: "按钮文案改成立即签到",
      reason: "用户要求修改文案",
    }],
    regenerationPlan: { prd: "affected_sections", prototypeSpec: "affected_pages", htmlPrototype: "affected_pages", qa: "basic" },
    risks: [{ level: "low", message: "仅修改文案" }],
    needUserConfirm: true,
    needsUserConfirmation: true,
    reason: "由 Codex runtime 规划 PatchPlan",
    summary: "更新按钮文案",
  };
}

function qaOutput() {
  return {
    status: "warning",
    summary: "发现 1 个一致性提醒。",
    issues: [{
      id: "qa-runtime-1",
      checkType: "state_prd_consistency",
      severity: "minor",
      title: "PRD 未同步按钮文案",
      description: "ProductDesignState 中的新按钮文案需要同步到 PRD。",
      status: "open",
    }],
  };
}

function baseState(): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 3,
    title: "签到活动",
    summary: "用户每天签到领取积分。",
    businessGoal: "提升日活和留存。",
    targetUsers: [{ name: "普通用户" }],
    userScenarios: [],
    pages: [{ id: "home", name: "签到首页" }],
    features: [{ id: "checkin", name: "签到" }],
    backendConfigs: [],
    frontendRules: [],
    businessRules: [],
    stateRules: [],
    exceptionScenarios: [],
    acceptanceCriteria: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "draft",
    createdBy: "user-1",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
  };
}
