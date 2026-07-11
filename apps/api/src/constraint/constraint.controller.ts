import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, Query, UseGuards } from "@nestjs/common";
import { ConversationStatus, UserRole } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { BuildConstraintDto } from "./constraint.dto";
import { ConstraintService } from "./constraint.service";

@Controller("constraint")
@UseGuards(JwtAuthGuard)
export class ConstraintController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly constraints: ConstraintService,
  ) {}

  @Post("build")
  async build(@CurrentUser() user: AuthenticatedUser, @Body() dto: BuildConstraintDto) {
    await this.assertConversationAccess(user, dto.conversationId, { requireOwner: true });
    return this.constraints.build({
      conversationId: dto.conversationId,
      userInput: dto.input,
      createdBy: user.id,
    });
  }

  @Get("context")
  async context(@CurrentUser() user: AuthenticatedUser, @Query("conversationId") conversationId: string) {
    await this.assertConversationAccess(user, conversationId);
    return this.constraints.context(conversationId);
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { requireOwner?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (conversation.ownerId !== user.id && (options.requireOwner || user.role !== UserRole.admin)) {
      throw new ForbiddenException("无权访问该会话");
    }
  }
}
