import {
  AgentName,
  AgentStepStatus,
  MessageType,
  PatchRecordStatus,
  ProductDesignStateStatus,
  ProjectStatus,
  UserIntent,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatchService } from "../src/ai/patch.service";
import type {
  PatchPlan,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  RequirementDocument,
} from "../src/ai/ai-vibe.types";

describe("PatchService", () => {
  const now = new Date("2026-06-20T08:00:00Z");
  const prisma = {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
    },
    patchRecord: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const messageService = {
    createUserMessage: vi.fn(),
    createAssistantMessage: vi.fn(),
  };
  const fileAssetService = {
    getAttachmentSummaries: vi.fn(),
    attachFilesToMessage: vi.fn(),
  };
  const runLog = {
    createRun: vi.fn(),
    markRunIntent: vi.fn(),
    createStep: vi.fn(),
    startStep: vi.fn(),
    completeStep: vi.fn(),
    failStep: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  };
  const stream = {
    emit: vi.fn(),
  };
  const stateService = {
    getCurrentState: vi.fn(),
    applyPatch: vi.fn(),
    attachGeneratedArtifacts: vi.fn(),
    restoreStateAfterPatchFailure: vi.fn(),
  };
  const documentService = {
    saveGeneratedDocument: vi.fn(),
  };
  const prototypeService = {
    saveGeneratedPrototype: vi.fn(),
  };
  const patchAgent = {
    run: vi.fn(),
  };
  const prdWriterAgent = {
    run: vi.fn(),
  };
  const prototypeDesignerAgent = {
    run: vi.fn(),
  };
  const prototypeCodeAgent = {
    run: vi.fn(),
  };
  const qaAgent = {
    run: vi.fn(),
  };
  const service = new PatchService(
    prisma as never,
    messageService as never,
    fileAssetService as never,
    runLog as never,
    stream as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
    patchAgent as never,
    prdWriterAgent as never,
    prototypeDesignerAgent as never,
    prototypeCodeAgent as never,
    qaAgent as never,
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
    prisma.conversation.findFirst.mockResolvedValue({ id: "conversation-1", projectId: "project-1" });
    prisma.patchRecord.create.mockImplementation(async ({ data }) => patchRecordRow({ id: "patch-1", ...data }));
    prisma.patchRecord.update.mockImplementation(async ({ data }) => patchRecordRow({ id: "patch-1", ...data }));
    messageService.createUserMessage.mockResolvedValue({
      id: "message-user-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "修改按钮",
      createdAt: now,
    });
    messageService.createAssistantMessage.mockImplementation(async (input) => ({
      id: "message-assistant-1",
      ...input,
      createdAt: now,
    }));
    fileAssetService.getAttachmentSummaries.mockResolvedValue([]);
    fileAssetService.attachFilesToMessage.mockResolvedValue(undefined);
    runLog.createRun.mockResolvedValue({ id: "run-1", traceId: "trace-1", startedAt: now });
    runLog.markRunIntent.mockResolvedValue(undefined);
    runLog.createStep.mockImplementation(async ({ agentName }) => ({
      id: `step-${agentName}`,
      agentName,
      status: AgentStepStatus.pending,
    }));
    runLog.startStep.mockResolvedValue(undefined);
    runLog.completeStep.mockResolvedValue(undefined);
    runLog.failStep.mockResolvedValue(undefined);
    runLog.completeRun.mockResolvedValue(undefined);
    runLog.failRun.mockResolvedValue(undefined);
    stream.emit.mockResolvedValue(undefined);
  });

  it("creates a PatchRecord, applies ProductDesignState operations, regenerates artifacts, and completes QA", async () => {
    const beforeState = baseState();
    const patchedState = baseState({
      version: 2,
      status: "patching",
      frontendRules: [
        ...beforeState.frontendRules,
        { id: "patch_button_copy", title: "按钮文案", description: "按钮文案改为立即签到" },
      ],
      prdDocument: undefined,
      prototypeSpec: undefined,
    });
    const stateWithArtifacts = baseState({
      ...patchedState,
      version: 3,
      status: "prototype_ready",
      prdDocument: basePrd(),
      prototypeSpec: basePrototypeSpec(),
    });
    stateService.getCurrentState.mockResolvedValue(beforeState);
    stateService.applyPatch.mockResolvedValue(patchedState);
    stateService.attachGeneratedArtifacts.mockResolvedValue(stateWithArtifacts);
    patchAgent.run.mockResolvedValue({ data: basePatchPlan() });
    prdWriterAgent.run.mockResolvedValue({ data: basePrdDraft(), modelCallLogId: "model-prd" });
    documentService.saveGeneratedDocument.mockResolvedValue(basePrd());
    prototypeDesignerAgent.run.mockResolvedValue({ data: basePrototypeSpec(), modelCallLogId: "model-spec" });
    prototypeCodeAgent.run.mockResolvedValue({ data: basePrototypeDraft(), modelCallLogId: "model-html" });
    prototypeService.saveGeneratedPrototype.mockResolvedValue({
      prototypeSpec: basePrototypeSpec(),
      artifact: baseArtifact(),
    });
    qaAgent.run.mockResolvedValue({
      data: { passed: true, issues: [], suggestions: ["通过"], autoFixable: true },
      modelCallLogId: "model-qa",
    });

    const result = await service.createPatchForUser(user, "project-1", {
      conversationId: "conversation-1",
      selectedRegion: {
        type: "prototype",
        targetId: "artifact-1",
        artifactId: "artifact-1",
        pageId: "page_home",
        componentId: "page_home_primary_action",
        label: "签到按钮",
        sourcePaths: ["frontendRules"],
      },
      userInstruction: "这个按钮文案改成立即签到。",
    });

    expect(result.patchRecord.status).toBe(PatchRecordStatus.applied);
    expect(result.result.productDesignState.version).toBe(3);
    expect(prisma.patchRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectedRegion: expect.objectContaining({ type: "prototype", targetId: "artifact-1" }),
        status: PatchRecordStatus.planned,
        beforeProductDesignStateVersion: 1,
      }),
    });
    expect(stateService.applyPatch).toHaveBeenCalledWith(
      "project-1",
      beforeState,
      expect.objectContaining({ operations: basePatchPlan().operations }),
      expect.objectContaining({ userId: "user-1", runId: "run-1" }),
    );
    expect(documentService.saveGeneratedDocument).toHaveBeenCalledWith(
      patchedState,
      expect.any(Object),
      expect.objectContaining({ reason: "Patch 后重新生成 PRD" }),
    );
    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalledWith(
      patchedState,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ reason: "Patch 后重新生成 HTML 原型" }),
    );
    expect(qaAgent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          productDesignState: stateWithArtifacts,
          patchPlan: expect.objectContaining({ id: "patch-plan-1" }),
        }),
      }),
    );
    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch_completed",
        data: expect.objectContaining({
          result: expect.objectContaining({
            patchPlan: expect.objectContaining({ id: "patch-plan-1" }),
          }),
        }),
      }),
    );
    expect(runLog.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.patch_prototype);
  });

  it("rolls ProductDesignState back when regeneration fails after patch application", async () => {
    const beforeState = baseState({ version: 7 });
    const patchedState = baseState({ version: 8, status: "patching", prdDocument: undefined, prototypeSpec: undefined });
    const rollbackState = baseState({ version: 9, status: "prototype_ready" });
    stateService.getCurrentState.mockResolvedValue(beforeState);
    stateService.applyPatch.mockResolvedValue(patchedState);
    stateService.restoreStateAfterPatchFailure.mockResolvedValue({
      state: rollbackState,
      version: { id: "version-9", version: 9 },
    });
    patchAgent.run.mockResolvedValue({ data: basePatchPlan() });
    prdWriterAgent.run.mockRejectedValue(new Error("PRD_REGENERATION_FAILED"));

    await expect(
      service.createPatchForUser(user, "project-1", {
        conversationId: "conversation-1",
        selectedRegion: {
          type: "document",
          targetId: "prd-1",
          documentId: "prd-1",
          sectionId: "frontend_rules",
          label: "前端展示规则",
          sourcePaths: ["frontendRules"],
        },
        userInstruction: "补充按钮置灰说明。",
      }),
    ).rejects.toThrow("PRD_REGENERATION_FAILED");

    expect(stateService.restoreStateAfterPatchFailure).toHaveBeenCalledWith(
      "project-1",
      beforeState,
      expect.objectContaining({
        userId: "user-1",
        runId: "run-1",
      }),
    );
    expect(prisma.patchRecord.update).toHaveBeenCalledWith({
      where: { id: "patch-1" },
      data: expect.objectContaining({
        afterProductDesignStateVersion: 9,
      }),
    });
    expect(prisma.patchRecord.update).toHaveBeenCalledWith({
      where: { id: "patch-1" },
      data: expect.objectContaining({
        status: PatchRecordStatus.failed,
        errorMessage: "PRD_REGENERATION_FAILED",
      }),
    });
    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch_failed",
        data: expect.objectContaining({ errorMessage: "PRD_REGENERATION_FAILED" }),
      }),
    );
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { status: ProjectStatus.qa_failed },
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        currentPrdDocumentId: "prd-before",
        currentPrototypeArtifactId: "artifact-before",
        latestQaReportId: "qa-before",
      },
    });
  });
});

