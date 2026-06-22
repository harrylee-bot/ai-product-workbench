import { ConversationStatus, ProjectStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectService } from "../src/modules/project/project.service";

describe("Phase1 ProjectService", () => {
  const prisma = {
    project: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    conversation: {
      create: vi.fn(),
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

  const service = new ProjectService(prisma as never);
  const user = {
    id: "user-1",
    username: "lee",
    displayName: "Lee",
    role: UserRole.user,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("soft deletes a project and its visible conversations", async () => {
    prisma.project.findUnique.mockResolvedValue({
      id: "project-1",
      ownerId: "user-1",
      title: "测试项目",
      status: ProjectStatus.draft,
      deletedAt: null,
    });
    prisma.project.update.mockResolvedValue({});

    const result = await service.delete(user, "project-1");

    expect(result).toEqual({
      success: true,
      deletedProjectId: "project-1",
    });
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "project-1" },
      data: {
        status: ProjectStatus.deleted,
        deletedAt: expect.any(Date),
        currentConversationId: null,
        conversations: {
          updateMany: {
            where: {
              deletedAt: null,
              status: { not: ConversationStatus.deleted },
            },
            data: {
              status: ConversationStatus.deleted,
              deletedAt: expect.any(Date),
            },
          },
        },
      },
    });
  });
});
