import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class CreateProductDesignStateDto {
  @IsString({ message: "标题不能为空" })
  @IsNotEmpty({ message: "标题不能为空" })
  @MaxLength(100, { message: "标题不能超过 100 个字符" })
  title!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "业务目标格式不正确" })
  @MaxLength(1000, { message: "业务目标不能超过 1000 个字符" })
  businessGoal?: string;

  @IsOptional()
  initialState?: unknown;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "变更原因格式不正确" })
  @MaxLength(500, { message: "变更原因不能超过 500 个字符" })
  reason?: string;
}

export class UpdateProductDesignStateDto {
  @IsOptional()
  patch?: unknown;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "变更原因格式不正确" })
  @MaxLength(500, { message: "变更原因不能超过 500 个字符" })
  reason?: string;

  @IsOptional()
  @IsBoolean({ message: "createVersion 格式不正确" })
  createVersion?: boolean;
}

export class StatePatchOperationDto {
  @IsIn(["add", "replace", "remove", "append", "update", "delete"], {
    message: "PatchOperation.op 不正确",
  })
  op!: "add" | "replace" | "remove" | "append" | "update" | "delete";

  @IsString({ message: "PatchOperation.path 不能为空" })
  @IsNotEmpty({ message: "PatchOperation.path 不能为空" })
  path!: string;

  @IsOptional()
  value?: unknown;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "PatchOperation.reason 格式不正确" })
  @MaxLength(500, { message: "PatchOperation.reason 不能超过 500 个字符" })
  reason?: string;
}

export class ApplyStatePatchDto {
  @IsArray({ message: "operations 格式不正确" })
  @ArrayMaxSize(50, { message: "单次最多应用 50 个 PatchOperation" })
  @ValidateNested({ each: true })
  operations!: StatePatchOperationDto[];

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "变更原因格式不正确" })
  @MaxLength(500, { message: "变更原因不能超过 500 个字符" })
  reason?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "runId 格式不正确" })
  runId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "messageId 格式不正确" })
  messageId?: string;

  @IsOptional()
  @IsBoolean({ message: "createVersion 格式不正确" })
  createVersion?: boolean;
}

export class CreateProductDesignVersionDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "版本原因格式不正确" })
  @MaxLength(500, { message: "版本原因不能超过 500 个字符" })
  reason?: string;
}

export class RollbackProductDesignStateDto {
  @IsString({ message: "versionId 不能为空" })
  @IsNotEmpty({ message: "versionId 不能为空" })
  versionId!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "回滚原因格式不正确" })
  @MaxLength(500, { message: "回滚原因不能超过 500 个字符" })
  reason?: string;
}

export class AnswerClarificationQuestionDto {
  @IsString({ message: "回答不能为空" })
  @IsNotEmpty({ message: "回答不能为空" })
  @MaxLength(2000, { message: "回答不能超过 2000 个字符" })
  answer!: string;
}
