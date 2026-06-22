import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
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

  @Get("projects/:projectId/conversations")
  listByProject(@CurrentUser() user: Phase1User, @Param("projectId") projectId: string) {
    return this.conversations.listByProject(user, projectId);
  }
}
