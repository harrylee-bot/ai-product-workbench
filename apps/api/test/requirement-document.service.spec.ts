import {
  KnowledgeCandidateSource,
  ConversationStatus,
  RequirementDocumentStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDesignState,
  RequirementDocumentDraft,
} from "../src/ai/ai-vibe.types";
import { RequirementDocumentService } from "../src/ai/requirement-document.service";

describe("PRD requirement document module", () => {
  const now = new Date("2026-06-20T08:00:00Z");
  const prisma = {
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    requirementDocument: {
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    requirementDocumentVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
    ),
  };
  const stateService = {
    getCurrentState: vi.fn(),
    getStateByIdForConversation: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
    syncRequirementDocumentEdit: vi.fn(),
  };
  const qaService = {
    assertGateAllows: vi.fn(),
  };
  const knowledgeCandidateService = {
    createMany: vi.fn(),
  };
  const service = new RequirementDocumentService(
    prisma as never,
    stateService as never,
    knowledgeCandidateService as never,
    qaService as never,
  );
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findUnique.mockResolvedValue(baseProject());
    prisma.conversation.update.mockResolvedValue({});
    prisma.requirementDocumentVersion.findFirst.mockResolvedValue(null);
    prisma.requirementDocumentVersion.create.mockImplementation(
      async ({ data }) => ({
        id: `prd-version-${data.version}`,
        ...data,
        reason: data.reason ?? null,
        createdAt: now,
      }),
    );
    stateService.attachGeneratedArtifacts.mockImplementation(
      async (_stateId, input) => ({
        ...baseState(),
        version: 4,
        status: input.status,
        prdDocument: input.prdDocument,
      }),
    );
    stateService.syncRequirementDocumentEdit.mockImplementation(
      async (input) => ({
        ...baseState(),
        version: 4,
        status: "doc_ready",
        prdDocument: input.document,
        prototypeSpec: undefined,
      }),
    );
    knowledgeCandidateService.createMany.mockResolvedValue({ items: [] });
  });

  it("saves generated documents, creates a version, and updates the conversation pointer", async () => {
    const state = baseState();
    const draft = prdDraft(state);
    prisma.requirementDocument.create.mockImplementation(async ({ data }) =>
      documentRecord({
        id: "prd-1",
        ...data,
      }),
    );

    const document = await service.saveGeneratedDocument(state, draft, {
      userId: "user-1",
      runId: "run-1",
      reason: "DeerFlow 生成 PRD",
    });

    expect(document.id).toBe("prd-1");
    expect(document.conversationDesignStateId).toBe("state-1");
    expect(document.conversationDesignStateVersion).toBe(3);
    expect(document.sections).toHaveLength(2);
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { currentPrdDocumentId: "prd-1" },
    });
    expect(prisma.requirementDocumentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "prd-1",
        version: 1,
        createdBy: "user-1",
      }),
    });
  });

  it("loads the current PRD through Conversation.currentPrdDocumentId", async () => {
    const draft = prdDraft(baseState());
    prisma.conversation.findUnique.mockResolvedValue(
      baseProject({ currentPrdDocumentId: "prd-current" }),
    );
    prisma.requirementDocument.findFirst.mockResolvedValueOnce(
      documentRecord({
        id: "prd-current",
        ...draft,
      }),
    );

    const result = await service.getCurrentForUser(user, "conversation-1");

    expect(prisma.requirementDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "prd-current", conversationId: "conversation-1" },
    });
    expect(result.document?.id).toBe("prd-current");
  });

  it("does not trust a stale PRD snapshot embedded in ConversationDesignState", async () => {
    const statePrd = documentRecord({
      id: "prd-state",
      ...prdDraft(baseState()),
    });
    stateService.getCurrentState.mockResolvedValue(
      baseState({
        version: 4,
        prdDocument: {
          ...statePrd,
          status: "ready",
          createdAt: statePrd.createdAt.toISOString(),
          updatedAt: statePrd.updatedAt.toISOString(),
        },
      }),
    );
    prisma.conversation.findUnique.mockResolvedValue(
      baseProject({ currentPrdDocumentId: "prd-stale" }),
    );
    prisma.requirementDocument.findFirst.mockResolvedValueOnce(null);

    const result = await service.getCurrentForUser(user, "conversation-1");

    expect(result.document).toBeNull();
    expect(prisma.requirementDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "prd-stale", conversationId: "conversation-1" },
    });
  });

  it("updates a section, creates a version, and syncs the PRD back into ConversationDesignState", async () => {
    const draft = prdDraft(baseState());
    prisma.requirementDocument.findUnique.mockResolvedValue({
      ...documentRecord({
        id: "prd-1",
        ...draft,
        status: "confirmed",
      }),
      conversation: baseProject(),
    });
    prisma.requirementDocument.update.mockImplementation(async ({ data }) =>
      documentRecord({
        id: "prd-1",
        ...draft,
        status: data.status,
        sections: data.sections,
        updatedBy: data.updatedBy,
      }),
    );

    const result = await service.updateSectionForUser(
      user,
      "prd-1",
      "business_goal",
      {
        content: "提升签到转化率，并让运营能清楚追踪连续签到效果。",
      },
    );

    const section = result.document.sections.find(
      (item) => item.id === "business_goal",
    );
    expect(result.document.status).toBe("ready");
    expect(section?.content).toBe(
      "提升签到转化率，并让运营能清楚追踪连续签到效果。",
    );
    expect(section?.blocks?.[0]).toEqual(
      expect.objectContaining({
        id: "business_goal_body",
        content: "提升签到转化率，并让运营能清楚追踪连续签到效果。",
      }),
    );
    expect(stateService.syncRequirementDocumentEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: "prd-1", status: "ready" }),
        section: expect.objectContaining({ id: "business_goal" }),
        userId: "user-1",
      }),
    );
  });

  it("updates the whole PRD markdown and creates a restorable version", async () => {
    const draft = prdDraft(baseState());
    prisma.requirementDocument.findUnique.mockResolvedValue({
      ...documentRecord({
        id: "prd-1",
        ...draft,
        status: "confirmed",
      }),
      conversation: baseProject(),
    });
    prisma.requirementDocument.update.mockImplementation(async ({ data }) =>
      documentRecord({
        id: "prd-1",
        ...draft,
        title: data.title,
        status: data.status,
        sections: data.sections,
        updatedBy: data.updatedBy,
      }),
    );

    const result = await service.updateDocumentContentForUser(user, "prd-1", {
      content: [
        "# 连续打开 5 天达成奖励活动需求说明书",
        "",
        "## 需求概览",
        "",
        "连续 5 天打开后发放一次性奖励。",
        "",
        "## 新增风控说明",
        "",
        "同一用户每天只能记一次打开。",
      ].join("\n"),
    });

    expect(result.document.title).toBe("连续打开 5 天达成奖励活动需求说明书");
    expect(result.document.sections).toEqual([
      expect.objectContaining({
        id: "overview",
        title: "需求概览",
        content: "连续 5 天打开后发放一次性奖励。",
        order: 1,
      }),
      expect.objectContaining({
        title: "新增风控说明",
        content: "同一用户每天只能记一次打开。",
        order: 2,
      }),
    ]);
    expect(prisma.requirementDocumentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: "prd-1",
        version: 1,
        reason: "整文编辑 PRD",
        createdBy: "user-1",
      }),
    });
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith(
      "state-1",
      expect.objectContaining({
        prdDocument: expect.objectContaining({ id: "prd-1", status: "ready" }),
        status: "doc_ready",
        userId: "user-1",
      }),
    );
  });

  it("confirms a PRD for the prototype gate and syncs doc_confirmed into ConversationDesignState", async () => {
    const draft = prdDraft(baseState());
    prisma.requirementDocument.findUnique.mockResolvedValue({
      ...documentRecord({
        id: "prd-1",
        ...draft,
      }),
      conversation: baseProject(),
    });

    prisma.requirementDocument.update.mockImplementation(async ({ data }) =>
      documentRecord({
        id: "prd-1",
        ...draft,
        status: data.status,
        updatedBy: data.updatedBy,
      }),
    );
    stateService.getStateByIdForConversation.mockResolvedValue(
      baseState({ status: "doc_ready" }),
    );

    const result = await service.confirmForPrototypeGate(user, "prd-1");

    expect(result.document.status).toBe("confirmed");
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith(
      "state-1",
      expect.objectContaining({
        prdDocument: expect.objectContaining({
          id: "prd-1",
          status: "confirmed",
        }),
        status: "doc_confirmed",
      }),
    );
  });

  it("extracts pending knowledge candidates after PRD confirmation", async () => {
    const draft = prdDraft(baseState());
    prisma.requirementDocument.findUnique.mockResolvedValue({
      ...documentRecord({
        id: "prd-1",
        ...draft,
      }),
      conversation: baseProject(),
    });
    prisma.requirementDocument.update.mockImplementation(async ({ data }) =>
      documentRecord({
        id: "prd-1",
        ...draft,
        status: data.status,
        updatedBy: data.updatedBy,
      }),
    );
    stateService.getStateByIdForConversation.mockResolvedValue(
      baseState({ status: "doc_ready" }),
    );
    qaService.assertGateAllows.mockResolvedValue({
      allowPersistKnowledge: true,
    });
    knowledgeCandidateService.createMany.mockResolvedValue({
      items: [{ id: "candidate-1", title: "业务目标候选" }],
    });

    const result = await service.confirmForUser(user, "prd-1", "确认 PRD");

    expect(knowledgeCandidateService.createMany).toHaveBeenCalledWith(
      "conversation-1",
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringContaining("业务目标"),
          sourcePath: "sections.business_goal",
        }),
      ]),
      { source: KnowledgeCandidateSource.prd, sourceRefId: "prd-1" },
    );
    expect(result.knowledgeCandidates.items).toEqual([
      expect.objectContaining({ id: "candidate-1" }),
    ]);
  });

  it("blocks PRD confirmation when QA gate does not allow artifact confirmation", async () => {
    qaService.assertGateAllows.mockRejectedValue(new Error("QA_GATE_BLOCKED"));
    prisma.requirementDocument.findUnique.mockResolvedValue({
      ...documentRecord({
        id: "prd-1",
        ...prdDraft(baseState()),
      }),
      conversation: baseProject({ status: ConversationStatus.qa_failed }),
    });

    await expect(
      service.confirmForUser(user, "prd-1", "确认 PRD"),
    ).rejects.toThrow("QA_GATE_BLOCKED");

    expect(qaService.assertGateAllows).toHaveBeenCalledWith(
      user,
      "conversation-1",
      "confirm_artifacts",
    );
    expect(prisma.requirementDocument.update).not.toHaveBeenCalled();
    expect(prisma.requirementDocumentVersion.create).not.toHaveBeenCalled();
  });
});

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    ownerId: "user-1",
    status: ConversationStatus.draft,
    deletedAt: null,
    currentPrdDocumentId: null,
    ...overrides,
  };
}

