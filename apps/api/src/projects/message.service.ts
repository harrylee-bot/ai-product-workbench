import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ConversationStatus,
  Message,
  MessageRole,
  MessageType,
  Prisma,
  ProjectStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type CreateMessageInput = {
  projectId: string;
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

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  async createUserMessage(input: CreateMessageInput) {
    return this.createMessage({ ...input, role: MessageRole.user, type: input.type ?? MessageType.text });
  }

  async createAssistantMessage(input: CreateMessageInput) {
    return this.createMessage({
      ...input,
      role: MessageRole.assistant,
      type: input.type ?? MessageType.text,
    });
  }

  async createSystemMessage(input: CreateMessageInput) {
    return this.createMessage({ ...input, role: MessageRole.system, type: input.type ?? MessageType.text });
  }

  async getRecentMessages(conversationId: string, limit = 20) {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });

    return messages.reverse().map((message) => this.toMessageItem(message));
  }

  async updateConversationStats(conversationId: string, tx: Prisma.TransactionClient = this.prisma) {
    const [messageCount, latestMessage] = await Promise.all([
      tx.message.count({ where: { conversationId } }),
      tx.message.findFirst({
        where: { conversationId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        messageCount,
        lastMessageAt: latestMessage?.createdAt ?? null,
      },
    });
  }

  async updateProjectActivity(projectId: string, tx: Prisma.TransactionClient = this.prisma) {
    await tx.project.update({
      where: { id: projectId },
      data: { lastActivityAt: new Date() },
    });
  }

  private async createMessage(input: CreateMessageInput & { role: MessageRole; type: MessageType }) {
    const now = new Date();

    const message = await this.prisma.$transaction(async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: input.conversationId },
        include: { project: true },
      });

      if (!conversation || conversation.projectId !== input.projectId) {
        throw new NotFoundException("会话不存在");
      }

      if (
        conversation.status !== ConversationStatus.active ||
        conversation.deletedAt ||
        conversation.project.status === ProjectStatus.archived ||
        conversation.project.status === ProjectStatus.deleted ||
        conversation.project.deletedAt
      ) {
        throw new ForbiddenException("当前项目或会话不可继续发送消息");
      }

      const created = await tx.message.create({
        data: {
          projectId: input.projectId,
          conversationId: input.conversationId,
          userId: input.userId,
          role: input.role,
          type: input.type,
          content: input.content,
          attachments: input.attachments,
          metadata: input.metadata,
          relatedRunId: input.relatedRunId,
          relatedPrdDocumentId: input.relatedPrdDocumentId,
          relatedPrototypeArtifactId: input.relatedPrototypeArtifactId,
          relatedQaReportId: input.relatedQaReportId,
          createdAt: now,
        },
      });

      await tx.conversation.update({
        where: { id: input.conversationId },
        data: {
          messageCount: { increment: 1 },
          lastMessageAt: now,
        },
      });

      await tx.project.update({
        where: { id: input.projectId },
        data: { lastActivityAt: now },
      });

      return created;
    });

    return this.toMessageItem(message);
  }

  private toMessageItem(message: Message) {
    return {
      id: message.id,
      projectId: message.projectId,
      conversationId: message.conversationId,
      userId: message.userId ?? undefined,
      role: message.role,
      type: message.type,
      content: message.content,
      attachments: message.attachments,
      metadata: message.metadata,
      relatedRunId: message.relatedRunId ?? undefined,
      relatedPrdDocumentId: message.relatedPrdDocumentId ?? undefined,
      relatedPrototypeArtifactId: message.relatedPrototypeArtifactId ?? undefined,
      relatedQaReportId: message.relatedQaReportId ?? undefined,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
