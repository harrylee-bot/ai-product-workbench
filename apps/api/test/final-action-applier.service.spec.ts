import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinalActionApplierService } from "../src/ai/final-action-applier.service";
import type { DeerFlowFinalAction, DeerFlowResolvedArtifact } from "../src/ai/deerflow-runtime.service";

describe("FinalActionApplierService", () => {
  const stateService = {
    createDraft: vi.fn(),
    createDraftInTransaction: vi.fn(),
    createProvisionalDraftInTransaction: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
    attachGeneratedArtifactsInTransaction: vi.fn(),
    getCurrentState: vi.fn(),
    getCurrentStateInTransaction: vi.fn(),
    getCurrentStateWithPublishFenceInTransaction: vi.fn(),
  };
  const documentService = {
    saveGeneratedDocument: vi.fn(),
    saveGeneratedDocumentInTransaction: vi.fn(),
  };
  const prototypeService = {
    saveGeneratedPrototype: vi.fn(),
    saveGeneratedPrototypeInTransaction: vi.fn(),
  };
  const qaRuleCheck = {
    run: vi.fn((): Array<{ severity: string; title: string }> => []),
  };
  const prisma = {
    conversation: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    requirementDocument: { findMany: vi.fn(), updateMany: vi.fn() },
    prototypeArtifact: { updateMany: vi.fn() },
    qAReport: { findFirst: vi.fn() },
    conversationDesignState: { updateMany: vi.fn() },
    runtimeRunLog: { updateMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((callback) => callback(prisma)),
  };
  const service = new FinalActionApplierService(
    prisma as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
    qaRuleCheck as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findUnique.mockResolvedValue({ currentPrdDocumentId: null });
    prisma.requirementDocument.findMany.mockResolvedValue([]);
    prisma.requirementDocument.updateMany.mockResolvedValue({ count: 1 });
    prisma.prototypeArtifact.updateMany.mockResolvedValue({ count: 1 });
    prisma.qAReport.findFirst.mockResolvedValue({
      id: "qa-1",
      conversationDesignStateId: "state-1",
      conversationDesignStateVersion: 3,
      prdDocumentId: "prd-1",
      prototypeArtifactId: null,
    });
    prisma.runtimeRunLog.updateMany.mockResolvedValue({ count: 1 });
    prisma.conversationDesignState.updateMany.mockResolvedValue({ count: 1 });
    prisma.conversation.update.mockResolvedValue({});
    prisma.conversation.updateMany.mockResolvedValue({ count: 1 });
    prisma.$queryRaw.mockResolvedValue([{
      started_at: new Date("2026-06-20T08:00:00.000Z"),
      version: 2,
      updatedAt: new Date("2026-06-20T07:00:00.000Z"),
      currentDesignStateId: "state-current",
      currentPrdDocumentId: null,
      currentPrototypeArtifactId: null,
      latestQaReportId: null,
    }]);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    stateService.createProvisionalDraftInTransaction.mockImplementation(
      async (tx, conversationId, draft, options) => ({
        state: await stateService.createDraftInTransaction(tx, conversationId, draft, options),
        publishFence: basePublishFence(),
      }),
    );
    stateService.getCurrentStateWithPublishFenceInTransaction.mockImplementation(
      async (tx, conversationId) => {
        const state = await stateService.getCurrentStateInTransaction(tx, conversationId);
        return {
          state,
          publishFence: basePublishFence({
            currentDesignStateId: state?.id ?? null,
            currentDesignStateVersion: state?.version ?? null,
            currentDesignStateUpdatedAt: state?.updatedAt ?? null,
          }),
        };
      },
    );
    qaRuleCheck.run.mockReturnValue([]);
  });

  it("publishes QA-approved artifacts and completes the fenced run atomically", async () => {
    const state = baseState({ status: "design_ready" });
    const document = { ...baseDocument(), status: "generating" as const };
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue({
      ...state,
      status: "doc_ready",
      prdDocument: { ...document, status: "ready" },
    });

    const result = await service.publishAppliedArtifacts({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-1",
      commitToken: "lease-1",
      qaReportId: "qa-1",
      applied: {
        prdDocument: document,
        state,
        publishFence: basePublishFence(),
      },
      runResult: { status: "success", qaReportId: "qa-1" },
      outputSummary: "PRD 已生成",
    });

    expect(result.prdDocument?.status).toBe("ready");
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "conversation-1",
        currentDesignStateId: "state-current",
      }),
      data: expect.objectContaining({
        currentDesignStateId: "state-1",
        currentPrdDocumentId: "prd-1",
        currentPrototypeArtifactId: null,
        latestQaReportId: "qa-1",
      }),
    });
    expect(prisma.runtimeRunLog.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "running",
        leaseToken: "lease-1",
      },
      data: expect.objectContaining({ status: "succeeded" }),
    });
  });

  it("does not publish or promote QA after the run lease is lost", async () => {
    const state = baseState({ status: "design_ready" });
    const document = { ...baseDocument(), status: "generating" as const };
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(service.publishAppliedArtifacts({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-cancelled",
      commitToken: "stale-lease",
      qaReportId: "qa-1",
      applied: {
        prdDocument: document,
        state,
        publishFence: basePublishFence(),
      },
      runResult: { status: "success", qaReportId: "qa-1" },
      outputSummary: "PRD 已生成",
    })).rejects.toThrow("RUN_COMMIT_FENCE_REJECTED");

    expect(prisma.qAReport.findFirst).not.toHaveBeenCalled();
    expect(prisma.requirementDocument.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.runtimeRunLog.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a QA report that is not fenced to the current run and artifacts", async () => {
    const state = baseState({ status: "design_ready" });
    const document = { ...baseDocument(), status: "generating" as const };
    prisma.qAReport.findFirst.mockResolvedValueOnce(null);

    await expect(service.publishAppliedArtifacts({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-1",
      commitToken: "lease-1",
      qaReportId: "qa-other-run",
      applied: {
        prdDocument: document,
        state,
        publishFence: basePublishFence(),
      },
      runResult: { status: "success", qaReportId: "qa-other-run" },
      outputSummary: "PRD 已生成",
    })).rejects.toThrow("QA_REPORT_PUBLISH_FENCE_REJECTED");

    expect(prisma.requirementDocument.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.runtimeRunLog.updateMany).not.toHaveBeenCalled();
  });

  it("does not downgrade state when publication committed but its acknowledgement was lost", async () => {
    const state = baseState({ status: "doc_ready" });
    const document = { ...baseDocument(), status: "ready" as const };
    prisma.requirementDocument.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.rejectAppliedArtifacts({
      runId: "run-1",
      applied: { prdDocument: document, state },
      error: new Error("database acknowledgement lost"),
    });

    expect(prisma.conversationDesignState.updateMany).not.toHaveBeenCalled();
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
      externalResearchContext: {
        status: "delegated_to_agent",
        fetchedAt: "2026-07-10T00:00:00.000Z",
        searchQueries: [],
        refs: [],
        failures: [],
        privacyBoundary: ["只搜索通用领域词，不发送内部路径、附件原文、真实接口或密钥。"],
      },
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
          expect.stringContaining("补齐边界：未确认内容仅记录为假设或待确认项"),
          "联网隐私边界：只搜索通用领域词，不发送内部路径、附件原文、真实接口或密钥。",
        ]),
        sections: expect.arrayContaining([
          expect.objectContaining({ id: "version_history", title: "版 本 历 史" }),
          expect.objectContaining({ id: "manual_toc", title: "目 录" }),
          expect.objectContaining({ id: "background", title: "1.1 项目背景" }),
          expect.objectContaining({ id: "core_rules", title: "2.2 核心业务规则/功能说明" }),
          expect.objectContaining({
            id: "core_flow_state",
            title: "2.3 核心流程/状态/页面要求",
            blocks: expect.arrayContaining([
              expect.objectContaining({ title: "产品流程图", type: "diagram" }),
              expect.objectContaining({ title: "产品架构图", type: "diagram" }),
            ]),
          }),
          expect.objectContaining({ id: "acceptance_criteria", title: "2.4 验收标准" }),
          expect.objectContaining({ id: "degradation_plan", title: "3 业务降级方案（必填）" }),
          expect.objectContaining({ id: "safety_baseline", title: "4 需求安全基线要求（必填）" }),
        ]),
      }),
      expect.objectContaining({ userId: "user-1", runId: "run-1" }),
    );
    expect(stateService.attachGeneratedArtifactsInTransaction).toHaveBeenCalledWith(prisma, "state-1", expect.objectContaining({
      prdDocument: document,
      runId: "run-1",
    }));
    expect(result).toEqual(expect.objectContaining({
      prdDocument: document,
      state: updatedState,
      publishFence: basePublishFence(),
    }));
  });

  it("rejects generated artifacts inside the persistence transaction when deterministic QA finds a major issue", async () => {
    const state = baseState({ status: "design_ready" });
    const document = baseDocument();
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    qaRuleCheck.run.mockReturnValue([{ severity: "major", title: "PRD 未完整覆盖产品设计状态" }]);

    await expect(service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-quality-fail",
      finalAction: finalAction({
        type: "review_prd",
        message: "PRD 已生成。",
        raw: {
          type: "review_prd",
          designStateDraft: { title: "门店预约", businessGoal: "提升预约转化" },
          prdDocumentDraft: {
            title: "门店预约需求说明书",
            sections: [{ id: "background", title: "1.1 项目背景", content: "支持用户选择门店和时段后提交预约。" }],
          },
        },
      }),
      artifacts: [],
    })).rejects.toThrow("GENERATED_ARTIFACT_QUALITY_FAILED");

    expect(stateService.attachGeneratedArtifactsInTransaction).not.toHaveBeenCalled();
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
          expect.objectContaining({ title: "2 业务需求", content: "总体目标：提升用户活跃。" }),
          expect.objectContaining({ title: "2.2 核心业务规则/功能说明" }),
          expect.objectContaining({
            title: "2.3 核心流程/状态/页面要求",
            blocks: expect.arrayContaining([
              expect.objectContaining({ title: "产品流程图" }),
              expect.objectContaining({ title: "产品架构图" }),
            ]),
          }),
          expect.objectContaining({ title: "2.4 验收标准" }),
          expect.objectContaining({ title: "3 业务降级方案（必填）" }),
          expect.objectContaining({ title: "4 需求安全基线要求（必填）" }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("persists full retrieved knowledge metadata even when DeerFlow only echoes titles", async () => {
    const state = baseState();
    const document = baseDocument();
    stateService.createDraftInTransaction.mockResolvedValue(state);
    documentService.saveGeneratedDocumentInTransaction.mockResolvedValue(document);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue({ ...state, prdDocument: document });

    await service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-knowledge",
      finalAction: finalAction({
        type: "review_prd",
        message: "已生成 PRD。",
        raw: {
          type: "review_prd",
          knowledgeRefsUsed: ["活动发布与模板配置（02-业务域知识/活动发布与模板配置.md）"],
          prdDocumentDraft: {
            title: "签到领积分活动需求说明书",
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
        },
      }),
      artifacts: [],
      knowledgeContext: [
        {
          id: "knowledge_ref_vault_activity_1",
          knowledgeId: "vault_activity",
          title: "活动发布与模板配置",
          snippet: "活动发布必须覆盖草稿、预览、审核、发布、下线和回滚。",
          content: "来源文件：02-业务域知识/活动发布与模板配置.md\n活动发布必须覆盖草稿、预览、审核、发布、下线和回滚。",
          type: "business_concept",
          score: 0.98,
          reason: "标题匹配 活动；高优先级知识",
          relatedPath: "02-业务域知识/活动发布与模板配置.md",
        },
        {
          id: "knowledge_ref_vault_prd_2",
          knowledgeId: "vault_prd",
          title: "PRD标准结构",
          content: "来源文件：04-产品文档规范/PRD标准结构.md\nPRD 必须包含 1 引言、2 业务需求、3 业务降级方案、4 需求安全基线要求。",
          type: "prd_writing_rule",
          score: 0.91,
          reason: "符合调用方偏好类型",
          relatedPath: "04-产品文档规范/PRD标准结构.md",
        },
      ],
    });

    const stateDraft = stateService.createDraftInTransaction.mock.calls[0]?.[2];
    const savedDraft = documentService.saveGeneratedDocumentInTransaction.mock.calls[0]?.[2];

    expect(stateDraft.knowledgeRefs).toEqual([
      expect.objectContaining({
        knowledgeId: "vault_activity",
        title: "活动发布与模板配置（02-业务域知识/活动发布与模板配置.md）",
        snippet: "活动发布必须覆盖草稿、预览、审核、发布、下线和回滚。",
        type: "business_concept",
        score: 0.98,
        reason: "标题匹配 活动；高优先级知识",
        relatedPath: "02-业务域知识/活动发布与模板配置.md",
      }),
      expect.objectContaining({
        knowledgeId: "vault_prd",
        title: "PRD标准结构（04-产品文档规范/PRD标准结构.md）",
        snippet: "PRD 必须包含 1 引言、2 业务需求、3 业务降级方案、4 需求安全基线要求。",
        type: "prd_writing_rule",
        relatedPath: "04-产品文档规范/PRD标准结构.md",
      }),
    ]);
    expect(savedDraft.knowledgeRefs).toEqual(stateDraft.knowledgeRefs);
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
          expect.objectContaining({ title: "2 业务需求", content: "总体目标：提升用户每日活跃和连续访问。" }),
          expect.objectContaining({ title: "2.2 核心业务规则/功能说明" }),
          expect.objectContaining({
            title: "2.3 核心流程/状态/页面要求",
            blocks: expect.arrayContaining([
              expect.objectContaining({ title: "产品流程图" }),
              expect.objectContaining({ title: "产品架构图" }),
            ]),
          }),
          expect.objectContaining({ title: "2.4 验收标准", content: "签到成功后页面状态应更新为今日已签到。" }),
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
	        htmlContent: fullPrototypeHtml(),
	        html: fullPrototypeHtml(),
	        title: "签到活动原型",
	        targetDevice: "desktop",
	      }),
      expect.objectContaining({ userId: "user-1", runId: "run-2" }),
      expect.any(String), // htmlContent
      expect.any(Boolean), // hasContent
    );
    expect(stateService.attachGeneratedArtifactsInTransaction).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      prototypeArtifact: artifact,
      state: updatedState,
    }));
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
	        htmlContent: fullPrototypeHtml(),
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
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      prdDocument: document,
      prototypeArtifact: artifact,
      state: finalState,
    }));
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
	            "<!doctype html>",
	            "<html lang=\"zh-CN\">",
	            "<head><style>body{font-family:sans-serif}.panel{display:grid;padding:16px}</style></head>",
	            "<body>",
	            "<main class=\"panel\">签到页</main>",
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
    expect(persistedPayload).toContain("<main class=\\\"panel\\\">签到页</main>");
	    expect(persistedPayload).not.toMatch(/Context from AI Product Workbench|read_file|write_file|write_todos|tool-input|tool-output|Updated todo list/);
	  });

  it("rejects prototype HTML that exposes generation trace or external evidence", async () => {
    const state = baseState({ status: "doc_confirmed" });
    stateService.getCurrentStateInTransaction.mockResolvedValue(state);

    await expect(service.apply({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-trace-prototype",
      finalAction: finalAction({
        type: "review_prototype",
        message: "原型已生成。",
        raw: {
          type: "review_prototype",
          prototypeSpec: {
            title: "签到领积分活动原型",
            targetDevice: "both",
            pages: [{ id: "page_config", name: "后台配置页" }],
          },
        },
      }),
      artifacts: [{
        ...prototypeHtmlArtifact(),
        text: fullPrototypeHtml([
          "<section>补齐策略：知识库打底，公开资料补齐。</section>",
          "<section>Building an Effective Loyalty Program</section>",
        ].join("")),
      }],
    })).rejects.toThrow("PROTOTYPE_HTML_CONTAINS_GENERATION_TRACE");

    expect(prototypeService.saveGeneratedPrototypeInTransaction).not.toHaveBeenCalled();
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

  it("keeps the existing current state and pointers unchanged when QA rejects provisional artifacts", async () => {
    const state = baseState({
      id: "state-provisional",
      version: 4,
      updatedAt: "2026-06-20T09:00:01.000Z",
    });
    const document = { ...baseDocument(), id: "prd-provisional", status: "generating" as const };
    prisma.conversation.findUnique.mockResolvedValueOnce({
      currentDesignStateId: "state-current",
    });

    await service.rejectAppliedArtifacts({
      runId: "run-rejected",
      applied: { prdDocument: document, state },
      error: new Error("GENERATED_ARTIFACT_QA_FAILED"),
    });

    expect(prisma.conversation.update).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversationDesignState.updateMany).toHaveBeenCalledWith({
      where: {
        id: "state-provisional",
        version: 4,
        updatedAt: new Date("2026-06-20T09:00:01.000Z"),
      },
      data: { status: "qa_failed" },
    });
  });

  it("rejects publish when the baseline current state was manually edited", async () => {
    const state = baseState({
      id: "state-provisional",
      version: 4,
      updatedAt: "2026-06-20T09:00:01.000Z",
    });
    const document = { ...baseDocument(), id: "prd-provisional", status: "generating" as const };
    const fence = basePublishFence();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ started_at: new Date("2026-06-20T08:00:00.000Z") }])
      .mockResolvedValueOnce([{
        version: 3,
        updatedAt: new Date("2026-06-20T08:45:00.000Z"),
      }]);

    await expect(service.publishAppliedArtifacts({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-stale-baseline",
      commitToken: "lease-1",
      qaReportId: "qa-1",
      applied: { prdDocument: document, state, publishFence: fence },
      runResult: { status: "success" },
      outputSummary: "PRD 已生成",
    })).rejects.toThrow("CURRENT_STATE_PUBLISH_FENCE_REJECTED");

    expect(prisma.qAReport.findFirst).not.toHaveBeenCalled();
    expect(prisma.requirementDocument.updateMany).not.toHaveBeenCalled();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("publishes the first approved state only after fencing a null current pointer", async () => {
    const state = baseState({
      version: 1,
      updatedAt: "2026-06-20T09:00:01.000Z",
    });
    const document = {
      ...baseDocument(),
      conversationDesignStateVersion: 1,
      status: "generating" as const,
    };
    const fence = basePublishFence({
      currentDesignStateId: null,
      currentDesignStateVersion: null,
      currentDesignStateUpdatedAt: null,
    });
    prisma.qAReport.findFirst.mockResolvedValueOnce({
      id: "qa-first",
      conversationDesignStateId: "state-1",
      conversationDesignStateVersion: 1,
      prdDocumentId: "prd-1",
      prototypeArtifactId: null,
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ started_at: new Date("2026-06-20T08:00:00.000Z") }])
      .mockResolvedValueOnce([{
        currentDesignStateId: null,
        currentPrdDocumentId: null,
        currentPrototypeArtifactId: null,
        latestQaReportId: null,
      }]);
    stateService.attachGeneratedArtifactsInTransaction.mockResolvedValue({
      ...state,
      status: "doc_ready",
      prdDocument: { ...document, status: "ready" },
    });

    await service.publishAppliedArtifacts({
      conversationId: "conversation-1",
      userId: "user-1",
      runId: "run-first",
      commitToken: "lease-first",
      qaReportId: "qa-first",
      applied: { prdDocument: document, state, publishFence: fence },
      runResult: { status: "success" },
      outputSummary: "首份 PRD 已生成",
    });

    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "conversation-1",
        currentDesignStateId: null,
      }),
      data: expect.objectContaining({
        currentDesignStateId: "state-1",
        currentPrdDocumentId: "prd-1",
        currentPrototypeArtifactId: null,
        latestQaReportId: "qa-first",
      }),
    });
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
    text: fullPrototypeHtml(),
  };
}

function fullPrototypeHtml(extraBody = "") {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>签到领积分活动原型</title>",
    "<style>body{margin:0;font-family:sans-serif}.panel{display:grid;padding:16px}.btn{border-radius:6px}</style>",
    "</head>",
    "<body>",
    "<main class=\"panel\"><button class=\"btn\">立即签到</button><table><tbody><tr><td>签到页</td></tr></tbody></table></main>",
    extraBody,
    "</body>",
    "</html>",
  ].join("");
}

function basePublishFence(overrides: Record<string, unknown> = {}) {
  return {
    currentDesignStateId: "state-current",
    currentDesignStateVersion: 2,
    currentDesignStateUpdatedAt: "2026-06-20T07:00:00.000Z",
    currentPrdDocumentId: null,
    currentPrototypeArtifactId: null,
    latestQaReportId: null,
    ...overrides,
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
