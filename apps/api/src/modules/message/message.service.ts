import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConversationStatus, Message, ProjectStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1User } from "../auth/auth.types";

@Injectable()
export class MessageService {
  constructor(private readonly prisma: PrismaService) {}

  async listByConversation(user: Phase1User, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (conversation.project.status === ProjectStatus.deleted || conversation.project.deletedAt) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该会话");
    }

    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return { items: messages.map(toMessage) };
  }
}

function toMessage(message: Message) {
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
