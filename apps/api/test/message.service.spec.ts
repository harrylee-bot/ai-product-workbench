import { ConversationStatus, MessageRole, MessageType, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageService } from "../src/conversations/message.service";

describe("MessageService", () => {
  const prisma = {
    $transaction: vi.fn(),
    conversation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    message: {
      create: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const service = new MessageService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.conversation.findUnique.mockResolvedValue(baseConversation());
  });

  it("creates a user message and updates conversation stats", async () => {
    const createdMessage = baseMessage("message-1", {
      role: MessageRole.user,
      content: "帮我做签到活动",
    });
    prisma.message.create.mockResolvedValue(createdMessage);
    prisma.message.count.mockResolvedValue(1);

    const result = await service.createUserMessage({
      conversationId: "conversation-1",
      userId: "user-1",
      content: "帮我做签到活动",
    });

    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        userId: "user-1",
        role: MessageRole.user,
        type: MessageType.text,
        content: "帮我做签到活动",
      }),
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        messageCount: 1,
        lastMessageAt: expect.any(Date),
        lastActivityAt: expect.any(Date),
      },
    });
    expect(result).toMatchObject({ id: "message-1", role: MessageRole.user });
  });

  it("returns recent messages in ascending order", async () => {
    prisma.message.findMany.mockResolvedValue([
      baseMessage("message-2", { createdAt: new Date("2026-06-20T08:02:00Z") }),
      baseMessage("message-1", { createdAt: new Date("2026-06-20T08:01:00Z") }),
    ]);

    const result = await service.getRecentMessages("conversation-1");

    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: "conversation-1" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    expect(result.map((message) => message.id)).toEqual(["message-1", "message-2"]);
  });

  it("lists conversation messages after access check", async () => {
    prisma.message.findMany.mockResolvedValue([
      baseMessage("message-1", { createdAt: new Date("2026-06-20T08:01:00Z") }),
      baseMessage("message-2", { createdAt: new Date("2026-06-20T08:02:00Z") }),
    ]);

    const result = await service.listByConversation({
      id: "user-1",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      role: UserRole.user,
      status: UserStatus.active,
    }, "conversation-1");

    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
    });
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { conversationId: "conversation-1" },
      orderBy: { createdAt: "asc" },
    });
    expect(result.items.map((message) => message.id)).toEqual(["message-1", "message-2"]);
  });

  it("updates an assistant message draft in place", async () => {
    const existingMessage = baseMessage("message-1", { role: MessageRole.assistant });
    const updatedMessage = baseMessage("message-1", {
      role: MessageRole.assistant,
      type: MessageType.agent_summary,
      content: "PRD 已生成",
      metadata: { draft: false, runId: "run-1" },
      relatedRunId: "run-1",
    });
    prisma.message.findUnique.mockResolvedValue(existingMessage);
    prisma.message.update.mockResolvedValue(updatedMessage);

    const result = await service.updateAssistantMessage("message-1", {
      content: "PRD 已生成",
      type: MessageType.agent_summary,
      metadata: { draft: false, runId: "run-1" },
      relatedRunId: "run-1",
    });

    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: expect.objectContaining({
        content: "PRD 已生成",
        type: MessageType.agent_summary,
        relatedRunId: "run-1",
      }),
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { lastActivityAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ id: "message-1", content: "PRD 已生成" });
  });

  it("sanitizes assistant metadata at the shared message write boundary", async () => {
    prisma.message.create.mockImplementation(async ({ data }) =>
      baseMessage("message-1", data),
    );
    prisma.message.count.mockResolvedValue(1);

    await service.createAssistantMessage({
      conversationId: "conversation-1",
      userId: "user-1",
      content: "已完成",
      metadata: {
        reasoningText: "hidden reasoning",
        parts: [
          { type: "reasoning", text: "hidden reasoning" },
          {
            type: "dynamic-tool",
            toolCallId: "read-1",
            toolName: "read_file",
            state: "output-available",
            output: "runtime skill",
          },
          { type: "text", text: "已完成" },
        ],
      },
    });

    const createInput = prisma.message.create.mock.calls[0]?.[0];
    expect(createInput.data.metadata).toEqual({
      parts: [{ type: "text", text: "已完成" }],
    });
  });

  it("does not sanitize user metadata at the shared message write boundary", async () => {
    const metadata = {
      parts: [
        { type: "text", text: "请读取附件" },
        { type: "file", url: "/files/1", mediaType: "text/plain" },
      ],
    };
    prisma.message.create.mockImplementation(async ({ data }) =>
      baseMessage("message-1", data),
    );
    prisma.message.count.mockResolvedValue(1);

    await service.createUserMessage({
      conversationId: "conversation-1",
      userId: "user-1",
      content: "请读取附件",
      metadata,
    });

    expect(prisma.message.create.mock.calls[0]?.[0].data.metadata).toEqual(metadata);
  });

  it("does not expose unsafe parts from historical assistant rows", async () => {
    prisma.message.findMany.mockResolvedValue([
      baseMessage("message-1", {
        role: MessageRole.assistant,
        content: "已完成",
        metadata: {
          reasoningText: "hidden reasoning",
          parts: [
            {
              type: "dynamic-tool",
              toolCallId: "read-1",
              toolName: "read_file",
              state: "output-available",
              output: "complete runtime skill",
            },
            { type: "text", text: "已完成" },
          ],
        },
      }),
    ]);

    const result = await service.listByConversation(
      {
        id: "user-1",
        username: "zhangsan",
        displayName: "张三",
        role: UserRole.user,
        status: UserStatus.active,
      },
      "conversation-1",
    );

    expect(result.items[0]?.metadata).toEqual({
      parts: [{ type: "text", text: "已完成" }],
    });
  });
});

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    ownerId: "user-1",
    status: ConversationStatus.active,
    deletedAt: null,
    ...overrides,
  };
}

function baseMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
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
    createdAt: new Date("2026-06-20T08:00:00Z"),
    ...overrides,
  };
}
