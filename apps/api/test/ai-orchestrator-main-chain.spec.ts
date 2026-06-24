import { AgentName, MessageType, ModelTaskType, ProjectStatus, UserIntent } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiOrchestratorService } from "../src/ai/ai-orchestrator.service";
import type {
  KnowledgeContext,
  PatchPlan,
  PatchRecord,
  ProductBuildPlan,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QAReport,
  RequirementAnalysis,
  RequirementDocument,
  RequirementDocumentDraft,
} from "../src/ai/ai-vibe.types";

describe("AiOrchestrator main vibe chain", () => {
  let stepIndex = 0;
  const runLog = {
    createStep: vi.fn(),
    startStep: vi.fn(),
    completeStep: vi.fn(),
    failStep: vi.fn(),
    markRunIntent: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  };
  const stream = { emit: vi.fn() };
  const stateService = {
    createDraft: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
    applyPatch: vi.fn(),
  };
  const documentService = {
    saveGeneratedDocument: vi.fn(),
  };
  const prototypeService = {
    saveGeneratedPrototype: vi.fn(),
  };
  const exportService = {};
  const qaService = {
    runForProject: vi.fn(),
  };
  const messageService = {
    createAssistantMessage: vi.fn(),
    updateProjectActivity: vi.fn(),
  };
  const prisma = {
    project: {
      update: vi.fn(),
    },
    decisionTrace: {
      create: vi.fn(),
    },
  };
  const intentAgent = { run: vi.fn() };
  const knowledgeAgent = { run: vi.fn() };
  const requirementAnalystAgent = { run: vi.fn() };
  const productPlannerAgent = { run: vi.fn() };
  const productDesignerAgent = { run: vi.fn() };
  const prdWriterAgent = { run: vi.fn() };
  const prototypeDesignerAgent = { run: vi.fn() };
  const prototypeCodeAgent = { run: vi.fn() };
  const patchService = { createPatchCandidateFromRun: vi.fn() };
  const qaAgent = { run: vi.fn() };
  const knowledgeExtractorAgent = { run: vi.fn() };
  const service = new AiOrchestratorService(
    runLog as never,
    stream as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
    exportService as never,
    patchService as never,
    qaService as never,
    messageService as never,
    prisma as never,
    intentAgent as never,
    knowledgeAgent as never,
    requirementAnalystAgent as never,
    productPlannerAgent as never,
    productDesignerAgent as never,
    prdWriterAgent as never,
    prototypeDesignerAgent as never,
    prototypeCodeAgent as never,
    qaAgent as never,
    knowledgeExtractorAgent as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    stepIndex = 0;
    runLog.createStep.mockImplementation(async () => ({ id: `step-${++stepIndex}` }));
    stream.emit.mockResolvedValue({});
    const state = baseState();
    const plan = baseBuildPlan();
    const prdDocument = basePrdDocument();
    const prototypeSpec = basePrototypeSpec();
    const prototypeArtifact = basePrototypeArtifact();
    const qaReport = baseQaReport();

    intentAgent.run.mockResolvedValue({
      data: {
        intent: UserIntent.new_requirement,
        confidence: 0.96,
        reason: "用户正在发起新的产品需求。",
        requiresSelection: false,
        isAmbiguous: false,
      },
    });
    knowledgeAgent.run.mockResolvedValue({ data: baseKnowledgeContext() });
    requirementAnalystAgent.run.mockResolvedValue({ data: baseRequirementAnalysis() });
    productPlannerAgent.run.mockResolvedValue({ data: plan });
    productDesignerAgent.run.mockResolvedValue({ data: { ...state, id: undefined } });
    stateService.createDraft.mockResolvedValue(state);
    prdWriterAgent.run.mockResolvedValue({ data: basePrdDraft() });
    documentService.saveGeneratedDocument.mockResolvedValue(prdDocument);
    prototypeDesignerAgent.run.mockResolvedValue({ data: prototypeSpec });
    prototypeCodeAgent.run.mockResolvedValue({
      data: {
        projectId: "project-1",
        prototypeSpecId: "prototype-spec-1",
        htmlContent: "<!doctype html><html><body>签到</body></html>",
        entryFilePath: "index.html",
        targetDevice: "both",
        pageCount: 1,
      },
    });
    prototypeService.saveGeneratedPrototype.mockResolvedValue({
      prototypeSpec,
      artifact: prototypeArtifact,
      version: { id: "prototype-version-1" },
    });
    stateService.attachGeneratedArtifacts.mockImplementation(async (_stateId: string, input: { status?: string }) => ({
      ...state,
      status: input?.status ?? "prototype_ready",
      prdDocument,
      prototypeSpec,
    }));
    qaService.runForProject.mockResolvedValue(qaReport);
    knowledgeExtractorAgent.run.mockResolvedValue({
      data: {
        candidates: [{
          title: "每日签到规则",
          content: "用户每日只能签到一次。",
          suggestedType: "strong_rule",
          suggestedTags: ["签到"],
          confidence: 0.9,
          sourcePath: "businessRules[0]",
          reason: "从生成链路中发现可复用规则。",
        }],
      },
    });
    patchService.createPatchCandidateFromRun.mockResolvedValue({
      patchRecord: basePatchRecord(),
      patchPreview: basePatchPreview(),
      assistantMessage: { id: "assistant-patch-1" },
      result: {
        patchRecord: basePatchRecord(),
        patchPreview: basePatchPreview(),
        patchPlan: basePatchPlan(),
        nextAction: { type: "confirm_patch" },
      },
    });
    prisma.decisionTrace.create.mockImplementation(async ({ data }) => ({
      id: `decision-${data.sourceType}`,
      ...data,
      createdAt: new Date("2026-06-24T00:00:00.000Z"),
    }));
  });

  it("生成 PRD 后停在确认门 A（review_prd），不连跑原型/QA", async () => {
    const result = await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "做一个每日签到活动",
        recentMessages: [],
        attachments: [],
        traceId: "trace-1",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      runId: "run-1",
      projectId: "project-1",
      message: "已生成 PRD 草案，请确认无误后我再继续生成原型。",
      prdDocument: expect.objectContaining({ id: "prd-1" }),
      productBuildPlan: expect.objectContaining({ id: "plan-1" }),
      requirementIntakeGraph: expect.objectContaining({
        schema: "requirement.intake.graph.v1",
        requirementPackageId: expect.stringMatching(/^requirement_package_/),
        productBuildPlanId: "plan-1",
        gateAction: "continue",
      }),
      nextAction: { type: "review_prd", wantsPrototype: true },
    }));
    expect(result.requirementIntakeGraph?.nodes.map((node) => node.name)).toEqual([
      "intent",
      "knowledge",
      "context_fetch",
      "requirement",
      "planner",
      "validator",
      "safety",
      "gate",
    ]);
    expect(result.requirementIntakeGraph?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "intent", to: "knowledge", mode: "async" }),
      expect.objectContaining({ from: "intent", to: "context_fetch", mode: "async" }),
      expect.objectContaining({ from: "requirement", to: "planner", mode: "shared_input" }),
      expect.objectContaining({ from: "requirement", to: "validator", mode: "shared_input" }),
      expect.objectContaining({ from: "requirement", to: "safety", mode: "shared_input" }),
    ]));
    // 确认门 A 之前：PRD 已落库（doc_ready），但不生成原型、不跑 QA、不抽知识
    expect(stateService.createDraft).toHaveBeenCalledWith("project-1", expect.any(Object), expect.objectContaining({
      userId: "user-1",
      runId: "run-1",
      messageId: "message-1",
    }));
    expect(documentService.saveGeneratedDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: "state-1" }),
      expect.objectContaining({ title: "每日签到活动 PRD" }),
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith(
      "state-1",
      expect.objectContaining({ status: "doc_ready" }),
    );
    expect(prisma.decisionTrace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        sourceType: "prd_generation",
        sourceId: "prd-1",
        selectedStrategy: "propose_prd_then_wait_for_confirmation",
        output: expect.objectContaining({
          decisionCard: expect.objectContaining({
            title: "PRD 草案生成决策",
          }),
          nextGate: "review_prd",
        }),
      }),
    });
    expect(prototypeDesignerAgent.run).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
    expect(qaService.runForProject).not.toHaveBeenCalled();
    expect(knowledgeExtractorAgent.run).not.toHaveBeenCalled();

    const eventTypes = stream.emit.mock.calls.map(([input]) => input.type);
    expect(eventTypes).toEqual(expect.arrayContaining(["state_updated", "prd_updated", "run_completed"]));
    expect(eventTypes).not.toContain("prototype_updated");
    expect(eventTypes).not.toContain("qa_completed");
    const completedSteps = stream.emit.mock.calls
      .map(([input]) => input)
      .filter((input) => input.type === "step_completed")
      .map((input) => input.step);
    expect(completedSteps.indexOf("knowledge_retrieval")).toBeLessThan(completedSteps.indexOf("requirement_analysis"));
    expect(completedSteps.indexOf("context_fetch")).toBeLessThan(completedSteps.indexOf("requirement_analysis"));
    expect(completedSteps.indexOf("requirement_packaging")).toBeLessThan(completedSteps.indexOf("product_planning"));
    expect(completedSteps.indexOf("product_planning")).toBeLessThan(completedSteps.indexOf("requirement_validation"));
    expect(completedSteps.indexOf("product_planning")).toBeLessThan(completedSteps.indexOf("safety_check"));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "message_delta",
      data: expect.objectContaining({
        requirementIntakeGraph: expect.objectContaining({
          schema: "requirement.intake.graph.v1",
          gateAction: "continue",
        }),
      }),
    }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prd_ready }),
    });
  });

  it("continues the main flow when Product Planner falls back", async () => {
    const plannerFallback = {
      used: true,
      level: "acceptable_result" as const,
      action: "continue" as const,
      agentName: AgentName.product_planner_agent,
      taskType: ModelTaskType.product_planning,
      fallbackMode: "deterministic_product_build_plan",
      errorCode: "MODEL_CALL_TIMEOUT" as const,
      errorMessage: "模型调用超时",
      reason: "Product Planner 模型调用超时，使用确定性规划。",
      userMessage: "Product Planner 模型规划未及时完成，已使用规则兜底生成执行计划并继续后续链路。",
      canContinue: true,
      allowsConfirmation: true,
      allowsKnowledgeExtraction: true,
      allowsExport: true,
      occurredAt: "2026-06-24T00:00:00.000Z",
    };
    productPlannerAgent.run.mockResolvedValueOnce({
      data: baseBuildPlan(),
      fallback: plannerFallback,
    });

    const result = await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-fallback",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "做一个每日签到活动",
        recentMessages: [],
        attachments: [],
        traceId: "trace-fallback",
      },
    });

    expect(result.nextAction).toEqual({ type: "review_prd", wantsPrototype: true });
    expect(stateService.createDraft).toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).toHaveBeenCalled();
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "fallback_used",
      step: "product_planning",
      content: plannerFallback.userMessage,
      data: plannerFallback,
    }));
    expect(runLog.completeRun).toHaveBeenCalledWith(
      "run-fallback",
      expect.objectContaining({ productBuildPlan: expect.objectContaining({ id: "plan-1" }) }),
      "已生成 PRD 草案，请确认无误后我再继续生成原型。",
    );
  });

  it("generate_prd 意图只生成文档，wantsPrototype 为 false", async () => {
    intentAgent.run.mockResolvedValueOnce({
      data: {
        intent: UserIntent.generate_prd,
        confidence: 0.95,
        reason: "用户只想要需求文档。",
        requiresSelection: false,
        isAmbiguous: false,
      },
    });

    const result = await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "只帮我写需求文档",
        recentMessages: [],
        attachments: [],
        traceId: "trace-1",
      },
    });

    expect(result.nextAction).toEqual({ type: "review_prd", wantsPrototype: false });
    expect(prototypeDesignerAgent.run).not.toHaveBeenCalled();
  });

  it("blocks generation when attached requirement material fails the input quality gate", async () => {
    const result = await service.run({
      userMessageId: "message-1",
      attachments: [
        { fileId: "file-1", fileName: "需求文档模板.docx", fileType: "docx" },
      ],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "做一下这个需求",
        recentMessages: [],
        attachments: [
          { fileId: "file-1", fileName: "需求文档模板.docx", fileType: "docx" },
        ],
        traceId: "trace-1",
      },
    });

    expect(result.inputQuality).toEqual(expect.objectContaining({
      status: "must_optimize",
      shouldBlock: true,
      hardGateTriggered: true,
    }));
    expect(result.nextAction?.type).toBe("ask_clarification");
    expect(result.message).toContain("输入资料评分");
    expect(knowledgeAgent.run).not.toHaveBeenCalled();
    expect(productPlannerAgent.run).not.toHaveBeenCalled();
    expect(prdWriterAgent.run).not.toHaveBeenCalled();
    expect(prisma.decisionTrace.create).not.toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.clarifying }),
    });
  });

  it("确认门 A 之后 confirmPrdAndContinue 生成原型、QA 并停在 review_prototype", async () => {
    const confirmedState = {
      ...baseState(),
      status: "doc_confirmed",
      prdDocument: { ...basePrdDocument(), status: "confirmed" },
    };
    const result = await service.confirmPrdAndContinue({
      userMessageId: "message-2",
      attachments: [],
      context: {
        runId: "run-2",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "确认 PRD，继续生成原型。",
        recentMessages: [],
        attachments: [],
        productDesignState: confirmedState,
        traceId: "trace-2",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      runId: "run-2",
      projectId: "project-1",
      message: "已完成产品设计状态、PRD 草案、HTML 原型和 QA 校验。",
      prototypeSpec: expect.objectContaining({ id: "prototype-spec-1" }),
      prototypeArtifact: expect.objectContaining({ id: "artifact-1" }),
      qaReport: expect.objectContaining({ id: "qa-1", passed: true }),
      nextAction: { type: "review_prototype" },
    }));
    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalled();
    expect(qaService.runForProject).toHaveBeenCalledWith("project-1", "user-1", expect.objectContaining({
      trigger: "initial_generation",
      runId: "run-2",
    }));
    expect(prisma.decisionTrace.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        sourceType: "prototype_generation",
        sourceId: "artifact-1",
        selectedStrategy: "confirmed_prd_to_html_prototype",
        output: expect.objectContaining({
          decisionCard: expect.objectContaining({
            title: "原型生成决策",
          }),
          nextGate: "review_prototype",
        }),
      }),
    });
    expect(knowledgeExtractorAgent.run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ confirmedByUser: false }),
    }));

    const eventTypes = stream.emit.mock.calls.map(([input]) => input.type);
    expect(eventTypes.indexOf("prototype_updated")).toBeLessThan(eventTypes.indexOf("qa_completed"));
    expect(eventTypes.indexOf("qa_completed")).toBeLessThan(eventTypes.indexOf("run_completed"));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prototype_ready }),
    });
  });

  it("keeps the project at the PRD gate status when prototype generation fails after PRD confirmation", async () => {
    const confirmedState = {
      ...baseState(),
      status: "doc_confirmed",
      prdDocument: { ...basePrdDocument(), status: "confirmed" },
    };
    prototypeDesignerAgent.run.mockRejectedValueOnce(new Error("prototype agent unavailable"));

    await expect(service.confirmPrdAndContinue({
      userMessageId: "message-2",
      attachments: [],
      context: {
        runId: "run-2",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "确认 PRD，继续生成原型。",
        recentMessages: [],
        attachments: [],
        productDesignState: confirmedState,
        currentProjectStatus: ProjectStatus.prd_ready,
        traceId: "trace-2",
      },
    })).rejects.toThrow("prototype agent unavailable");

    expect(runLog.failRun).toHaveBeenCalledWith("run-2", expect.any(Error));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prd_ready }),
    });
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
  });

  it("已有已确认文档时，generate_prototype 意图直接进入原型阶段（FR-2.2）", async () => {
    intentAgent.run.mockResolvedValueOnce({
      data: {
        intent: UserIntent.generate_prototype,
        confidence: 0.95,
        reason: "用户已有文档，要求生成原型。",
        requiresSelection: false,
        isAmbiguous: false,
      },
    });
    const stateWithPrd = {
      ...baseState(),
      status: "doc_confirmed",
      prdDocument: { ...basePrdDocument(), status: "confirmed" },
    };

    const result = await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "根据文档生成原型",
        recentMessages: [],
        attachments: [],
        productDesignState: stateWithPrd,
        traceId: "trace-1",
      },
    });

    // 直接进入原型阶段，不重新生成文档（不调用文档/规划/设计链路）
    expect(knowledgeAgent.run).not.toHaveBeenCalled();
    expect(productPlannerAgent.run).not.toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalled();
    expect(result.nextAction).toEqual({ type: "review_prototype" });
  });

  it("does not bypass confirmation gate for an unconfirmed doc_ready PRD", async () => {
    intentAgent.run.mockResolvedValueOnce({
      data: {
        intent: UserIntent.generate_prototype,
        confidence: 0.95,
        reason: "用户要求生成原型，但 PRD 尚未确认。",
        requiresSelection: false,
        isAmbiguous: false,
      },
    });
    const unconfirmedState = {
      ...baseState(),
      status: "doc_ready",
      prdDocument: basePrdDocument(),
    };

    await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "根据文档生成原型",
        recentMessages: [],
        attachments: [],
        productDesignState: unconfirmedState,
        traceId: "trace-1",
      },
    });

    expect(knowledgeAgent.run).toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
  });

  it("does not bypass confirmation gate when doc_confirmed is out of sync with the PRD status", async () => {
    intentAgent.run.mockResolvedValueOnce({
      data: {
        intent: UserIntent.generate_prototype,
        confidence: 0.95,
        reason: "用户要求生成原型，但 PRD 记录尚未确认。",
        requiresSelection: false,
        isAmbiguous: false,
      },
    });
    const outOfSyncState = {
      ...baseState(),
      status: "doc_confirmed",
      prdDocument: basePrdDocument(),
    };

    await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "根据文档生成原型",
        recentMessages: [],
        attachments: [],
        productDesignState: outOfSyncState,
        traceId: "trace-1",
      },
    });

    expect(knowledgeAgent.run).toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
  });

  it("ends the main flow and shows the upstream agent error when an agent fails", async () => {
    intentAgent.run.mockRejectedValueOnce(new Error("upstream agent unavailable"));

    await expect(service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "做一个每日签到活动",
        recentMessages: [],
        attachments: [],
        traceId: "trace-1",
      },
    })).rejects.toThrow("upstream agent unavailable");

    expect(runLog.failRun).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "upstream agent unavailable",
      type: MessageType.error,
      relatedRunId: "run-1",
    }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.qa_failed }),
    });
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "run_failed",
      content: "upstream agent unavailable",
      data: expect.objectContaining({
        errorMessage: "upstream agent unavailable",
        runId: "run-1",
        projectId: "project-1",
      }),
    }));
    expect(stateService.createDraft).not.toHaveBeenCalled();
    expect(runLog.completeRun).not.toHaveBeenCalled();
  });

  it("routes selected-region patches to confirmation without applying or regenerating artifacts", async () => {
    intentAgent.run.mockResolvedValueOnce({
      data: {
        intent: UserIntent.patch_prototype,
        confidence: 0.96,
        reason: "用户选中了原型局部区域并要求修改。",
        requiresSelection: true,
        isAmbiguous: false,
      },
    });

    const selectedRegion = {
      type: "prototype",
      targetId: "artifact-1",
      artifactId: "artifact-1",
      pageId: "page_home",
      componentId: "page_home_button",
      label: "签到按钮",
    };
    const result = await service.run({
      userMessageId: "message-1",
      attachments: [],
      context: {
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "把按钮改成醒目的红色",
        selectedRegion,
        recentMessages: [],
        attachments: [],
        productDesignState: baseState(),
        traceId: "trace-1",
      },
    });

    expect(patchService.createPatchCandidateFromRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      userInstruction: "把按钮改成醒目的红色",
      selectedRegion: expect.objectContaining({ type: "prototype", targetId: "artifact-1" }),
      runId: "run-1",
      traceId: "trace-1",
      instructionMessageId: "message-1",
      knowledgeContext: expect.objectContaining({ summary: "未命中知识。" }),
    }));
    expect(stateService.applyPatch).not.toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
    expect(qaService.runForProject).not.toHaveBeenCalled();
    expect(knowledgeExtractorAgent.run).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      patchRecord: expect.objectContaining({ id: "patch-1", status: "needs_confirmation" }),
      patchPlan: expect.objectContaining({ needUserConfirm: true, needsUserConfirmation: true }),
      nextAction: expect.objectContaining({ type: "confirm_patch" }),
    }));
  });
});

