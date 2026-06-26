import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  ModelCallStatus,
  ModelProviderType,
  ModelResponseFormat,
  ModelTaskType,
} from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class CreateModelProviderDto {
  @IsString({ message: "供应商名称不能为空" })
  @IsNotEmpty({ message: "供应商名称不能为空" })
  @MaxLength(80, { message: "供应商名称不能超过 80 个字符" })
  name!: string;

  @IsOptional()
  @IsEnum(ModelProviderType, { message: "供应商类型不正确" })
  type?: ModelProviderType;

  @IsString({ message: "接口地址不能为空" })
  @IsNotEmpty({ message: "接口地址不能为空" })
  @MaxLength(500, { message: "接口地址不能超过 500 个字符" })
  baseUrl!: string;

  @IsString({ message: "API Key 不能为空" })
  @IsNotEmpty({ message: "API Key 不能为空" })
  apiKey!: string;

  @IsOptional()
  @IsObject({ message: "默认请求头格式不正确" })
  defaultHeaders?: Record<string, string>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(300000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateModelProviderDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "供应商名称不能为空" })
  @IsNotEmpty({ message: "供应商名称不能为空" })
  @MaxLength(80, { message: "供应商名称不能超过 80 个字符" })
  name?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "接口地址不能为空" })
  @IsNotEmpty({ message: "接口地址不能为空" })
  @MaxLength(500, { message: "接口地址不能超过 500 个字符" })
  baseUrl?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "API Key 不能为空" })
  @IsNotEmpty({ message: "API Key 不能为空" })
  apiKey?: string;

  @IsOptional()
  @IsObject({ message: "默认请求头格式不正确" })
  defaultHeaders?: Record<string, string>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(300000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class CreateModelConfigDto {
  @IsString({ message: "供应商 ID 不能为空" })
  @IsNotEmpty({ message: "供应商 ID 不能为空" })
  providerId!: string;

  @IsString({ message: "模型显示名称不能为空" })
  @IsNotEmpty({ message: "模型显示名称不能为空" })
  @MaxLength(80, { message: "模型显示名称不能超过 80 个字符" })
  displayName!: string;

  @IsString({ message: "模型名称不能为空" })
  @IsNotEmpty({ message: "模型名称不能为空" })
  @MaxLength(120, { message: "模型名称不能超过 120 个字符" })
  modelName!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contextWindow?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  @IsOptional()
  @IsBoolean()
  supportsStreaming?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsJsonMode?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsMultimodal?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  defaultTemperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultMaxTokens?: number;
}

export class UpdateModelConfigDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "供应商 ID 不能为空" })
  @IsNotEmpty({ message: "供应商 ID 不能为空" })
  providerId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "模型显示名称不能为空" })
  @IsNotEmpty({ message: "模型显示名称不能为空" })
  @MaxLength(80, { message: "模型显示名称不能超过 80 个字符" })
  displayName?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "模型名称不能为空" })
  @IsNotEmpty({ message: "模型名称不能为空" })
  @MaxLength(120, { message: "模型名称不能超过 120 个字符" })
  modelName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  contextWindow?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  @IsOptional()
  @IsBoolean()
  supportsStreaming?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsJsonMode?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsMultimodal?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  defaultTemperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultMaxTokens?: number;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class UpsertModelTaskProfileDto {
  @IsString({ message: "模型配置 ID 不能为空" })
  @IsNotEmpty({ message: "模型配置 ID 不能为空" })
  modelConfigId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxTokens?: number;

  @IsOptional()
  @IsEnum(ModelResponseFormat, { message: "响应格式不正确" })
  responseFormat?: ModelResponseFormat;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  retryCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(300000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class ListModelCallLogsQueryDto {
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
