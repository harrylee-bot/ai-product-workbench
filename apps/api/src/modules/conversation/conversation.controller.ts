import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { Phase1User } from "../auth/auth.types";
import { ConversationService } from "./conversation.service";
import { CreateConversationDto } from "./dto";

@Controller()
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Post("conversations")
  create(@CurrentUser() user: Phase1User, @Body() dto: CreateConversationDto) {
    return this.conversations.create(user, dto);
  }

  @Get("conversations")
  list(@CurrentUser() user: Phase1User) {
    return this.conversations.list(user);
  }

  @Get("conversations/:conversationId")
  get(@CurrentUser() user: Phase1User, @Param("conversationId") conversationId: string) {
    return this.conversations.get(user, conversationId);
  }

  @Get("projects/:projectId/conversations")
  listByProject(@CurrentUser() user: Phase1User, @Param("projectId") projectId: string) {
    return this.conversations.listByProject(user, projectId);
  }

  @Delete("conversations/:conversationId")
  delete(@CurrentUser() user: Phase1User, @Param("conversationId") conversationId: string) {
    return this.conversations.delete(user, conversationId);
  }
}
