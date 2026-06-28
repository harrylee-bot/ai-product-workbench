import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class CreateProductDto {
  @IsString({ message: "产品名称不能为空" })
  @IsNotEmpty({ message: "产品名称不能为空" })
  @MaxLength(120, { message: "产品名称不能超过 120 个字符" })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: "产品描述不能超过 500 个字符" })
  description?: string;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString({ message: "产品名称不能为空" })
  @IsNotEmpty({ message: "产品名称不能为空" })
  @MaxLength(120, { message: "产品名称不能超过 120 个字符" })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: "产品描述不能超过 500 个字符" })
  description?: string | null;
}

export class ListProductsQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