function baseState(): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 1,
    title: "每日签到活动",
    summary: "用户每日签到领取奖励。",
    businessGoal: "提升用户活跃。",
    background: "运营需要轻量活动。",
    targetUsers: [{ id: "target_user_1", name: "普通用户" }],
    userScenarios: [{ id: "scenario_1", title: "每日签到" }],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [{ id: "feature_checkin", name: "签到" }],
    backendConfigs: [{ id: "config_reward", name: "奖励配置" }],
    frontendRules: [{ id: "front_signed", title: "已签到态" }],
    businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
    stateRules: [{ id: "state_signed", name: "已签到" }],
    exceptionScenarios: [{ id: "exception_repeat", title: "重复签到" }],
    acceptanceCriteria: [{ id: "accept_once", title: "每日签到限制" }],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "design_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function baseKnowledgeContext(): KnowledgeContext {
  return {
    query: "每日签到活动",
    strongRules: [],
    defaultRules: [],
    referenceCases: [],
    designPatterns: [],
    prdWritingRules: [],
    prototypeRules: [],
    businessConcepts: [],
    conflicts: [],
    unknownAreas: [],
    summary: "未命中知识。",
  };
}

function baseRequirementAnalysis(): RequirementAnalysis {
  return {
    completenessScore: 0.92,
    knownFromUser: ["每日签到活动"],
    knownFromKnowledge: [],
    inferredByAI: [],
    missingCritical: [],
    missingOptional: [],
    conflicts: [],
    shouldAskUser: false,
    clarificationQuestions: [],
  };
}

