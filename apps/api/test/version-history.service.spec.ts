import { ConversationStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionHistoryService } from "../src/ai/version-history.service";

describe("VersionHistoryService", () => {
  const prisma = {
    conversation: { findUnique: vi.fn() },
    conversationDesignVersion: { findMany: vi.fn() },
    requirementDocumentVersion: { findMany: vi.fn() },
    prototypeVersion: { findMany: vi.fn() },
    qAReport: { findMany: vi.fn() },
    rollbackRecord: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  const service = new VersionHistoryService(prisma as never);
  const user = {
    id: "user-1",
    username: "owner",
    displayName: "Owner",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      ownerId: "user-1",
      status: ConversationStatus.active,
      deletedAt: null,
    });
    prisma.$transaction.mockImplementation(async (queries) => Promise.all(queries));
  });

  it("merges all version sources into a descending conversation timeline", async () => {
    prisma.conversationDesignVersion.findMany.mockResolvedValue([
      {
        id: "state-version-1",
        version: 2,
        reason: "更新状态",
        stateId: "state-1",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:00:00.000Z"),
      },
    ]);
    prisma.requirementDocumentVersion.findMany.mockResolvedValue([
      {
        id: "prd-version-1",
        version: 1,
        reason: "生成 PRD",
        documentId: "prd-1",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:01:00.000Z"),
      },
    ]);
    prisma.prototypeVersion.findMany.mockResolvedValue([
      {
        id: "prototype-version-1",
        version: 1,
        reason: "生成原型",
        artifactId: "artifact-1",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:02:00.000Z"),
      },
    ]);
    prisma.qAReport.findMany.mockResolvedValue([
      {
        id: "qa-1",
        status: "warning",
        summary: "存在提示",
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:03:00.000Z"),
      },
    ]);
    prisma.rollbackRecord.findMany.mockResolvedValue([
      {
        id: "rollback-1",
        status: "succeeded",
        reason: null,
        fromConversationDesignStateVersion: 3,
        toConversationDesignStateVersion: 2,
        createdBy: "user-1",
        createdAt: new Date("2026-06-28T08:04:00.000Z"),
      },
    ]);

    const result = await service.listConversationTimeline(user, "conversation-1");

    expect(result.items.map((item) => item.type)).toEqual([
      "rollback",
      "qa",
      "prototype",
      "prd",
      "conversation_design_state",
    ]);
    expect(result.items[0]).toMatchObject({
      id: "rollback-1",
      title: "回滚 succeeded",
      description: "v3 -> v2",
      relatedId: "rollback-1",
    });
    expect(prisma.$transaction).toHaveBeenCalledWith([
      expect.any(Promise),
      expect.any(Promise),
      expect.any(Promise),
      expect.any(Promise),
      expect.any(Promise),
    ]);
  });

  it("allows admins and blocks non-owners", async () => {
    prisma.conversation.findUnique.mockResolvedValueOnce({
      id: "conversation-1",
      ownerId: "other-user",
      status: ConversationStatus.active,
      deletedAt: null,
    });

    await expect(service.listConversationTimeline(user, "conversation-1")).rejects.toThrow("VERSION_FORBIDDEN");

    prisma.conversation.findUnique.mockResolvedValueOnce({
      id: "conversation-1",
      ownerId: "other-user",
      status: ConversationStatus.archived,
      deletedAt: null,
    });
    prisma.conversationDesignVersion.findMany.mockResolvedValue([]);
    prisma.requirementDocumentVersion.findMany.mockResolvedValue([]);
    prisma.prototypeVersion.findMany.mockResolvedValue([]);
    prisma.qAReport.findMany.mockResolvedValue([]);
    prisma.rollbackRecord.findMany.mockResolvedValue([]);

    await expect(service.listConversationTimeline({ ...user, role: UserRole.admin }, "conversation-1")).resolves.toEqual({ items: [] });
  });
});
