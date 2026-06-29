import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { Phase1User } from "../auth/auth.types";
import { VibeService } from "../../ai/vibe.service";
import { HandleVibeMessageDto } from "../../ai/dto";
import { MessageService } from "../../projects/message.service";
import { ListMessagesQueryDto } from "./dto";

/**
 * 消息读写入口。
 * - POST /messages：与 POST /ai/vibe/handle-message 等价的别名（复用 HandleVibeMessageDto，
 *   委托 VibeService.handleMessage），消除此前剥离字段的重复 DTO。
 * - GET /messages、GET /conversations/:id/messages：读取会话消息 + 最近运行摘要，
 *   统一由 projects/MessageService.listByConversation 提供（合并自原 modules/message/service）。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class MessageController {
  constructor(
    private readonly vibe: VibeService,
    private readonly messages: MessageService,
  ) {}

  @Post("messages")
  create(@CurrentUser() user: Phase1User, @Body() dto: HandleVibeMessageDto) {
    return this.vibe.handleMessage(user, dto);
  }

  @Get("messages")
  list(@CurrentUser() user: Phase1User, @Query() query: ListMessagesQueryDto) {
    return this.messages.listByConversation(user, query.conversationId ?? "");
  }

  @Get("conversations/:conversationId/messages")
  listByConversation(@CurrentUser() user: Phase1User, @Param("conversationId") conversationId: string) {
    return this.messages.listByConversation(user, conversationId);
  }
}
