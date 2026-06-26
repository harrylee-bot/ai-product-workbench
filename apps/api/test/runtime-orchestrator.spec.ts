import { MessageType, ProjectStatus, UserIntent } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiOrchestratorService } from "../src/ai/ai-orchestrator.service";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";

describe("runtime-only Vibe orchestrator", () => {
  const runLog = {
    markRunIntent: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  };
  const stream = { emit: vi.fn() };
  const messageService = {
    createAssistantMessage: vi.fn(),
    updateProjectActivity: vi.fn(),
  };
  const prisma = {
    project: {
      update: vi.fn(),
    },
  };
  const exportService = {
    createPrdWordExport: vi.fn(),
    createPrototypeHtmlExport: vi.fn(),
  };
  const service = new AiOrchestratorService(
    runLog as never,
    stream as never,
    messageService as never,
    prisma as never,
    exportService as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    stream.emit.mockResolvedValue({});
    exportService.createPrdWordExport.mockResolvedValue({
      format: "prd_word",
      projectId: "project-1",
      title: "签到活动 PRD",
      sourceType: "requirement_document",
      sourceId: "prd-1",
      productDesignStateId: "state-1",
      productDesignStateVersion: 3,
      fileName: "签到活动-PRD.doc",
      contentType: "application/msword; charset=utf-8",
      downloadPath: "/api/projects/project-1/export/word",
      sizeBytes: 12,
      generatedAt: "2026-06-20T08:00:00.000Z",
      buffer: Buffer.from("word"),
    });
  });

  it("ends generation requests safely when no external runtime adapter is configured", async () => {
    const result = await service.run(baseInput("做一个签到活动"));

    expect(result.intent.intent).toBe(UserIntent.new_requirement);
    expect(result.message).toContain("当前未配置 DeerFlow/Codex runtime adapter");
    expect(runLog.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.new_requirement);
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: MessageType.agent_summary,
      metadata: expect.objectContaining({
        runtimeAdapter: expect.objectContaining({ status: "not_configured" }),
      }),
    }));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "message_delta",
      data: expect.objectContaining({
        runtimeAdapter: expect.objectContaining({
          status: "not_configured",
        }),
      }),
    }));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "run_completed",
    }));
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.draft }),
    });
  });

  it("keeps non-agent export passthrough while the runtime migration is underway", async () => {
    const result = await service.run(baseInput("导出 Word"));

    expect(result.intent.intent).toBe(UserIntent.export_word);
    expect(result.nextAction?.type).toBe("download_export");
    expect(result.exportArtifact?.sourceId).toBe("prd-1");
    expect(exportService.createPrdWordExport).toHaveBeenCalledWith("project-1");
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "export_ready",
      data: expect.objectContaining({ downloadPath: "/api/projects/project-1/export/word" }),
    }));
  });

  it("uses DeerFlow runtime for requirement intake when configured", async () => {
    const stateService = {
      createDraft: vi.fn().mockResolvedValue(baseState({
        status: "design_ready",
        version: 1,
      })),
      attachGeneratedArtifacts: vi.fn().mockResolvedValue(baseState({
        status: "doc_ready",
        version: 2,
        prdDocument: prdDocument(),
      })),
    };
    const documentService = {
      saveGeneratedDocument: vi.fn().mockResolvedValue(prdDocument()),
    };
    const runtime = {
      runTask: vi.fn().mockResolvedValue({
        provider: "deerflow",
        taskId: "runtime-task-1",
        runId: "run-1",
        status: "completed",
        output: {
          productDesignDraft: {
            projectId: "project-1",
            title: "签到活动",
            summary: "用户每天签到领取积分。",
            businessGoal: "提升日活。",
            targetUsers: [],
            userScenarios: [],
            pages: [],
            features: [],
            backendConfigs: [],
            frontendRules: [],
            businessRules: [],
            stateRules: [],
            exceptionScenarios: [],
            acceptanceCriteria: [],
            assumptions: [],
            knowledgeRefs: [],
            pendingQuestions: [],
            confirmedFacts: [],
            createdBy: "user-1",
            updatedBy: "user-1",
          },
          requirementDocumentDraft: prdDraft(),
          message: "DeerFlow 已生成 PRD。",
        },
        events: [
          {
            id: "runtime-event-1",
            provider: "deerflow",
            taskId: "runtime-task-1",
            runId: "run-1",
            type: "runtime_message",
            content: "DeerFlow 正在规划需求。",
            createdAt: "2026-06-20T08:00:00.000Z",
          },
        ],
      }),
    };
    const serviceWithRuntime = new AiOrchestratorService(
      runLog as never,
      stream as never,
      messageService as never,
      prisma as never,
      exportService as never,
      { requirementProvider: () => "deerflow" } as never,
      runtime as never,
      stateService as never,
      documentService as never,
    );

    const result = await serviceWithRuntime.run(baseInput("做一个签到活动"));

    expect(runtime.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "intake_requirement",
        runId: "run-1",
        projectId: "project-1",
      }),
      "deerflow",
    );
    expect(stateService.createDraft).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ title: "签到活动" }),
      expect.objectContaining({ runId: "run-1", messageId: "msg-1" }),
    );
    expect(documentService.saveGeneratedDocument).toHaveBeenCalled();
    expect(stateService.attachGeneratedArtifacts).toHaveBeenCalledWith("state-1", expect.objectContaining({
      status: "doc_ready",
      prdDocument: expect.objectContaining({ id: "prd-1" }),
    }));
    expect(result.nextAction?.type).toBe("review_prd");
    expect(result.prdDocument?.id).toBe("prd-1");
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prd_ready }),
    });
  });

  it("uses protocol fallback when configured requirement runtime fails", async () => {
    const stateService = {
      createDraft: vi.fn().mockResolvedValue(baseState({
        status: "design_ready",
        version: 1,
      })),
      attachGeneratedArtifacts: vi.fn().mockResolvedValue(baseState({
        status: "doc_ready",
        version: 2,
        prdDocument: prdDocument(),
      })),
    };
    const documentService = {
      saveGeneratedDocument: vi.fn().mockResolvedValue(prdDocument()),
    };
    const runtime = {
      runTask: vi.fn().mockRejectedValue(new Error("Codex request failed")),
    };
    const serviceWithRuntime = new AiOrchestratorService(
      runLog as never,
      stream as never,
      messageService as never,
      prisma as never,
      exportService as never,
      {
        requirementProvider: () => "codex",
        runtimeFallbackToLocal: () => true,
      } as never,
      runtime as never,
      stateService as never,
      documentService as never,
    );

    const result = await serviceWithRuntime.run(baseInput("做一个签到活动"));

    expect(runtime.runTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: "intake_requirement" }),
      "codex",
    );
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "fallback_used",
      data: expect.objectContaining({
        provider: "codex",
        errorMessage: "Codex request failed",
      }),
    }));
    expect(stateService.createDraft).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ title: "做一个签到活动" }),
      expect.objectContaining({ reason: expect.stringContaining("fallback") }),
    );
    expect(documentService.saveGeneratedDocument).toHaveBeenCalled();
    expect(result.runtimeAdapter).toEqual(expect.objectContaining({
      status: "fallback",
      provider: "codex",
    }));
    expect(result.nextAction?.type).toBe("review_prd");
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.prd_ready }),
    });
  });

  it("continues from confirmed PRD to prototype and QA", async () => {
    const confirmedPrd = { ...prdDocument(), status: "confirmed" as const };
    const sourceState = baseState({
      status: "doc_confirmed",
      prdDocument: confirmedPrd,
    });
    const productRuntime = {
      generatePrototypeSpec: vi.fn().mockResolvedValue({
        data: prototypeSpec(),
      }),
      generatePrototypeHtml: vi.fn().mockResolvedValue({
        data: {
          id: "artifact-draft-1",
          projectId: "project-1",
          prototypeSpecId: "prototype-spec-1",
          productDesignStateId: "state-1",
          productDesignStateVersion: 3,
          title: "签到活动 HTML 原型",
          htmlContent: "<!doctype html><html><body><main data-page-id=\"page_main\">签到活动</main></body></html>",
          entryFilePath: "index.html",
          targetDevice: "both",
          pageCount: 1,
          generatedByRunId: "run-1",
          assets: [],
        },
      }),
    };
    const prototypeService = {
      saveGeneratedPrototype: vi.fn().mockResolvedValue({
        prototypeSpec: prototypeSpec(),
        artifact: prototypeArtifact(),
        version: {},
      }),
    };
    const stateService = {
      attachGeneratedArtifacts: vi.fn().mockResolvedValue(baseState({
        status: "prototype_ready",
        prdDocument: confirmedPrd,
        prototypeSpec: prototypeSpec(),
      })),
    };
    const qaService = {
      runForProject: vi.fn().mockResolvedValue(qaReport()),
    };
    const serviceWithRuntime = new AiOrchestratorService(
      runLog as never,
      stream as never,
      messageService as never,
      prisma as never,
      exportService as never,
      { prototypeCodeProvider: () => "codex" } as never,
      undefined,
      stateService as never,
      undefined,
      productRuntime as never,
      prototypeService as never,
      qaService as never,
    );

    const result = await serviceWithRuntime.confirmPrdAndContinue({
      ...baseInput("确认 PRD，继续生成原型。"),
      context: {
        ...baseInput("确认 PRD，继续生成原型。").context,
        productDesignState: sourceState,
        currentProjectStatus: ProjectStatus.prd_ready,
      },
    });

    expect(productRuntime.generatePrototypeSpec).toHaveBeenCalledWith(expect.objectContaining({
      productDesignState: sourceState,
      targetDevice: "both",
    }));
    expect(productRuntime.generatePrototypeHtml).toHaveBeenCalledWith(expect.objectContaining({
      prototypeSpec: expect.objectContaining({ id: "prototype-spec-1" }),
    }));
    expect(prototypeService.saveGeneratedPrototype).toHaveBeenCalled();
    expect(qaService.runForProject).toHaveBeenCalledWith(
      "project-1",
      "user-1",
      expect.objectContaining({ trigger: "initial_generation" }),
    );
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "prototype_updated" }));
    expect(stream.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "qa_completed" }));
    expect(result.nextAction?.type).toBe("review_qa");
    expect(result.prototypeArtifact?.id).toBe("artifact-1");
    expect(result.qaReport?.id).toBe("qa-1");
  });
});

