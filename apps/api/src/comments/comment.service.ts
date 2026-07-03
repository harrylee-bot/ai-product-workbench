import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

type CommentRecord = {
  id: string;
  projectId: string;
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
  projectId: string;
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
      projectId: string;
      targetType: string;
      targetId: string;
      sectionId?: string;
      content: string;
      parentCommentId?: string;
    }
  ): Promise<Comment> {
    // 验证项目访问权限
    await this.assertProjectAccess(user, input.projectId);

    const comment = await this.prisma.comment.create({
      data: {
        projectId: input.projectId,
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
    projectId: string,
    targetType?: string,
    targetId?: string
  ): Promise<Comment[]> {
    await this.assertProjectAccess(user, projectId);

    const comments = await this.prisma.comment.findMany({
      where: {
        projectId,
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
          where: { deletedAt: null },
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

    const project = await this.prisma.project.findUnique({
      where: { id: comment.projectId },
    });

    // 只有评论作者或项目所有者可以删除
    if (comment.userId !== user.id && project?.ownerId !== user.id) {
      throw new ForbiddenException("无权删除此评论");
    }

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

    await this.assertProjectAccess(user, comment.projectId);

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

    await this.assertProjectAccess(user, comment.projectId);

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

  private async assertProjectAccess(
    user: AuthenticatedUser,
    projectId: string
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException("项目不存在");
    }

    // Admin 可以访问所有项目
    if (user.role === "admin") {
      return;
    }

    // Product/Developer/User 可以访问自己的项目或被邀请的项目
    if (project.ownerId !== user.id) {
      // TODO: 检查是否被邀请参与此项目（待实现邀请功能）
      throw new ForbiddenException("无权访问此项目");
    }
  }

  private toCommentItem(record: CommentRecord): Comment {
    return {
      id: record.id,
      projectId: record.projectId,
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
