import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { Phase1User } from "../auth/auth.types";
import { MessageService } from "../../projects/message.service";
import { ListMessagesQueryDto } from "./dto";

/**
 * 消息读取入口。
 *
 * 注：ai-chatbot 前端通过 POST /api/chat/stream（AI-SDK UIMessageStream 桥端点）发送消息，
 * 并在 onFinish 时批量持久化 assistant 消息；不再使用单条 POST /messages 发送用户消息，
 * 因此该控制器仅保留读取端点。
 *
 * - GET /messages、GET /conversations/:id/messages：读取会话消息 + 最近运行摘要，
 *   统一由 projects/MessageService.listByConversation 提供。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class MessageController {
  constructor(private readonly messages: MessageService) {}

  @Get("messages")
  list(@CurrentUser() user: Phase1User, @Query() query: ListMessagesQueryDto) {
    return this.messages.listByConversation(user, query.conversationId ?? "");
  }

  @Get("conversations/:conversationId/messages")
  listByConversation(@CurrentUser() user: Phase1User, @Param("conversationId") conversationId: string) {
    return this.messages.listByConversation(user, conversationId);
  }
}
