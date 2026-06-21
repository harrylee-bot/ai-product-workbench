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
  Max,
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

export class CreateContractEventDto {
  @IsIn([
    "agent_started",
    "agent_completed",
    "state_updated",
    "state_version_created",
    "prd_generated",
    "prototype_generated",
    "patch_applied",
    "qa_completed",
  ], { message: "事件类型不符合 event-schema" })
  eventType!:
    | "agent_started"
    | "agent_completed"
    | "state_updated"
    | "state_version_created"
    | "prd_generated"
    | "prototype_generated"
    | "patch_applied"
    | "qa_completed";

  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsOptional()
  @IsString({ message: "targetId 格式不正确" })
  @MaxLength(200, { message: "targetId 不能超过 200 个字符" })
  targetId?: string;

  @IsOptional()
  @IsObject({ message: "payload 格式不正确" })
  payload?: Record<string, unknown>;
}

export class AiSuggestDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsObject({ message: "selectedRegion 格式不正确" })
  selectedRegion!: Record<string, unknown>;

  @IsString({ message: "修改目标不能为空" })
  @IsNotEmpty({ message: "修改目标不能为空" })
  @MaxLength(4000, { message: "修改目标不能超过 4000 个字符" })
  instruction!: string;

  @IsOptional()
  @IsIn(["component_edit", "layout_edit", "flow_update", "redesign"], { message: "action 不正确" })
  action?: "component_edit" | "layout_edit" | "flow_update" | "redesign";
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

export class SaveProductMemoryDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsOptional()
  @IsString({ message: "evolutionPlanId 格式不正确" })
  evolutionPlanId?: string;

  @IsOptional()
  @IsString({ message: "patchExecutionId 格式不正确" })
  patchExecutionId?: string;

  @IsOptional()
  @IsString({ message: "patchRecordId 格式不正确" })
  patchRecordId?: string;
}

export class RunEvolutionCycleDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsOptional()
  @IsIn(["event", "batch", "manual", "patch"], { message: "triggerType 不正确" })
  triggerType?: "event" | "batch" | "manual" | "patch";

  @IsOptional()
  @IsArray({ message: "eventIds 格式不正确" })
  @ArrayMaxSize(100, { message: "单次最多调度 100 条反馈事件" })
  @IsString({ each: true, message: "eventIds 格式不正确" })
  eventIds?: string[];

  @IsOptional()
  @IsString({ message: "conversationId 格式不正确" })
  conversationId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "maxCycles 必须是整数" })
  @Min(1, { message: "maxCycles 不能小于 1" })
  @Max(5, { message: "maxCycles 不能超过 5" })
  maxCycles?: number;
}
