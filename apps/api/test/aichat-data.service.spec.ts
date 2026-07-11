import { ForbiddenException } from "@nestjs/common";
import { ConversationStatus, UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AichatDataService } from "../src/modules/aichat-data/aichat-data.service";
import type { AuthenticatedUser } from "../src/auth/auth.types";

describe("AichatDataService", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    username: "user",
    displayName: "User",
    role: UserRole.user,
    status: UserStatus.active,
  };
  const admin: AuthenticatedUser = {
    ...user,
    id: "admin-1",
    role: UserRole.admin,
  };
  const prisma = {
    $transaction: vi.fn(),
    conversation: {
      findUnique: vi.fn(),
    },
    message: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    stream: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  const service = new AichatDataService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      ownerId: "user-1",
      status: ConversationStatus.active,
      deletedAt: null,
      conversation: {
        status: ConversationStatus.active,
        deletedAt: null,
      },
    });
  });

  it("returns an existing stream only when it belongs to the conversation", async () => {
    const createdAt = new Date("2026-07-02T08:00:00.000Z");
    prisma.stream.findUnique.mockResolvedValue({
      id: "stream-1",
      chatId: "conversation-1",
      createdAt,
    });

    await expect(
      service.registerStream(user, "conversation-1", { streamId: "stream-1" }),
    ).resolves.toEqual({
      id: "stream-1",
      chatId: "conversation-1",
      createdAt: createdAt.toISOString(),
    });
    expect(prisma.stream.create).not.toHaveBeenCalled();
  });

  it("rejects a stream id that already belongs to another conversation", async () => {
    prisma.stream.findUnique.mockResolvedValue({
      id: "stream-1",
      chatId: "conversation-2",
      createdAt: new Date("2026-07-02T08:00:00.000Z"),
    });

    await expect(
      service.registerStream(user, "conversation-1", { streamId: "stream-1" }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.stream.create).not.toHaveBeenCalled();
  });

  it("creates a new stream for the owned conversation", async () => {
    const createdAt = new Date("2026-07-02T08:00:00.000Z");
    prisma.stream.findUnique.mockResolvedValue(null);
    prisma.stream.create.mockResolvedValue({
      id: "stream-1",
      chatId: "conversation-1",
      createdAt,
    });

    await expect(
      service.registerStream(user, "conversation-1", { streamId: "stream-1" }),
    ).resolves.toEqual({
      id: "stream-1",
      chatId: "conversation-1",
      createdAt: createdAt.toISOString(),
    });
    expect(prisma.stream.create).toHaveBeenCalledWith({
      data: {
        id: "stream-1",
        chatId: "conversation-1",
      },
    });
  });

  it("filters runtime tool and reasoning parts when editing an assistant message", async () => {
    prisma.message.findUnique.mockResolvedValue({
      id: "message-1",
      conversationId: "conversation-1",
      role: "assistant",
      metadata: { source: "aichat", reasoningText: "historical hidden reasoning" },
      conversation: {
        id: "conversation-1",
        ownerId: "user-1",
        status: ConversationStatus.active,
        deletedAt: null,
      },
    });
    prisma.message.update.mockImplementation(async ({ data }) => ({
      id: "message-1",
      ...data,
    }));

    await service.updateMessageParts(user, "message-1", {
      parts: [
        { type: "reasoning", text: "hidden" },
        {
          type: "dynamic-tool",
          toolCallId: "read-1",
          toolName: "read_file",
          state: "output-available",
          output: "runtime skill",
        },
        { type: "text", text: "可见回复" },
      ],
    });

    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: {
        content: "可见回复",
        metadata: {
          source: "aichat",
          parts: [{ type: "text", text: "可见回复" }],
        },
      },
    });
  });

  it("does not let an admin mutate another user's conversation through user routes", async () => {
    await expect(
      service.registerStream(admin, "conversation-1", { streamId: "stream-1" }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.stream.create).not.toHaveBeenCalled();
  });
});
