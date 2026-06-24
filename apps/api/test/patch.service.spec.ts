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
    patchPreview: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    productInteractionEvent: {
      create: vi.fn(),
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
  const knowledgeRetrieval = {
    search: vi.fn(),
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
    trySaveLocalizedGeneratedPrototype: vi.fn(),
  };
  const qaService = {
    runForProject: vi.fn(),
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
    knowledgeRetrieval as never,
    stateService as never,
    documentService as never,
    prototypeService as never,
    qaService as never,
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
    prisma.patchPreview.findUnique.mockResolvedValue(null);
    prisma.patchPreview.create.mockImplementation(async ({ data }) => patchPreviewRow({ id: "preview-1", ...data }));
    prisma.patchPreview.update.mockImplementation(async ({ data, where }) =>
      patchPreviewRow({
        id: where.id,
        status: data.status,
        message: data.message,
        afterProductDesignStateVersion: data.afterProductDesignStateVersion,
      }),
    );
    prisma.productInteractionEvent.create.mockResolvedValue({});
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
    knowledgeRetrieval.search.mockResolvedValue({
      results: [],
      references: [],
    });
    prototypeService.trySaveLocalizedGeneratedPrototype.mockResolvedValue(null);
  });

  it("creates a PatchRecord preview candidate without mutating ProductDesignState", async () => {
    const beforeState = baseState();
    stateService.getCurrentState.mockResolvedValue(beforeState);
    patchAgent.run.mockResolvedValue({ data: basePatchPlan() });

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

    expect(result.status).toBe("candidate_created");
    expect(result.patchRecord.status).toBe(PatchRecordStatus.needs_confirmation);
    expect(result.patchPreview).toEqual(
      expect.objectContaining({
        patchId: "patch-1",
        requiresConfirmation: true,
        diff: expect.objectContaining({
          mode: "product_design_state",
        }),
      }),
    );
    expect(prisma.patchRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectedRegion: expect.objectContaining({ type: "prototype", targetId: "artifact-1" }),
        status: PatchRecordStatus.needs_confirmation,
        beforeProductDesignStateVersion: 1,
      }),
    });
    expect(prisma.patchPreview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        patchRecordId: "patch-1",
        beforeProductDesignStateVersion: 1,
        diff: expect.objectContaining({
          operations: expect.any(Array),
        }),
        riskPanel: expect.objectContaining({
          requiresConfirmation: true,
          versionedApply: true,
        }),
      }),
    });
    expect(stateService.applyPatch).not.toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
    expect(qaService.runForProject).not.toHaveBeenCalled();
    expect(knowledgeRetrieval.search).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        agentName: AgentName.patch_agent,
      }),
    );
    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch_plan_created",
        data: expect.objectContaining({
          patchPreview: expect.objectContaining({ patchId: "patch-1" }),
        }),
      }),
    );
    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run_completed",
        data: expect.objectContaining({
          nextAction: expect.objectContaining({ type: "confirm_patch" }),
        }),
      }),
    );
    expect(runLog.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.patch_prototype);
  });

  it("creates an inline editing Patch candidate without mutating ProductDesignState", async () => {
    const beforeState = baseState();
    stateService.getCurrentState.mockResolvedValue(beforeState);
    patchAgent.run.mockResolvedValue({ data: basePatchPlan() });

    const result = await service.createPatchCandidateForUser(user, "project-1", {
      conversationId: "conversation-1",
      selectedRegion: {
        type: "document",
        targetId: "prd-1",
        documentId: "prd-1",
        sectionId: "frontend_rules",
        label: "前端展示规则",
        sourcePaths: ["frontendRules"],
      },
      userInstruction: "编辑动作：rewrite\n选区内容：按钮文案为立即签到。\n用户指令：表达更清楚。",
      source: "inline_edit",
      interactionEvent: {
        action: "rewrite",
        selectedText: "按钮文案为立即签到。",
      },
    });

    expect(result.status).toBe("candidate_created");
    expect(result.patchRecord.status).toBe(PatchRecordStatus.needs_confirmation);
    expect(stateService.applyPatch).not.toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
    expect(qaService.runForProject).not.toHaveBeenCalled();
    expect(prisma.patchRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectedRegion: expect.objectContaining({ type: "document", sectionId: "frontend_rules" }),
        patchPlan: expect.objectContaining({
          candidateOnly: true,
          needUserConfirm: true,
          needsUserConfirmation: true,
        }),
        status: PatchRecordStatus.needs_confirmation,
        beforeProductDesignStateVersion: 1,
      }),
    });
    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch_plan_created",
        step: "patch_planning",
        data: expect.objectContaining({
          interactionEvent: expect.objectContaining({
            source: "inline_edit",
            action: "rewrite",
            payload: expect.objectContaining({
              selectedText: "按钮文案为立即签到。",
            }),
          }),
        }),
      }),
    );
    expect(prisma.productInteractionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        type: "selection",
        targetType: "prd",
        targetId: "prd-1",
        content: expect.stringContaining("表达更清楚"),
        createdBy: "user-1",
        metadata: expect.objectContaining({
          source: "inline_edit",
          action: "rewrite",
          selectedText: "按钮文案为立即签到。",
        }),
      }),
    });
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "已生成 Patch 候选，请在修改历史中确认后再应用。",
        metadata: expect.objectContaining({
          candidateOnly: true,
        }),
      }),
    );
    expect(runLog.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.patch_document);
  });

  it("previews a Patch candidate without applying ProductDesignState operations", async () => {
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-preview-1",
        status: PatchRecordStatus.needs_confirmation,
      }),
      project: baseProject(),
    });

    const result = await service.previewForUser(user, "patch-preview-1");

    expect(result.patchPreview).toEqual(
      expect.objectContaining({
        patchId: "patch-preview-1",
        status: PatchRecordStatus.needs_confirmation,
        previewOnly: true,
        requiresConfirmation: true,
        operations: basePatchPlan().operations,
        diff: expect.objectContaining({
          mode: "product_design_state",
        }),
      }),
    );
    expect(prisma.patchPreview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patchRecordId: "patch-preview-1",
        riskPanel: expect.objectContaining({
          requiresConfirmation: true,
        }),
      }),
    });
    expect(stateService.applyPatch).not.toHaveBeenCalled();
    expect(documentService.saveGeneratedDocument).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
    expect(qaService.runForProject).not.toHaveBeenCalled();
  });

  it("applies a confirmed Patch Preview, regenerates artifacts, runs QA, and returns applied preview", async () => {
    const beforeState = baseState({ version: 1 });
    const patchedState = baseState({ version: 2, status: "patching", prdDocument: undefined, prototypeSpec: undefined });
    const stateWithArtifacts = baseState({ version: 2, status: "prototype_ready" });
    const prdDocument = basePrd();
    const prototypeSpec = basePrototypeSpec();
    const artifact = baseArtifact();
    const qaReport = baseQaReport();
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-1",
        status: PatchRecordStatus.needs_confirmation,
        beforeProductDesignStateVersion: 1,
      }),
      project: baseProject(),
    });
    prisma.patchPreview.findUnique.mockResolvedValue(patchPreviewRow({
      id: "preview-1",
      patchRecordId: "patch-1",
      beforeProductDesignStateVersion: 1,
    }));
    stateService.getCurrentState.mockResolvedValue(beforeState);
    stateService.applyPatch.mockResolvedValue(patchedState);
    prdWriterAgent.run.mockResolvedValue({ data: basePrdDraft() });
    documentService.saveGeneratedDocument.mockResolvedValue(prdDocument);
    prototypeDesignerAgent.run.mockResolvedValue({ data: prototypeSpec });
    prototypeCodeAgent.run.mockResolvedValue({ data: basePrototypeDraft() });
    prototypeService.saveGeneratedPrototype.mockResolvedValue({ prototypeSpec, artifact });
    stateService.attachGeneratedArtifacts.mockResolvedValue(stateWithArtifacts);
    qaService.runForProject.mockResolvedValue(qaReport);

    const result = await service.confirmForUser(user, "patch-1", "确认应用预览");

    expect(result.status).toBe("completed");
    expect(result.patchRecord.status).toBe(PatchRecordStatus.applied);
    expect(result.patchPreview).toEqual(
      expect.objectContaining({
        patchId: "patch-1",
        status: PatchRecordStatus.applied,
        previewStatus: "applied",
        afterProductDesignStateVersion: 2,
        previewOnly: false,
        requiresConfirmation: false,
      }),
    );
    expect(result.result).toEqual(
      expect.objectContaining({
        productDesignState: stateWithArtifacts,
        prdDocument,
        prototypeSpec,
        prototypeArtifact: artifact,
        qaReport,
        patchPreview: expect.objectContaining({ previewStatus: "applied" }),
      }),
    );
    expect(patchAgent.run).not.toHaveBeenCalled();
    expect(stateService.applyPatch).toHaveBeenCalledWith(
      "project-1",
      beforeState,
      expect.objectContaining({
        id: "patch-plan-1",
        needUserConfirm: false,
        needsUserConfirmation: false,
      }),
      expect.objectContaining({
        userId: "user-1",
        runId: "run-1",
      }),
    );
    expect(documentService.saveGeneratedDocument).toHaveBeenCalledWith(
      patchedState,
      basePrdDraft(),
      expect.objectContaining({ reason: "补丁应用后重新生成需求文档" }),
    );
    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalledWith(
      patchedState,
      prototypeSpec,
      basePrototypeDraft(),
      expect.objectContaining({ reason: "补丁应用后重新生成网页原型" }),
    );
    expect(qaService.runForProject).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      expect.objectContaining({
        trigger: "patch",
        relatedPatchId: "patch-1",
        prdDocument,
        prototypeSpec,
        prototypeArtifact: artifact,
      }),
    );
    expect(prisma.patchPreview.update).toHaveBeenCalledWith({
      where: { id: "preview-1" },
      data: expect.objectContaining({
        status: "applying",
      }),
    });
    expect(prisma.patchPreview.update).toHaveBeenCalledWith({
      where: { id: "preview-1" },
      data: expect.objectContaining({
        status: "applied",
        afterProductDesignStateVersion: 2,
      }),
    });
    expect(stream.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "patch_completed",
        data: expect.objectContaining({
          patchPreview: expect.objectContaining({ previewStatus: "applied" }),
          result: expect.objectContaining({
            qaReport,
            patchPreview: expect.objectContaining({ previewStatus: "applied" }),
          }),
        }),
      }),
    );
    const emittedTypes = stream.emit.mock.calls.map(([event]) => event.type);
    expect(emittedTypes).toEqual(
      expect.arrayContaining([
        "patch_started",
        "patch_plan_created",
        "prd_updated",
        "prototype_updated",
        "qa_completed",
        "patch_completed",
      ]),
    );
    expect(emittedTypes.indexOf("patch_plan_created")).toBeLessThan(emittedTypes.indexOf("prd_updated"));
    expect(emittedTypes.indexOf("prd_updated")).toBeLessThan(emittedTypes.indexOf("prototype_updated"));
    expect(emittedTypes.indexOf("prototype_updated")).toBeLessThan(emittedTypes.indexOf("qa_completed"));
    expect(emittedTypes.indexOf("qa_completed")).toBeLessThan(emittedTypes.indexOf("patch_completed"));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "qa_completed",
      step: "qa_check",
      data: expect.objectContaining({
        id: "qa-1",
        qaReport: expect.objectContaining({ id: "qa-1", relatedPatchId: "patch-1" }),
        qaGate: expect.objectContaining({
          status: "open",
          allowExportOrPublish: true,
          allowPersistKnowledge: true,
        }),
      }),
    }));
    expect(runLog.completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        patchRecord: expect.objectContaining({ status: PatchRecordStatus.applied }),
        qaReport,
        patchPreview: expect.objectContaining({ previewStatus: "applied" }),
      }),
      "局部修改已应用，需求文档、网页原型和质检结果已同步更新。",
    );
  });

  it("applies a confirmed prototype component Patch by locally regenerating the selected component", async () => {
    const beforeState = baseState({ version: 1 });
    const patchedState = baseState({ version: 2, status: "patching", prdDocument: undefined, prototypeSpec: undefined });
    const stateWithArtifacts = baseState({ version: 2, status: "prototype_ready" });
    const prdDocument = basePrd();
    const prototypeSpec = basePrototypeSpec();
    const artifact = baseArtifact({
      id: "artifact-local",
      htmlContent: "<!doctype html><button data-component-id=\"page_home_primary_action\">立即签到</button>",
    });
    const qaReport = baseQaReport();
    const plan = baseComponentPatchPlan();
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-local",
        status: PatchRecordStatus.needs_confirmation,
        beforeProductDesignStateVersion: 1,
        patchPlan: plan,
        operations: plan.operations,
        selectedRegion: plan.selectedRegion,
      }),
      project: baseProject(),
    });
    prisma.patchPreview.findUnique.mockResolvedValue(patchPreviewRow({
      id: "preview-local",
      patchRecordId: "patch-local",
      beforeProductDesignStateVersion: 1,
      patchPlan: plan,
      operations: plan.operations,
    }));
    stateService.getCurrentState.mockResolvedValue(beforeState);
    stateService.applyPatch.mockResolvedValue(patchedState);
    prdWriterAgent.run.mockResolvedValue({ data: basePrdDraft() });
    documentService.saveGeneratedDocument.mockResolvedValue(prdDocument);
    prototypeDesignerAgent.run.mockResolvedValue({ data: prototypeSpec });
    prototypeService.trySaveLocalizedGeneratedPrototype.mockResolvedValue({
      prototypeSpec,
      artifact,
      version: { id: "prototype-version-local", version: 2 },
      localPatch: {
        mode: "component",
        componentId: "page_home_primary_action",
      },
    });
    stateService.attachGeneratedArtifacts.mockResolvedValue(stateWithArtifacts);
    qaService.runForProject.mockResolvedValue(qaReport);

    const result = await service.confirmForUser(user, "patch-local", "确认应用局部组件预览");

    expect(result.result.prototypeRegenerationMode).toBe("component_patch");
    expect(result.result.localPatch).toEqual(expect.objectContaining({
      mode: "component",
      componentId: "page_home_primary_action",
    }));
    expect(prototypeService.trySaveLocalizedGeneratedPrototype).toHaveBeenCalledWith(
      patchedState,
      prototypeSpec,
      expect.objectContaining({
        selectedRegion: expect.objectContaining({
          type: "prototype",
          componentId: "page_home_primary_action",
          artifactId: "artifact-1",
        }),
        sourceArtifactId: "artifact-1",
      }),
    );
    expect(prototypeCodeAgent.run).not.toHaveBeenCalled();
    expect(prototypeService.saveGeneratedPrototype).not.toHaveBeenCalled();
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "prototype_updated",
      data: expect.objectContaining({
        regenerationMode: "component_patch",
        localPatch: expect.objectContaining({ componentId: "page_home_primary_action" }),
      }),
    }));
  });

  it("applies a confirmed Patch Preview and rolls ProductDesignState back when regeneration fails", async () => {
    const beforeState = baseState({ version: 7 });
    const patchedState = baseState({ version: 8, status: "patching", prdDocument: undefined, prototypeSpec: undefined });
    const rollbackState = baseState({ version: 9, status: "prototype_ready" });
    prisma.patchRecord.findUnique.mockResolvedValue({
      ...patchRecordRow({
        id: "patch-1",
        status: PatchRecordStatus.needs_confirmation,
        beforeProductDesignStateVersion: 7,
      }),
      project: baseProject(),
    });
    prisma.patchPreview.findUnique.mockResolvedValue(patchPreviewRow({
      id: "preview-1",
      patchRecordId: "patch-1",
      beforeProductDesignStateVersion: 7,
    }));
    stateService.getCurrentState.mockResolvedValue(beforeState);
    stateService.applyPatch.mockResolvedValue(patchedState);
    stateService.restoreStateAfterPatchFailure.mockResolvedValue({
      state: rollbackState,
      version: { id: "version-9", version: 9 },
    });
    prdWriterAgent.run.mockRejectedValue(new Error("PRD_REGENERATION_FAILED"));

    await expect(
      service.confirmForUser(user, "patch-1", "确认应用预览"),
    ).rejects.toThrow("PRD_REGENERATION_FAILED");

    expect(patchAgent.run).not.toHaveBeenCalled();
    expect(prisma.patchPreview.update).toHaveBeenCalledWith({
      where: { id: "preview-1" },
      data: expect.objectContaining({
        status: "applying",
      }),
    });
    expect(prisma.patchPreview.update).toHaveBeenCalledWith({
      where: { id: "preview-1" },
      data: expect.objectContaining({
        status: "failed",
        message: "PRD_REGENERATION_FAILED",
      }),
    });
    expect(stateService.applyPatch).toHaveBeenCalledWith(
      "project-1",
      beforeState,
      expect.objectContaining({
        id: "patch-plan-1",
        needUserConfirm: false,
        needsUserConfirmation: false,
      }),
      expect.objectContaining({
        userId: "user-1",
        runId: "run-1",
      }),
    );
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
        content: "PRD_REGENERATION_FAILED",
      }),
    );
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "PRD_REGENERATION_FAILED",
      type: MessageType.error,
      relatedRunId: "run-1",
    }));
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

