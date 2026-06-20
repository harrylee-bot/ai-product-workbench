import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateInteractionDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsIn(["patch", "comment", "selection", "feedback"], { message: "交互类型不正确" })
  type!: "patch" | "comment" | "selection" | "feedback";

  @IsIn(["prd", "prototype", "state"], { message: "反馈对象类型不正确" })
  targetType!: "prd" | "prototype" | "state";

  @IsOptional()
  @IsString({ message: "targetId 格式不正确" })
  @MaxLength(200, { message: "targetId 不能超过 200 个字符" })
  targetId?: string;

  @IsOptional()
  @IsString({ message: "反馈内容格式不正确" })
  @MaxLength(4000, { message: "反馈内容不能超过 4000 个字符" })
  content?: string;

  @IsOptional()
  @IsObject({ message: "metadata 格式不正确" })
  metadata?: Record<string, unknown>;
}

export class AnalyzeFeedbackDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsOptional()
  @IsArray({ message: "eventIds 格式不正确" })
  @ArrayMaxSize(100, { message: "单次最多分析 100 条反馈" })
  @IsString({ each: true, message: "eventIds 格式不正确" })
  eventIds?: string[];
}

export class RunProjectWorkflowDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;
}

export class ApplyEvolutionPlanDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "evolutionPlanId 不能为空" })
  @IsNotEmpty({ message: "evolutionPlanId 不能为空" })
  evolutionPlanId!: string;

  @IsOptional()
  @IsString({ message: "conversationId 格式不正确" })
  conversationId?: string;
}

export class RollbackPatchDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @Type(() => Number)
  @IsInt({ message: "targetVersion 必须是整数" })
  @Min(1, { message: "targetVersion 不能小于 1" })
  targetVersion!: number;

  @IsOptional()
  @IsString({ message: "reason 格式不正确" })
  @MaxLength(1000, { message: "reason 不能超过 1000 个字符" })
  reason?: string;
}
