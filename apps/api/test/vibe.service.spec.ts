import { MessageType, ProjectStatus, UserIntent, UserRole, UserStatus } from "@prisma/client";
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
    attachFilesToMessage: vi.fn(),
  };
  const runLogService = {
    createRun: vi.fn(),
    markRunIntent: vi.fn(),
    completeRun: vi.fn(),
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
  const service = new VibeService(
    prisma as never,
    messageService as never,
    fileAssetService as never,
    runLogService as never,
    stateService as never,
    streamService as never,
    documentService as never,
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
    fileAssetService.attachFilesToMessage.mockResolvedValue(undefined);
    runLogService.createRun.mockResolvedValue({ id: "run-1", traceId: "trace-1" });
    runLogService.markRunIntent.mockResolvedValue(undefined);
    runLogService.completeRun.mockResolvedValue(undefined);
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
