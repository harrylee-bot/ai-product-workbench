import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import {
  ListAdminAuditLogsQueryDto,
  ListAdminModelCallsQueryDto,
  ListAdminProjectsQueryDto,
  ListRuntimeRunsQueryDto,
  ListFileParsesQueryDto,
  ListPatchesQueryDto,
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
  ) {}

  @Get("dashboard/stats")
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  @Get("projects")
  listProjects(@Query() query: ListAdminProjectsQueryDto) {
    return this.adminService.listProjects(query);
  }

  @Get("projects/:projectId")
  getProject(@Param("projectId") projectId: string) {
    return this.adminService.getProject(projectId);
  }

  @Get("projects/:projectId/runs")
  listProjectRuns(@Param("projectId") projectId: string, @Query() query: ListRuntimeRunsQueryDto) {
    return this.adminService.listProjectRuns(projectId, query);
  }

  @Get("projects/:projectId/patches")
  listProjectPatches(@Param("projectId") projectId: string, @Query() query: ListPatchesQueryDto) {
    return this.adminService.listProjectPatches(projectId, query);
  }

  @Get("projects/:projectId/files")
  listProjectFiles(@Param("projectId") projectId: string, @Query() query: ListFileParsesQueryDto) {
    return this.adminService.listProjectFiles(projectId, query);
  }

  @Get("projects/:projectId/qa-reports")
  listProjectQaReports(
    @Param("projectId") projectId: string,
    @Query() query: ListQaReportsQueryDto,
  ) {
    return this.adminService.listProjectQaReports(projectId, query);
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

  @Get("logs/patches")
  listPatches(@Query() query: ListPatchesQueryDto) {
    return this.adminService.listPatches(query);
  }

  @Get("logs/patches/:patchId")
  getPatch(@Param("patchId") patchId: string) {
    return this.adminService.getPatch(patchId);
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
