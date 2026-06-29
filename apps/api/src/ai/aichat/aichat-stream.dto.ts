import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";

/**
 * ai-chatbot 前端发来的 chat message part（最小子集）。
 * vercel/ai-chatbot 的 UIMessage.parts 里我们只消费 text。
 */
export class ChatStreamPartDto {
  @IsString()
  @IsNotEmpty({ message: "part.type 不能为空" })
  type!: string;

  @IsOptional()
  @IsString()
  text?: string;
}

/**
 * ai-chatbot 当前消息（message 字段）。
 */
export class ChatStreamMessageDto {
  @IsString()
  @IsNotEmpty({ message: "message.role 不能为空" })
  role!: string;

  @IsArray()
  @ArrayMaxSize(64, { message: "parts 数量过多" })
  @ValidateNested({ each: true })
  @Type(() => ChatStreamPartDto)
  parts!: ChatStreamPartDto[];
}

/**
 * POST /api/chat/stream 的请求体。
 *
 * - id: 会话 id（必填，对应 conversationId）
 * - message: 当前轮用户消息（含 parts）
 * - messages: 历史消息数组（可选，后端从 DB 取，前端传了也忽略以防篡改）
 * - selectedChatModel / selectedVisibilityType: ai-chatbot 原生字段，透传忽略
 */
export class ChatStreamDto {
  @IsString()
  @IsNotEmpty({ message: "id（会话 id）不能为空" })
  id!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ChatStreamMessageDto)
  message?: ChatStreamMessageDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200, { message: "messages 数量过多" })
  messages?: unknown[];

  @IsOptional()
  @IsString()
  selectedChatModel?: string;

  @IsOptional()
  @IsString()
  selectedVisibilityType?: string;
}
