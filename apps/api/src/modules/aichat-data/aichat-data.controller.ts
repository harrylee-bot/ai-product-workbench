import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { Phase1User } from "../auth/auth.types";
import { AichatDataService } from "./aichat-data.service";
import {
  BulkCreateMessagesDto,
  CreateSuggestionsDto,
  DeleteMessagesAfterQueryDto,
  MessageCountQueryDto,
  RegisterStreamDto,
  RenameConversationDto,
  UpdateMessagePartsDto,
  VoteDto,
} from "./dto";

/**
 * ai-chatbot 前端持久化所需 REST 端点。
 *
 * 与 vercel/ai-chatbot 后端契约对齐，但底层复用现有 NestJS 认证、
 * Prisma 消息/会话模型（parts → metadata.parts，attachments → attachments）。
 *
 * 路由均为全路径（控制器无前缀），与 conversation/message 控制器风格一致。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class AichatDataController {
  constructor(private readonly data: AichatDataService) {}

  // 1. 重命名会话
  @Patch("conversations/:conversationId")
  renameConversation(
    @CurrentUser() user: Phase1User,
    @Param("conversationId") conversationId: string,
    @Body() dto: RenameConversationDto,
  ) {
    return this.data.renameConversation(user, conversationId, dto);
  }

  // 2. 批量写消息
  @Post("conversations/:conversationId/messages/bulk")
  bulkCreateMessages(
    @CurrentUser() user: Phase1User,
    @Param("conversationId") conversationId: string,
    @Body() dto: BulkCreateMessagesDto,
  ) {
    return this.data.bulkCreateMessages(user, conversationId, dto);
  }

  // 3. 编辑消息 parts
  @Patch("messages/:messageId")
  updateMessage(
    @CurrentUser() user: Phase1User,
    @Param("messageId") messageId: string,
    @Body() dto: UpdateMessagePartsDto,
  ) {
    return this.data.updateMessageParts(user, messageId, dto);
  }

  // 4. 按时间点截断消息（重新生成）
  @Delete("conversations/:conversationId/messages")
  deleteMessagesAfter(
    @CurrentUser() user: Phase1User,
    @Param("conversationId") conversationId: string,
    @Query() query: DeleteMessagesAfterQueryDto,
  ) {
    return this.data.deleteMessagesAfter(user, conversationId, query.after);
  }

  // 5. 用户最近 N 小时消息计数
  @Get("users/me/message-count")
  countMyMessages(
    @CurrentUser() user: Phase1User,
    @Query() query: MessageCountQueryDto,
  ) {
    return this.data.countUserMessages(user, query.hours);
  }

  // 6. 投票
  @Post("messages/:messageId/vote")
  vote(
    @CurrentUser() user: Phase1User,
    @Param("messageId") messageId: string,
    @Body() dto: VoteDto,
  ) {
    return this.data.voteMessage(user, messageId, dto.type);
  }

  @Get("messages/:messageId/vote")
  getVote(@CurrentUser() user: Phase1User, @Param("messageId") messageId: string) {
    return this.data.getVote(user, messageId);
  }

  // 7. 文档建议
  @Post("documents/:documentId/suggestions")
  createSuggestions(
    @CurrentUser() user: Phase1User,
    @Param("documentId") documentId: string,
    @Body() dto: CreateSuggestionsDto,
  ) {
    return this.data.createSuggestions(user, documentId, dto);
  }

  @Get("documents/:documentId/suggestions")
  listSuggestions(
    @CurrentUser() user: Phase1User,
    @Param("documentId") documentId: string,
  ) {
    return this.data.listSuggestions(user, documentId);
  }

  // 8. stream id 记录（断线重连）
  @Post("conversations/:conversationId/streams")
  registerStream(
    @CurrentUser() user: Phase1User,
    @Param("conversationId") conversationId: string,
    @Body() dto: RegisterStreamDto,
  ) {
    return this.data.registerStream(user, conversationId, dto);
  }

  @Get("conversations/:conversationId/streams")
  listStreams(
    @CurrentUser() user: Phase1User,
    @Param("conversationId") conversationId: string,
  ) {
    return this.data.listStreams(user, conversationId);
  }
}
