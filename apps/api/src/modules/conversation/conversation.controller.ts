import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../../auth/current-user.decorator";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { ConversationService } from "./conversation.service";
import { CreateConversationDto } from "./dto";

@Controller()
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly conversations: ConversationService) {}

  @Post("conversations")
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateConversationDto) {
    return this.conversations.create(user, dto);
  }

  @Get("conversations")
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.conversations.list(user);
  }

  @Get("conversations/:conversationId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.conversations.get(user, conversationId);
  }

  @Delete("conversations")
  deleteAll(@CurrentUser() user: AuthenticatedUser) {
    return this.conversations.deleteAll(user);
  }

  @Delete("conversations/:conversationId")
  delete(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.conversations.delete(user, conversationId);
  }
}
