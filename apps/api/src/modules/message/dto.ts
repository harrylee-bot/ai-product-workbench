import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateMessageDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;

  @IsString({ message: "content 不能为空" })
  @IsNotEmpty({ message: "content 不能为空" })
  @MaxLength(4000, { message: "content 不能超过 4000 个字符" })
  content!: string;
}

export class ListMessagesQueryDto {
  @IsOptional()
  @IsString()
  conversationId?: string;
}
