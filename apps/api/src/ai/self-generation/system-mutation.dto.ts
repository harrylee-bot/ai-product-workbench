import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import type { SystemMutation } from "./mutation.engine";

export class ProposeSystemMutationDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "instruction 不能为空" })
  @IsNotEmpty({ message: "instruction 不能为空" })
  @MaxLength(1000, { message: "instruction 不能超过 1000 个字符" })
  instruction!: string;
}

export class PreviewSystemMutationDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsArray({ message: "mutations 必须是数组" })
  mutations!: SystemMutation[];
}

export class ApplySystemMutationDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "proposalId 不能为空" })
  @IsNotEmpty({ message: "proposalId 不能为空" })
  proposalId!: string;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
