import { IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

class PatchOperationDto {
  @IsIn(["add", "update", "delete", "replace"], { message: "op 必须是 add/update/delete/replace" })
  op!: "add" | "update" | "delete" | "replace";

  @IsString({ message: "path 不能为空" })
  @IsNotEmpty({ message: "path 不能为空" })
  path!: string;

  @IsOptional()
  value?: unknown;
}

class PatchDraftDto {
  @IsString({ message: "id 不能为空" })
  @IsNotEmpty({ message: "id 不能为空" })
  id!: string;

  @IsString({ message: "strategyId 不能为空" })
  @IsNotEmpty({ message: "strategyId 不能为空" })
  strategyId!: string;

  @IsArray({ message: "operations 必须是数组" })
  @ValidateNested({ each: true })
  @Type(() => PatchOperationDto)
  operations!: PatchOperationDto[];

  @IsArray({ message: "targetDomains 必须是数组" })
  @IsIn(["prd", "prototype", "state"], { each: true, message: "targetDomains 只能包含 prd/prototype/state" })
  targetDomains!: Array<"prd" | "prototype" | "state">;
}

export class PatchPreviewRequestDto extends PatchDraftDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PatchDraftDto)
  draft?: PatchDraftDto;
}
