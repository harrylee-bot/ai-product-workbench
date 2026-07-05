import { describe, expect, it, vi } from "vitest";
import { FinalActionApplierService } from "../src/ai/final-action-applier.service";
import type { DeerFlowFinalAction, DeerFlowResolvedArtifact } from "../src/ai/deerflow-runtime.service";

describe("FinalActionApplierService", () => {
  const stateService = {
    createDraft: vi.fn(),
    createDraftInTransaction: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
    attachGeneratedArtifactsInTransaction: vi.fn(),
    getCurrentState: vi.fn(),
    getCurrentStateInTransaction: vi.fn(),
  };
  const documentService = {
    saveGeneratedDocument: vi.fn(),
    saveGeneratedDocumentInTransaction: vi.fn(),
  };
  const prototypeService = {
    saveGeneratedPrototype: vi.fn(),
    saveGeneratedPrototypeInTransaction: vi.fn(),
  };
  const prisma = {
    conversation: { findUnique: vi.fn() },
    requirementDocument: { findMany: vi.fn() },
    $transaction: vi.fn((callback) => callback(prisma)),
  };
  const service = new FinalActionApplierService(
    prisma as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findUnique.mockResolvedValue({ currentPrdDocumentId: null });
    prisma.requirementDocument.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
  });

  it("bridges DeerFlow review_prd final actions into ConversationDesignState and PRD persistence", async () => {
    const state = baseState({ status: "design_ready" });
    const document = baseDocument();
    const updatedState = { ...state, status: "doc_ready", prdDocument: document };
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue(updatedState);

    const result = await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "已生成 PRD，请确认。",
        raw: {
          type: "review_prd",
          designStateDraft: {
            title: "签到活动",
            summary: "用户每日签到领取积分",
            businessGoal: "提升活跃",
            pages: [{ id: "page_home", name: "签到页" }],
            businessRules: [{ id: "daily_once", title: "每日一次" }],
          },
          prdDocumentDraft: {
            title: "签到活动 PRD",
            sections: [
              {
                id: "overview",
                title: "概览",
                type: "overview",
                level: 1,
                order: 1,
                content: "用户每日签到领取积分。",
                sourcePaths: ["summary"],
              },
            ],
          },
          knowledgeRefsUsed: ["01-业务规则/签到规则"],
          assumptions: ["默认每日只能签到一次"],
        },
      }),
      artifacts: [],
    });

    expect(stateService.createDraftInTransaction).toHaveBeenCalledWith(
      prisma,
      "conversation-1",
      expect.objectContaining({
        title: "签到活动",
        summary: "用户每日签到领取积分",
        businessGoal: "提升活跃",
        pages: [{ id: "page_home", name: "签到页" }],
        businessRules: [{ id: "daily_once", title: "每日一次" }],
        assumptions: [expect.objectContaining({ content: "默认每日只能签到一次", status: "pending" })],
        knowledgeRefs: [expect.objectContaining({ title: "01-业务规则/签到规则" })],
        createdBy: "user-1",
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-1" }),
    );
    expect(documentService.saveGeneratedDocumentInTransaction).toHaveBeenCalledWith(
      prisma,
      state,
      expect.objectContaining({
        title: "签到活动需求说明书",
        sections: expect.arrayContaining([
          expect.objectContaining({ id: "version_history", title: "版 本 历 史" }),
          expect.objectContaining({ id: "manual_toc", title: "目 录" }),
          expect.objectContaining({ id: "background", title: "1.1 项目背景" }),
          expect.objectContaining({ id: "core_1", title: "2.2 概览", content: "用户每日签到领取积分。" }),
          expect.objectContaining({ id: "degradation_plan", title: "3 业务降级方案（必填）" }),
          expect.objectContaining({ id: "safety_baseline", title: "4 需求安全基线要求（必填）" }),
        ]),
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-1" }),
    );
    expect(stateService.attachGeneratedArtifactsInTransaction).toHaveBeenCalledWith(prisma, "state-1", expect.objectContaining({
      prdDocument: document,
      status: "doc_ready",
      runId: "run-1",
    }));
    expect(result).toEqual({ prdDocument: document, state: updatedState });
  });

  it("builds PRD sections from DeerFlow markdown artifacts when structured sections are absent", async () => {
    const state = baseState();
    const document = baseDocument();
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue({ ...state, prdDocument: document });

    await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "已生成 PRD。",
        raw: { type: "review_prd", prdDocumentDraft: { title: "签到活动 PRD" } },
      }),
      artifacts: [
        {
          kind: "prd_markdown",
          path: "mnt/user-data/outputs/prd.md",
          artifactUrl: "/api/artifacts/prd.md",
          contentType: "text/markdown",
          status: "fetched",
          text: "# 签到活动 PRD\n\n## 目标\n提升用户活跃。\n\n## 页面\n签到页展示连续签到天数。",
        },
      ],
    });

    expect(documentService.saveGeneratedDocumentInTransaction).toHaveBeenCalledWith(
      prisma,
      state,
      expect.objectContaining({
        title: "签到活动需求说明书",
        sections: expect.arrayContaining([
          expect.objectContaining({ title: "2.2 目标", content: "提升用户活跃。" }),
          expect.objectContaining({ title: "2.3 页面", content: "签到页展示连续签到天数。" }),
          expect.objectContaining({ title: "3 业务降级方案（必填）" }),
          expect.objectContaining({ title: "4 需求安全基线要求（必填）" }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("builds PRD sections from assistant markdown when DeerFlow only returns a summary final action", async () => {
    const state = baseState();
    const document = baseDocument();
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue({ ...state, prdDocument: document });

    await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "已继续完善签到打卡活动 PRD。",
        raw: { type: "review_prd", prdDocumentDraft: { title: "需求文档" } },
      }),
      artifacts: [],
      assistantText: [
        "# 签到打卡活动 PRD",
        "",
        "## 产品目标",
        "提升用户每日活跃和连续访问。",
        "",
        "## 用户端功能",
        "用户可以每日签到、查看连续签到天数和奖励明细。",
        "",
        "## 验收标准",
        "签到成功后页面状态应更新为今日已签到。",
      ].join("\n"),
    });

    expect(documentService.saveGeneratedDocumentInTransaction).toHaveBeenCalledWith(
      prisma,
      state,
      expect.objectContaining({
        title: "签到活动需求说明书",
        sections: expect.arrayContaining([
          expect.objectContaining({ title: "2.2 产品目标", content: "提升用户每日活跃和连续访问。" }),
          expect.objectContaining({ title: "2.3 用户端功能", content: "用户可以每日签到、查看连续签到天数和奖励明细。" }),
          // 接口章节已从强制列表中移除，验收标准编号相应调整
          expect.objectContaining({ title: expect.stringMatching(/验收标准/), content: "签到成功后页面状态应更新为今日已签到。" }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("infers a specific PRD title from sections when DeerFlow returns generic titles", async () => {
    const state = baseState({ title: "产品需求方案" });
    const document = baseDocument();
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue({ ...state, prdDocument: document });

    await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-1",
      finalAction: finalAction({
        type: "review_prd",
        message: "PRD 已生成。",
        raw: {
          type: "review_prd",
          designStateDraft: { title: "产品需求方案" },
          prdDocumentDraft: {
            title: "产品需求方案",
            sections: [
              {
                id: "business_doc",
                title: "会员积分商城需求说明书",
                type: "overview",
                level: 1,
                order: 1,
                content: "会员积分商城覆盖积分查询、商品兑换、兑换记录和库存管理。",
              },
              {
                id: "acceptance",
                title: "验收标准",
                type: "acceptance_criteria",
                level: 2,
                order: 2,
                content: "兑换成功后需扣减积分并生成兑换单。",
              },
            ],
          },
        },
      }),
      artifacts: [],
    });

    expect(documentService.saveGeneratedDocumentInTransaction).toHaveBeenCalledWith(
      prisma,
      state,
      expect.objectContaining({
        title: "会员积分商城需求说明书",
      }),
      expect.any(Object),
    );
  });

  it("bridges DeerFlow review_prototype final actions into PrototypeSpec, HTML artifact, and state persistence", async () => {
    const state = baseState({ status: "doc_confirmed" });
    const prototypeSpec = { id: "spec-1", pages: [{ id: "page_home", name: "签到页" }] };
    const artifact = { id: "artifact-1", htmlContent: "<main>签到页</main>" };
    const updatedState = { ...state, status: "prototype_ready", prototypeSpec };
    stateService.getCurrentStateInTransaction.mockResolvedValue(state);
    prototypeService.saveGeneratedPrototypeInTransaction.mockResolvedValue({ prototypeSpec, artifact, hasContent: true });
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue(updatedState);

    const result = await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-2",
      finalAction: finalAction({
        type: "review_prototype",
        message: "原型已生成，请确认。",
        raw: {
          type: "review_prototype",
          prototypeSpec: {
            title: "签到活动原型",
            targetDevice: "desktop",
            pages: [{ id: "page_home", name: "签到页", components: [] }],
          },
        },
      }),
      artifacts: [prototypeHtmlArtifact()],
    });

    expect(prototypeService.saveGeneratedPrototypeInTransaction).toHaveBeenCalledWith(
      prisma,
      state,
      expect.objectContaining({
        conversationId: "conversation-1",
        conversationDesignStateId: "state-1",
        conversationDesignStateVersion: 3,
        title: "签到活动原型",
        targetDevice: "desktop",
        pages: [{ id: "page_home", name: "签到页", components: [] }],
      }),
      expect.objectContaining({
        conversationId: "conversation-1",
        htmlContent: "<html><body>签到页</body></html>",
        html: "<html><body>签到页</body></html>",
        title: "签到活动原型",
        targetDevice: "desktop",
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-2" }),
      expect.any(String), // htmlContent
      expect.any(Boolean), // hasContent
    );
    expect(stateService.attachGeneratedArtifactsInTransaction).toHaveBeenCalledWith(prisma, "state-1", expect.objectContaining({
      prototypeSpec,
      status: "prototype_ready",
      runId: "run-2",
    }));
    expect(result).toEqual({ prototypeArtifact: artifact, state: updatedState });
  });

  it("fails prototype bridge when no ConversationDesignState exists", async () => {
    stateService.getCurrentStateInTransaction.mockResolvedValue(null);

    await expect(service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-2",
      finalAction: finalAction({ type: "review_prototype", message: "原型已生成。" }),
      artifacts: [prototypeHtmlArtifact()],
    })).rejects.toThrow("PROTOTYPE_STATE_NOT_FOUND");

    expect(prototypeService.saveGeneratedPrototypeInTransaction).not.toHaveBeenCalled();
  });
});

function finalAction(overrides: Partial<DeerFlowFinalAction>): DeerFlowFinalAction {
  return {
    type: "answer",
    message: "完成。",
    parsed: true,
    raw: { type: "answer" },
    ...overrides,
  };
}

function prototypeHtmlArtifact(): DeerFlowResolvedArtifact {
  return {
    kind: "prototype_html",
    path: "mnt/user-data/outputs/index.html",
    artifactUrl: "/api/threads/thread-1/artifacts/mnt/user-data/outputs/index.html",
    contentType: "text/html",
    status: "fetched",
    text: "<html><body>签到页</body></html>",
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    id: "state-1",
    conversationId: "conversation-1",
    version: 3,
    title: "签到活动",
    status: "doc_ready",
    ...overrides,
  };
}

function baseDocument() {
  return {
    id: "prd-1",
    conversationId: "conversation-1",
    title: "签到活动 PRD",
    sections: [],
  };
}
