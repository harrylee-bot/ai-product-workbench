import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { ListQaReportsQueryDto, RunQaDto } from "./qa.dto";
import { QaService } from "./qa.service";
import { RollbackService } from "./rollback.service";
import { VersionHistoryService } from "./version-history.service";

@Controller("conversations/:conversationId/qa")
@UseGuards(JwtAuthGuard)
export class ConversationQaController {
  constructor(private readonly qaService: QaService) {}

  @Post("run")
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Body() dto: RunQaDto,
  ) {
    return this.qaService.runForUser(user, conversationId, dto);
  }

  @Get("latest")
  latest(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.qaService.getLatestForUser(user, conversationId);
  }

  @Get("gate")
  gate(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.qaService.getGateForUser(user, conversationId);
  }
}

@Controller("conversations/:conversationId/qa-reports")
@UseGuards(JwtAuthGuard)
export class ConversationQaReportsController {
  constructor(private readonly qaService: QaService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Query() query: ListQaReportsQueryDto,
  ) {
    return this.qaService.listForConversation(user, conversationId, query);
  }
}

@Controller("qa-reports")
@UseGuards(JwtAuthGuard)
export class QaReportController {
  constructor(private readonly qaService: QaService) {}

  @Get(":qaReportId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("qaReportId") qaReportId: string) {
    return this.qaService.getForUser(user, qaReportId);
  }
}

@Controller("conversations/:conversationId/version-timeline")
@UseGuards(JwtAuthGuard)
export class ConversationVersionTimelineController {
  constructor(private readonly versionHistory: VersionHistoryService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.versionHistory.listConversationTimeline(user, conversationId);
  }
}

@Controller("conversations/:conversationId/rollback")
@UseGuards(JwtAuthGuard)
export class ConversationRollbackController {
  constructor(private readonly rollbackService: RollbackService) {}

  @Get("records")
  listRollbackRecords(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.rollbackService.listConversationRollbackRecords(user, conversationId);
  }
}