function baseComponentPatchPlan(): PatchPlan {
  return {
    ...basePatchPlan(),
    regenerationPlan: {
      prd: "affected_sections",
      prototypeSpec: "affected_pages",
      htmlPrototype: "affected_pages",
      qa: "basic",
    },
    impactScope: ["frontendRules", "prototypeSpec", "htmlPrototype"],
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

function baseArtifact(overrides: Partial<PrototypeArtifact> = {}): PrototypeArtifact {
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
    ...overrides,
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
    relatedQaReportId: input.relatedQaReportId ? String(input.relatedQaReportId) : null,
    generatedByRunId: input.generatedByRunId ? String(input.generatedByRunId) : "run-1",
    errorMessage: input.errorMessage ? String(input.errorMessage) : null,
    createdBy: String(input.createdBy ?? "user-1"),
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-20T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-20T08:00:00Z"),
  };
}

function patchPreviewRow(input: Record<string, unknown>) {
  const plan = input.patchPlan ?? basePatchPlan();
  const operations = input.operations ?? basePatchPlan().operations;
  return {
    id: String(input.id ?? "preview-1"),
    projectId: String(input.projectId ?? "project-1"),
    patchRecordId: String(input.patchRecordId ?? "patch-1"),
    status: String(input.status ?? "ready"),
    beforeProductDesignStateVersion: Number(input.beforeProductDesignStateVersion ?? 1),
    afterProductDesignStateVersion:
      typeof input.afterProductDesignStateVersion === "number" ? input.afterProductDesignStateVersion : null,
    beforeSnapshot: input.beforeSnapshot ?? {
      productDesignStateVersion: Number(input.beforeProductDesignStateVersion ?? 1),
    },
    afterSnapshot: input.afterSnapshot ?? {
      productDesignStateVersion: null,
      projectedOperations: operations,
    },
    diff: input.diff ?? {
      mode: "product_design_state",
      operations,
    },
    riskPanel: input.riskPanel ?? {
      level: "low",
      requiresConfirmation: true,
      versionedApply: true,
    },
    patchPlan: plan,
    operations,
    message: input.message ? String(input.message) : "Patch Preview 已生成。",
    createdBy: String(input.createdBy ?? "user-1"),
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-20T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-20T08:00:00Z"),
  };
}

function baseQaReport() {
  return {
    id: "qa-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    prdDocumentId: "prd-1",
    prototypeArtifactId: "artifact-1",
    prototypeSpecId: "spec-1",
    status: "passed",
    trigger: "patch",
    checkTypes: ["state_schema"],
    summary: "QA 通过",
    issues: [],
    blockingCount: 0,
    majorCount: 0,
    minorCount: 0,
    infoCount: 0,
    generatedByRunId: "run-1",
    relatedPatchId: "patch-1",
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
