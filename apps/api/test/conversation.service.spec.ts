import { ProjectStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationService } from "../src/modules/conversation/conversation.service";
import { ProjectService } from "../src/modules/project/project.service";

describe("ConversationService conversation-first APIs", () => {
  const tx = {
    project: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    conversation: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const prisma = {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    productDesignState: {
      findFirst: vi.fn(),
    },
    requirementDocument: {
      findUnique: vi.fn(),
    },
    prototypeArtifact: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const projectService = new ProjectService(prisma as never);
  const service = new ConversationService(prisma as never, projectService);
  const user = {
    id: "user-1",
    username: "lee",
    displayName: "Lee",
    role: UserRole.user,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
  });

  it("creates an internal project when projectId is omitted", async () => {
    tx.project.create.mockResolvedValue(baseProject({ id: "project-new", title: "新需求对话" }));
    tx.conversation.create.mockResolvedValue(baseConversation({
      id: "conversation-new",
      projectId: "project-new",
      title: "新需求对话",
    }));
    tx.project.update.mockResolvedValue(baseProject({ id: "project-new" }));

    const result = await service.create(user, { title: " 新需求对话 " });

    expect(tx.project.create).toHaveBeenCalledWith({
      data: {
        ownerId: "user-1",
        title: "新需求对话",
        status: ProjectStatus.draft,
      },
    });
    expect(tx.conversation.create).toHaveBeenCalledWith({
      data: {
        projectId: "project-new",
        ownerId: "user-1",
        title: "新需求对话",
      },
    });
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-new" },
      data: {
        currentConversationId: "conversation-new",
        lastActivityAt: expect.any(Date),
      },
    });
    expect(result).toEqual({
      conversation: expect.objectContaining({
        id: "conversation-new",
        projectId: "project-new",
        title: "新需求对话",
      }),
    });
  });

  it("creates a missing frontend-generated conversation id for first chat stream", async () => {
    prisma.conversation.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(baseConversation({
        id: "frontend-chat-id",
        projectId: "project-new",
        title: "首条消息标题",
        project: baseProject({ id: "project-new", title: "首条消息标题" }),
      }));
    tx.project.create.mockResolvedValue(baseProject({ id: "project-new", title: "首条消息标题" }));
    tx.conversation.create.mockResolvedValue(baseConversation({
      id: "frontend-chat-id",
      projectId: "project-new",
      title: "首条消息标题",
    }));
    tx.project.update.mockResolvedValue(baseProject({ id: "project-new" }));

    const result = await service.getOrCreateInternal(
      user,
      "frontend-chat-id",
      "首条消息标题",
    );

    expect(tx.project.create).toHaveBeenCalledWith({
      data: {
        ownerId: "user-1",
        title: "首条消息标题",
        status: ProjectStatus.draft,
      },
    });
    expect(tx.conversation.create).toHaveBeenCalledWith({
      data: {
        id: "frontend-chat-id",
        projectId: "project-new",
        ownerId: "user-1",
        title: "首条消息标题",
      },
    });
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: "project-new" },
      data: {
        currentConversationId: "frontend-chat-id",
        lastActivityAt: expect.any(Date),
      },
    });
    expect(result.conversation).toEqual(expect.objectContaining({
      id: "frontend-chat-id",
      projectId: "project-new",
    }));
  });

  it("lists conversations without requiring the project list API", async () => {
    prisma.conversation.findMany.mockResolvedValue([
      baseConversation({ id: "conversation-1", projectId: "project-1", title: "会话 1" }),
      baseConversation({ id: "conversation-2", projectId: "project-2", title: "会话 2" }),
    ]);

    const result = await service.list(user);

    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: {
        ownerId: "user-1",
        deletedAt: null,
        status: { not: "deleted" },
        project: {
          deletedAt: null,
          status: { notIn: ["deleted", "archived"] },
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    });
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({ id: "conversation-1", projectId: "project-1" }),
      expect.objectContaining({ id: "conversation-2", projectId: "project-2" }),
    ]);
  });

  it("returns conversation detail with project and current artifacts", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation({
      project: baseProject({
        id: "project-1",
        currentProductDesignStateId: "state-1",
        currentPrdDocumentId: "prd-1",
        currentPrototypeArtifactId: "prototype-1",
      }),
    }));
    prisma.productDesignState.findFirst.mockResolvedValue({ id: "state-1", title: "产品状态", version: 2 });
    prisma.requirementDocument.findUnique.mockResolvedValue({ id: "prd-1", title: "PRD" });
    prisma.prototypeArtifact.findUnique.mockResolvedValue({ id: "prototype-1", title: "原型" });

    const result = await service.get(user, "conversation-1");

    expect(result).toEqual({
      conversation: expect.objectContaining({
        id: "conversation-1",
        projectId: "project-1",
      }),
      project: expect.objectContaining({
        id: "project-1",
        currentProductDesignStateId: "state-1",
        currentPrdDocumentId: "prd-1",
        currentPrototypeArtifactId: "prototype-1",
      }),
      productDesignState: { id: "state-1", title: "产品状态", version: 2 },
      prd: { id: "prd-1", title: "PRD" },
      prototype: { id: "prototype-1", title: "原型" },
    });
    expect(prisma.productDesignState.findFirst).toHaveBeenCalledWith({
      where: { projectId: "project-1" },
      orderBy: { version: "desc" },
    });
  });

  it("rejects cross-user conversation detail access", async () => {
    prisma.conversation.findUnique.mockResolvedValue(baseConversation({
      ownerId: "user-2",
      project: baseProject({ ownerId: "user-2" }),
    }));

    await expect(service.get(user, "conversation-1")).rejects.toThrow("无权访问该会话");
    expect(prisma.productDesignState.findFirst).not.toHaveBeenCalled();
  });

  it("keeps legacy projectId-based conversation creation working", async () => {
    prisma.project.findUnique.mockResolvedValue(baseProject({ id: "project-1", ownerId: "user-1" }));
    tx.conversation.create.mockResolvedValue(baseConversation({
      id: "conversation-legacy",
      projectId: "project-1",
      title: "旧项目新会话",
    }));
    tx.project.update.mockResolvedValue(baseProject({ id: "project-1" }));

    const result = await service.create(user, {
      projectId: "project-1",
      title: "旧项目新会话",
    });

    expect(tx.project.create).not.toHaveBeenCalled();
    expect(prisma.project.findUnique).toHaveBeenCalledWith({ where: { id: "project-1" } });
    expect(tx.conversation.create).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        ownerId: "user-1",
        title: "旧项目新会话",
      },
    });
    expect(result.conversation).toEqual(expect.objectContaining({
      id: "conversation-legacy",
      projectId: "project-1",
    }));
  });

  it("bulk deletes own active conversations without creating a replacement conversation", async () => {
    tx.conversation.findMany.mockResolvedValue([
      { id: "conversation-1" },
      { id: "conversation-2" },
    ]);
    tx.conversation.updateMany.mockResolvedValue({ count: 2 });
    tx.project.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.deleteAll(user);

    expect(tx.conversation.findMany).toHaveBeenCalledWith({
      where: {
        ownerId: "user-1",
        deletedAt: null,
        status: { not: "deleted" },
        project: {
          deletedAt: null,
          status: { notIn: ["deleted", "archived"] },
        },
      },
      select: { id: true },
    });
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["conversation-1", "conversation-2"] } },
      data: {
        status: "deleted",
        deletedAt: expect.any(Date),
      },
    });
    expect(tx.project.updateMany).toHaveBeenCalledWith({
      where: {
        ownerId: "user-1",
        currentConversationId: { in: ["conversation-1", "conversation-2"] },
      },
      data: {
        currentConversationId: null,
        lastActivityAt: expect.any(Date),
      },
    });
    expect(tx.conversation.create).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, deletedCount: 2 });
  });
});

function baseProject(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-27T08:00:00.000Z");
  return {
    id: "project-1",
    ownerId: "user-1",
    title: "内部项目",
    description: null,
    status: ProjectStatus.draft,
    currentConversationId: "conversation-1",
    currentProductDesignStateId: null,
    currentPrdDocumentId: null,
    currentPrototypeArtifactId: null,
    latestQaReportId: null,
    lastActivityAt: now,
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function baseConversation(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-06-27T08:00:00.000Z");
  return {
    id: "conversation-1",
    projectId: "project-1",
    ownerId: "user-1",
    title: "默认会话",
    summary: null,
    messageCount: 0,
    lastMessageAt: null,
    status: "active",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
