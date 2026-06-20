import { ConversationStatus, MessageRole, MessageType, ProjectStatus } from "@prisma/client";
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
  };
  const service = new MessageService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
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
