import { Transform, Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { FileAssetStatus } from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class UploadFilesDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "conversationId 格式不正确" })
  conversationId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "messageId 格式不正确" })
  messageId?: string;
}

export class ListProjectFilesQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(FileAssetStatus, { message: "文件状态不正确" })
  status?: FileAssetStatus;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  fileType?: string;

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
