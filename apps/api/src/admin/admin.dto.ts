import { Transform, Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  AdminAuditTargetType,
  AgentName,
  AgentRunStatus,
  FileAssetStatus,
  FileParserType,
  ModelCallStatus,
  ModelTaskType,
  PatchRecordStatus,
  ProjectStatus,
  QAReportStatus,
  QAReportTrigger,
} from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class AdminPaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ListAdminProjectsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  keyword?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  owner?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ProjectStatus, { message: "项目状态不正确" })
  status?: ProjectStatus;
}

export class ListAgentRunsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  projectId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  userId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(AgentRunStatus, { message: "运行状态不正确" })
  status?: AgentRunStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(AgentName, { message: "Agent 名称不正确" })
  agentName?: AgentName;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  traceId?: string;
}

export class ListAdminModelCallsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ModelTaskType, { message: "任务类型不正确" })
  taskType?: ModelTaskType;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  agentName?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  modelName?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  providerId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ModelCallStatus, { message: "调用状态不正确" })
  status?: ModelCallStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  runId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  traceId?: string;
}

export class ListFileParsesQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  projectId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  uploadedBy?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(FileAssetStatus, { message: "文件状态不正确" })
  status?: FileAssetStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(FileParserType, { message: "解析器类型不正确" })
  parserType?: FileParserType;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  extension?: string;
}

export class ListPatchesQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  projectId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  createdBy?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(PatchRecordStatus, { message: "Patch 状态不正确" })
  status?: PatchRecordStatus;
}

export class ListQaReportsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  projectId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(QAReportStatus, { message: "QA 状态不正确" })
  status?: QAReportStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(QAReportTrigger, { message: "QA 触发类型不正确" })
  trigger?: QAReportTrigger;
}

export class ListAdminAuditLogsQueryDto extends AdminPaginationQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  adminUserId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  action?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(AdminAuditTargetType, { message: "审计目标类型不正确" })
  targetType?: AdminAuditTargetType;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  targetId?: string;
}
