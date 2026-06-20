import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { UserRole, UserStatus } from "@prisma/client";

export class LoginDto {
  @IsOptional()
  @IsString({ message: "请输入账号和密码" })
  account?: string;

  @IsOptional()
  @IsString({ message: "请输入账号和密码" })
  password?: string;
}

export class CreateUserDto {
  @IsString({ message: "用户名不能为空" })
  @IsNotEmpty({ message: "用户名不能为空" })
  username!: string;

  @IsString({ message: "显示名称不能为空" })
  @IsNotEmpty({ message: "显示名称不能为空" })
  displayName!: string;

  @IsOptional()
  @IsEmail({}, { message: "邮箱格式不正确" })
  email?: string;

  @IsString({ message: "密码不能为空" })
  @IsNotEmpty({ message: "密码不能为空" })
  password!: string;

  @IsEnum(UserRole, { message: "角色不正确" })
  role!: UserRole;

  @IsOptional()
  @IsEnum(UserStatus, { message: "状态不正确" })
  status?: UserStatus;
}

export class UpdateUserDto {
  @IsOptional()
  @IsEmail({}, { message: "邮箱格式不正确" })
  email?: string | null;

  @IsOptional()
  @IsString({ message: "显示名称不能为空" })
  @IsNotEmpty({ message: "显示名称不能为空" })
  displayName?: string;

  @IsOptional()
  @IsEnum(UserRole, { message: "角色不正确" })
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus, { message: "状态不正确" })
  status?: UserStatus;
}

export class ResetPasswordDto {
  @IsString({ message: "密码不能为空" })
  @IsNotEmpty({ message: "密码不能为空" })
  password!: string;
}