function baseInput(userInput: string) {
  return {
    userMessageId: "msg-1",
    attachments: [],
    context: {
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      userInput,
      recentMessages: [],
      attachments: [],
      productDesignState: baseState(),
      currentProjectStatus: ProjectStatus.draft,
      traceId: "trace-1",
    },
  };
}

function baseState(partial: Partial<ProductDesignState> = {}): ProductDesignState {
  return {
    id: "state-1",
    projectId: "project-1",
    version: 3,
    title: "签到活动",
    summary: "让用户每天完成签到并领取积分奖励。",
    businessGoal: "提升用户活跃和连续访问。",
    background: "运营希望用轻量活动提升留存。",
    targetUsers: [],
    userScenarios: [],
    pages: [],
    features: [],
    backendConfigs: [],
    frontendRules: [],
    businessRules: [],
    stateRules: [],
    exceptionScenarios: [],
    acceptanceCriteria: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    confirmedFacts: [],
    status: "draft",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...partial,
  };
}

function prdDraft() {
  return {
    projectId: "project-1",
    title: "签到活动 PRD",
    sections: [
      {
        id: "overview",
        title: "需求概述",
        type: "overview" as const,
        level: 1 as const,
        order: 1,
        content: "用户每天签到领取积分。",
        sourcePaths: ["summary"],
      },
    ],
    knowledgeRefs: [],
    assumptions: [],
    pendingQuestions: [],
    validationNotes: [],
  };
}

