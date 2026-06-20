import { ProjectStatus, RequirementDocumentStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderPrdFromState } from "../src/ai/agents/prd-writer-agent.service";
import type { ProductDesignState, RequirementDocumentDraft } from "../src/ai/ai-vibe.types";
import { RequirementDocumentService } from "../src/ai/requirement-document.service";

describe("PRD requirement document module", () => {
  const now = new Date("2026-06-20T08:00:00Z");
  const prisma = {
    project: {
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
  };
  const stateService = {
    getCurrentState: vi.fn(),
    getStateByIdForProject: vi.fn(),
  };
  const prdWriterAgent = {
    run: vi.fn(),
  };
  const service = new RequirementDocumentService(
    prisma as never,
    stateService as never,
    prdWriterAgent as never,
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
    prisma.project.findUnique.mockResolvedValue(baseProject());
    prisma.project.update.mockResolvedValue({});
    prisma.requirementDocumentVersion.findFirst.mockResolvedValue(null);
    prisma.requirementDocumentVersion.create.mockImplementation(async ({ data }) => ({
      id: `prd-version-${data.version}`,
      ...data,
      reason: data.reason ?? null,
      createdAt: now,
    }));
  });

  it("renders a structured 16-section PRD from ProductDesignState", () => {
    const draft = renderPrdFromState(baseState());

    expect(draft.sections).toHaveLength(16);
    expect(draft.sections[0]).toEqual(
      expect.objectContaining({
        id: "overview",
        type: "overview",
        level: 1,
        order: 1,
        sourcePaths: ["title", "summary"],
      }),
    );
    expect(draft.sections.at(-1)).toEqual(
      expect.objectContaining({
        id: "pending_questions",
        tags: ["pending_question"],
      }),
    );
    expect(draft.assumptions[0]).toEqual(
      expect.objectContaining({
        assumptionId: "assumption_reward",
        status: "pending",
      }),
    );
    expect(JSON.stringify(draft.sections)).not.toMatch(/GET\s+\/api|CREATE TABLE|```/i);
  });

  it("saves generated documents, creates a version, and updates the project pointer", async () => {
    const state = baseState();
    const draft = renderPrdFromState(state);
    prisma.requirementDocument.create.mockImplementation(async ({ data }) =>
      documentRecord({
        id: "prd-1",
        ...data,
      }),
    );

    const document = await service.saveGeneratedDocument(state, draft, {
      userId: "user-1",
      runId: "run-1",
      reason: "PRD Writer Agent 生成 PRD",
    });

    expect(document.id).toBe("prd-1");
    expect(document.productDesignStateId).toBe("state-1");
    expect(document.productDesignStateVersion).toBe(3);
    expect(document.sections).toHaveLength(16);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
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

  it("loads the current PRD through Project.currentPrdDocumentId", async () => {
    const draft = renderPrdFromState(baseState());
    prisma.project.findUnique.mockResolvedValue(baseProject({ currentPrdDocumentId: "prd-current" }));
    prisma.requirementDocument.findFirst.mockResolvedValueOnce(
      documentRecord({
        id: "prd-current",
        ...draft,
      }),
    );

    const result = await service.getCurrentForUser(user, "project-1");

    expect(prisma.requirementDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "prd-current", projectId: "project-1" },
    });
    expect(result.document?.id).toBe("prd-current");
  });
});

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    ownerId: "user-1",
    status: ProjectStatus.draft,
    deletedAt: null,
    currentPrdDocumentId: null,
    ...overrides,
  };
}

function baseState(overrides: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 3,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃和连续访问。",
    background: "运营希望用轻量活动提升留存。",
    targetUsers: [{ id: "target_user_1", name: "普通用户", description: "参与日常签到的用户" }],
    userScenarios: [{ id: "scenario_1", title: "每日签到", description: "用户进入页面后完成签到" }],
    pages: [{ id: "page_home", name: "签到页", description: "展示签到状态和奖励" }],
    features: [{ id: "feature_checkin", name: "签到", description: "用户点击后完成当日签到" }],
    backendConfigs: [{ id: "config_reward", name: "奖励配置", description: "配置每日奖励额度" }],
    frontendRules: [{ id: "front_status", title: "状态展示", description: "已签到后按钮置灰" }],
    businessRules: [{ id: "rule_daily_once", title: "每日一次", description: "每个用户每天只能签到一次" }],
    stateRules: [{ id: "state_signed", name: "已签到", description: "用户当天完成签到后的状态" }],
    exceptionScenarios: [{ id: "exception_repeat", title: "重复签到", expectedBehavior: "提示今日已签到" }],
    acceptanceCriteria: [{ id: "accept_once", title: "每日签到限制", description: "重复签到不会重复发奖" }],
    assumptions: [{ id: "assumption_reward", content: "默认奖励为积分", status: "pending" }],
    knowledgeRefs: [{ id: "knowledge_1", title: "活动规范", content: "活动必须展示奖励说明" }],
    pendingQuestions: [{ id: "question_reward", question: "积分额度是多少？", status: "pending" }],
    confirmedFacts: [],
    status: "prd_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function documentRecord(input: Partial<RequirementDocumentDraft> & Record<string, unknown>) {
  return {
    id: String(input.id ?? "prd-1"),
    projectId: String(input.projectId ?? "project-1"),
    productDesignStateId: String(input.productDesignStateId ?? "state-1"),
    productDesignStateVersion: Number(input.productDesignStateVersion ?? 3),
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
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-20T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-20T08:00:00Z"),
  };
}
