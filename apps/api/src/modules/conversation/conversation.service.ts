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
    const project = await this.projects.getAccessibleProject(user, dto.projectId);
    const conversation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.conversation.create({
        data: {
          projectId: project.id,
          ownerId: project.ownerId,
          title: dto.title?.trim() || "新对话",
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
