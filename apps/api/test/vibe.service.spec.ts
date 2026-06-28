import { MessageType, ProjectStatus, RuntimeRunStatus, UserIntent, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";
import { VibeService } from "../src/ai/vibe.service";

describe("VibeService main entry", () => {
  const prisma = {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    runtimeRunLog: {
      findUnique: vi.fn(),
    },
  };
  const messageService = {
    createUserMessage: vi.fn(),
    createAssistantMessage: vi.fn(),
    getRecentMessages: vi.fn(),
  };
  const fileAssetService = {
    getAttachmentSummaries: vi.fn(),
    getRuntimeAttachmentFiles: vi.fn(),
    attachFilesToMessage: vi.fn(),
  };
  const runLogService = {
    createRun: vi.fn(),
    markRunIntent: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    cancelRun: vi.fn(),
    isRunCancelled: vi.fn(),
    isRunRunning: vi.fn(),
    getRun: vi.fn(),
  };
  const stateService = {
    getCurrentState: vi.fn(),
  };
  const streamService = {
    emit: vi.fn(),
    stream: vi.fn(),
  };
  const documentService = {
    confirmForPrototypeGate: vi.fn(),
  };
  const deerFlowRuntime = {
    isEnabled: vi.fn(),
    runTurn: vi.fn(),
  };
  const finalActionApplier = {
    apply: vi.fn().mockResolvedValue({}),
  };
  const knowledgeRetrieval = {
    search: vi.fn().mockResolvedValue({ results: [], references: [] }),
  };
  const service = new VibeService(
    prisma as never,
    messageService as never,
    fileAssetService as never,
    runLogService as never,
    stateService as never,
    streamService as never,
    documentService as never,
    deerFlowRuntime as never,
    finalActionApplier as never,
    knowledgeRetrieval as never,
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
    messageService.createUserMessage.mockResolvedValue({
      id: "message-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "生成签到活动",
    });
    messageService.createAssistantMessage.mockResolvedValue({
      id: "assistant-message-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "DeerFlow 2.0 流程大脑尚未接入；旧的自研生成链路已停用。本轮已安全结束，不会生成或改写 PRD、原型和产品状态。",
    });
    messageService.getRecentMessages.mockResolvedValue([{ id: "message-1", role: "user", content: "生成签到活动" }]);
    fileAssetService.getAttachmentSummaries.mockResolvedValue([
      { fileId: "file-1", fileName: "活动规则.md", fileType: "markdown", summary: "活动规则" },
    ]);
    fileAssetService.getRuntimeAttachmentFiles.mockResolvedValue([
      {
        fileId: "file-1",
        fileName: "活动规则.md",
        fileType: "md",
        mimeType: "text/markdown",
        size: 128,
        storagePath: "/tmp/file-1.md",
      },
    ]);
    fileAssetService.attachFilesToMessage.mockResolvedValue(undefined);
    runLogService.createRun.mockResolvedValue({ id: "run-1", traceId: "trace-1" });
    runLogService.markRunIntent.mockResolvedValue(undefined);
    runLogService.completeRun.mockResolvedValue(true);
    runLogService.failRun.mockResolvedValue(true);
    runLogService.cancelRun.mockResolvedValue({
      changed: true,
      run: baseRun({ status: RuntimeRunStatus.cancelled }),
    });
    runLogService.isRunCancelled.mockResolvedValue(false);
    runLogService.isRunRunning.mockResolvedValue(true);
    prisma.runtimeRunLog.findUnique.mockResolvedValue(baseRun());
    deerFlowRuntime.isEnabled.mockReturnValue(false);
    deerFlowRuntime.runTurn.mockResolvedValue(undefined);
    stateService.getCurrentState.mockResolvedValue(baseState());
    streamService.emit.mockResolvedValue({});
    documentService.confirmForPrototypeGate.mockResolvedValue({
      document: basePrdDocument({ status: "confirmed" }),
      productDesignState: baseState({
        status: "doc_confirmed",
        prdDocument: basePrdDocument({ status: "confirmed" }),
      }),
    });
  });

  it("records user input and stops at the DeerFlow-first boundary", async () => {
    const result = await service.handleMessage(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
      message: "  生成签到活动  ",
      fileIds: ["file-1", "file-1"],
      previewMode: "prototype",
      selectedRegion: { type: "prototype", artifactId: "artifact-1" },
    });

    expect(fileAssetService.getAttachmentSummaries).toHaveBeenCalledWith(["file-1"], "project-1");
    expect(fileAssetService.getRuntimeAttachmentFiles).toHaveBeenCalledWith(["file-1"], "project-1");
    expect(messageService.createUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      content: "生成签到活动",
      metadata: { selectedRegion: { type: "prototype", artifactId: "artifact-1" } },
    }));
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(runLogService.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.general_question);
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      type: MessageType.agent_summary,
      content: expect.stringContaining("DeerFlow 2.0"),
      metadata: expect.objectContaining({
        runId: "run-1",
        intent: UserIntent.general_question,
        runtimeAdapter: expect.objectContaining({
          status: "not_configured",
          provider: "deerflow",
          mode: "deerflow_first",
        }),
      }),
    }));
    expect(runLogService.completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ runtimeAdapter: expect.objectContaining({ mode: "deerflow_first" }) }),
      expect.stringContaining("旧的自研生成链路已停用"),
    );
    expect(streamService.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "run_completed",
      content: expect.stringContaining("旧的自研生成链路已停用"),
    }));
    expect(result).toEqual(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      runId: "run-1",
      assistantMessage: expect.objectContaining({ id: "assistant-message-1" }),
      status: "completed",
    }));
  });

  it("rejects missing attachments before creating a run", async () => {
    fileAssetService.getAttachmentSummaries.mockResolvedValue([]);

    await expect(service.handleMessage(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
      message: "生成签到活动",
      fileIds: ["missing-file"],
    })).rejects.toThrow("附件不存在或无权访问");

    expect(messageService.createUserMessage).not.toHaveBeenCalled();
    expect(runLogService.createRun).not.toHaveBeenCalled();
    expect(messageService.createAssistantMessage).not.toHaveBeenCalled();
    expect(fileAssetService.getRuntimeAttachmentFiles).not.toHaveBeenCalled();
  });

  it("hands enabled turns to DeerFlow, suppresses token chunks, and emits debuggable runtime events", async () => {
    deerFlowRuntime.isEnabled.mockReturnValue(true);
    fileAssetService.getAttachmentSummaries.mockResolvedValue([]);
    fileAssetService.getRuntimeAttachmentFiles.mockResolvedValue([]);
    deerFlowRuntime.runTurn.mockImplementation(async (input) => {
      await input.onEvent?.({
        event: "messages-tuple",
        data: [{ content: "正在处理" }],
        content: "正在处理",
      });
      await input.onEvent?.({
        event: "messages-tuple",
        data: [{ tool_calls: [{ function: { name: "coding_node" } }] }],
        toolName: "coding_node",
      });
      await input.onEvent?.({
        event: "gateway-artifacts",
        data: { artifacts: [] },
        content: "已同步 0 个 DeerFlow 产物。",
      });
      return {
        threadId: "deerflow-thread-1",
        assistantText: "你好，我在。",
        finalAction: {
          type: "answer",
          message: "你好，我在。",
          intent: "general_question",
          raw: {
            type: "answer",
            message: "你好，我在。",
            intent: "general_question",
            requirementMode: "one_sentence_completion",
            knowledgeRefsUsed: ["01-产品架构/产品能力地图"],
            assumptions: ["普通问候不触发生成流程"],
            consistencyStrategy: "直接回答。",
          },
        },
        uploads: [],
        artifacts: [],
        rawEvents: [],
        finalState: { ok: true },
      };
    });

    const result = await service.handleMessage(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
      message: "你好",
    });

    expect(result).toEqual(expect.objectContaining({
      runId: "run-1",
      status: "running",
      assistantMessage: null,
    }));

    await flushAsyncWork();

    expect(deerFlowRuntime.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      message: "你好",
      attachmentFiles: [],
    }));

    const emittedEvents = streamService.emit.mock.calls.map(([event]) => event);
    expect(emittedEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "message_delta",
        content: "正在处理",
      }),
    ]));
    expect(streamService.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_call_started",
      content: "调用工具：coding_node",
    }));
    expect(streamService.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "message_delta",
      content: "已同步 0 个 DeerFlow 产物。",
      data: expect.objectContaining({ event: "gateway-artifacts" }),
    }));
    expect(runLogService.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.general_question);
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "你好，我在。",
      type: MessageType.text,
      metadata: expect.objectContaining({
        runId: "run-1",
        provider: "deerflow",
        threadId: "deerflow-thread-1",
        finalAction: expect.objectContaining({
          type: "answer",
          message: "你好，我在。",
          raw: expect.objectContaining({
            requirementMode: "one_sentence_completion",
            knowledgeRefsUsed: ["01-产品架构/产品能力地图"],
            assumptions: ["普通问候不触发生成流程"],
            consistencyStrategy: "直接回答。",
          }),
        }),
        uploads: [],
        artifacts: [],
      }),
    }));
    expect(runLogService.completeRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        provider: "deerflow",
        threadId: "deerflow-thread-1",
        finalAction: expect.objectContaining({
          raw: expect.objectContaining({
            requirementMode: "one_sentence_completion",
            assumptions: ["普通问候不触发生成流程"],
          }),
        }),
        nextAction: { type: "answer" },
      }),
      "你好，我在。",
    );
    expect(documentService.confirmForPrototypeGate).not.toHaveBeenCalled();
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("records DeerFlow failures and emits run_failed so the client can stop running", async () => {
    deerFlowRuntime.isEnabled.mockReturnValue(true);
    fileAssetService.getAttachmentSummaries.mockResolvedValue([]);
    fileAssetService.getRuntimeAttachmentFiles.mockResolvedValue([]);
    deerFlowRuntime.runTurn.mockRejectedValue(new Error("gateway unavailable"));

    const result = await service.handleMessage(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
      message: "你好",
    });

    expect(result).toEqual(expect.objectContaining({
      runId: "run-1",
      status: "running",
      assistantMessage: null,
    }));

    await flushAsyncWork();

    expect(runLogService.failRun).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(streamService.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: "run_failed",
      content: "gateway unavailable",
      data: expect.objectContaining({
        provider: "deerflow",
        errorMessage: "gateway unavailable",
      }),
    }));
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      content: "DeerFlow 执行失败：gateway unavailable",
      type: MessageType.error,
      metadata: expect.objectContaining({
        runId: "run-1",
        provider: "deerflow",
        errorMessage: "gateway unavailable",
      }),
      relatedRunId: "run-1",
    }));
    expect(runLogService.completeRun).not.toHaveBeenCalled();
  });

  it("cancels a running run, records the terminal status, and emits run_canceled", async () => {
    const result = await service.cancelRun(user, "run-1", " 用户点击停止 ");

    expect(runLogService.cancelRun).toHaveBeenCalledWith({
      runId: "run-1",
      canceledBy: "user-1",
      reason: "用户点击停止",
    });
    expect(streamService.emit).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      projectId: "project-1",
      type: "run_canceled",
      content: "执行已停止。",
      data: {
        runId: "run-1",
        status: RuntimeRunStatus.cancelled,
        reason: "用户点击停止",
        messageStatus: "not_created",
      },
    }));
    expect(result).toEqual({
      runId: "run-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      status: RuntimeRunStatus.cancelled,
      reason: "用户点击停止",
      messageStatus: "not_created",
      canceled: true,
    });
  });

  it("marks the run cancelled before aborting the active DeerFlow request", async () => {
    const controller = new AbortController();
    (service as unknown as { activeRunControllers: Map<string, AbortController> }).activeRunControllers.set("run-1", controller);
    runLogService.cancelRun.mockImplementationOnce(async () => {
      expect(controller.signal.aborted).toBe(false);
      return {
        changed: true,
        run: baseRun({ status: RuntimeRunStatus.cancelled }),
      };
    });

    await service.cancelRun(user, "run-1");

    expect(controller.signal.aborted).toBe(true);
  });

  it("rejects cancel attempts from another user", async () => {
    prisma.runtimeRunLog.findUnique.mockResolvedValue(baseRun({
      userId: "user-2",
      project: { ...baseProject(), ownerId: "user-2" },
      conversation: { id: "conversation-1", projectId: "project-1", ownerId: "user-2", deletedAt: null },
    }));

    await expect(service.cancelRun(user, "run-1")).rejects.toThrow("你无权停止该执行记录");

    expect(runLogService.cancelRun).not.toHaveBeenCalled();
    expect(streamService.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: "run_canceled" }));
  });

  it("does not let a late DeerFlow completion overwrite a canceled run", async () => {
    deerFlowRuntime.isEnabled.mockReturnValue(true);
    fileAssetService.getAttachmentSummaries.mockResolvedValue([]);
    fileAssetService.getRuntimeAttachmentFiles.mockResolvedValue([]);
    runLogService.isRunRunning.mockResolvedValue(false);
    deerFlowRuntime.runTurn.mockResolvedValue({
      threadId: "deerflow-thread-1",
      assistantText: "已完成。",
      finalAction: {
        type: "review_prototype",
        message: "已完成。",
        intent: "generate_prototype",
        raw: { type: "review_prototype", message: "已完成。" },
      },
      uploads: [],
      artifacts: [],
      rawEvents: [],
      finalState: { ok: true },
    });

    await service.handleMessage(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
      message: "生成原型",
    });

    await flushAsyncWork();

    expect(messageService.createAssistantMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      relatedRunId: "run-1",
      content: "已完成。",
    }));
    expect(runLogService.completeRun).not.toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ provider: "deerflow" }),
      "已完成。",
    );
    expect(streamService.emit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "run_completed",
      content: "已完成。",
    }));
  });

  it("confirms a doc_ready PRD and waits for the DeerFlow-first prototype flow", async () => {
    stateService.getCurrentState.mockResolvedValue(baseState({
      status: "doc_ready",
      prdDocument: basePrdDocument({ status: "ready" }),
    }));

    const result = await service.confirmPrd(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
    });

    expect(documentService.confirmForPrototypeGate).toHaveBeenCalledWith(
      user,
      "prd-1",
      "用户确认 PRD，继续生成原型",
    );
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect(runLogService.markRunIntent).toHaveBeenCalledWith("run-1", UserIntent.generate_prototype);
    expect(messageService.createAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("PRD 确认已记录"),
      metadata: expect.objectContaining({
        intent: UserIntent.generate_prototype,
        productDesignState: expect.objectContaining({
          status: "doc_confirmed",
          prdDocument: expect.objectContaining({ status: "confirmed" }),
        }),
      }),
    }));
    expect(result).toEqual(expect.objectContaining({ runId: "run-1", status: "completed" }));
  });

  it("rejects PRD confirmation outside the document gate", async () => {
    stateService.getCurrentState.mockResolvedValue(baseState({
      status: "prototype_ready",
      prdDocument: basePrdDocument({ status: "confirmed" }),
      prototypeSpec: { pages: [], components: [], flows: [], styleGuide: {}, targetDevice: "desktop" },
    } as never));

    await expect(service.confirmPrd(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
    })).rejects.toThrow("当前项目已生成原型，不能重复触发 PRD 确认门");

    expect(documentService.confirmForPrototypeGate).not.toHaveBeenCalled();
    expect(messageService.createAssistantMessage).not.toHaveBeenCalled();
  });

  it("streams PRD sections as deltas before the final prd_updated snapshot and run_completed", async () => {
    process.env.PRD_SECTION_DELTA_DELAY_MS = "0";
    deerFlowRuntime.isEnabled.mockReturnValue(true);
    fileAssetService.getAttachmentSummaries.mockResolvedValue([]);
    fileAssetService.getRuntimeAttachmentFiles.mockResolvedValue([]);
    finalActionApplier.apply.mockResolvedValue({
      prdDocument: {
        id: "prd-stream",
        title: "签到活动 PRD",
        sections: [
          { id: "sec-1", title: "背景", type: "overview", level: 1, order: 1, content: "活动背景。", sourcePaths: [] },
          { id: "sec-2", title: "目标", type: "business_goal", level: 1, order: 2, content: "提升活跃。", sourcePaths: [] },
          { id: "sec-3", title: "页面", type: "page_requirements", level: 1, order: 3, content: "签到页。", sourcePaths: [] },
        ],
      },
    });
    deerFlowRuntime.runTurn.mockResolvedValue({
      threadId: "deerflow-thread-stream",
      assistantText: "PRD 已生成。",
      finalAction: {
        type: "review_prd",
        message: "PRD 已生成，请确认。",
        intent: "generate_prd",
        parsed: true,
        raw: { type: "review_prd", message: "PRD 已生成，请确认。" },
      },
      uploads: [],
      artifacts: [],
      rawEvents: [],
      finalState: { ok: true },
    });

    await service.handleMessage(user, {
      projectId: "project-1",
      conversationId: "conversation-1",
      message: "生成签到活动 PRD",
    });
    await flushAsyncWork();

    const emitCalls = streamService.emit.mock.calls.map(([event]) => event);
    const deltaCalls = emitCalls.filter((event) => event.type === "prd_section_delta");
    const updatedCalls = emitCalls.filter((event) => event.type === "prd_updated");
    const completedIndex = emitCalls.findIndex((event) => event.type === "run_completed");

    expect(deltaCalls).toHaveLength(3);
    expect(deltaCalls[0].data.section.id).toBe("sec-1");
    expect(deltaCalls[0].data.isLast).toBe(false);
    expect(deltaCalls[0].data.index).toBe(0);
    expect(deltaCalls[0].data.total).toBe(3);
    expect(deltaCalls[2].data.section.id).toBe("sec-3");
    expect(deltaCalls[2].data.isLast).toBe(true);
    expect(updatedCalls).toHaveLength(1);
    expect(updatedCalls[0].data.id).toBe("prd-stream");

    // 所有 delta 和 prd_updated 必须在 run_completed 之前（终端事件会关闭 SSE 流）。
    const lastDeltaIndex = emitCalls.map((e) => e.type).lastIndexOf("prd_section_delta");
    const updatedIndex = emitCalls.map((e) => e.type).lastIndexOf("prd_updated");
    expect(completedIndex).toBeGreaterThan(lastDeltaIndex);
    expect(completedIndex).toBeGreaterThan(updatedIndex);

    delete process.env.PRD_SECTION_DELTA_DELAY_MS;
  });
});

function baseProject() {
  return {
    id: "project-1",
    ownerId: "user-1",
    status: ProjectStatus.prototype_ready,
    deletedAt: null,
    conversations: [{ id: "conversation-1", deletedAt: null }],
  };
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    projectId: "project-1",
    conversationId: "conversation-1",
    userId: "user-1",
    status: RuntimeRunStatus.running,
    startedAt: new Date("2026-06-20T08:00:00.000Z"),
    project: baseProject(),
    conversation: { id: "conversation-1", projectId: "project-1", ownerId: "user-1", deletedAt: null },
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
    status: "prototype_ready",
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  };
}

function basePrdDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "prd-1",
    projectId: "project-1",
    productDesignStateId: "state-1",
    productDesignStateVersion: 3,
    title: "签到活动 PRD",
    status: "ready",
    sections: [],
    assumptions: [],
    knowledgeRefs: [],
    pendingQuestions: [],
    validationNotes: [],
    createdBy: "user-1",
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T08:00:00.000Z",
    ...overrides,
  } as ProductDesignState["prdDocument"];
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