function baseBuildPlan(): ProductBuildPlan {
  return {
    id: "plan-1",
    projectId: "project-1",
    title: "每日签到活动",
    goal: "提升用户活跃",
    summary: "生成签到活动的 PRD 和 HTML 原型。",
    requirementMode: "formal_requirement",
    sourceSummary: {
      userFacts: ["每日签到"],
      knowledgeFacts: [],
      assumptions: [],
      openQuestions: [],
    },
    scope: {
      inScope: ["签到页", "每日一次规则"],
      outOfScope: [],
      targetUsers: ["普通用户"],
      coreScenarios: ["用户完成签到"],
    },
    pagePlan: [{
      id: "page_home",
      name: "签到页",
      purpose: "展示签到入口和状态",
      priority: "must",
      sourcePaths: ["pages[0]"],
    }],
    statePlan: [{
      id: "state_signed",
      name: "已签到",
      coverage: "success",
      required: true,
      sourcePaths: ["stateRules[0]"],
    }],
    deliverables: {
      productDesignState: true,
      prd: true,
      prototypeSpec: true,
      htmlPrototype: true,
      qa: true,
      knowledgeCandidates: true,
    },
    agentSequence: [],
    qaFocus: ["PRD 与原型一致"],
    risks: [],
    createdAt: "2026-06-20T08:00:00.000Z",
  };
}

