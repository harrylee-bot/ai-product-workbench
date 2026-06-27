import { Transform } from "class-transformer";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class ConfirmPrdDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "确认说明格式不正确" })
  @MaxLength(500, { message: "确认说明不能超过 500 个字符" })
  reason?: string;
}

export class UpdatePrdSectionDto {
  @IsString({ message: "段落内容不能为空" })
  @IsNotEmpty({ message: "段落内容不能为空" })
  @MaxLength(20000, { message: "段落内容不能超过 20000 个字符" })
  content!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "段落标题格式不正确" })
  @MaxLength(200, { message: "段落标题不能超过 200 个字符" })
  title?: string;
}
