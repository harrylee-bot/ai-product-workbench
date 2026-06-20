import { ForbiddenException } from "@nestjs/common";
import { ConversationStatus, ProjectStatus, UserRole, UserStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectService } from "../src/projects/project.service";

describe("ProjectService", () => {
  const prisma = {
    $transaction: vi.fn(),
    project: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    conversation: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
  const service = new ProjectService(prisma as never);
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a project with a default conversation", async () => {
    const project = {
      id: "project-1",
      ownerId: "user-1",
      title: "签到活动",
      description: null,
      status: ProjectStatus.draft,
      currentConversationId: null,
      currentProductDesignStateId: null,
      currentPrdDocumentId: null,
      currentPrototypeArtifactId: null,
      latestQaReportId: null,
      lastActivityAt: new Date("2026-06-20T08:00:00Z"),
      archivedAt: null,
      deletedAt: null,
      createdAt: new Date("2026-06-20T08:00:00Z"),
      updatedAt: new Date("2026-06-20T08:00:00Z"),
    };
    const conversation = {
      id: "conversation-1",
      projectId: "project-1",
      ownerId: "user-1",
      title: "默认会话",
      summary: null,
      messageCount: 0,
      lastMessageAt: null,
      status: ConversationStatus.active,
      deletedAt: null,
      createdAt: new Date("2026-06-20T08:00:00Z"),
      updatedAt: new Date("2026-06-20T08:00:00Z"),
    };

    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        project: {
          create: vi.fn().mockResolvedValue(project),
          update: vi.fn().mockResolvedValue({
            ...project,
            currentConversationId: conversation.id,
          }),
        },
        conversation: {
          create: vi.fn().mockResolvedValue(conversation),
        },
      }),
    );

    const result = await service.createProject(user, { title: " 签到活动 " });

    expect(result.project.currentConversationId).toBe("conversation-1");
    expect(result.defaultConversation.title).toBe("默认会话");
  });

  it("rejects normal users from updating projects they do not own", async () => {
    prisma.project.findUnique.mockResolvedValue({
      id: "project-2",
      ownerId: "other-user",
      status: ProjectStatus.draft,
      deletedAt: null,
    });

    await expect(
      service.updateProject(user, "project-2", { title: "新的标题" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects admins from creating conversations in user projects", async () => {
    prisma.project.findUnique.mockResolvedValue({
      id: "project-3",
      ownerId: "user-1",
      status: ProjectStatus.draft,
      deletedAt: null,
    });

    await expect(
      service.ensureDefaultConversation(
        {
          id: "admin-1",
          username: "admin",
          displayName: "管理员",
          role: UserRole.admin,
          status: UserStatus.active,
        },
        "project-3",
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
