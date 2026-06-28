import { Transform, Type } from "class-transformer";
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  KnowledgeCandidateStatus,
  KnowledgePriority,
  KnowledgeScope,
  KnowledgeStatus,
  KnowledgeType,
} from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const toStringArray = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return value;
};

export class CreateKnowledgeItemDto {
  @IsString({ message: "知识标题不能为空" })
  @IsNotEmpty({ message: "知识标题不能为空" })
  @MaxLength(120, { message: "知识标题不能超过 120 个字符" })
  title!: string;

  @IsString({ message: "知识内容不能为空" })
  @IsNotEmpty({ message: "知识内容不能为空" })
  content!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsEnum(KnowledgeType, { message: "知识类型不正确" })
  type!: KnowledgeType;

  @IsOptional()
  @IsEnum(KnowledgeStatus, { message: "知识状态不正确" })
  status?: KnowledgeStatus;

  @IsOptional()
  @IsEnum(KnowledgeScope, { message: "知识范围不正确" })
  scope?: KnowledgeScope;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  sourceProductId?: string;

  @IsOptional()
  @IsEnum(KnowledgePriority, { message: "知识优先级不正确" })
  priority?: KnowledgePriority;
}

export class UpdateKnowledgeItemDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "知识标题不能为空" })
  @IsNotEmpty({ message: "知识标题不能为空" })
  @MaxLength(120, { message: "知识标题不能超过 120 个字符" })
  title?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "知识内容不能为空" })
  @IsNotEmpty({ message: "知识内容不能为空" })
  content?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsEnum(KnowledgeType, { message: "知识类型不正确" })
  type?: KnowledgeType;

  @IsOptional()
  @IsEnum(KnowledgeStatus, { message: "知识状态不正确" })
  status?: KnowledgeStatus;

  @IsOptional()
  @IsEnum(KnowledgeScope, { message: "知识范围不正确" })
  scope?: KnowledgeScope;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  sourceProductId?: string;

  @IsOptional()
  @IsEnum(KnowledgePriority, { message: "知识优先级不正确" })
  priority?: KnowledgePriority;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  changeSummary?: string;
}

export class ListKnowledgeItemsQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  keyword?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(KnowledgeType, { message: "知识类型不正确" })
  type?: KnowledgeType;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(KnowledgeStatus, { message: "知识状态不正确" })
  status?: KnowledgeStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  tag?: string;

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

export class CreateKnowledgeCategoryDto {
  @IsString({ message: "分类名称不能为空" })
  @IsNotEmpty({ message: "分类名称不能为空" })
  @MaxLength(60, { message: "分类名称不能超过 60 个字符" })
  name!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  parentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  order?: number;
}

export class ListKnowledgeCandidatesQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  projectId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(KnowledgeCandidateStatus, { message: "候选状态不正确" })
  status?: KnowledgeCandidateStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(KnowledgeType, { message: "知识类型不正确" })
  suggestedType?: KnowledgeType;

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

export class ApproveKnowledgeCandidateDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  content?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsEnum(KnowledgeType, { message: "知识类型不正确" })
  type?: KnowledgeType;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  categoryId?: string;

  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(KnowledgePriority, { message: "知识优先级不正确" })
  priority?: KnowledgePriority;
}

export class RejectKnowledgeCandidateDto {
  @IsString({ message: "拒绝原因不能为空" })
  @IsNotEmpty({ message: "拒绝原因不能为空" })
  @MaxLength(500, { message: "拒绝原因不能超过 500 个字符" })
  reviewComment!: string;
}

export class MergeKnowledgeCandidateDto {
  @IsString({ message: "目标知识 ID 不能为空" })
  @IsNotEmpty({ message: "目标知识 ID 不能为空" })
  targetKnowledgeItemId!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  mergedContent?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  @MaxLength(500)
  reviewComment?: string;
}
