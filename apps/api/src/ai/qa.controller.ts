import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { ListQaReportsQueryDto, RollbackProductDesignStateByVersionDto, RunQaDto } from "./qa.dto";
import { QaService } from "./qa.service";
import { RollbackService } from "./rollback.service";
import { VersionHistoryService } from "./version-history.service";

@Controller("projects/:projectId/qa")
@UseGuards(JwtAuthGuard)
export class ProjectQaController {
  constructor(private readonly qaService: QaService) {}

  @Post("run")
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: RunQaDto,
  ) {
    return this.qaService.runForUser(user, projectId, dto);
  }

  @Get("latest")
  latest(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.qaService.getLatestForUser(user, projectId);
  }
}

@Controller("projects/:projectId/qa-reports")
@UseGuards(JwtAuthGuard)
export class ProjectQaReportsController {
  constructor(private readonly qaService: QaService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Query() query: ListQaReportsQueryDto,
  ) {
    return this.qaService.listForProject(user, projectId, query);
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

@Controller("projects/:projectId/version-timeline")
@UseGuards(JwtAuthGuard)
export class ProjectVersionTimelineController {
  constructor(private readonly versionHistory: VersionHistoryService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.versionHistory.listProjectTimeline(user, projectId);
  }
}

@Controller("projects/:projectId/rollback")
@UseGuards(JwtAuthGuard)
export class ProjectRollbackController {
  constructor(private readonly rollbackService: RollbackService) {}

  @Post("product-design-state")
  rollbackProductDesignState(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: RollbackProductDesignStateByVersionDto,
  ) {
    return this.rollbackService.rollbackProductDesignStateForUser(user, projectId, dto);
  }

  @Get("records")
  listRollbackRecords(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.rollbackService.listProjectRollbackRecords(user, projectId);
  }
}
