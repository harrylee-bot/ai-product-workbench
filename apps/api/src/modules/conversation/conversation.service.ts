import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConversationStatus, ProjectStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1User } from "../auth/auth.types";
import { ProjectService } from "../project/project.service";
import type { CreateConversationDto } from "./dto";

@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectService,
  ) {}

  async create(user: Phase1User, dto: CreateConversationDto) {
    const title = dto.title?.trim() || "新对话";
    const projectId = dto.projectId?.trim();
    if (!projectId) return this.createWithInternalProject(user, title);

    const project = await this.projects.getAccessibleProject(user, projectId);
    const conversation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          projectId: project.id,
          ownerId: project.ownerId,
          title,
        },
      });

      await tx.project.update({
        where: { id: project.id },
        data: {
          currentConversationId: created.id,
          lastActivityAt: new Date(),
        },
      });

      return created;
    });

    return { conversation: this.projects.toConversation(conversation) };
  }

  async getOrCreateInternal(user: Phase1User, conversationId: string, title: string) {
    const existing = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });

    if (!existing) {
      await this.createWithInternalProject(user, title, conversationId);
    }

    return this.get(user, conversationId);
  }

  async list(user: Phase1User) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        ownerId: user.id,
        deletedAt: null,
        status: { not: ConversationStatus.deleted },
        project: {
          deletedAt: null,
          status: { notIn: [ProjectStatus.deleted, ProjectStatus.archived] },
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    });
    return { items: conversations.map((conversation) => this.projects.toConversation(conversation)) };
  }

  async get(user: Phase1User, conversationId: string) {
    const conversation = await this.getAccessibleConversation(user, conversationId);
    const project = conversation.project;
    const state = await this.prisma.productDesignState.findFirst({
      where: { projectId: project.id },
      orderBy: { version: "desc" },
    });
    const prd = project.currentPrdDocumentId
      ? await this.prisma.requirementDocument.findUnique({ where: { id: project.currentPrdDocumentId } })
      : null;
    const prototype = project.currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findUnique({ where: { id: project.currentPrototypeArtifactId } })
      : null;

    return {
      conversation: this.projects.toConversation(conversation),
      project: this.projects.toProject(project),
      productDesignState: state,
      prd,
      prototype,
    };
  }

  async listByProject(user: Phase1User, projectId: string) {
    await this.projects.getAccessibleProject(user, projectId);
    const conversations = await this.prisma.conversation.findMany({
      where: {
        projectId,
        deletedAt: null,
        status: { not: ConversationStatus.deleted },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    });
    return { items: conversations.map((conversation) => this.projects.toConversation(conversation)) };
  }

  async deleteAll(user: Phase1User) {
    const deletedCount = await this.prisma.$transaction(async (tx) => {
      const conversations = await tx.conversation.findMany({
        where: {
          ownerId: user.id,
          deletedAt: null,
          status: { not: ConversationStatus.deleted },
          project: {
            deletedAt: null,
            status: { notIn: [ProjectStatus.deleted, ProjectStatus.archived] },
          },
        },
        select: { id: true },
      });

      if (!conversations.length) return 0;

      const conversationIds = conversations.map((conversation) => conversation.id);
      const now = new Date();

      await tx.conversation.updateMany({
        where: { id: { in: conversationIds } },
        data: {
          status: ConversationStatus.deleted,
          deletedAt: now,
        },
      });

      await tx.project.updateMany({
        where: {
          ownerId: user.id,
          currentConversationId: { in: conversationIds },
        },
        data: {
          currentConversationId: null,
          lastActivityAt: now,
        },
      });

      return conversationIds.length;
    });

    return {
      success: true,
      deletedCount,
    };
  }

  async delete(user: Phase1User, conversationId: string) {
    const conversation = await this.getAccessibleConversation(user, conversationId);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          status: ConversationStatus.deleted,
          deletedAt: new Date(),
        },
      });

      const project = await tx.project.findUnique({ where: { id: conversation.projectId } });
      let nextConversation = await tx.conversation.findFirst({
        where: {
          projectId: conversation.projectId,
          status: ConversationStatus.active,
          deletedAt: null,
          id: { not: conversation.id },
        },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      });

      if (!nextConversation) {
        nextConversation = await tx.conversation.create({
          data: {
            projectId: conversation.projectId,
            ownerId: conversation.ownerId,
            title: "新对话",
          },
        });
      }

      if (project?.currentConversationId === conversation.id || !project?.currentConversationId) {
        await tx.project.update({
          where: { id: conversation.projectId },
          data: {
            currentConversationId: nextConversation.id,
            lastActivityAt: new Date(),
          },
        });
      }

      return nextConversation;
    });

    return {
      success: true,
      deletedConversationId: conversation.id,
      nextConversation: this.projects.toConversation(result),
    };
  }

  private async createWithInternalProject(
    user: Phase1User,
    title: string,
    conversationId?: string,
  ) {
    const conversation = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          ownerId: user.id,
          title,
          status: ProjectStatus.draft,
        },
      });
      const created = await tx.conversation.create({
        data: {
          ...(conversationId ? { id: conversationId } : {}),
          projectId: project.id,
          ownerId: user.id,
          title,
        },
      });
      await tx.project.update({
        where: { id: project.id },
        data: {
          currentConversationId: created.id,
          lastActivityAt: new Date(),
        },
      });
      return created;
    });

    return { conversation: this.projects.toConversation(conversation) };
  }

  private async getAccessibleConversation(user: Phase1User, conversationId: string) {
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
      throw new ForbiddenException("无权访问该会话");
    }

    return conversation;
  }
}
