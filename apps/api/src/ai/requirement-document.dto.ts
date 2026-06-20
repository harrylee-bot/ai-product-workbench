import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class GeneratePrdDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "productDesignStateId 格式不正确" })
  productDesignStateId?: string;

  @IsOptional()
  @IsIn(["draft", "formal"], { message: "mode 不正确" })
  mode?: "draft" | "formal";
}

export class ConfirmPrdDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "确认说明格式不正确" })
  @MaxLength(500, { message: "确认说明不能超过 500 个字符" })
  reason?: string;
}
