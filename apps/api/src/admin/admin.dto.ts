import { Transform, Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  AdminAuditTargetType,
  RuntimeStepName,
  RuntimeRunStatus,
  FileAssetStatus,
  FileParserType,
  ModelCallStatus,
  ModelTaskType,
  ProjectStatus,
  QAReportStatus,
  QAReportTrigger,
} from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const toOptionalBoolean = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  return Boolean(value);
};

class AdminPaginationQueryDto {
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

export class ListRuntimeRunsQueryDto extends AdminPaginationQueryDto {
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
  @IsString()
  conversationId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(RuntimeRunStatus, { message: "运行状态不正确" })
  status?: RuntimeRunStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(RuntimeStepName, { message: "Runtime 名称不正确" })
  runtimeName?: RuntimeStepName;

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
  runtimeName?: string;

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

export class BackfillPrototypeConversionsDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  projectId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  run?: boolean;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @Transform(toOptionalBoolean)
  @IsBoolean()
  background?: boolean;
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