function baseState(
  overrides: Partial<ConversationDesignState> = {},
): ConversationDesignState {
  return {
    id: "state-1",
    conversationId: "conversation-1",
    version: 3,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃和连续访问。",
    background: "运营希望用轻量活动提升留存。",
    targetUsers: [
      {
        id: "target_user_1",
        name: "普通用户",
        description: "参与日常签到的用户",
      },
    ],
    userScenarios: [
      {
        id: "scenario_1",
        title: "每日签到",
        description: "用户进入页面后完成签到",
      },
    ],
    pages: [
      { id: "page_home", name: "签到页", description: "展示签到状态和奖励" },
    ],
    features: [
      {
        id: "feature_checkin",
        name: "签到",
        description: "用户点击后完成当日签到",
      },
    ],
    backendConfigs: [
      {
        id: "config_reward",
        name: "奖励配置",
        description: "配置每日奖励额度",
      },
    ],
    frontendRules: [
      {
        id: "front_status",
        title: "状态展示",
        description: "已签到后按钮置灰",
      },
    ],
    businessRules: [
      {
        id: "rule_daily_once",
        title: "每日一次",
        description: "每个用户每天只能签到一次",
      },
    ],
    stateRules: [
      {
        id: "state_signed",
        name: "已签到",
        description: "用户当天完成签到后的状态",
      },
    ],
    exceptionScenarios: [
      {
        id: "exception_repeat",
        title: "重复签到",
        expectedBehavior: "提示今日已签到",
      },
    ],
    acceptanceCriteria: [
      {
        id: "accept_once",
        title: "每日签到限制",
        description: "重复签到不会重复发奖",
      },
    ],
    assumptions: [
      { id: "assumption_reward", content: "默认奖励为积分", status: "pending" },
    ],
    knowledgeRefs: [
      { id: "knowledge_1", title: "活动规范", content: "活动必须展示奖励说明" },
    ],
    pendingQuestions: [
      {
        id: "question_reward",
        question: "积分额度是多少？",
        status: "pending",
      },
    ],
    confirmedFacts: [],
    status: "prd_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function prdDraft(state: ConversationDesignState): RequirementDocumentDraft {
  return {
    conversationId: state.conversationId,
    title: `${state.title} PRD`,
    sections: [
      {
        id: "overview",
        title: "需求概览",
        type: "overview",
        level: 1,
        order: 1,
        content: state.summary ?? state.title,
        sourcePaths: ["title", "summary"],
      },
      {
        id: "business_goal",
        title: "业务目标",
        type: "business_goal",
        level: 1,
        order: 2,
        content: state.businessGoal,
        sourcePaths: ["businessGoal"],
      },
    ],
    assumptions: state.assumptions.map((item) => ({
      assumptionId: String(item.id ?? "assumption_1"),
      content: String(item.content ?? ""),
      relatedSectionIds: ["overview"],
      status: "pending",
    })),
    knowledgeRefs: state.knowledgeRefs,
    pendingQuestions: state.pendingQuestions.map((item) => ({
      questionId: String(item.id ?? "question_1"),
      question: String(item.question ?? ""),
      reason: "待用户确认",
      relatedSectionIds: ["overview"],
      status: "pending",
    })),
    validationNotes: [],
  };
}

function documentRecord(
  input: Partial<RequirementDocumentDraft> & Record<string, unknown>,
) {
  return {
    id: String(input.id ?? "prd-1"),
    conversationId: String(input.conversationId ?? "conversation-1"),
    conversationDesignStateId: String(
      input.conversationDesignStateId ?? "state-1",
    ),
    conversationDesignStateVersion: Number(
      input.conversationDesignStateVersion ?? 3,
    ),
    title: String(input.title ?? "签到活动 PRD"),
    status: input.status ?? RequirementDocumentStatus.ready,
    sections: input.sections ?? [],
    assumptions: input.assumptions ?? [],
    knowledgeRefs: input.knowledgeRefs ?? [],
    pendingQuestions: input.pendingQuestions ?? [],
    validationNotes: input.validationNotes ?? [],
    generatedByRunId: input.generatedByRunId ?? null,
    createdBy: String(input.createdBy ?? "user-1"),
    updatedBy: input.updatedBy ? String(input.updatedBy) : null,
    createdAt:
      input.createdAt instanceof Date
        ? input.createdAt
        : new Date("2026-06-20T08:00:00Z"),
    updatedAt:
      input.updatedAt instanceof Date
        ? input.updatedAt
        : new Date("2026-06-20T08:00:00Z"),
  };
}
