import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateConversationDto {
  @IsOptional()
  @IsString({ message: "conversationId 格式不正确" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId?: string;

  @IsOptional()
  @IsString({ message: "title 格式不正确" })
  @MaxLength(120, { message: "title 不能超过 120 个字符" })
  title?: string;
}
