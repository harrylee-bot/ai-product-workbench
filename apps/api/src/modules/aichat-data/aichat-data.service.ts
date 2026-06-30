import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ConversationStatus,
  MessageRole,
  MessageType,
  Prisma,
  ProjectStatus,
  UserRole,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { Phase1User } from "../auth/auth.types";
import {
  buildMessagePayload,
  BulkCreateMessagesDto,
  CreateSuggestionsDto,
  RegisterStreamDto,
  RenameConversationDto,
  UpdateMessagePartsDto,
} from "./dto";

/**
 * ai-chatbot 数据持久化服务。
 *
 * 覆盖 ConversationService/MessageService 未提供的能力：
 * - 会话重命名
 * - 批量写消息（绕过 VibeService）
 * - 编辑消息 parts
 * - 按时间点截断消息（重新生成）
 * - 用户消息计数
 * - 投票 / 建议 / stream id 记录
 *
 * 所有权校验统一：会话或其消息所属会话的 ownerId 必须等于当前用户，
 * 或当前用户为 admin。
 */
@Injectable()
export class AichatDataService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- 1. 会话重命名 ----------

  async renameConversation(
    user: Phase1User,
    conversationId: string,
    dto: RenameConversationDto,
  ) {
    const conversation = await this.getOwnedConversation(user, conversationId);
    const updated = await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { title: dto.title.trim() },
    });
    return { id: updated.id, title: updated.title };
  }

  // ---------- 2. 批量写消息 ----------

  async bulkCreateMessages(
    user: Phase1User,
    conversationId: string,
    dto: BulkCreateMessagesDto,
  ) {
    const conversation = await this.getOwnedConversation(user, conversationId);

    const rows = dto.messages.map((item) => {
      const payload = buildMessagePayload(
        item,
        conversation.id,
        conversation.projectId,
        user.id,
      );
      const data: Prisma.MessageUncheckedCreateInput = {
        projectId: conversation.projectId,
        conversationId: conversation.id,
        userId: user.id,
        role: payload.role as MessageRole,
        type: MessageType.text,
        content: payload.content,
        attachments: payload.attachments,
        metadata: payload.metadata,
        createdAt: payload.createdAt ?? new Date(),
      };
      return data;
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.createMany({ data: rows });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          messageCount: { increment: created.count },
          lastMessageAt: new Date(),
        },
      });
      await tx.project.update({
        where: { id: conversation.projectId },
        data: { lastActivityAt: new Date() },
      });
      return created;
    });

    return { count: result.count };
  }

  // ---------- 3. 编辑消息 parts ----------

  async updateMessageParts(
    user: Phase1User,
    messageId: string,
    dto: UpdateMessagePartsDto,
  ) {
    const message = await this.getOwnedMessage(user, messageId);

    const existingMetadata =
      (message.metadata as Record<string, unknown> | null) ?? {};
    const nextMetadata = {
      ...existingMetadata,
      parts: dto.parts,
    } as Prisma.InputJsonObject;

    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: { metadata: nextMetadata },
    });

    return {
      id: updated.id,
      metadata: updated.metadata,
    };
  }

  // ---------- 4. 按时间点截断消息 ----------

  async deleteMessagesAfter(user: Phase1User, conversationId: string, after: string) {
    const conversation = await this.getOwnedConversation(user, conversationId);
    const afterDate = new Date(after);
    if (Number.isNaN(afterDate.getTime())) {
      throw new ForbiddenException("after 时间格式不正确");
    }

    const deleted = await this.prisma.$transaction(async (tx) => {
      const result = await tx.message.deleteMany({
        where: {
          conversationId: conversation.id,
          createdAt: { gt: afterDate },
        },
      });

      // 重新统计会话消息数与最近消息时间。
      const [messageCount, latestMessage] = await Promise.all([
        tx.message.count({ where: { conversationId: conversation.id } }),
        tx.message.findFirst({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          messageCount,
          lastMessageAt: latestMessage?.createdAt ?? null,
        },
      });

      return result;
    });

    return { count: deleted.count };
  }

  // ---------- 5. 用户消息计数 ----------

  async countUserMessages(user: Phase1User, hours?: number) {
    const windowHours = hours && hours > 0 ? hours : 24;
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const count = await this.prisma.message.count({
      where: {
        userId: user.id,
        role: MessageRole.user,
        createdAt: { gte: since },
      },
    });

    return { count };
  }

  // ---------- 6. 投票 ----------

  async voteMessage(user: Phase1User, messageId: string, type: "up" | "down") {
    await this.getOwnedMessage(user, messageId);
    const isUpvoted = type === "up";

    const record = await this.prisma.vote.upsert({
      where: {
        messageId_userId: { messageId, userId: user.id },
      },
      update: { isUpvoted },
      create: {
        messageId,
        userId: user.id,
        isUpvoted,
      },
    });

    return {
      messageId: record.messageId,
      type: record.isUpvoted ? "up" : "down",
    };
  }

  async getVote(user: Phase1User, messageId: string) {
    await this.getOwnedMessage(user, messageId);
    const record = await this.prisma.vote.findUnique({
      where: {
        messageId_userId: { messageId, userId: user.id },
      },
    });
    return {
      messageId,
      type: record ? (record.isUpvoted ? "up" : "down") : null,
    };
  }

  // ---------- 7. 建议 ----------

  async createSuggestions(
    user: Phase1User,
    documentId: string,
    dto: CreateSuggestionsDto,
  ) {
    // 文档归属校验：RequirementDocument 通过 project.ownerId 判定。
    await this.getOwnedDocument(user, documentId);

    const created = await this.prisma.suggestion.createMany({
      data: dto.suggestions.map((item) => ({
        documentId,
        originalText: item.originalText,
        suggestedText: item.suggestedText,
        description: item.description ?? null,
        userId: user.id,
      })),
    });

    return { count: created.count };
  }

  async listSuggestions(user: Phase1User, documentId: string) {
    await this.getOwnedDocument(user, documentId);
    const items = await this.prisma.suggestion.findMany({
      where: { documentId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        documentId: item.documentId,
        originalText: item.originalText,
        suggestedText: item.suggestedText,
        description: item.description,
        isResolved: item.isResolved,
        userId: item.userId,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  // ---------- 8. Stream id 记录 ----------

  async registerStream(
    user: Phase1User,
    conversationId: string,
    dto: RegisterStreamDto,
  ) {
    await this.getOwnedConversation(user, conversationId);
    // 幂等：重连场景下 ai-chatbot 可能重复注册同一 streamId。
    const stream = await this.prisma.stream.upsert({
      where: { id: dto.streamId },
      update: {},
      create: {
        id: dto.streamId,
        chatId: conversationId,
      },
    });
    return {
      id: stream.id,
      chatId: stream.chatId,
      createdAt: stream.createdAt.toISOString(),
    };
  }

  async listStreams(user: Phase1User, conversationId: string) {
    await this.getOwnedConversation(user, conversationId);
    const items = await this.prisma.stream.findMany({
      where: { chatId: conversationId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      items: items.map((stream) => ({
        id: stream.id,
        chatId: stream.chatId,
        createdAt: stream.createdAt.toISOString(),
      })),
    };
  }

  async getRuntimeStatus(user: Phase1User, conversationId: string) {
    await this.getOwnedConversation(user, conversationId);
    const latestRun = await this.prisma.runtimeRunLog.findFirst({
      where: { conversationId },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        status: true,
        inputSummary: true,
        outputSummary: true,
        errorMessage: true,
        startedAt: true,
        endedAt: true,
      },
    });

    return {
      latestRun: latestRun
        ? {
            id: latestRun.id,
            status: latestRun.status,
            inputSummary: latestRun.inputSummary,
            outputSummary: latestRun.outputSummary,
            errorMessage: latestRun.errorMessage,
            startedAt: latestRun.startedAt.toISOString(),
            endedAt: latestRun.endedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  // ---------- 归属校验工具 ----------

  private async getOwnedConversation(user: Phase1User, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });

    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (
      conversation.project.status === ProjectStatus.deleted ||
      conversation.project.deletedAt
    ) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该会话");
    }
    return conversation;
  }

  private async getOwnedMessage(user: Phase1User, messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (!message) {
      throw new NotFoundException("消息不存在");
    }
    const conversation = message.conversation;
    if (
      !conversation ||
      conversation.deletedAt ||
      conversation.status === ConversationStatus.deleted
    ) {
      throw new NotFoundException("会话不存在");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该消息");
    }
    return message;
  }

  private async getOwnedDocument(user: Phase1User, documentId: string) {
    const document = await this.prisma.requirementDocument.findUnique({
      where: { id: documentId },
      include: { project: true },
    });
    if (!document) {
      throw new NotFoundException("文档不存在");
    }
    if (
      document.project.status === ProjectStatus.deleted ||
      document.project.deletedAt
    ) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && document.project.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该文档");
    }
    return document;
  }
}
