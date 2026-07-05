import { ConversationStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationService } from "../src/modules/conversation/conversation.service";

describe("ConversationService", () => {
  const prisma = {
    conversation: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationDesignState: { findFirst: vi.fn() },
    requirementDocument: { findFirst: vi.fn() },
    prototypeArtifact: { findFirst: vi.fn() },
  };
  const service = new ConversationService(prisma as never);
  const user = {
    id: "user-1",
    username: "lee",
    displayName: "Lee",
    role: UserRole.user,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a conversation as the only work unit", async () => {
    prisma.conversation.create.mockResolvedValue(baseConversation({ title: "新需求对话" }));

    const result = await service.create(user, { title: " 新需求对话 " });

    expect(prisma.conversation.create).toHaveBeenCalledWith({
      data: {
        ownerId: "user-1",
        title: "新需求对话",
        status: ConversationStatus.active,
      },
    });
    expect(result.conversation.title).toBe("新需求对话");
  });

  it("lists only accessible non-deleted conversations for normal users", async () => {
    prisma.conversation.findMany.mockResolvedValue([baseConversation()]);

    const result = await service.list(user);

    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: {
        ownerId: "user-1",
        deletedAt: null,
        status: { not: ConversationStatus.deleted },
      },
      orderBy: [{ lastMessageAt: "desc" }, { lastActivityAt: "desc" }, { createdAt: "desc" }],
    });
    expect(result.items).toHaveLength(1);
  });

  it("returns conversation current artifacts by conversation pointers", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation({
      currentDesignStateId: "state-1",
      currentPrdDocumentId: "prd-1",
      currentPrototypeArtifactId: "prototype-1",
    }));
    prisma.conversationDesignState.findFirst.mockResolvedValue({ id: "state-1" });
    prisma.requirementDocument.findFirst.mockResolvedValue({ id: "prd-1" });
    prisma.prototypeArtifact.findFirst.mockResolvedValue({ id: "prototype-1" });

    const result = await service.get(user, "conversation-1");

    expect(prisma.conversationDesignState.findFirst).toHaveBeenCalledWith({
      where: { id: "state-1", conversationId: "conversation-1" },
    });
    expect(prisma.requirementDocument.findFirst).toHaveBeenCalledWith({
      where: { id: "prd-1", conversationId: "conversation-1" },
    });
    expect(prisma.prototypeArtifact.findFirst).toHaveBeenCalledWith({
      where: { id: "prototype-1", conversationId: "conversation-1" },
    });
    expect(result.conversationDesignState).toEqual({ id: "state-1" });
    expect(result.prd).toEqual({ id: "prd-1" });
    expect(result.prototype).toEqual({ id: "prototype-1" });
  });

  it("soft deletes a conversation without conversation delete behavior", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation());
    prisma.conversation.update.mockResolvedValue(baseConversation({ status: ConversationStatus.deleted }));

    await expect(service.delete(user, "conversation-1")).resolves.toEqual({
      success: true,
      deletedConversationId: "conversation-1",
    });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        status: ConversationStatus.deleted,
        deletedAt: expect.any(Date),
      },
    });
  });
});

function baseConversation(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-01T00:00:00.000Z");
  return {
    id: "conversation-1",
    ownerId: "user-1",
    title: "对话",
    summary: null,
    status: ConversationStatus.active,
    currentDesignStateId: null,
    currentPrdDocumentId: null,
    currentPrototypeArtifactId: null,
    latestQaReportId: null,
    messageCount: 0,
    lastMessageAt: null,
    lastActivityAt: now,
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
