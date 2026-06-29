import { IsOptional, IsString } from "class-validator";

export class ListMessagesQueryDto {
  @IsOptional()
  @IsString()
  conversationId?: string;
}
