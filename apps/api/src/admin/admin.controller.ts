import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { PrototypeConversionService } from "../files/prototype-conversion.service";
import {
  BackfillPrototypeConversionsDto,
  ListAdminAuditLogsQueryDto,
  ListAdminModelCallsQueryDto,
  ListAdminConversationsQueryDto,
  ListRuntimeRunsQueryDto,
  ListFileParsesQueryDto,
  ListQaReportsQueryDto,
} from "./admin.dto";
import { AdminAuditService } from "./admin-audit.service";
import { AdminService } from "./admin.service";

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly auditService: AdminAuditService,
    private readonly prototypeConversionService: PrototypeConversionService,
  ) {}

  @Get("dashboard/stats")
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  @Get("conversations")
  listConversations(@Query() query: ListAdminConversationsQueryDto) {
    return this.adminService.listConversations(query);
  }

  @Get("conversations/:conversationId")
  getConversation(@Param("conversationId") conversationId: string) {
    return this.adminService.getConversation(conversationId);
  }

  @Get("conversations/:conversationId/runs")
  listConversationRuns(@Param("conversationId") conversationId: string, @Query() query: ListRuntimeRunsQueryDto) {
    return this.adminService.listConversationRuns(conversationId, query);
  }

  @Get("conversations/:conversationId/files")
  listConversationFiles(@Param("conversationId") conversationId: string, @Query() query: ListFileParsesQueryDto) {
    return this.adminService.listConversationFiles(conversationId, query);
  }

  @Get("conversations/:conversationId/qa-reports")
  listConversationQaReports(
    @Param("conversationId") conversationId: string,
    @Query() query: ListQaReportsQueryDto,
  ) {
    return this.adminService.listConversationQaReports(conversationId, query);
  }

  @Get("logs/runtime-runs")
  listRuntimeRuns(@Query() query: ListRuntimeRunsQueryDto) {
    return this.adminService.listRuntimeRuns(query);
  }

  @Get("logs/runtime-runs/:runId")
  getRuntimeRun(@Param("runId") runId: string) {
    return this.adminService.getRuntimeRun(runId);
  }

  @Get("logs/model-calls")
  listModelCalls(@Query() query: ListAdminModelCallsQueryDto) {
    return this.adminService.listModelCalls(query);
  }

  @Get("logs/model-calls/:logId")
  getModelCall(@Param("logId") logId: string) {
    return this.adminService.getModelCall(logId);
  }

  @Get("logs/file-parses")
  listFileParses(@Query() query: ListFileParsesQueryDto) {
    return this.adminService.listFileParses(query);
  }

  @Get("logs/file-parses/:fileId")
  getFileParse(@Param("fileId") fileId: string) {
    return this.adminService.getFileParse(fileId);
  }

  @Post("prototype-conversions/backfill")
  backfillPrototypeConversions(@Body() dto: BackfillPrototypeConversionsDto) {
    return this.prototypeConversionService.backfillRpConversions(dto);
  }

  @Get("logs/qa-reports")
  listQaReports(@Query() query: ListQaReportsQueryDto) {
    return this.adminService.listQaReports(query);
  }

  @Get("logs/qa-reports/:qaReportId")
  getQaReport(@Param("qaReportId") qaReportId: string) {
    return this.adminService.getQaReport(qaReportId);
  }

  @Get("audit-logs")
  listAuditLogs(@Query() query: ListAdminAuditLogsQueryDto) {
    return this.auditService.list(query);
  }
}
