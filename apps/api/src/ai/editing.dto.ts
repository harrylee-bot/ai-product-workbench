import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";

export class EditingPatchDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "conversationId 不能为空" })
  @IsNotEmpty({ message: "conversationId 不能为空" })
  conversationId!: string;

  @IsObject({ message: "selectedRegion 格式不正确" })
  selectedRegion!: Record<string, unknown>;

  @IsString({ message: "修改指令不能为空" })
  @IsNotEmpty({ message: "修改指令不能为空" })
  @MaxLength(4000, { message: "修改指令不能超过 4000 个字符" })
  instruction!: string;

  @IsOptional()
  @IsIn([
    "edit",
    "rewrite",
    "expand",
    "simplify",
    "compress",
    "restructure",
    "diff",
    "component_edit",
    "layout_edit",
    "flow_update",
    "redesign",
  ], { message: "action 不正确" })
  action?: string;

  @IsOptional()
  @IsString({ message: "selectedText 格式不正确" })
  @MaxLength(8000, { message: "selectedText 不能超过 8000 个字符" })
  selectedText?: string;

  @IsOptional()
  @IsString({ message: "replacementText 格式不正确" })
  @MaxLength(8000, { message: "replacementText 不能超过 8000 个字符" })
  replacementText?: string;

  @IsOptional()
  @IsString({ message: "diffBaseText 格式不正确" })
  @MaxLength(8000, { message: "diffBaseText 不能超过 8000 个字符" })
  diffBaseText?: string;

  @IsOptional()
  @IsString({ message: "diffTargetText 格式不正确" })
  @MaxLength(8000, { message: "diffTargetText 不能超过 8000 个字符" })
  diffTargetText?: string;

  @IsOptional()
  @IsArray({ message: "attachmentFileIds 格式不正确" })
  @ArrayMaxSize(10, { message: "单次最多携带 10 个附件" })
  @IsString({ each: true, message: "attachmentFileIds 格式不正确" })
  attachmentFileIds?: string[];
}
