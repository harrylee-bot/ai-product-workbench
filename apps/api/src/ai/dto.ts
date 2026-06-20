import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";

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
}
