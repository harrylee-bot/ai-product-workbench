import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class BuildConstraintDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "input 不能为空" })
  @IsNotEmpty({ message: "input 不能为空" })
  @MaxLength(2000, { message: "input 不能超过 2000 个字符" })
  input!: string;
}
