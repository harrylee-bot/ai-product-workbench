import { ConversationStatus, MessageRole, MessageType, ProjectStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageService } from "../src/projects/message.service";

describe("MessageService", () => {
  const prisma = {
    $transaction: vi.fn(),
    message: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
	    project: {
	      update: vi.fn(),
	    },
	    runtimeRunLog: {
	      findFirst: vi.fn(),
	    },
	  };
  const service = new MessageService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockReset();
  });

  it("creates a user message and updates conversation stats", async () => {
    const createdAt = new Date("2026-06-20T08:00:00Z");
    const createdMessage = {
      id: "message-1",
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      role: MessageRole.user,
      type: MessageType.text,
      content: "帮我做签到活动",
      attachments: null,
      metadata: null,
      relatedRunId: null,
      relatedPrdDocumentId: null,
      relatedPrototypeArtifactId: null,
      relatedQaReportId: null,
      createdAt,
    };
    const tx = {
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "conversation-1",
          projectId: "project-1",
          status: ConversationStatus.active,
          deletedAt: null,
          project: {
            id: "project-1",
            status: ProjectStatus.draft,
            deletedAt: null,
          },
        }),
        update: vi.fn(),
      },
      message: {
        create: vi.fn().mockResolvedValue(createdMessage),
      },
      project: {
        update: vi.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await service.createUserMessage({
      projectId: "project-1",
      conversationId: "conversation-1",
      userId: "user-1",
      content: "帮我做签到活动",
    });

    expect(result).toMatchObject({
      id: "message-1",
      role: MessageRole.user,
      content: "帮我做签到活动",
    });
    expect(tx.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        messageCount: { increment: 1 },
        lastMessageAt: expect.any(Date),
      },
    });
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: { lastActivityAt: expect.any(Date) },
    });
  });

	  it("returns recent messages in ascending order", async () => {
    prisma.message.findMany.mockResolvedValue([
      { ...baseMessage("message-2"), createdAt: new Date("2026-06-20T08:02:00Z") },
      { ...baseMessage("message-1"), createdAt: new Date("2026-06-20T08:01:00Z") },
    ]);

    const result = await service.getRecentMessages("conversation-1");

    expect(result.map((message) => message.id)).toEqual(["message-1", "message-2"]);
	  });

	  it("lists the latest conversation messages in chronological order", async () => {
	    prisma.conversation.findUnique.mockResolvedValue({
	      id: "conversation-1",
	      ownerId: "user-1",
	      status: ConversationStatus.active,
	      deletedAt: null,
	      project: {
	        id: "project-1",
	        status: ProjectStatus.draft,
	        deletedAt: null,
	      },
	    });
	    prisma.message.findMany.mockResolvedValue([
	      { ...baseMessage("message-3"), createdAt: new Date("2026-06-20T08:03:00Z") },
	      { ...baseMessage("message-2"), createdAt: new Date("2026-06-20T08:02:00Z") },
	      { ...baseMessage("message-1"), createdAt: new Date("2026-06-20T08:01:00Z") },
	    ]);
	    prisma.runtimeRunLog.findFirst.mockResolvedValue(null);

	    const result = await service.listByConversation({
	      id: "user-1",
	      username: "zhangsan",
	      email: "zhangsan@example.local",
	      displayName: "张三",
	      role: UserRole.user,
	      status: UserStatus.active,
	    }, "conversation-1");

	    expect(prisma.message.findMany).toHaveBeenCalledWith({
	      where: { conversationId: "conversation-1" },
	      orderBy: { createdAt: "desc" },
	      take: 100,
	    });
	    expect(result.items.map((message) => message.id)).toEqual(["message-1", "message-2", "message-3"]);
	  });

  it("updates an assistant message draft in place", async () => {
    const updatedMessage = {
      ...baseMessage("message-1"),
      role: MessageRole.assistant,
      type: MessageType.agent_summary,
      content: "PRD 已生成",
      metadata: { draft: false, runId: "run-1" },
      relatedRunId: "run-1",
    };
    const tx = {
      message: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(updatedMessage),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await service.updateAssistantMessage("message-1", {
      content: "PRD 已生成",
      type: MessageType.agent_summary,
      metadata: { draft: false, runId: "run-1" },
      relatedRunId: "run-1",
    });

    expect(result).toMatchObject({
      id: "message-1",
      role: MessageRole.assistant,
      content: "PRD 已生成",
      relatedRunId: "run-1",
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { id: "message-1", role: MessageRole.assistant },
      data: {
        content: "PRD 已生成",
        type: MessageType.agent_summary,
        metadata: { draft: false, runId: "run-1" },
        relatedRunId: "run-1",
      },
    });
  });
});

function baseMessage(id: string) {
  return {
    id,
    projectId: "project-1",
    conversationId: "conversation-1",
    userId: "user-1",
    role: MessageRole.user,
    type: MessageType.text,
    content: id,
    attachments: null,
    metadata: null,
    relatedRunId: null,
    relatedPrdDocumentId: null,
    relatedPrototypeArtifactId: null,
    relatedQaReportId: null,
    createdAt: new Date(),
  };
}
