import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { QAReportStatus, QAReportTrigger } from "@prisma/client";
import type { QACheckType } from "./ai-vibe.types";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const QA_CHECK_TYPES = [
  "state_schema",
  "prd_completeness",
  "prototype_completeness",
  "state_prd_consistency",
  "state_prototype_consistency",
  "prd_prototype_consistency",
  "knowledge_rule_compliance",
  "assumption_risk",
] as const;

export class RunQaDto {
  @IsOptional()
  @IsArray({ message: "checkTypes 格式不正确" })
  @ArrayMaxSize(9, { message: "checkTypes 最多 9 项" })
  @IsEnum(QA_CHECK_TYPES, { each: true, message: "checkType 不正确" })
  checkTypes?: QACheckType[];
}

export class ListQaReportsQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(QAReportStatus, { message: "QA 状态不正确" })
  status?: QAReportStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(QAReportTrigger, { message: "QA 触发类型不正确" })
  trigger?: QAReportTrigger;

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
