import { BadRequestException } from "@nestjs/common";

export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertConversationId(value: string): string {
  if (!CONVERSATION_ID_PATTERN.test(value)) {
    throw new BadRequestException("conversationId 只能包含字母、数字、下划线和连字符，且长度不能超过 128 个字符");
  }
  return value;
}
