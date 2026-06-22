import { ProjectStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDesignState } from "../src/ai/ai-vibe.types";
import { VibeService } from "../src/ai/vibe.service";

describe("VibeService main entry", () => {
  const prisma = {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    agentRunLog: {
      findUnique: vi.fn(),
    },
  };
  const messageService = {
    createUserMessage: vi.fn(),
    getRecentMessages: vi.fn(),
  };
  const fileAssetService = {
    getAttachmentSummaries: vi.fn(),
    attachFilesToMessage: vi.fn(),
  };
  const runLogService = {
    createRun: vi.fn(),
    getRun: vi.fn(),
  };
  const stateService = {
    getCurrentState: vi.fn(),
  };
  const orchestrator = {
    run: vi.fn(),
  };
  const streamService = {
    stream: vi.fn(),
  };
  const skillRegistry = {
    listSkills: vi.fn(),
  };
  const service = new VibeService(
    prisma as never,
    messageService as never,
    fileAssetService as never,
    runLogService as never,
    stateService as never,
    orchestrator as never,
    streamService as never,
    skillRegistry as never,
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
    messageService.getRecentMessages.mockResolvedValue([{ id: "message-1", role: "user", content: "生成签到活动" }]);
    fileAssetService.getAttachmentSummaries.mockResolvedValue([
      { fileId: "file-1", fileName: "活动规则.md", fileType: "markdown", summary: "活动规则" },
    ]);
    fileAssetService.attachFilesToMessage.mockResolvedValue(undefined);
    runLogService.createRun.mockResolvedValue({ id: "run-1", traceId: "trace-1" });
    stateService.getCurrentState.mockResolvedValue(baseState());
    orchestrator.run.mockResolvedValue({ runId: "run-1" });
  });

  it("dispatches /ai/vibe/handle-message payloads into the new orchestrator context", async () => {
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
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: expect.objectContaining({ status: ProjectStatus.designing }),
    });
    expect(orchestrator.run).toHaveBeenCalledWith({
      userMessageId: "message-1",
      attachments: [{ fileId: "file-1", fileName: "活动规则.md", fileType: "markdown", summary: "活动规则" }],
      context: expect.objectContaining({
        runId: "run-1",
        projectId: "project-1",
        conversationId: "conversation-1",
        userId: "user-1",
        userInput: "生成签到活动",
        previewMode: "prototype",
        currentProjectStatus: ProjectStatus.prototype_ready,
        productDesignState: expect.objectContaining({ id: "state-1" }),
        traceId: "trace-1",
      }),
    });
    expect(result).toEqual(expect.objectContaining({
      projectId: "project-1",
      conversationId: "conversation-1",
      runId: "run-1",
      status: "running",
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
    expect(orchestrator.run).not.toHaveBeenCalled();
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

function baseState(): ProductDesignState {
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
  };
}
