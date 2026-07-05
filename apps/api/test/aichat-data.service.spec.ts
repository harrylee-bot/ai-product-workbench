import { ForbiddenException } from "@nestjs/common";
import { ConversationStatus, UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AichatDataService } from "../src/modules/aichat-data/aichat-data.service";
import type { AuthenticatedUser } from "../src/modules/auth/auth.types";

describe("AichatDataService", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    username: "user",
    displayName: "User",
    role: UserRole.user,
    status: UserStatus.active,
  };
  const prisma = {
    conversation: {
      findUnique: vi.fn(),
    },
    stream: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
  const service = new AichatDataService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      ownerId: "user-1",
      status: ConversationStatus.active,
      deletedAt: null,
      conversation: {
        status: ConversationStatus.draft,
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
});
