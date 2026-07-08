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
          externalRefsUsed: ["公开资料：积分权益风控 https://example.com/points-risk"],
          externalResearchStatus: "completed",
          enrichmentNotes: ["知识库定义活动配置闭环，模型补齐默认状态，联网补充积分风控表达。"],
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
        validationNotes: expect.arrayContaining([
          "外部补充状态：completed",
          "补齐说明：知识库定义活动配置闭环，模型补齐默认状态，联网补充积分风控表达。",
          "外部参考：公开资料：积分权益风控 https://example.com/points-risk",
        ]),
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

  it("persists retrieved knowledge metadata even when DeerFlow only echoes knowledge titles", async () => {
    const state = baseState({ status: "design_ready" });
    const document = baseDocument();
    const updatedState = { ...state, status: "doc_ready", prdDocument: document };
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue(updatedState);

    await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-knowledge-refs",
      finalAction: finalAction({
        type: "review_prd",
        message: "已生成 PRD。",
        raw: {
          type: "review_prd",
          designStateDraft: {
            title: "签到领积分活动",
            summary: "用户每日签到领取积分奖励",
            businessGoal: "提升活跃",
          },
          prdDocumentDraft: {
            title: "签到领积分活动 PRD",
            sections: [
              {
                id: "background",
                title: "1.1 项目背景",
                type: "overview",
                level: 3,
                order: 1,
                content: "通过签到领积分提升用户每日活跃。",
              },
            ],
          },
          knowledgeRefsUsed: ["活动发布与模板配置", "PRD标准结构"],
        },
      }),
      artifacts: [],
      knowledgeContext: [
        {
          id: "knowledge_ref_activity",
          knowledgeId: "vault:02-业务域知识/活动发布与模板配置.md",
          title: "活动发布与模板配置",
          snippet: "活动必须覆盖草稿、预览、审核、发布、下线和回滚。",
          content: "活动必须覆盖草稿、预览、审核、发布、下线和回滚。",
          type: "business_concept",
          score: 0.98,
          reason: "标题匹配 活动；高优先级知识",
          relatedPath: "02-业务域知识/活动发布与模板配置.md",
        },
        {
          id: "knowledge_ref_prd",
          knowledgeId: "vault:04-产品文档规范/PRD标准结构.md",
          title: "PRD标准结构",
          snippet: "PRD 必须包含 1 引言、2 业务需求、3 业务降级方案、4 需求安全基线要求。",
          content: "来源文件：04-产品文档规范/PRD标准结构.md\nPRD 必须包含 1 引言、2 业务需求、3 业务降级方案、4 需求安全基线要求。",
          type: "prd_writing_rule",
          score: 0.95,
          reason: "标题匹配 PRD标准结构；符合调用方偏好类型",
          relatedPath: "04-产品文档规范/PRD标准结构.md",
        },
      ],
    });

    const stateDraft = stateService.createDraftInTransaction.mock.calls[0]?.[2];
    const savedDraft = documentService.saveGeneratedDocumentInTransaction.mock.calls[0]?.[2];
    expect(stateDraft.knowledgeRefs).toEqual([
      expect.objectContaining({
        knowledgeId: "vault:02-业务域知识/活动发布与模板配置.md",
        title: "活动发布与模板配置（02-业务域知识/活动发布与模板配置.md）",
        snippet: "活动必须覆盖草稿、预览、审核、发布、下线和回滚。",
        type: "business_concept",
        score: 0.98,
        reason: "标题匹配 活动；高优先级知识",
        relatedPath: "02-业务域知识/活动发布与模板配置.md",
      }),
      expect.objectContaining({
        knowledgeId: "vault:04-产品文档规范/PRD标准结构.md",
        title: "PRD标准结构（04-产品文档规范/PRD标准结构.md）",
        snippet: "PRD 必须包含 1 引言、2 业务需求、3 业务降级方案、4 需求安全基线要求。",
        type: "prd_writing_rule",
        relatedPath: "04-产品文档规范/PRD标准结构.md",
      }),
    ]);
    expect(savedDraft.knowledgeRefs).toEqual(stateDraft.knowledgeRefs);
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

  it("does not persist completion summaries as PRD body content", async () => {
    const completionSummary =
      "已生成《营销日历需求说明书》，覆盖营销日历的运营排期、节点规划、资源占用、权益库存联动、审核发布、复盘归因、接口联动、降级方案与安全基线，可在右侧 PRD 画布中继续评审和修改。";
    const state = baseState({ title: completionSummary });
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
        message: completionSummary,
        raw: {
          type: "review_prd",
          designStateDraft: { title: completionSummary },
          prdDocumentDraft: {
            title: completionSummary,
          },
        },
      }),
      artifacts: [],
      assistantText: completionSummary,
    });

    const savedDraft = documentService.saveGeneratedDocumentInTransaction.mock.calls[0]?.[2] as {
      title: string;
      sections: Array<{ content: string; title: string }>;
    };
    const body = savedDraft.sections.map((section) => `${section.title}\n${section.content}`).join("\n\n");

    expect(stateService.createDraftInTransaction).toHaveBeenCalledWith(
      prisma,
      "conversation-1",
      expect.objectContaining({ title: "营销日历需求说明书" }),
      expect.any(Object),
    );
    expect(savedDraft.title).toBe("营销日历需求说明书");
    expect(body).toContain("1.1 项目背景");
    expect(body).toContain("2.2 核心业务规则/功能说明");
    expect(body).not.toContain("可在右侧 PRD 画布");
    expect(body).not.toContain("覆盖营销日历的运营排期");
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

  it("persists PRD and prototype from a single review_prototype final action when both payloads exist", async () => {
    const state = baseState({ status: "design_ready", version: 3 });
    const document = baseDocument();
    const stateWithPrd = { ...state, version: 4, status: "doc_ready", prdDocument: document };
    const prototypeSpec = { id: "spec-1", pages: [{ id: "page_home", name: "签到页" }] };
    const artifact = { id: "artifact-1", title: "签到活动原型", htmlContent: "<main>签到页</main>" };
    const finalState = { ...stateWithPrd, version: 5, status: "prototype_ready", prototypeSpec };
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction
      .mockResolvedValueOnce(stateWithPrd)
      .mockResolvedValueOnce(finalState);
    prototypeService.saveGeneratedPrototypeInTransaction.mockResolvedValue({
      prototypeSpec,
      artifact,
      hasContent: true,
    });

    const result = await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-both",
      finalAction: finalAction({
        type: "review_prototype",
        message: "PRD 和原型已生成。",
        raw: {
          type: "review_prototype",
          designStateDraft: {
            title: "签到领积分活动",
            summary: "用户每日签到领取积分奖励",
            businessGoal: "提升用户活跃",
          },
          prdDocumentDraft: {
            title: "签到领积分活动需求说明书",
            sections: [
              {
                id: "background",
                title: "1.1 项目背景",
                type: "overview",
                level: 3,
                order: 1,
                content: "通过签到领积分提升用户每日活跃，并串联后台配置、审核发布、积分发放和数据报表。",
              },
            ],
          },
          prototypeSpec: {
            title: "签到领积分活动原型",
            targetDevice: "both",
            pages: [{ id: "page_config", name: "后台配置页" }],
          },
        },
      }),
      artifacts: [prototypeHtmlArtifact()],
    });

    expect(documentService.saveGeneratedDocumentInTransaction).toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototypeInTransaction).toHaveBeenCalledWith(
      prisma,
      stateWithPrd,
      expect.objectContaining({
        conversationDesignStateVersion: 4,
        title: "签到领积分活动原型",
      }),
      expect.objectContaining({
        htmlContent: "<html><body>签到页</body></html>",
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-both" }),
      expect.any(String),
      true,
    );
    expect(stateService.attachGeneratedArtifactsInTransaction).toHaveBeenNthCalledWith(
      2,
      prisma,
      "state-1",
      expect.objectContaining({
        prdDocument: document,
        prototypeSpec,
        status: "prototype_ready",
      }),
    );
    expect(result).toEqual({ prdDocument: document, prototypeArtifact: artifact, state: finalState });
  });

  it("strips runtime noise before persisting generated PRD and prototype artifacts", async () => {
    const state = baseState({ status: "design_ready", version: 3 });
    const document = baseDocument();
    const stateWithPrd = { ...state, version: 4, status: "doc_ready", prdDocument: document };
    const prototypeSpec = { id: "spec-1", pages: [{ id: "page_home", name: "签到页" }] };
    const artifact = { id: "artifact-1", title: "签到活动原型", htmlContent: "<main>签到页</main>" };
    const finalState = { ...stateWithPrd, version: 5, status: "prototype_ready", prototypeSpec };
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction
      .mockResolvedValueOnce(stateWithPrd)
      .mockResolvedValueOnce(finalState);
    prototypeService.saveGeneratedPrototypeInTransaction.mockResolvedValue({
      prototypeSpec,
      artifact,
      hasContent: true,
    });

    await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-clean",
      finalAction: finalAction({
        type: "review_prototype",
        message: "PRD 和原型已生成。",
        raw: {
          type: "review_prototype",
          designStateDraft: {
            title: "签到领积分活动\nContext from AI Product Workbench:",
            summary: "用户每日签到领取积分奖励。\nUpdated todo list",
            businessGoal: "提升用户活跃。\nread_file SKILL.md",
            pages: [{ id: "page_config", name: "后台配置页\nwrite_file draft.md" }],
          },
          prdDocumentDraft: {
            title: "签到领积分活动需求说明书\ntool-output read_file",
            validationNotes: ["知识库命中活动配置。\nContext from AI Product Workbench:"],
            sections: [
              {
                id: "background",
                title: "1.1 项目背景\nread_file source.md",
                type: "overview",
                level: 3,
                order: 1,
                content: [
                  "通过签到领积分提升用户每日活跃。",
                  "read_file /tmp/SKILL.md",
                  "Updated todo list",
                  "后台配置、审核发布、积分发放和数据报表必须闭环。",
                ].join("\n"),
              },
            ],
          },
          prototypeSpec: {
            title: "签到领积分活动原型\nContext from AI Product Workbench:",
            targetDevice: "both",
            pages: [{ id: "page_config", name: "后台配置页\nwrite_todos" }],
          },
          externalRefsUsed: ["公开资料：积分风控。\ntool-input read_file"],
          enrichmentNotes: ["知识库打底，模型补齐，联网补充。\nUpdated todo list"],
        },
      }),
      artifacts: [
        {
          ...prototypeHtmlArtifact(),
          text: [
            "Context from AI Product Workbench:",
            "<html>",
            "<body>",
            "<main>签到页</main>",
            "read_file SKILL.md",
            "Updated todo list",
            "</body>",
            "</html>",
          ].join("\n"),
        },
      ],
    });

    const stateDraft = stateService.createDraftInTransaction.mock.calls[0]?.[2];
    const savedDraft = documentService.saveGeneratedDocumentInTransaction.mock.calls[0]?.[2];
    const prototypeCall = prototypeService.saveGeneratedPrototypeInTransaction.mock.calls[0];
    const prototypeSpecDraft = prototypeCall?.[2];
    const artifactDraft = prototypeCall?.[3];
    const htmlContent = prototypeCall?.[5];
    const persistedPayload = JSON.stringify({
      stateDraft,
      savedDraft,
      prototypeSpecDraft,
      artifactDraft,
      htmlContent,
    });

    expect(persistedPayload).toContain("签到领积分活动");
    expect(persistedPayload).toContain("后台配置、审核发布、积分发放和数据报表必须闭环");
    expect(persistedPayload).toContain("<main>签到页</main>");
    expect(persistedPayload).not.toMatch(/Context from AI Product Workbench|read_file|write_file|write_todos|tool-input|tool-output|Updated todo list/);
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
