import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { ProjectStatus } from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class CreateProjectDto {
  @IsString({ message: "项目名称不能为空" })
  @IsNotEmpty({ message: "项目名称不能为空" })
  @MaxLength(80, { message: "项目名称不能超过 80 个字符" })
  title!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "项目描述格式不正确" })
  @MaxLength(500, { message: "项目描述不能超过 500 个字符" })
  description?: string;
}

export class ListProjectsQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  keyword?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ProjectStatus, { message: "项目状态不正确" })
  status?: ProjectStatus;

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

export class UpdateProjectDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "项目名称不能为空" })
  @IsNotEmpty({ message: "项目名称不能为空" })
  @MaxLength(80, { message: "项目名称不能超过 80 个字符" })
  title?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "项目描述格式不正确" })
  @MaxLength(500, { message: "项目描述不能超过 500 个字符" })
  description?: string;
}

export class CreateConversationDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "会话标题不能为空" })
  @IsNotEmpty({ message: "会话标题不能为空" })
  @MaxLength(80, { message: "会话标题不能超过 80 个字符" })
  title?: string;
}

export class UpdateConversationDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "会话标题不能为空" })
  @IsNotEmpty({ message: "会话标题不能为空" })
  @MaxLength(80, { message: "会话标题不能超过 80 个字符" })
  title?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "会话摘要格式不正确" })
  @MaxLength(2000, { message: "会话摘要不能超过 2000 个字符" })
  summary?: string;
}

export class ListMessagesQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
