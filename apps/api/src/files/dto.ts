import { Transform, Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { FileAssetStatus } from "@prisma/client";
import { CONVERSATION_ID_PATTERN } from "../modules/conversation/conversation-id";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class UploadFilesDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "conversationId 格式不正确" })
  @MaxLength(128, { message: "conversationId 不能超过 128 个字符" })
  @Matches(CONVERSATION_ID_PATTERN, { message: "conversationId 只能包含字母、数字、下划线和连字符" })
  conversationId?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "messageId 格式不正确" })
  messageId?: string;
}

export class ListConversationFilesQueryDto {
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
