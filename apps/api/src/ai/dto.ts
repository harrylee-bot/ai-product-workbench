import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class HandleVibeMessageDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;

  @IsString({ message: "消息不能为空" })
  @IsNotEmpty({ message: "消息不能为空" })
  message!: string;

  @IsOptional()
  selectedRegion?: unknown;

  @IsOptional()
  @IsIn(["prd", "prototype"], { message: "previewMode 不正确" })
  previewMode?: "prd" | "prototype";

  @IsOptional()
  @IsArray({ message: "fileIds 格式不正确" })
  @ArrayMaxSize(10, { message: "单条消息最多携带 10 个附件" })
  @IsString({ each: true, message: "fileIds 格式不正确" })
  fileIds?: string[];
}

export class ConfirmPrdDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;
}

export class CancelVibeRunDto {
  @IsOptional()
  @IsString({ message: "停止原因格式不正确" })
  reason?: string;
}
