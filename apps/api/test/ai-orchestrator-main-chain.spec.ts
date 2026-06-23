import { AgentName, MessageType, ProjectStatus, UserIntent } from "@prisma/client";
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
    stateService.attachGeneratedArtifacts.mockResolvedValue({
      ...state,
      status: "prototype_ready",
      prdDocument,
      prototypeSpec,
    });
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
  });

  it("runs formal requirements through state, PRD, prototype, QA and canonical stream events", async () => {
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
      message: "已完成产品设计状态、PRD 草案、HTML 原型和 QA 校验。",
      productDesignState: expect.objectContaining({ id: "state-1", status: "prototype_ready" }),
      prdDocument: expect.objectContaining({ id: "prd-1" }),
      prototypeSpec: expect.objectContaining({ id: "prototype-spec-1" }),
      prototypeArtifact: expect.objectContaining({ id: "artifact-1" }),
      qaReport: expect.objectContaining({ id: "qa-1", passed: true }),
      productBuildPlan: expect.objectContaining({ id: "plan-1" }),
      nextAction: { type: "review_prototype" },
    }));
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
    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalledWith(
      expect.objectContaining({ id: "state-1" }),
      expect.objectContaining({ id: "prototype-spec-1" }),
      expect.objectContaining({ htmlContent: expect.stringContaining("<!doctype html>") }),
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(qaService.runForProject).toHaveBeenCalledWith("project-1", "user-1", expect.objectContaining({
      trigger: "initial_generation",
      runId: "run-1",
      prdDocument: expect.objectContaining({ id: "prd-1" }),
      prototypeSpec: expect.objectContaining({ id: "prototype-spec-1" }),
      prototypeArtifact: expect.objectContaining({ id: "artifact-1" }),
    }));
    expect(knowledgeExtractorAgent.run).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        confirmedByUser: false,
        prdDocument: expect.objectContaining({ id: "prd-1" }),
        prototypeSpec: expect.objectContaining({ id: "prototype-spec-1" }),
      }),
    }));

    const eventTypes = stream.emit.mock.calls.map(([input]) => input.type);
    expect(eventTypes).toEqual(expect.arrayContaining([
      "state_updated",
      "state_version_created",
      "prd_updated",
      "prototype_updated",
      "qa_completed",
      "run_completed",
    ]));
    expect(eventTypes.indexOf("state_updated")).toBeLessThan(eventTypes.indexOf("prd_updated"));
    expect(eventTypes.indexOf("prd_updated")).toBeLessThan(eventTypes.indexOf("prototype_updated"));
    expect(eventTypes.indexOf("prototype_updated")).toBeLessThan(eventTypes.indexOf("qa_completed"));
    expect(eventTypes.indexOf("qa_completed")).toBeLessThan(eventTypes.indexOf("run_completed"));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "prd_updated",
      step: "prd_generation",
      data: expect.objectContaining({ id: "prd-1" }),
    }));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "prototype_updated",
      step: "prototype_code_generation",
      data: expect.objectContaining({
        prototypeSpec: expect.objectContaining({ id: "prototype-spec-1" }),
        prototypeArtifact: expect.objectContaining({ id: "artifact-1" }),
      }),
    }));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "qa_completed",
      step: "qa_check",
      data: expect.objectContaining({
        id: "qa-1",
        issues: [],
        qaReport: expect.objectContaining({ id: "qa-1" }),
        qaGate: expect.objectContaining({
          status: "open",
          allowExportOrPublish: true,
          allowPersistKnowledge: true,
        }),
      }),
    }));
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: "已完成产品设计状态、PRD 草案、HTML 原型和 QA 校验。",
      relatedRunId: "run-1",
    }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prototype_ready }),
    });
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
