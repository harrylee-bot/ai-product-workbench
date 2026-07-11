import { Transform, Type } from "class-transformer";
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MinLength,
  Min,
} from "class-validator";
import { UserRole, UserStatus } from "@prisma/client";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? null : value;

export class ListUsersQueryDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  keyword?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(UserRole, { message: "角色不正确" })
  role?: UserRole;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(UserStatus, { message: "状态不正确" })
  status?: UserStatus;

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

export class CreateUserDto {
  @IsString({ message: "用户名不能为空" })
  @IsNotEmpty({ message: "用户名不能为空" })
  username!: string;

  @IsString({ message: "显示名称不能为空" })
  @IsNotEmpty({ message: "显示名称不能为空" })
  displayName!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEmail({}, { message: "邮箱格式不正确" })
  email?: string | null;

  @IsString({ message: "密码不能为空" })
  @IsNotEmpty({ message: "密码不能为空" })
  @MinLength(8, { message: "密码至少 8 位" })
  password!: string;

  @IsEnum(UserRole, { message: "角色不正确" })
  role!: UserRole;

  @IsOptional()
  @IsEnum(UserStatus, { message: "状态不正确" })
  status?: UserStatus;
}

export class UpdateUserDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEmail({}, { message: "邮箱格式不正确" })
  email?: string;

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
  @MinLength(8, { message: "密码至少 8 位" })
  password!: string;
}
