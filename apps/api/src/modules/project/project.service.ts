import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Conversation, ConversationStatus, Prisma, Project, ProjectStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1User } from "../auth/auth.types";
import type { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from "./dto";

@Injectable()
export class ProjectService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: Phase1User, dto: CreateProjectDto) {
    const title = dto.title.trim();
    const result = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          ownerId: user.id,
          title,
          productId: dto.productId,
          status: ProjectStatus.draft,
        },
      });
      const conversation = await tx.conversation.create({
        data: {
          projectId: project.id,
          ownerId: user.id,
          title: "默认会话",
        },
      });
      const updated = await tx.project.update({
        where: { id: project.id },
        data: { currentConversationId: conversation.id },
      });
      return { project: updated, conversation };
    });

    return {
      project: this.toProject(result.project),
      defaultConversation: this.toConversation(result.conversation),
    };
  }

  async list(user: Phase1User, query: ListProjectsQueryDto) {
    const keyword = query.keyword?.trim();
    const projects = await this.prisma.project.findMany({
      where: {
        ownerId: user.id,
        deletedAt: null,
        status: { notIn: [ProjectStatus.deleted, ProjectStatus.archived] },
        ...(keyword
          ? {
              title: {
                contains: keyword,
                mode: "insensitive",
              },
            }
          : {}),
      },
      orderBy: { lastActivityAt: "desc" },
      include: {
        conversations: {
          where: {
            deletedAt: null,
            status: { not: ConversationStatus.deleted },
          },
          orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
          take: 1,
        },
      },
    });

    return {
      items: projects.map((project) => ({
        ...this.toProject(project),
        defaultConversationId: project.currentConversationId ?? project.conversations[0]?.id,
      })),
    };
  }

  async get(user: Phase1User, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId);
    const conversations = await this.prisma.conversation.findMany({
      where: {
        projectId,
        deletedAt: null,
        status: { not: ConversationStatus.deleted },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    });
    const state = await this.prisma.productDesignState.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    const prd = project.currentPrdDocumentId
      ? await this.prisma.requirementDocument.findUnique({ where: { id: project.currentPrdDocumentId } })
      : null;
    const prototype = project.currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findUnique({ where: { id: project.currentPrototypeArtifactId } })
      : null;

    return {
      project: this.toProject(project),
      conversations: conversations.map((conversation) => this.toConversation(conversation)),
      productDesignState: state,
      prd,
      prototype,
    };
  }

  async update(user: Phase1User, projectId: string, dto: UpdateProjectDto) {
    const project = await this.getAccessibleProject(user, projectId);
    const data: Prisma.ProjectUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = normalizeOptionalText(dto.description);
    if (dto.productId !== undefined) {
      const productId = normalizeOptionalText(dto.productId);
      data.product = productId ? { connect: { id: productId } } : { disconnect: true };
    }
    if (!Object.keys(data).length) return { project: this.toProject(project) };
    const updated = await this.prisma.project.update({
      where: { id: project.id },
      data,
    });
    return { project: this.toProject(updated) };
  }

  async delete(user: Phase1User, projectId: string) {
    const project = await this.getAccessibleProject(user, projectId);
    const now = new Date();

    await this.prisma.project.update({
      where: { id: project.id },
      data: {
        status: ProjectStatus.deleted,
        deletedAt: now,
        currentConversationId: null,
        conversations: {
          updateMany: {
            where: {
              deletedAt: null,
              status: { not: ConversationStatus.deleted },
            },
            data: {
              status: ConversationStatus.deleted,
              deletedAt: now,
            },
          },
        },
      },
    });

    return {
      success: true,
      deletedProjectId: project.id,
    };
  }

  async getAccessibleProject(user: Phase1User, projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该项目");
    }
    return project;
  }

  toProject(project: Project) {
    return {
      id: project.id,
      userId: project.ownerId,
      title: project.title,
      status: project.status,
      productId: project.productId ?? undefined,
      currentConversationId: project.currentConversationId,
      currentProductDesignStateId: project.currentProductDesignStateId,
      currentPrdDocumentId: project.currentPrdDocumentId,
      currentPrototypeArtifactId: project.currentPrototypeArtifactId,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  toConversation(conversation: Conversation) {
    return {
      id: conversation.id,
      projectId: conversation.projectId,
      title: conversation.title,
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt?.toISOString(),
      status: conversation.status,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }
}

function normalizeOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
