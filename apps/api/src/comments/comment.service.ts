import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConversationStatus, UserRole } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

type CommentRecord = {
  id: string;
  conversationId: string;
  targetType: string;
  targetId: string;
  sectionId: string | null;
  content: string;
  parentCommentId: string | null;
  userId: string;
  isResolved: boolean;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  user: {
    id: string;
    displayName: string;
    username: string;
  };
  resolver?: {
    id: string;
    displayName: string;
  } | null;
  replies?: CommentRecord[];
};

export type Comment = {
  id: string;
  conversationId: string;
  targetType: string;
  targetId: string;
  sectionId: string | null;
  content: string;
  parentCommentId: string | null;
  userId: string;
  userName: string;
  userDisplayName: string;
  isResolved: boolean;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  replies: Comment[];
};

@Injectable()
export class CommentService {
  constructor(private readonly prisma: PrismaService) {}

  async createComment(
    user: AuthenticatedUser,
    input: {
      conversationId: string;
      targetType: string;
      targetId: string;
      sectionId?: string;
      content: string;
      parentCommentId?: string;
    }
  ): Promise<Comment> {
    // 验证会话访问权限
    await this.assertConversationAccess(user, input.conversationId, { requireOwner: true });
    if (input.parentCommentId) {
      const parent = await this.prisma.comment.findFirst({
        where: {
          id: input.parentCommentId,
          conversationId: input.conversationId,
          deletedAt: null,
        },
      });
      if (!parent) throw new BadRequestException("父评论不属于当前会话");
    }

    const comment = await this.prisma.comment.create({
      data: {
        conversationId: input.conversationId,
        targetType: input.targetType,
        targetId: input.targetId,
        sectionId: input.sectionId,
        content: input.content,
        parentCommentId: input.parentCommentId,
        userId: user.id,
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
      },
    });

    return this.toCommentItem(comment as CommentRecord);
  }

  async listComments(
    user: AuthenticatedUser,
    conversationId: string,
    targetType?: string,
    targetId?: string
  ): Promise<Comment[]> {
    await this.assertConversationAccess(user, conversationId);

    const comments = await this.prisma.comment.findMany({
      where: {
        conversationId,
        targetType,
        targetId,
        parentCommentId: null, // 只获取顶层评论
        deletedAt: null,
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
        resolver: {
          select: {
            id: true,
            displayName: true,
          },
        },
        replies: {
          where: { conversationId, deletedAt: null },
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                username: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return comments.map((c) => this.toCommentItem(c as CommentRecord));
  }

  async updateComment(
    user: AuthenticatedUser,
    commentId: string,
    content: string
  ): Promise<Comment> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
      },
    });

    if (!comment) {
      throw new NotFoundException("评论不存在");
    }

    await this.assertConversationAccess(user, comment.conversationId, { requireOwner: true });

    if (comment.userId !== user.id) {
      throw new ForbiddenException("只能编辑自己的评论");
    }

    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: { content },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
      },
    });

    return this.toCommentItem(updated as CommentRecord);
  }

  async deleteComment(
    user: AuthenticatedUser,
    commentId: string
  ): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException("评论不存在");
    }

    await this.assertConversationAccess(user, comment.conversationId, { requireOwner: true });

    await this.prisma.comment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() },
    });
  }

  async resolveComment(
    user: AuthenticatedUser,
    commentId: string
  ): Promise<Comment> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException("评论不存在");
    }

    await this.assertConversationAccess(user, comment.conversationId, { requireOwner: true });

    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        isResolved: true,
        resolvedBy: user.id,
        resolvedAt: new Date(),
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
        resolver: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
    });

    return this.toCommentItem(updated as CommentRecord);
  }

  async unresolveComment(
    user: AuthenticatedUser,
    commentId: string
  ): Promise<Comment> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment) {
      throw new NotFoundException("评论不存在");
    }

    await this.assertConversationAccess(user, comment.conversationId, { requireOwner: true });

    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        isResolved: false,
        resolvedBy: null,
        resolvedAt: null,
      },
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            username: true,
          },
        },
      },
    });

    return this.toCommentItem(updated as CommentRecord);
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { requireOwner?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (
      !conversation ||
      conversation.deletedAt ||
      conversation.status === ConversationStatus.deleted
    ) {
      throw new NotFoundException("会话不存在");
    }

    // Admin cross-owner access is read-only on ordinary business routes.
    if (!options.requireOwner && user.role === UserRole.admin) {
      return;
    }

    // 用户可以访问自己的会话
    if (conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问此会话");
    }
  }

  private toCommentItem(record: CommentRecord): Comment {
    return {
      id: record.id,
      conversationId: record.conversationId,
      targetType: record.targetType,
      targetId: record.targetId,
      sectionId: record.sectionId,
      content: record.content,
      parentCommentId: record.parentCommentId,
      userId: record.userId,
      userName: record.user.username,
      userDisplayName: record.user.displayName,
      isResolved: record.isResolved,
      resolvedBy: record.resolvedBy,
      resolvedByName: record.resolver?.displayName || null,
      resolvedAt: record.resolvedAt?.toISOString() || null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      replies: record.replies?.map((r) => this.toCommentItem(r)) || [],
    };
  }
}
