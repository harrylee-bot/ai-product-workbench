import { BadRequestException, ForbiddenException } from "@nestjs/common";
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

  it("rejects unsafe client and internal conversation identifiers", async () => {
    await expect(service.create(user, {
      conversationId: "../../outside",
      title: "非法会话",
    })).rejects.toThrow("conversationId 只能包含字母、数字、下划线和连字符");
    await expect(service.getOrCreateInternal(
      user,
      "../outside",
      "非法会话",
    )).rejects.toThrow("conversationId 只能包含字母、数字、下划线和连字符");
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
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
      where: {
        id: "prd-1",
        conversationId: "conversation-1",
        status: { in: ["ready", "confirmed"] },
      },
    });
    expect(prisma.prototypeArtifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: "prototype-1",
        conversationId: "conversation-1",
        status: "ready",
      },
    });
    expect(result.conversationDesignState).toEqual({ id: "state-1" });
    expect(result.prd).toEqual({ id: "prd-1" });
    expect(result.prototype).toEqual({ id: "prototype-1" });
  });

  it("does not fall back to provisional rows when all current pointers are null", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation());

    const result = await service.get(user, "conversation-1");

    expect(result.conversationDesignState).toBeNull();
    expect(result.prd).toBeNull();
    expect(result.prototype).toBeNull();
    expect(prisma.conversationDesignState.findFirst).not.toHaveBeenCalled();
    expect(prisma.requirementDocument.findFirst).not.toHaveBeenCalled();
    expect(prisma.prototypeArtifact.findFirst).not.toHaveBeenCalled();
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

  it("rejects unsafe client-provided conversation ids before touching the database", async () => {
    await expect(service.create(user, { conversationId: "../../outside", title: "bad" }))
      .rejects.toThrow(BadRequestException);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it("keeps admin bulk deletion scoped to the admin's own conversations", async () => {
    prisma.conversation.updateMany.mockResolvedValue({ count: 2 });
    const admin = { ...user, id: "admin-1", role: UserRole.admin };

    await service.deleteAll(admin);

    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        ownerId: "admin-1",
        deletedAt: null,
        status: { not: ConversationStatus.deleted },
      },
      data: {
        status: ConversationStatus.deleted,
        deletedAt: expect.any(Date),
      },
    });
  });

  it("does not let an admin delete another user's conversation through the ordinary endpoint", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation({ ownerId: "other-user" }));
    const admin = { ...user, id: "admin-1", role: UserRole.admin };

    await expect(service.delete(admin, "conversation-1")).rejects.toThrow(ForbiddenException);
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("does not let an admin reuse another user's conversation as an internal chat target", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation({ ownerId: "other-user" }));
    const admin = { ...user, id: "admin-1", role: UserRole.admin };

    await expect(service.getOrCreateInternal(admin, "conversation-1", "title"))
      .rejects.toThrow(ForbiddenException);
    expect(prisma.conversation.create).not.toHaveBeenCalled();
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
