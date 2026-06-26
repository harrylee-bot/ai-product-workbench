import { Transform } from "class-transformer";
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class GeneratePrototypeDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "productDesignStateId 格式不正确" })
  productDesignStateId?: string;

  @IsOptional()
  @IsIn(["desktop", "mobile", "both"], { message: "targetDevice 不正确" })
  targetDevice?: "desktop" | "mobile" | "both";
}

export class GetPrototypeStateDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

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
