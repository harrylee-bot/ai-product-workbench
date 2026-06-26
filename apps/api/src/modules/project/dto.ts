import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateProjectDto {
  @IsString({ message: "title 不能为空" })
  @IsNotEmpty({ message: "title 不能为空" })
  @MaxLength(120, { message: "title 不能超过 120 个字符" })
  title!: string;
}

export class ListProjectsQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;
}
