import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConversationStatus, Message, MessageRole, MessageType, Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";

type CreateMessageInput = {
  conversationId: string;
  userId?: string;
  content: string;
  type?: MessageType;
  attachments?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  relatedRunId?: string;
  relatedPrdDocumentId?: string;
  relatedPrototypeArtifactId?: string;
  relatedQaReportId?: string;
};

type UpdateAssistantMessageInput = {
  content: string;
  type?: MessageType;
  attachments?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
  relatedRunId?: string;
  relatedPrdDocumentId?: string;
  relatedPrototypeArtifactId?: string;
  relatedQaReportId?: string;
};

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  createUserMessage(input: CreateMessageInput) {
    return this.createMessage(MessageRole.user, input);
  }

  createAssistantMessage(input: CreateMessageInput) {
    return this.createMessage(MessageRole.assistant, input);
  }

  createSystemMessage(input: CreateMessageInput) {
    return this.createMessage(MessageRole.system, input);
  }

  async updateAssistantMessage(messageId: string, input: UpdateAssistantMessageInput) {
    const message = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.role !== MessageRole.assistant) {
      throw new NotFoundException("ASSISTANT_MESSAGE_NOT_FOUND");
    }

    const updated = await this.prisma.message.update({
      where: { id: messageId },
      data: {
        content: input.content,
        type: input.type ?? MessageType.text,
        attachments: input.attachments,
        metadata: input.metadata,
        relatedRunId: input.relatedRunId,
        relatedPrdDocumentId: input.relatedPrdDocumentId,
        relatedPrototypeArtifactId: input.relatedPrototypeArtifactId,
        relatedQaReportId: input.relatedQaReportId,
      },
    });
    await this.touchConversation(message.conversationId);
    return this.toMessageItem(updated);
  }

  async getRecentMessages(conversationId: string, limit = 20) {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return messages.reverse().map((message) => this.toMessageItem(message));
  }

  async listByConversation(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    return { items: messages.map((message) => this.toMessageItem(message)) };
  }

  async createMessage(role: MessageRole, input: CreateMessageInput) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: input.conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("CONVERSATION_NOT_FOUND");
    }
    if (conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("CONVERSATION_ARCHIVED");
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: input.conversationId,
          userId: input.userId,
          role,
          type: input.type ?? MessageType.text,
          content: input.content,
          attachments: input.attachments,
          metadata: input.metadata,
          relatedRunId: input.relatedRunId,
          relatedPrdDocumentId: input.relatedPrdDocumentId,
          relatedPrototypeArtifactId: input.relatedPrototypeArtifactId,
          relatedQaReportId: input.relatedQaReportId,
        },
      });
      await this.updateConversationStats(input.conversationId, tx);
      return created;
    });

    return this.toMessageItem(message);
  }

  private async updateConversationStats(
    conversationId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const messageCount = await tx.message.count({ where: { conversationId } });
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        messageCount,
        lastMessageAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
  }

  private async touchConversation(conversationId: string) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastActivityAt: new Date() },
    });
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("CONVERSATION_NOT_FOUND");
    }
    if (!options.allowArchived && conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("CONVERSATION_ARCHIVED");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("CONVERSATION_FORBIDDEN");
    }
    return conversation;
  }

  private toMessageItem(message: Message) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      userId: message.userId,
      role: message.role,
      type: message.type,
      content: message.content,
      attachments: message.attachments,
      metadata: message.metadata,
      relatedRunId: message.relatedRunId,
      relatedPrdDocumentId: message.relatedPrdDocumentId,
      relatedPrototypeArtifactId: message.relatedPrototypeArtifactId,
      relatedQaReportId: message.relatedQaReportId,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
