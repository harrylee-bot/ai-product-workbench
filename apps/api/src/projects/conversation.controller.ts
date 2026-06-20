import { Body, Controller, Delete, Param, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../common/current-user.decorator";
import { UpdateConversationDto } from "./dto";
import { ProjectService } from "./project.service";

@Controller("conversations")
@UseGuards(JwtAuthGuard)
export class ConversationController {
  constructor(private readonly projectService: ProjectService) {}

  @Patch(":conversationId")
  updateConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.projectService.updateConversation(user, conversationId, dto);
  }

  @Delete(":conversationId")
  deleteConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
  ) {
    return this.projectService.deleteConversation(user, conversationId);
  }
}
