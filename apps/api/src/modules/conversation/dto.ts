import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { CONVERSATION_ID_PATTERN } from "./conversation-id";

export class CreateConversationDto {
  @IsOptional()
  @IsString({ message: "conversationId 格式不正确" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  @MaxLength(128, { message: "conversationId 不能超过 128 个字符" })
  @Matches(CONVERSATION_ID_PATTERN, { message: "conversationId 只能包含字母、数字、下划线和连字符" })
  conversationId?: string;

  @IsOptional()
  @IsString({ message: "title 格式不正确" })
  @MaxLength(120, { message: "title 不能超过 120 个字符" })
  title?: string;
}
