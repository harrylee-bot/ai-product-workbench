import { Transform } from "class-transformer";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class GetPrototypeStateDto {
  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "artifactId 格式不正确" })
  artifactId?: string;
}

export class ConfirmPrototypeDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "确认说明格式不正确" })
  @MaxLength(500, { message: "确认说明不能超过 500 个字符" })
  reason?: string;
}
