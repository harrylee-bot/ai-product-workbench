import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/current-user.decorator";
import { ListMessagesQueryDto } from "./dto";
import { MessageService } from "./message.service";

@Controller("conversations")
@UseGuards(JwtAuthGuard)
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  @Get(":conversationId/messages")
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messageService.listMessages(user, conversationId, query);
  }
}
