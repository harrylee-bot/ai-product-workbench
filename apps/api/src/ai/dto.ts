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

  /** FR-1.3：确认 PRD 后是否继续生成原型。默认 true（确认并继续）。false 表示仅确认 PRD，不生成原型。 */
  @IsOptional()
  wantsPrototype?: boolean;
}

export class CancelVibeRunDto {
  @IsOptional()
  @IsString({ message: "停止原因格式不正确" })
  reason?: string;
}
