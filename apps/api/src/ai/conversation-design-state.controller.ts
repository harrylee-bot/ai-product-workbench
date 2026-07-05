import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import {
  AnswerClarificationQuestionDto,
  CreateConversationDesignStateDto,
  CreateConversationDesignVersionDto,
  RollbackConversationDesignStateDto,
} from "./conversation-design-state.dto";
import { ConversationDesignStateService } from "./conversation-design-state.service";
import type { ConversationDesignState } from "./ai-vibe.types";

@Controller("conversations/:conversationId/conversation-design-state")
@UseGuards(JwtAuthGuard)
export class ConversationDesignStateController {
  constructor(private readonly stateService: ConversationDesignStateService) {}

  @Get()
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.stateService.getCurrentStateForUser(user, conversationId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Body() dto: CreateConversationDesignStateDto,
  ) {
    return this.stateService.createStateForUser(user, conversationId, {
      title: dto.title,
      businessGoal: dto.businessGoal,
      initialState: dto.initialState as Partial<ConversationDesignState> | undefined,
      reason: dto.reason,
    });
  }
}

@Controller("conversation-design-states")
@UseGuards(JwtAuthGuard)
export class ConversationDesignStateResourceController {
  constructor(private readonly stateService: ConversationDesignStateService) {}

  @Post(":stateId/versions")
  createVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Body() dto: CreateConversationDesignVersionDto,
  ) {
    return this.stateService.createVersionForUser(user, stateId, dto.reason);
  }

  @Get(":stateId/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("stateId") stateId: string) {
    return this.stateService.listVersionsForUser(user, stateId);
  }

  @Post(":stateId/rollback")
  rollback(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Body() dto: RollbackConversationDesignStateDto,
  ) {
    return this.stateService.rollbackForUser(user, stateId, dto);
  }

  @Get(":stateId/change-logs")
  listChangeLogs(@CurrentUser() user: AuthenticatedUser, @Param("stateId") stateId: string) {
    return this.stateService.listChangeLogsForUser(user, stateId);
  }

  @Post(":stateId/assumptions/:assumptionId/confirm")
  confirmAssumption(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Param("assumptionId") assumptionId: string,
  ) {
    return this.stateService.confirmAssumptionForUser(user, stateId, assumptionId);
  }

  @Post(":stateId/assumptions/:assumptionId/reject")
  rejectAssumption(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Param("assumptionId") assumptionId: string,
  ) {
    return this.stateService.rejectAssumptionForUser(user, stateId, assumptionId);
  }

  @Post(":stateId/questions/:questionId/answer")
  answerQuestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Param("questionId") questionId: string,
    @Body() dto: AnswerClarificationQuestionDto,
  ) {
    return this.stateService.answerQuestionForUser(user, stateId, questionId, dto);
  }
}
