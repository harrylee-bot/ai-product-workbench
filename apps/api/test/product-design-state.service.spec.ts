import { ProductDesignStateStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductDesignStateService } from "../src/ai/product-design-state.service";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";

describe("ProductDesignStateService", () => {
  const prisma = {
    productDesignState: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    project: {
      update: vi.fn(),
    },
  };
  const service = new ProductDesignStateService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies patch operations by creating a new ProductDesignState version", async () => {
    const createdAt = new Date("2026-06-20T08:00:00Z");
    const currentState = baseState(createdAt);
    prisma.productDesignState.findFirst.mockResolvedValue({ version: 1 });
    prisma.productDesignState.create.mockImplementation(async ({ data }) => ({
      id: "state-2",
      ...data,
      background: data.background ?? null,
      prototypeSpec: data.prototypeSpec,
      prdDocument: data.prdDocument,
      createdAt,
      updatedAt: createdAt,
    }));

    const result = await service.applyPatch("project-1", currentState, {
      patchType: "prototype",
      targetNodes: ["button-primary"],
      impactScope: ["frontendRules", "stateRules"],
      operations: [
        {
          op: "add",
          path: "frontendRules",
          value: {
            id: "rule_disabled_before_start",
            description: "未开始时按钮置灰，文案为活动未开始。",
          },
          reason: "用户要求补充未开始状态。",
        },
      ],
      needUserConfirm: false,
      reason: "局部修改按钮状态。",
    });

    expect(prisma.productDesignState.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        version: 2,
        status: ProductDesignStateStatus.patching,
        prdDocument: undefined,
        prototypeSpec: undefined,
      }),
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { currentProductDesignStateId: "state-2" },
    });
    expect(result.version).toBe(2);
    expect(result.frontendRules).toEqual([
      expect.objectContaining({ id: "rule_initial" }),
      expect.objectContaining({
        id: "rule_disabled_before_start",
        description: "未开始时按钮置灰，文案为活动未开始。",
      }),
    ]);
    expect(result.prdDocument).toBeUndefined();
    expect(result.prototypeSpec).toBeUndefined();
  });
});

function baseState(date: Date): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 1,
    title: "签到活动",
    businessGoal: "提升用户活跃",
    background: "活动背景",
    targetUsers: ["普通用户"],
    userScenarios: ["用户签到"],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [{ id: "feature_checkin", name: "签到" }],
    backendConfigs: [],
    frontendRules: [{ id: "rule_initial", description: "默认可点击" }],
    businessRules: [],
    stateRules: [{ id: "state_default", description: "默认态" }],
    exceptionScenarios: [],
    acceptanceCriteria: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    prototypeSpec: {
      id: "prototype-1",
      projectId: "project-1",
      pages: [],
      components: [],
      states: [],
      interactions: [],
      dialogs: [],
      styleGuide: {},
    },
    prdDocument: {
      id: "prd-1",
      projectId: "project-1",
      title: "签到活动 PRD",
      sections: [],
      knowledgeRefs: [],
      assumptions: [],
      validationNotes: [],
    },
    status: "prototype_ready",
    createdAt: date.toISOString(),
    updatedAt: date.toISOString(),
  };
}
