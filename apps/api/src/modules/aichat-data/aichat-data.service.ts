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
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthenticatedUser } from "../../auth/auth.types";
import {
  sanitizeAssistantMetadataForPersistence,
  sanitizeAssistantParts,
} from "../../conversations/message-metadata";
import {
  buildMessagePayload,
  BulkCreateMessagesDto,
  CreateSuggestionsDto,
  extractTextFromParts,
  RegisterStreamDto,
  RenameConversationDto,
  UpdateMessagePartsDto,
} from "./dto";
import { assertConversationId } from "../conversation/conversation-id";

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
 * 普通业务路由始终要求 ownerId 等于当前用户。管理员跨用户操作必须走
 * 独立的 admin API，以便保留明确授权和审计边界。
 */
@Injectable()
export class AichatDataService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- 1. 会话重命名 ----------

  async renameConversation(
    user: AuthenticatedUser,
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
    user: AuthenticatedUser,
    conversationId: string,
    dto: BulkCreateMessagesDto,
  ) {
    const conversation = await this.getOwnedConversation(user, conversationId);

    const rows = dto.messages.map((item) => {
      const payload = buildMessagePayload(
        item,
        conversation.id,
        user.id,
      );
      const data: Prisma.MessageUncheckedCreateInput = {
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
      return created;
    });

    return { count: result.count };
  }

  // ---------- 3. 编辑消息 parts ----------

  async updateMessageParts(
    user: AuthenticatedUser,
    messageId: string,
    dto: UpdateMessagePartsDto,
  ) {
    const message = await this.getOwnedMessage(user, messageId);

    const existingMetadata =
      (message.metadata as Record<string, unknown> | null) ?? {};
    const persistedParts =
      message.role === MessageRole.assistant
        ? sanitizeAssistantParts(dto.parts)
        : dto.parts;
    const mergedMetadata = {
      ...existingMetadata,
      parts: persistedParts,
    } as Prisma.InputJsonObject;
    const nextMetadata =
      message.role === MessageRole.assistant
        ? sanitizeAssistantMetadataForPersistence(mergedMetadata)
        : mergedMetadata;
    const content = extractTextFromParts(persistedParts) || "(empty)";

    const updated = await this.prisma.$transaction(async (tx) => {
      const nextMessage = await tx.message.update({
        where: { id: message.id },
        data: { content, metadata: nextMetadata },
      });

      if (dto.truncateAfter) {
        const orderedMessages = await tx.message.findMany({
          where: { conversationId: message.conversationId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        const editedIndex = orderedMessages.findIndex((item) => item.id === message.id);
        const idsToDelete =
          editedIndex >= 0
            ? orderedMessages.slice(editedIndex + 1).map((item) => item.id)
            : [];

        if (idsToDelete.length > 0) {
          await tx.message.deleteMany({ where: { id: { in: idsToDelete } } });
        }

        const [messageCount, latestMessage] = await Promise.all([
          tx.message.count({ where: { conversationId: message.conversationId } }),
          tx.message.findFirst({
            where: { conversationId: message.conversationId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          }),
        ]);
        await tx.conversation.update({
          where: { id: message.conversationId },
          data: {
            messageCount,
            lastMessageAt: latestMessage?.createdAt ?? null,
          },
        });
      }

      return nextMessage;
    });

    return {
      id: updated.id,
      metadata: updated.metadata,
    };
  }

  // ---------- 4. 按时间点截断消息 ----------

  async deleteMessagesAfter(user: AuthenticatedUser, conversationId: string, after: string) {
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

  async countUserMessages(user: AuthenticatedUser, hours?: number) {
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

  async voteMessage(user: AuthenticatedUser, messageId: string, type: "up" | "down") {
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

  async getVote(user: AuthenticatedUser, messageId: string) {
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
    user: AuthenticatedUser,
    documentId: string,
    dto: CreateSuggestionsDto,
  ) {
    // 文档归属校验：RequirementDocument 通过 conversation.ownerId 判定。
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

  async listSuggestions(user: AuthenticatedUser, documentId: string) {
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
    user: AuthenticatedUser,
    conversationId: string,
    dto: RegisterStreamDto,
  ) {
    await this.getOwnedConversation(user, conversationId);
    const existing = await this.prisma.stream.findUnique({
      where: { id: dto.streamId },
    });
    if (existing) {
      if (existing.chatId !== conversationId) {
        throw new ForbiddenException("无权访问该 stream");
      }
      return {
        id: existing.id,
        chatId: existing.chatId,
        createdAt: existing.createdAt.toISOString(),
      };
    }

    let stream: { id: string; chatId: string; createdAt: Date };
    try {
      stream = await this.prisma.stream.create({
        data: {
          id: dto.streamId,
          chatId: conversationId,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const raced = await this.prisma.stream.findUnique({
        where: { id: dto.streamId },
      });
      if (!raced || raced.chatId !== conversationId) {
        throw new ForbiddenException("无权访问该 stream");
      }
      stream = raced;
    }

    return {
      id: stream.id,
      chatId: stream.chatId,
      createdAt: stream.createdAt.toISOString(),
    };
  }

  async listStreams(user: AuthenticatedUser, conversationId: string) {
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

  async getRuntimeStatus(user: AuthenticatedUser, conversationId: string) {
    await this.getOwnedConversation(user, conversationId);
    const latestRun = await this.prisma.runtimeRunLog.findFirst({
      where: { conversationId },
      orderBy: { startedAt: "desc" },
      include: {
        streamEvents: {
          where: { eventType: "runtime_event" },
          orderBy: { createdAt: "asc" },
          take: 80,
          select: {
            id: true,
            eventType: true,
            payload: true,
            createdAt: true,
          },
        },
      },
    });
    const events = latestRun?.streamEvents
      .map((event) => event.payload)
      .filter(isRuntimeProcessEvent) ?? [];

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
            events,
          }
        : null,
    };
  }

  // ---------- 归属校验工具 ----------

  private async getOwnedConversation(user: AuthenticatedUser, conversationId: string) {
    assertConversationId(conversationId);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该会话");
    }
    return conversation;
  }

  private async getOwnedMessage(user: AuthenticatedUser, messageId: string) {
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
    if (conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该消息");
    }
    return message;
  }

  private async getOwnedDocument(user: AuthenticatedUser, documentId: string) {
    const document = await this.prisma.requirementDocument.findUnique({
      where: { id: documentId },
      include: { conversation: true },
    });
    if (!document) {
      throw new NotFoundException("文档不存在");
    }
    if (
      document.conversation.status === ConversationStatus.deleted ||
      document.conversation.deletedAt
    ) {
      throw new NotFoundException("会话不存在");
    }
    if (document.conversation.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该文档");
    }
    return document;
  }
}

function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRuntimeProcessEvent(value: unknown): value is {
  id: string;
  kind: string;
  label: string;
  status: string;
  createdAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.kind === "string" &&
    typeof record.label === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string"
  );
}
