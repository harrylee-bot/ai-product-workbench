import {
  ProductDesignChangeType,
  ProductDesignStateStatus,
  ProjectStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductDesignStateService } from "../src/ai/product-design-state.service";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";

describe("ProductDesignStateService", () => {
  const prisma = {
    productDesignState: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    productDesignVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    productDesignChangeLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const service = new ProductDesignStateService(prisma as never);
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.productDesignChangeLog.create.mockImplementation(async ({ data }) => ({
      id: `change-${Math.random()}`,
      ...data,
      runId: data.runId ?? null,
      messageId: data.messageId ?? null,
      path: data.path ?? null,
      before: data.before ?? null,
      after: data.after ?? null,
      reason: data.reason ?? null,
      createdAt: new Date("2026-06-20T08:00:00Z"),
    }));
    prisma.productDesignVersion.create.mockImplementation(async ({ data }) => ({
      id: `version-${data.version}`,
      ...data,
      reason: data.reason ?? null,
      createdAt: new Date("2026-06-20T08:00:00Z"),
    }));
    prisma.project.update.mockResolvedValue({});
  });

  it("creates ProductDesignState with version snapshot and change log", async () => {
    const createdAt = new Date("2026-06-20T08:00:00Z");
    prisma.project.findUnique.mockResolvedValue(baseProject());
    prisma.productDesignState.findFirst.mockResolvedValue(null);
    prisma.productDesignState.create.mockImplementation(async ({ data }) =>
      stateRecord({
        id: "state-1",
        ...data,
        createdAt,
        updatedAt: createdAt,
      }),
    );

    const result = await service.createStateForUser(user, "project-1", {
      title: "签到活动",
      businessGoal: "提升用户活跃",
      initialState: {
        pages: [{ id: "page_home", name: "签到页" }],
        businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
        assumptions: [{ id: "assumption_reward", content: "奖励默认发积分" }],
      } as Partial<ProductDesignState>,
    });

    expect(result.state.id).toBe("state-1");
    expect(result.state.version).toBe(1);
    expect(result.state.pages[0]).toEqual(expect.objectContaining({ id: "page_home" }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { currentProductDesignStateId: "state-1" },
    });
    expect(prisma.productDesignVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        stateId: "state-1",
        version: 1,
        createdBy: "user-1",
      }),
    });
    expect(prisma.productDesignChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changeType: ProductDesignChangeType.create,
        path: "*",
        createdBy: "user-1",
      }),
    });
  });

  it("applies patch operations, clears generated artifacts, and creates version", async () => {
    const current = baseState();
    prisma.productDesignState.findUnique.mockResolvedValue({
      ...stateRecord(current),
      project: baseProject(),
    });
    prisma.productDesignState.update.mockImplementation(async ({ data }) =>
      stateRecord({
        ...current,
        ...data,
        prototypeSpec: null,
        prdDocument: null,
        createdAt: new Date(current.createdAt),
        updatedAt: new Date("2026-06-20T09:00:00Z"),
      }),
    );

    const result = await service.applyPatchForUser(user, current.id, {
      operations: [
        {
          op: "add",
          path: "frontendRules",
          value: {
            id: "rule_disabled_before_start",
            title: "未开始置灰",
            description: "未开始时按钮置灰，文案为活动未开始。",
          },
          reason: "补充状态展示",
        },
      ],
      reason: "局部修改按钮状态",
    });

    expect(result.state.version).toBe(2);
    expect(result.state.status).toBe(ProductDesignStateStatus.patching);
    expect(result.state.frontendRules).toEqual([
      expect.objectContaining({ id: "rule_initial" }),
      expect.objectContaining({ id: "rule_disabled_before_start" }),
    ]);
    expect(result.state.prdDocument).toBeUndefined();
    expect(result.state.prototypeSpec).toBeUndefined();
    expect(result.changeLogs[0]).toEqual(
      expect.objectContaining({
        changeType: ProductDesignChangeType.patch,
        path: "frontendRules",
      }),
    );
    expect(result.version).toEqual(expect.objectContaining({ version: 2 }));
  });

  it("confirms assumptions and records confirmed facts", async () => {
    const current = baseState({
      assumptions: [
        {
          id: "assumption_reward",
          content: "签到奖励默认发积分",
          relatedPath: "businessRules.rule_daily_once",
          status: "pending",
        },
      ],
    });
    prisma.productDesignState.findUnique.mockResolvedValue({
      ...stateRecord(current),
      project: baseProject(),
    });
    prisma.productDesignState.update.mockImplementation(async ({ data }) =>
      stateRecord({
        ...current,
        ...data,
        assumptions: data.assumptions,
        confirmedFacts: data.confirmedFacts,
        createdAt: new Date(current.createdAt),
        updatedAt: new Date("2026-06-20T09:00:00Z"),
      }),
    );

    const result = await service.confirmAssumptionForUser(
      user,
      current.id,
      "assumption_reward",
    );

    expect(result.state.assumptions[0]).toEqual(expect.objectContaining({ status: "confirmed" }));
    expect(result.state.confirmedFacts[0]).toEqual(
      expect.objectContaining({ content: "签到奖励默认发积分", confirmedBy: "user-1" }),
    );
    expect(prisma.productDesignChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changeType: ProductDesignChangeType.confirm_assumption,
        path: "assumptions.assumption_reward",
      }),
    });
  });

  it("answers clarification questions and writes confirmed facts", async () => {
    const current = baseState({
      pendingQuestions: [
        {
          id: "question_reward",
          question: "签到奖励类型是什么？",
          relatedPath: "businessGoal",
          status: "pending",
        },
      ],
    });
    prisma.productDesignState.findUnique.mockResolvedValue({
      ...stateRecord(current),
      project: baseProject(),
    });
    prisma.productDesignState.update.mockImplementation(async ({ data }) =>
      stateRecord({
        ...current,
        ...data,
        pendingQuestions: data.pendingQuestions,
        confirmedFacts: data.confirmedFacts,
        businessGoal: data.businessGoal,
        createdAt: new Date(current.createdAt),
        updatedAt: new Date("2026-06-20T09:00:00Z"),
      }),
    );

    const result = await service.answerQuestionForUser(user, current.id, "question_reward", {
      answer: "签到奖励采用积分",
    });

    expect(result.state.pendingQuestions[0]).toEqual(expect.objectContaining({ status: "answered" }));
    expect(result.state.confirmedFacts[0]).toEqual(
      expect.objectContaining({ content: "签到奖励采用积分" }),
    );
    expect(result.state.businessGoal).toBe("签到奖励采用积分");
  });
});

