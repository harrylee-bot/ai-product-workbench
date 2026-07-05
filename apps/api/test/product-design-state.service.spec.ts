import {
  ConversationDesignChangeType,
  ConversationDesignStateStatus,
  ConversationStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationDesignStateService } from "../src/ai/conversation-design-state.service";
import type { ConversationDesignState } from "../src/ai/ai-vibe.types";

describe("ConversationDesignStateService", () => {
  const prisma = {
	    conversationDesignState: {
	      findUnique: vi.fn(),
	      findFirst: vi.fn(),
	      create: vi.fn(),
	      update: vi.fn(),
	      updateMany: vi.fn(),
	    },
    conversationDesignVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    conversationDesignChangeLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
	    conversation: {
	      findUnique: vi.fn(),
	      update: vi.fn(),
	    },
	    rollbackRecord: {
	      create: vi.fn(),
	    },
    // txn-1：事务化后 service 走 prisma.$transaction；测试中让 tx === prisma，复用上面的 model mock。
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  const service = new ConversationDesignStateService(prisma as never);
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversationDesignChangeLog.create.mockImplementation(async ({ data }) => ({
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
    prisma.conversationDesignVersion.create.mockImplementation(async ({ data }) => ({
      id: `version-${data.version}`,
      ...data,
      reason: data.reason ?? null,
      createdAt: new Date("2026-06-20T08:00:00Z"),
    }));
	    prisma.conversation.update.mockResolvedValue({});
	    prisma.conversationDesignState.updateMany.mockResolvedValue({ count: 1 });
	    prisma.rollbackRecord.create.mockImplementation(async ({ data }) => ({
	      id: "rollback-1",
	      ...data,
	      errorMessage: data.errorMessage ?? null,
	      generatedByRunId: data.generatedByRunId ?? null,
	      createdAt: new Date("2026-06-20T08:00:00Z"),
	      updatedAt: new Date("2026-06-20T08:00:00Z"),
	    }));
	  });

  it("creates ConversationDesignState with version snapshot and change log", async () => {
    const createdAt = new Date("2026-06-20T08:00:00Z");
    prisma.conversation.findUnique.mockResolvedValue(baseProject());
    prisma.conversationDesignState.findFirst.mockResolvedValue(null);
    prisma.conversationDesignState.create.mockImplementation(async ({ data }) =>
      stateRecord({
        id: "state-1",
        ...data,
        createdAt,
        updatedAt: createdAt,
      }),
    );

    const result = await service.createStateForUser(user, "conversation-1", {
      title: "签到活动",
      businessGoal: "提升用户活跃",
      initialState: {
        pages: [{ id: "page_home", name: "签到页" }],
        businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
        assumptions: [{ id: "assumption_reward", content: "奖励默认发积分" }],
      } as Partial<ConversationDesignState>,
    });

    expect(result.state.id).toBe("state-1");
    expect(result.state.version).toBe(1);
    expect(result.state.pages[0]).toEqual(expect.objectContaining({ id: "page_home" }));
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { currentDesignStateId: "state-1" },
    });
    expect(prisma.conversationDesignVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        stateId: "state-1",
        version: 1,
        createdBy: "user-1",
      }),
    });
    expect(prisma.conversationDesignChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changeType: ConversationDesignChangeType.create,
        path: "*",
        createdBy: "user-1",
      }),
    });
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
    prisma.conversationDesignState.findUnique.mockResolvedValue({
      ...stateRecord(current),
      conversation: baseProject(),
    });
    prisma.conversationDesignState.update.mockImplementation(async ({ data }) =>
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
    expect(prisma.conversationDesignChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changeType: ConversationDesignChangeType.confirm_assumption,
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
    prisma.conversationDesignState.findUnique.mockResolvedValue({
      ...stateRecord(current),
      conversation: baseProject(),
    });
    prisma.conversationDesignState.update.mockImplementation(async ({ data }) =>
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

  it("syncs scalar PRD section edits into ConversationDesignState and invalidates stale prototype artifacts", async () => {
    const current = baseState({
      version: 3,
      businessGoal: "提升用户活跃",
      status: "confirmed",
    });
    const section = {
      id: "business_goal",
      title: "3. 业务目标",
      type: "business_goal" as const,
      level: 1 as const,
      order: 3,
      content: "提升签到转化率，并让运营能追踪连续签到效果。",
      blocks: [
        {
          id: "business_goal_body",
          type: "paragraph" as const,
          content: "提升签到转化率，并让运营能追踪连续签到效果。",
          sourcePaths: ["businessGoal"],
        },
      ],
      sourcePaths: ["businessGoal"],
    };
    const document = {
      id: "prd-1",
      conversationId: "conversation-1",
      conversationDesignStateId: "state-1",
      conversationDesignStateVersion: 3,
      title: "签到活动 PRD",
      status: "ready" as const,
      sections: [section],
      assumptions: [],
      knowledgeRefs: [],
      pendingQuestions: [],
      validationNotes: [],
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: "2026-06-20T08:00:00.000Z",
      updatedAt: "2026-06-20T09:00:00.000Z",
    };
    prisma.conversationDesignState.findUnique.mockResolvedValue(stateRecord(current));
    prisma.conversationDesignState.update.mockImplementation(async ({ data }) =>
      stateRecord({
        ...current,
        ...data,
        prototypeSpec: undefined,
        prdDocument: data.prdDocument,
        createdAt: new Date(current.createdAt),
        updatedAt: new Date("2026-06-20T09:00:00Z"),
      }),
    );

    const result = await service.syncRequirementDocumentEdit({
      document,
      section,
      userId: "user-1",
    });

    expect(result.version).toBe(4);
    expect(result.status).toBe(ConversationDesignStateStatus.doc_ready);
    expect(result.businessGoal).toBe("提升签到转化率，并让运营能追踪连续签到效果。");
    expect(result.prototypeSpec).toBeUndefined();
    expect(result.prdDocument).toEqual(expect.objectContaining({ id: "prd-1" }));
    expect(result.confirmedFacts).toEqual([
      expect.objectContaining({
        content: "提升签到转化率，并让运营能追踪连续签到效果。",
        relatedPath: "businessGoal",
        confirmedBy: "user-1",
        sourceDocumentId: "prd-1",
        sourceSectionId: "business_goal",
      }),
    ]);
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: expect.objectContaining({
        currentDesignStateId: "state-1",
        status: ConversationStatus.active,
      }),
    });
    expect(prisma.conversationDesignChangeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        changeType: ConversationDesignChangeType.update,
        path: "prdDocument.sections.business_goal",
      }),
    });
  });

	  it("records array PRD section edits as user-confirmed state revisions", async () => {
    const current = baseState({
      version: 4,
      frontendRules: [{ id: "rule_initial", description: "默认可点击" }],
	  });

	    const section = {
      id: "frontend_rules",
      title: "9. 前端展示规则",
      type: "frontend_rules" as const,
      level: 1 as const,
      order: 9,
      content: "按钮文案改为立即签到，已签到后按钮置灰。",
      sourcePaths: ["frontendRules"],
    };
    const document = {
      id: "prd-1",
      conversationId: "conversation-1",
      conversationDesignStateId: "state-1",
      conversationDesignStateVersion: 4,
      title: "签到活动 PRD",
      status: "ready" as const,
      sections: [section],
      assumptions: [],
      knowledgeRefs: [],
      pendingQuestions: [],
      validationNotes: [],
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: "2026-06-20T08:00:00.000Z",
      updatedAt: "2026-06-20T09:00:00.000Z",
    };
    prisma.conversationDesignState.findUnique.mockResolvedValue(stateRecord(current));
    prisma.conversationDesignState.update.mockImplementation(async ({ data }) =>
      stateRecord({
        ...current,
        ...data,
        prototypeSpec: undefined,
        prdDocument: data.prdDocument,
        createdAt: new Date(current.createdAt),
        updatedAt: new Date("2026-06-20T09:00:00Z"),
      }),
    );

    const result = await service.syncRequirementDocumentEdit({
      document,
      section,
      userId: "user-1",
    });

    expect(result.frontendRules).toEqual([
      expect.objectContaining({ id: "rule_initial" }),
      expect.objectContaining({
        title: "9. 前端展示规则",
        description: "按钮文案改为立即签到，已签到后按钮置灰。",
        relatedPath: "frontendRules",
        source: expect.objectContaining({ type: "user_confirmed", confidence: 1 }),
      }),
    ]);
    expect(result.status).toBe(ConversationDesignStateStatus.doc_ready);
    expect(result.prototypeSpec).toBeUndefined();
	    expect(result.confirmedFacts).toEqual([
	      expect.objectContaining({
	        relatedPath: "frontendRules",
	        sourceSectionId: "frontend_rules",
	      }),
	    ]);
	  });

	  it("rolls back state snapshots atomically and records rollback history", async () => {
	    const current = baseState({
	      version: 5,
	      status: ConversationDesignStateStatus.prototype_ready,
	      prdDocument: { id: "prd-current" } as never,
	    });
	    const snapshot = baseState({
	      version: 2,
	      status: ConversationDesignStateStatus.doc_ready,
	      prdDocument: { id: "prd-previous" } as never,
	      prototypeSpec: undefined,
	    });
	    prisma.conversationDesignState.findUnique.mockResolvedValue({
	      ...stateRecord(current),
	      conversation: baseProject(),
	    });
	    prisma.conversationDesignVersion.findFirst
	      .mockResolvedValueOnce({
	        id: "version-target",
	        stateId: "state-1",
	        conversationId: "conversation-1",
	        version: 2,
	        snapshot,
	        reason: "旧版本",
	        createdBy: "user-1",
	        createdAt: new Date("2026-06-20T07:00:00Z"),
	      })
	      .mockResolvedValueOnce({ version: 5 });
	    prisma.conversationDesignState.findFirst.mockResolvedValue({ version: 5 });
	    prisma.conversationDesignState.update.mockImplementation(async ({ data }) =>
	      stateRecord({
	        ...snapshot,
	        id: "state-1",
	        conversationId: "conversation-1",
	        version: data.version,
	        updatedBy: data.updatedBy,
	        createdAt: new Date(current.createdAt),
	        updatedAt: new Date("2026-06-20T09:00:00Z"),
	      }),
	    );

	    const result = await service.rollbackForUser(user, "state-1", {
	      versionId: "version-target",
	      reason: "恢复到可用 PRD",
	    });

	    expect(result.state.version).toBe(6);
	    expect(result.state.prdDocument).toEqual(expect.objectContaining({ id: "prd-previous" }));
	    expect(prisma.conversation.update).toHaveBeenCalledWith({
	      where: { id: "conversation-1" },
	      data: expect.objectContaining({
	        currentDesignStateId: "state-1",
	        status: ConversationStatus.active,
	      }),
	    });
	    expect(prisma.rollbackRecord.create).toHaveBeenCalledWith({
	      data: expect.objectContaining({
	        conversationId: "conversation-1",
	        fromConversationDesignStateVersion: 5,
	        toConversationDesignStateVersion: 6,
	        beforePrdDocumentId: "prd-current",
	        afterPrdDocumentId: "prd-previous",
	        reason: "恢复到可用 PRD",
	        status: "completed",
	        createdBy: "user-1",
	      }),
	    });
	  });

});

function baseProject() {
  return {
    id: "conversation-1",
    ownerId: "user-1",
    status: ConversationStatus.draft,
    deletedAt: null,
    conversationDesignStates: [],
  };
}

function baseState(overrides: Partial<ConversationDesignState> = {}): ConversationDesignState {
  return {
    id: "state-1",
    conversationId: "conversation-1",
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
      conversationId: "conversation-1",
      pages: [],
      components: [],
      states: [],
      interactions: [],
      dialogs: [],
      styleGuide: {},
    },
    prdDocument: {
      id: "prd-1",
      conversationId: "conversation-1",
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

function stateRecord(input: Partial<ConversationDesignState> & Record<string, unknown>) {
  const state = baseState(input);
  return {
    id: state.id,
    conversationId: state.conversationId,
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
