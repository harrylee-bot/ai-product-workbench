import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateProjectDto {
  @IsString({ message: "title 不能为空" })
  @IsNotEmpty({ message: "title 不能为空" })
  @MaxLength(120, { message: "title 不能超过 120 个字符" })
  title!: string;

  @IsOptional()
  @IsString()
  productId?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString({ message: "title 不能为空" })
  @MaxLength(120, { message: "title 不能超过 120 个字符" })
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: "description 不能超过 500 个字符" })
  description?: string;

  @IsOptional()
  @IsString()
  productId?: string | null;
}

export class ListProjectsQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;
}
