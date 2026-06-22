import { Transform, Type } from "class-transformer";
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

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class CreatePatchDto {
  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;

  @IsObject({ message: "selectedRegion 格式不正确" })
  selectedRegion!: Record<string, unknown>;

  @IsString({ message: "修改指令不能为空" })
  @IsNotEmpty({ message: "修改指令不能为空" })
  @MaxLength(4000, { message: "修改指令不能超过 4000 个字符" })
  userInstruction!: string;

  @IsOptional()
  @IsArray({ message: "attachmentFileIds 格式不正确" })
  @ArrayMaxSize(10, { message: "单次最多携带 10 个附件" })
  @IsString({ each: true, message: "attachmentFileIds 格式不正确" })
  attachmentFileIds?: string[];
}

export class CreatePatchDraftDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;

  @IsObject({ message: "selectedRegion 格式不正确" })
  selectedRegion!: Record<string, unknown>;

  @IsOptional()
  @IsString({ message: "userInstruction 格式不正确" })
  @MaxLength(4000, { message: "userInstruction 不能超过 4000 个字符" })
  userInstruction?: string;

  @IsOptional()
  @IsIn([
    "prd_edit",
    "prd_rewrite",
    "prd_diff",
    "prototype_edit",
    "prototype_restructure",
    "prototype_flow_update",
    "inline_edit",
  ], { message: "source 不正确" })
  source?: "prd_edit" | "prd_rewrite" | "prd_diff" | "prototype_edit" | "prototype_restructure" | "prototype_flow_update" | "inline_edit";

  @IsOptional()
  @IsObject({ message: "interactionEvent 格式不正确" })
  interactionEvent?: Record<string, unknown>;

  @IsOptional()
  @IsString({ message: "instruction 格式不正确" })
  @MaxLength(4000, { message: "instruction 不能超过 4000 个字符" })
  instruction?: string;

  @IsOptional()
  @IsString({ message: "action 格式不正确" })
  @MaxLength(80, { message: "action 不能超过 80 个字符" })
  action?: string;

  @IsOptional()
  @IsString({ message: "selectedText 格式不正确" })
  @MaxLength(8000, { message: "selectedText 不能超过 8000 个字符" })
  selectedText?: string;

  @IsOptional()
  @IsString({ message: "replacementText 格式不正确" })
  @MaxLength(8000, { message: "replacementText 不能超过 8000 个字符" })
  replacementText?: string;

  @IsOptional()
  @IsString({ message: "diffBaseText 格式不正确" })
  @MaxLength(8000, { message: "diffBaseText 不能超过 8000 个字符" })
  diffBaseText?: string;

  @IsOptional()
  @IsString({ message: "diffTargetText 格式不正确" })
  @MaxLength(8000, { message: "diffTargetText 不能超过 8000 个字符" })
  diffTargetText?: string;

  @IsOptional()
  @IsArray({ message: "attachmentFileIds 格式不正确" })
  @ArrayMaxSize(10, { message: "单次最多携带 10 个附件" })
  @IsString({ each: true, message: "attachmentFileIds 格式不正确" })
  attachmentFileIds?: string[];
}

export class ListPatchRecordsQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(["planned", "applying", "applied", "failed", "cancelled", "needs_confirmation"], {
    message: "Patch 状态不正确",
  })
  status?: "planned" | "applying" | "applied" | "failed" | "cancelled" | "needs_confirmation";

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "page 必须是整数" })
  @Min(1, { message: "page 不能小于 1" })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "pageSize 必须是整数" })
  @Min(1, { message: "pageSize 不能小于 1" })
  pageSize?: number;
}

export class ConfirmPatchDto {
  @IsString({ message: "确认说明不能为空" })
  @IsNotEmpty({ message: "确认说明不能为空" })
  @MaxLength(1000, { message: "确认说明不能超过 1000 个字符" })
  userConfirmation!: string;
}

export class ApplyPatchDto extends ConfirmPatchDto {
  @IsString({ message: "patchId 不能为空" })
  @IsNotEmpty({ message: "patchId 不能为空" })
  patchId!: string;
}

export class PreviewPatchDto {
  @IsString({ message: "patchId 不能为空" })
  @IsNotEmpty({ message: "patchId 不能为空" })
  patchId!: string;
}
