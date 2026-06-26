import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  Conversation,
  ConversationStatus,
  Prisma,
  Project,
  ProjectStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type {
  CreateConversationDto,
  CreateProjectDto,
  ListProjectsQueryDto,
  UpdateConversationDto,
  UpdateProjectDto,
} from "./dto";

@Injectable()
export class ProjectService {
  constructor(private readonly prisma: PrismaService) {}

  async createProject(user: AuthenticatedUser, dto: CreateProjectDto) {
    const title = this.normalizeTitle(dto.title);
    const description = this.normalizeOptionalText(dto.description);

    const result = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          ownerId: user.id,
          title,
          description,
          status: ProjectStatus.draft,
        },
      });

      const defaultConversation = await tx.conversation.create({
        data: {
          projectId: project.id,
          ownerId: user.id,
          title: "默认会话",
        },
      });

      const updatedProject = await tx.project.update({
        where: { id: project.id },
        data: { currentConversationId: defaultConversation.id },
      });

      return { project: updatedProject, defaultConversation };
    });

    return {
      project: this.toProjectItem(result.project),
      defaultConversation: this.toConversationItem(result.defaultConversation),
    };
  }

  async listProjects(user: AuthenticatedUser, query: ListProjectsQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where: Prisma.ProjectWhereInput = {
      ownerId: user.id,
    };

    if (query.status) {
      where.status = query.status;
      if (query.status !== ProjectStatus.deleted) where.deletedAt = null;
    } else {
      where.status = { notIn: [ProjectStatus.archived, ProjectStatus.deleted] };
      where.deletedAt = null;
    }

    const keyword = query.keyword?.trim();
    if (keyword) {
      where.OR = [
        { title: { contains: keyword, mode: "insensitive" } },
        { description: { contains: keyword, mode: "insensitive" } },
      ];
    }

    const [projects, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        orderBy: { lastActivityAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      }),
      this.prisma.project.count({ where }),
    ]);

    return {
      items: projects.map((project) => ({
        ...this.toProjectItem(project),
        latestMessagePreview: project.messages[0]?.content,
      })),
      total,
      page,
      pageSize,
    };
  }

  async getProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId, { allowArchived: true });
    const conversations = await this.prisma.conversation.findMany({
      where: {
        projectId,
        status: { not: ConversationStatus.deleted },
        deletedAt: null,
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "asc" }],
    });

    return {
      project: this.toProjectItem(project),
      conversations: conversations.map((conversation) => this.toConversationItem(conversation)),
    };
  }

  async updateProject(user: AuthenticatedUser, projectId: string, dto: UpdateProjectDto) {
    const project = await this.getAccessibleProject(user, projectId);
    this.assertOwner(user, project.ownerId, "管理员不可直接修改用户项目");

    const title = dto.title === undefined ? undefined : this.normalizeTitle(dto.title);
    const description =
      dto.description === undefined ? undefined : this.normalizeOptionalText(dto.description);

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        title,
        description,
        lastActivityAt: new Date(),
      },
    });

    return this.toProjectItem(updated);
  }

  async archiveProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId);
    this.assertOwner(user, project.ownerId, "管理员不可直接归档用户项目");

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: ProjectStatus.archived,
        archivedAt: new Date(),
        lastActivityAt: new Date(),
      },
    });

    return this.toProjectItem(updated);
  }

  async restoreProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId, { allowArchived: true });
    this.assertOwner(user, project.ownerId, "管理员不可直接恢复用户项目");

    if (project.status !== ProjectStatus.archived) {
      return this.toProjectItem(project);
    }

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: ProjectStatus.draft,
        archivedAt: null,
        lastActivityAt: new Date(),
      },
    });

    return this.toProjectItem(updated);
  }

  async deleteProject(user: AuthenticatedUser, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId, { allowArchived: true });
    this.assertOwner(user, project.ownerId, "管理员不可直接删除用户项目");

    const now = new Date();
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: ProjectStatus.deleted,
        deletedAt: now,
        lastActivityAt: now,
        conversations: {
          updateMany: {
            where: { deletedAt: null },
            data: {
              status: ConversationStatus.deleted,
              deletedAt: now,
            },
          },
        },
      },
    });

    return { success: true };
  }

  async listConversations(user: AuthenticatedUser, projectId: string) {
    await this.getAccessibleProject(user, projectId, { allowArchived: true });

    const items = await this.prisma.conversation.findMany({
      where: {
        projectId,
        status: { not: ConversationStatus.deleted },
        deletedAt: null,
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "asc" }],
    });

    return { items: items.map((conversation) => this.toConversationItem(conversation)) };
  }

  async createConversation(user: AuthenticatedUser, projectId: string, dto: CreateConversationDto) {
    const project = await this.getAccessibleProject(user, projectId);
    this.assertOwner(user, project.ownerId, "管理员不可直接创建用户项目会话");

    const title = this.normalizeTitle(dto.title ?? "新的会话");

    const conversation = await this.prisma.conversation.create({
      data: {
        projectId,
        ownerId: project.ownerId,
        title,
      },
    });

    if (!project.currentConversationId) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { currentConversationId: conversation.id },
      });
    }

    return this.toConversationItem(conversation);
  }

  async updateConversation(user: AuthenticatedUser, conversationId: string, dto: UpdateConversationDto) {
    const conversation = await this.getAccessibleConversation(user, conversationId);
    this.assertOwner(user, conversation.ownerId, "管理员不可直接修改用户会话");

    const updated = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        title: dto.title === undefined ? undefined : this.normalizeTitle(dto.title),
        summary: dto.summary === undefined ? undefined : this.normalizeOptionalText(dto.summary),
      },
    });

    return this.toConversationItem(updated);
  }

  async deleteConversation(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.getAccessibleConversation(user, conversationId);
    this.assertOwner(user, conversation.ownerId, "管理员不可直接删除用户会话");

    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          status: ConversationStatus.deleted,
          deletedAt: new Date(),
        },
      });

      const project = await tx.project.findUniqueOrThrow({
        where: { id: conversation.projectId },
      });

      if (project.currentConversationId !== conversationId) return;

      const replacement = await tx.conversation.findFirst({
        where: {
          projectId: conversation.projectId,
          status: ConversationStatus.active,
          deletedAt: null,
          id: { not: conversationId },
        },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      });

      if (replacement) {
        await tx.project.update({
          where: { id: conversation.projectId },
          data: { currentConversationId: replacement.id },
        });
        return;
      }

      const defaultConversation = await tx.conversation.create({
        data: {
          projectId: conversation.projectId,
          ownerId: conversation.ownerId,
          title: "默认会话",
        },
      });

      await tx.project.update({
        where: { id: conversation.projectId },
        data: { currentConversationId: defaultConversation.id },
      });
    });

    return { success: true };
  }

  async ensureDefaultConversation(user: AuthenticatedUser, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId);
    this.assertOwner(user, project.ownerId, "管理员不可直接创建用户项目会话");

    if (project.currentConversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: {
          id: project.currentConversationId,
          projectId,
          status: ConversationStatus.active,
          deletedAt: null,
        },
      });
      if (conversation) return this.toConversationItem(conversation);
    }

    const conversation = await this.prisma.conversation.create({
      data: {
        projectId,
        ownerId: project.ownerId,
        title: "默认会话",
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentConversationId: conversation.id },
    });

    return this.toConversationItem(conversation);
  }

  private async getAccessibleProject(
    user: AuthenticatedUser,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.deleted || project.deletedAt) {
      throw new NotFoundException("项目不存在");
    }

    if (!options.allowArchived && project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }

    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该项目");
    }

    return project;
  }

  private async getAccessibleConversation(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });

    if (!conversation || conversation.status === ConversationStatus.deleted || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }

    if (conversation.project.status === ProjectStatus.deleted || conversation.project.deletedAt) {
      throw new NotFoundException("项目不存在");
    }

    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该会话");
    }

    return conversation;
  }

  private assertOwner(user: AuthenticatedUser, ownerId: string, adminMessage: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException(adminMessage);
    }
  }

  private normalizeTitle(title: string) {
    const value = title.trim();
    if (!value) throw new BadRequestException("标题不能为空");
    if (value.length > 80) throw new BadRequestException("标题不能超过 80 个字符");
    return value;
  }

  private normalizeOptionalText(value?: string) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private toProjectItem(project: Project) {
    return {
      id: project.id,
      ownerId: project.ownerId,
      title: project.title,
      description: project.description ?? undefined,
      status: project.status,
      currentConversationId: project.currentConversationId ?? undefined,
      currentProductDesignStateId: project.currentProductDesignStateId ?? undefined,
      currentPrdDocumentId: project.currentPrdDocumentId ?? undefined,
      currentPrototypeArtifactId: project.currentPrototypeArtifactId ?? undefined,
      latestQaReportId: project.latestQaReportId ?? undefined,
      lastActivityAt: project.lastActivityAt.toISOString(),
      archivedAt: project.archivedAt?.toISOString(),
      deletedAt: project.deletedAt?.toISOString(),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  private toConversationItem(conversation: Conversation) {
    return {
      id: conversation.id,
      projectId: conversation.projectId,
      ownerId: conversation.ownerId,
      title: conversation.title,
      summary: conversation.summary ?? undefined,
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt?.toISOString(),
      status: conversation.status,
      deletedAt: conversation.deletedAt?.toISOString(),
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }
}