function basePatchPlan(): PatchPlan {
  return {
    id: "patch-plan-1",
    projectId: "project-1",
    patchType: "prototype",
    targetNodes: ["pages[0].components[0]"],
    impactScope: ["prototypeSpec", "htmlPrototype"],
    operations: [{
      op: "replace",
      path: "/pages/0/components/0/content",
      value: "醒目签到",
      reason: "用户要求按钮更醒目。",
    }],
    regenerationPlan: {
      prd: "affected_sections",
      prototypeSpec: "affected_pages",
      htmlPrototype: "affected_pages",
      qa: "full",
    },
    risks: [{ level: "low", message: "仅影响按钮文案和视觉表达。" }],
    needUserConfirm: true,
    needsUserConfirmation: true,
    reason: "用户选中签到按钮后要求局部调整。",
    summary: "调整签到按钮表达。",
  };
}

function basePatchRecord(): PatchRecord {
  return {
    id: "patch-1",
    projectId: "project-1",
    conversationId: "conversation-1",
    instructionMessageId: "message-1",
    selectedRegion: {
      type: "prototype",
      targetId: "artifact-1",
      artifactId: "artifact-1",
      pageId: "page_home",
      componentId: "page_home_button",
      label: "签到按钮",
    },
    userInstruction: "把按钮改成醒目的红色",
    patchPlan: basePatchPlan(),
    operations: basePatchPlan().operations,
    status: "needs_confirmation",
    beforeProductDesignStateVersion: 1,
    generatedByRunId: "run-1",
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function basePatchPreview() {
  return {
    id: "patch-preview-1",
    patchId: "patch-1",
    status: "needs_confirmation",
    previewStatus: "ready",
    patchPlan: basePatchPlan(),
    operations: basePatchPlan().operations,
    requiresConfirmation: true,
    previewOnly: true,
    message: "补丁预览已生成。确认前不会修改产品设计状态、需求文档或原型。",
  };
}

function basePrdDraft(): RequirementDocumentDraft {
  return {
    projectId: "project-1",
    title: "每日签到活动 PRD",
    sections: [{
      id: "overview",
      title: "产品概述",
      type: "overview",
      level: 1,
      order: 1,
      content: "用户每日签到领取奖励。",
      sourcePaths: ["summary"],
    }],
    knowledgeRefs: [],
    assumptions: [],
    pendingQuestions: [],
    validationNotes: [],
  };
}

function basePrdDocument(): RequirementDocument {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 1,
    title: "每日签到活动 PRD",
    status: "ready",
    sections: basePrdDraft().sections,
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    generatedByRunId: "run-1",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function basePrototypeSpec(): PrototypeSpec {
  return {
    id: "prototype-spec-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 1,
    title: "每日签到活动原型",
    targetDevice: "both",
    styleGuide: {
      tone: "clean",
      layoutDensity: "comfortable",
      borderRadius: "medium",
    },
    pages: [{
      id: "page_home",
      name: "签到页",
      device: "responsive",
      layout: "single_column",
      components: [{
        id: "page_home_button",
        name: "签到按钮",
        type: "button",
        content: "立即签到",
        sourcePaths: ["features[0]"],
      }],
      sourcePaths: ["pages[0]"],
      order: 1,
    }],
    navigation: [],
    interactions: [{
      id: "interaction_checkin",
      pageId: "page_home",
      componentId: "page_home_button",
      event: "click",
      action: "show_toast",
      mockResult: "签到成功",
      sourcePaths: ["features[0]"],
    }],
    assumptions: [],
    knowledgeRefs: [],
    generatedByRunId: "run-1",
  };
}

function basePrototypeArtifact(): PrototypeArtifact {
  return {
    id: "artifact-1",
    projectId: "project-1",
    prototypeSpecId: "prototype-spec-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 1,
    title: "每日签到活动原型",
    status: "ready",
    htmlContent: "<!doctype html><html><body>签到</body></html>",
    entryFilePath: "index.html",
    targetDevice: "both",
    pageCount: 1,
    generatedByRunId: "run-1",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    html: "<!doctype html><html><body>签到</body></html>",
    entryFile: "index.html",
    assets: [],
  };
}

function baseQaReport(): QAReport {
  return {
    id: "qa-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 1,
    prdDocumentId: "prd-1",
    prototypeArtifactId: "artifact-1",
    prototypeSpecId: "prototype-spec-1",
    status: "passed",
    trigger: "initial_generation",
    checkTypes: ["state_prd_consistency"],
    summary: "QA 完成：未发现问题。",
    issues: [],
    blockingCount: 0,
    majorCount: 0,
    minorCount: 0,
    infoCount: 0,
    generatedByRunId: "run-1",
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    passed: true,
    gate: {
      status: "open",
      allowConfirmArtifacts: true,
      allowPersistKnowledge: true,
      allowExportOrPublish: true,
      shouldReturnToPatch: false,
      reportId: "qa-1",
      reportStatus: "passed",
      blockingReasons: [],
      warnings: [],
      requiredActions: [],
      evaluatedAt: "2026-06-20T08:00:00.000Z",
    },
  };
}
