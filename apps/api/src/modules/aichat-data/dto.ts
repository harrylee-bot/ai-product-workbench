import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Prisma } from "@prisma/client";

/**
 * ai-chatbot 数据持久化所需 DTO。
 *
 * 适配约定：
 * - ai-chatbot 的 UIMessage.parts（json 数组）序列化进 Message.metadata.parts。
 * - ai-chatbot 的 UIMessage.attachments（json 数组）存入 Message.attachments。
 * - role 沿用 MessageRole（user | assistant | system）。
 */

export class RenameConversationDto {
  @IsString({ message: "title 格式不正确" })
  @IsNotEmpty({ message: "title 不能为空" })
  @MaxLength(120, { message: "title 不能超过 120 个字符" })
  title!: string;
}

export class BulkMessageItemDto {
  @IsString({ message: "role 格式不正确" })
  @IsNotEmpty({ message: "role 不能为空" })
  role!: "user" | "assistant" | "system";

  @IsArray({ message: "parts 必须是数组" })
  @ArrayMinSize(0)
  @ArrayMaxSize(200, { message: "单条消息 parts 不能超过 200 个" })
  parts!: unknown[];

  @IsOptional()
  @IsArray({ message: "attachments 必须是数组" })
  @ArrayMaxSize(50, { message: "attachments 不能超过 50 个" })
  attachments?: unknown[];

  @IsOptional()
  @IsDateString({}, { message: "createdAt 必须是合法 ISO 时间" })
  createdAt?: string;
}

export class BulkCreateMessagesDto {
  @IsArray({ message: "messages 必须是数组" })
  @ArrayMinSize(1, { message: "messages 不能为空" })
  @ArrayMaxSize(500, { message: "单次最多写入 500 条消息" })
  @ValidateNested({ each: true })
  @Type(() => BulkMessageItemDto)
  messages!: BulkMessageItemDto[];
}

export class UpdateMessagePartsDto {
  @IsArray({ message: "parts 必须是数组" })
  @ArrayMinSize(0)
  @ArrayMaxSize(200, { message: "单条消息 parts 不能超过 200 个" })
  parts!: unknown[];
}

export class MessageCountQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "hours 必须是整数" })
  @Min(1, { message: "hours 最小为 1" })
  @Max(720, { message: "hours 最大为 720" })
  hours?: number;
}

export class VoteDto {
  @IsString({ message: "type 格式不正确" })
  @IsNotEmpty({ message: "type 不能为空" })
  type!: "up" | "down";
}

export class SuggestionItemDto {
  @IsString({ message: "originalText 格式不正确" })
  @IsNotEmpty({ message: "originalText 不能为空" })
  @MaxLength(8000, { message: "originalText 过长" })
  originalText!: string;

  @IsString({ message: "suggestedText 格式不正确" })
  @IsNotEmpty({ message: "suggestedText 不能为空" })
  @MaxLength(8000, { message: "suggestedText 过长" })
  suggestedText!: string;

  @IsOptional()
  @IsString({ message: "description 格式不正确" })
  @MaxLength(2000, { message: "description 过长" })
  description?: string;
}

export class CreateSuggestionsDto {
  @IsArray({ message: "suggestions 必须是数组" })
  @ArrayMinSize(1, { message: "suggestions 不能为空" })
  @ArrayMaxSize(100, { message: "单次最多 100 条建议" })
  @ValidateNested({ each: true })
  @Type(() => SuggestionItemDto)
  suggestions!: SuggestionItemDto[];
}

export class RegisterStreamDto {
  @IsString({ message: "streamId 格式不正确" })
  @IsNotEmpty({ message: "streamId 不能为空" })
  @MaxLength(200, { message: "streamId 过长" })
  streamId!: string;
}

export class DeleteMessagesAfterQueryDto {
  @IsDateString({}, { message: "after 必须是合法 ISO 时间" })
  after!: string;
}

/** 把 ai-chatbot parts + attachments 组装成 Prisma 可写的 metadata/attachments。 */
export function buildMessagePayload(
  item: BulkMessageItemDto,
  conversationId: string,
  projectId: string,
  userId: string,
): {
  role: "user" | "assistant" | "system";
  content: string;
  attachments: Prisma.MessageCreateInput["attachments"];
  metadata: Prisma.InputJsonValue;
  createdAt: Date | undefined;
} {
  // metadata.parts 存原始 parts 数组；content 从 parts 里抽取纯文本兜底展示。
  const text = extractTextFromParts(item.parts);
  const content = text.length > 0 ? text : "(empty)";

  const attachments: Prisma.MessageCreateInput["attachments"] =
    item.attachments && item.attachments.length > 0
      ? (item.attachments as Prisma.InputJsonValue)
      : Prisma.JsonNull;

  const metadata = { parts: item.parts } as Prisma.InputJsonObject;

  return {
    role: item.role,
    content,
    attachments,
    metadata,
    createdAt: item.createdAt ? new Date(item.createdAt) : undefined,
  };
}

/** 从 ai-chatbot parts 里拼接可读文本，用于落库 Message.content（列表/搜索兜底展示）。 */
function extractTextFromParts(parts: unknown[]): string {
  if (!Array.isArray(parts)) return "";
  const segments: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = record.type;
    if (type === "text" && typeof record.text === "string") {
      segments.push(record.text);
    } else if (type === "reasoning" && typeof record.text === "string") {
      // reasoning 不计入主展示文本
      continue;
    }
  }
  return segments.join("\n").slice(0, 10_000);
}
