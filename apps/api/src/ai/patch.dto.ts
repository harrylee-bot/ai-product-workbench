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
