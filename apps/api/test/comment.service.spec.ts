import { ForbiddenException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CommentService } from "../src/comments/comment.service";

describe("CommentService ownership", () => {
  const admin = {
    id: "admin-1",
    username: "admin",
    displayName: "Admin",
    role: UserRole.admin,
    status: UserStatus.active,
  };

  function createPrisma() {
    return {
      conversation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "conversation-1",
          ownerId: "user-1",
          status: "active",
          deletedAt: null,
        }),
      },
      comment: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({
          id: "comment-1",
          conversationId: "conversation-1",
          userId: "user-1",
        }),
        update: vi.fn(),
      },
    };
  }

  it("does not let an admin create comments in another user's conversation", async () => {
    const prisma = createPrisma();
    const service = new CommentService(prisma as never);

    await expect(service.createComment(admin, {
      conversationId: "conversation-1",
      targetType: "prd",
      targetId: "prd-1",
      content: "跨用户评论",
    })).rejects.toThrow(ForbiddenException);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("does not let an admin resolve another user's comments", async () => {
    const prisma = createPrisma();
    const service = new CommentService(prisma as never);

    await expect(service.resolveComment(admin, "comment-1")).rejects.toThrow(ForbiddenException);
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });

  it("does not let an admin edit a historical comment in another user's conversation", async () => {
    const prisma = createPrisma();
    prisma.comment.findUnique.mockResolvedValueOnce({
      id: "comment-1",
      conversationId: "conversation-1",
      userId: admin.id,
    });
    const service = new CommentService(prisma as never);

    await expect(service.updateComment(admin, "comment-1", "越权修改")).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });

  it("does not let an admin delete a historical comment in another user's conversation", async () => {
    const prisma = createPrisma();
    prisma.comment.findUnique.mockResolvedValueOnce({
      id: "comment-1",
      conversationId: "conversation-1",
      userId: admin.id,
    });
    const service = new CommentService(prisma as never);

    await expect(service.deleteComment(admin, "comment-1")).rejects.toThrow(ForbiddenException);
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });

  it("retains admin read access to another user's comments", async () => {
    const prisma = createPrisma();
    const service = new CommentService(prisma as never);

    await expect(service.listComments(admin, "conversation-1")).resolves.toEqual([]);
    expect(prisma.comment.findMany).toHaveBeenCalled();
  });
});
