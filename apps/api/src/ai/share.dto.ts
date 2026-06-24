import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from "class-validator";

export class CreateShareLinkDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsOptional()
  @IsIn(["prd", "prototype", "both"], { message: "scope 不正确" })
  scope?: "prd" | "prototype" | "both";

  @IsOptional()
  @IsInt({ message: "expiresInDays 必须为整数" })
  @Min(1, { message: "有效期至少 1 天" })
  @Max(365, { message: "有效期最多 365 天" })
  expiresInDays?: number;
}