function baseProject() {
  return {
    id: "project-1",
    ownerId: "user-1",
    status: ProjectStatus.draft,
    deletedAt: null,
    productDesignStates: [],
  };
}

function baseState(overrides: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 1,
    title: "签到活动",
    summary: "签到活动摘要",
    businessGoal: "提升用户活跃",
    background: "活动背景",
    targetUsers: [{ id: "target_user_1", name: "普通用户" }],
    userScenarios: [{ id: "scenario_1", title: "用户签到" }],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [{ id: "feature_checkin", name: "签到" }],
    backendConfigs: [],
    frontendRules: [{ id: "rule_initial", description: "默认可点击" }],
    businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
    stateRules: [{ id: "state_default", name: "默认态" }],
    exceptionScenarios: [{ id: "exception_network", title: "网络异常" }],
    acceptanceCriteria: [],
    prototypeOutline: undefined,
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
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
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function stateRecord(input: Partial<ProductDesignState> & Record<string, unknown>) {
  const state = baseState(input);
  return {
    id: state.id,
    projectId: state.projectId,
    version: state.version,
    title: state.title,
    summary: state.summary ?? null,
    businessGoal: state.businessGoal,
    background: state.background ?? null,
    targetUsers: state.targetUsers,
    userScenarios: state.userScenarios,
    pages: state.pages,
    features: state.features,
    backendConfigs: state.backendConfigs,
    frontendRules: state.frontendRules,
    businessRules: state.businessRules,
    stateRules: state.stateRules,
    exceptionScenarios: state.exceptionScenarios,
    acceptanceCriteria: state.acceptanceCriteria,
    prototypeOutline: state.prototypeOutline ?? null,
    assumptions: state.assumptions,
    knowledgeRefs: state.knowledgeRefs,
    pendingQuestions: state.pendingQuestions,
    confirmedFacts: state.confirmedFacts,
    prototypeSpec: state.prototypeSpec ?? null,
    prdDocument: state.prdDocument ?? null,
    status: state.status,
    createdBy: state.createdBy,
    updatedBy: state.updatedBy ?? null,
    createdAt:
      input.createdAt instanceof Date ? input.createdAt : new Date(state.createdAt),
    updatedAt:
      input.updatedAt instanceof Date ? input.updatedAt : new Date(state.updatedAt),
  };
}
