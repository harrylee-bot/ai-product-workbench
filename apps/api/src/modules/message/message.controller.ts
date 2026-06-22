import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { Phase1User } from "../auth/auth.types";
import { OrchestratorService } from "../ai/orchestrator/orchestrator.service";
import { CreateMessageDto, ListMessagesQueryDto } from "./dto";
import { MessageService } from "./message.service";

@Controller()
@UseGuards(JwtAuthGuard)
export class MessageController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly messages: MessageService,
  ) {}

  @Post("messages")
  create(@CurrentUser() user: Phase1User, @Body() dto: CreateMessageDto) {
    return this.orchestrator.handleUserMessage({
      user,
      projectId: dto.projectId,
      conversationId: dto.conversationId,
      content: dto.content,
    });
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
