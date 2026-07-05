import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Conversation, ConversationStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import type { CreateConversationDto } from "./dto";

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthenticatedUser, dto: CreateConversationDto) {
    const title = dto.title?.trim() || "新对话";
    const conversation = await this.prisma.conversation.create({
      data: {
        ...(dto.conversationId ? { id: dto.conversationId.trim() } : {}),
        ownerId: user.id,
        title,
        status: ConversationStatus.active,
      },
    });
    return { conversation: this.toConversation(conversation) };
  }

  async getOrCreateInternal(user: AuthenticatedUser, conversationId: string, title: string) {
    const existing = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!existing) {
      await this.prisma.conversation.create({
        data: {
          id: conversationId,
          ownerId: user.id,
          title: title.trim() || "新对话",
          status: ConversationStatus.active,
        },
      });
    }
    return this.get(user, conversationId);
  }

  async list(user: AuthenticatedUser) {
    const conversations = await this.prisma.conversation.findMany({
      where: this.accessWhere(user),
      orderBy: [{ lastMessageAt: "desc" }, { lastActivityAt: "desc" }, { createdAt: "desc" }],
    });
    return { items: conversations.map((conversation) => this.toConversation(conversation)) };
  }

  async get(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.getAccessibleConversation(user, conversationId, { allowArchived: true });
    const state = conversation.currentDesignStateId
      ? await this.prisma.conversationDesignState.findFirst({
          where: { id: conversation.currentDesignStateId, conversationId },
        })
      : await this.prisma.conversationDesignState.findFirst({
          where: { conversationId },
          orderBy: { version: "desc" },
        });
    const prd = conversation.currentPrdDocumentId
      ? await this.prisma.requirementDocument.findFirst({
          where: { id: conversation.currentPrdDocumentId, conversationId },
        })
      : null;
    const prototype = conversation.currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findFirst({
          where: { id: conversation.currentPrototypeArtifactId, conversationId },
        })
      : null;

    return {
      conversation: this.toConversation(conversation),
      conversationDesignState: state,
      prd,
      prototype,
    };
  }

  async deleteAll(user: AuthenticatedUser) {
    const now = new Date();
    const result = await this.prisma.conversation.updateMany({
      where: this.accessWhere(user),
      data: {
        status: ConversationStatus.deleted,
        deletedAt: now,
      },
    });
    return { success: true, deletedCount: result.count };
  }

  async delete(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.getAccessibleConversation(user, conversationId, { allowArchived: true });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        status: ConversationStatus.deleted,
        deletedAt: new Date(),
      },
    });
    return { success: true, deletedConversationId: conversation.id };
  }

  async getAccessibleConversation(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (!options.allowArchived && conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("会话已归档");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该会话");
    }
    return conversation;
  }

  private accessWhere(user: AuthenticatedUser) {
    return {
      ...(user.role === UserRole.admin ? {} : { ownerId: user.id }),
      deletedAt: null,
      status: { not: ConversationStatus.deleted },
    };
  }

  private toConversation(conversation: Conversation) {
    return {
      id: conversation.id,
      ownerId: conversation.ownerId,
      title: conversation.title,
      summary: conversation.summary ?? undefined,
      status: conversation.status,
      currentDesignStateId: conversation.currentDesignStateId ?? undefined,
      currentPrdDocumentId: conversation.currentPrdDocumentId ?? undefined,
      currentPrototypeArtifactId: conversation.currentPrototypeArtifactId ?? undefined,
      latestQaReportId: conversation.latestQaReportId ?? undefined,
      messageCount: conversation.messageCount,
      lastMessageAt: conversation.lastMessageAt?.toISOString(),
      lastActivityAt: conversation.lastActivityAt.toISOString(),
      archivedAt: conversation.archivedAt?.toISOString(),
      deletedAt: conversation.deletedAt?.toISOString(),
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }
}
