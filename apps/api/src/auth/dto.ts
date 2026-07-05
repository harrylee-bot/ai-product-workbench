import { IsNotEmpty, IsOptional, IsString, MinLength } from "class-validator";

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

export class RegisterDto {
  @IsOptional()
  @IsString({ message: "email 格式不正确" })
  email?: string;

  @IsString({ message: "username 不能为空" })
  @IsNotEmpty({ message: "username 不能为空" })
  username!: string;

  @IsString({ message: "password 不能为空" })
  @IsNotEmpty({ message: "password 不能为空" })
  @MinLength(8, { message: "password 至少 8 位" })
  password!: string;

  @IsOptional()
  @IsString({ message: "displayName 格式不正确" })
  displayName?: string;
}