function baseProject() {
  return {
    id: "project-1",
    ownerId: "user-1",
    status: ProjectStatus.draft,
    deletedAt: null,
    currentPrdDocumentId: "prd-before",
    currentPrototypeArtifactId: "artifact-before",
    latestQaReportId: "qa-before",
  };
}

function baseState(overrides: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 1,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃。",
    background: "运营活动背景。",
    targetUsers: [],
    userScenarios: [],
    pages: [{ id: "page_home", name: "签到页" }],
    features: [{ id: "feature_checkin", name: "签到" }],
    backendConfigs: [],
    frontendRules: [{ id: "front_initial", title: "默认按钮" }],
    businessRules: [{ id: "rule_daily_once", title: "每日一次" }],
    stateRules: [{ id: "state_default", name: "默认态" }],
    exceptionScenarios: [{ id: "exception_network", title: "网络异常" }],
    acceptanceCriteria: [],
    assumptions: [{ id: "assumption_reward", content: "默认奖励积分", status: "pending" }],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    prdDocument: basePrd(),
    prototypeSpec: basePrototypeSpec(),
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function basePatchPlan(): PatchPlan {
  return {
    id: "patch-plan-1",
    projectId: "project-1",
    intent: "copy_change",
    selectedRegion: {
      type: "prototype",
      targetId: "artifact-1",
      pageId: "page_home",
      componentId: "page_home_primary_action",
      label: "签到按钮",
      sourcePaths: ["frontendRules"],
    },
    patchType: "prototype",
    targetNodes: ["page_home_primary_action"],
    impactScope: ["frontendRules", "prdDocument", "prototypeSpec"],
    operations: [
      {
        op: "add",
        path: "frontendRules",
        value: { id: "patch_button_copy", title: "按钮文案", description: "按钮文案改为立即签到" },
        reason: "用户要求修改按钮文案。",
      },
    ],
    impactAnalysis: {
      affectedStatePaths: ["frontendRules"],
      affectedPrdSectionIds: ["frontend_rules"],
      affectedPrototypePageIds: ["page_home"],
      affectedPrototypeComponentIds: ["page_home_primary_action"],
      affectedAcceptanceCriteriaIds: [],
      requiresPrdRegeneration: true,
      requiresPrototypeRegeneration: true,
      requiresQaCheck: true,
      reason: "按钮文案影响 PRD 与原型。",
    },
    regenerationPlan: {
      prd: "full",
      prototypeSpec: "full",
      htmlPrototype: "full",
      qa: "basic",
    },
    risks: [],
    needUserConfirm: false,
    needsUserConfirmation: false,
    reason: "局部修改按钮文案。",
    summary: "更新按钮文案。",
  };
}

function basePrd(): RequirementDocument {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 2,
    title: "签到活动 PRD",
    status: "ready",
    sections: [
      {
        id: "frontend_rules",
        title: "前端展示规则",
        type: "frontend_rules",
        level: 1,
        order: 1,
        content: "按钮文案为立即签到。",
        sourcePaths: ["frontendRules"],
      },
    ],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function basePrdDraft() {
  return {
    projectId: "project-1",
    title: "签到活动 PRD",
    sections: basePrd().sections,
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
  };
}

function basePrototypeSpec(): PrototypeSpec {
  return {
    id: "spec-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 2,
    title: "签到活动 HTML 原型",
    targetDevice: "both",
    styleGuide: {
      tone: "clean",
      layoutDensity: "comfortable",
      borderRadius: "small",
    },
    pages: [
      {
        id: "page_home",
        name: "签到页",
        device: "responsive",
        layout: "dashboard",
        components: [
          {
            id: "page_home_primary_action",
            name: "签到按钮",
            type: "button",
            content: "立即签到",
            sourcePaths: ["frontendRules"],
          },
        ],
        sourcePaths: ["pages[0]"],
        order: 1,
      },
    ],
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: [],
  };
}

function basePrototypeDraft() {
  return {
    projectId: "project-1",
    prototypeSpecId: "spec-1",
    htmlContent: "<!doctype html><button data-component-id=\"page_home_primary_action\">立即签到</button>",
    entryFilePath: "index.html",
    targetDevice: "both" as const,
    pageCount: 1,
  };
}

function baseArtifact(): PrototypeArtifact {
  return {
    id: "artifact-1",
    projectId: "project-1",
    prototypeSpecId: "spec-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 2,
    title: "签到活动 HTML 原型",
    status: "ready",
    htmlContent: "<!doctype html><button data-component-id=\"page_home_primary_action\">立即签到</button>",
    entryFilePath: "index.html",
    targetDevice: "both",
    pageCount: 1,
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    assets: [],
  };
}

function patchRecordRow(input: Record<string, unknown>) {
  return {
    id: String(input.id ?? "patch-1"),
    projectId: String(input.projectId ?? "project-1"),
    conversationId: String(input.conversationId ?? "conversation-1"),
    instructionMessageId: input.instructionMessageId ? String(input.instructionMessageId) : "message-user-1",
    selectedRegion: input.selectedRegion ?? {
      type: "prototype",
      targetId: "artifact-1",
      pageId: "page_home",
      componentId: "page_home_primary_action",
    },
    userInstruction: String(input.userInstruction ?? "这个按钮文案改成立即签到。"),
    patchPlan: input.patchPlan ?? basePatchPlan(),
    operations: input.operations ?? basePatchPlan().operations,
    status: input.status ?? PatchRecordStatus.planned,
    beforeProductDesignStateVersion: Number(input.beforeProductDesignStateVersion ?? 1),
    afterProductDesignStateVersion:
      typeof input.afterProductDesignStateVersion === "number" ? input.afterProductDesignStateVersion : null,
    affectedPrdDocumentId: input.affectedPrdDocumentId ? String(input.affectedPrdDocumentId) : null,
    affectedPrototypeArtifactId: input.affectedPrototypeArtifactId ? String(input.affectedPrototypeArtifactId) : null,
    generatedByRunId: input.generatedByRunId ? String(input.generatedByRunId) : "run-1",
    errorMessage: input.errorMessage ? String(input.errorMessage) : null,
    createdBy: String(input.createdBy ?? "user-1"),
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-20T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-20T08:00:00Z"),
  };
}