function prdDocument() {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 1,
    title: "签到活动 PRD",
    status: "ready" as const,
    sections: prdDraft().sections,
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

function prototypeSpec() {
  return {
    id: "prototype-spec-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "签到活动 HTML 原型",
    targetDevice: "both" as const,
    styleGuide: {
      tone: "clean" as const,
      layoutDensity: "comfortable" as const,
      borderRadius: "small" as const,
    },
    pages: [],
    navigation: [],
    interactions: [],
    assumptions: [],
    knowledgeRefs: [],
    generatedByRunId: "run-1",
  };
}

function prototypeArtifact() {
  return {
    id: "artifact-1",
    projectId: "project-1",
    prototypeSpecId: "prototype-spec-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "签到活动 HTML 原型",
    status: "ready" as const,
    htmlContent: "<!doctype html><html><body>签到活动</body></html>",
    entryFilePath: "index.html",
    targetDevice: "both" as const,
    pageCount: 1,
    generatedByRunId: "run-1",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}

function qaReport() {
  return {
    id: "qa-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    status: "passed" as const,
    trigger: "initial_generation" as const,
    checkTypes: [],
    summary: "QA 通过。",
    issues: [],
    blockingCount: 0,
    majorCount: 0,
    minorCount: 0,
    infoCount: 0,
    generatedByRunId: "run-1",
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
  };
}
