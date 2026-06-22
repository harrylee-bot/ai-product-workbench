import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class LoginDto {
  @IsOptional()
  @IsString({ message: "email 格式不正确" })
  email?: string;

  @IsOptional()
  @IsString({ message: "account 格式不正确" })
  account?: string;

  @IsString({ message: "password 不能为空" })
  @IsNotEmpty({ message: "password 不能为空" })
  password!: string;
}
