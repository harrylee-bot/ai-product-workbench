import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export class GeneratePrototypeDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "productDesignStateId 格式不正确" })
  productDesignStateId?: string;

  @IsOptional()
  @IsIn(["desktop", "mobile", "both"], { message: "targetDevice 不正确" })
  targetDevice?: "desktop" | "mobile" | "both";
}

export class GetPrototypeStateDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "artifactId 格式不正确" })
  artifactId?: string;
}

export class UpdatePrototypeDto {
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
  @IsIn(["component_edit", "layout_edit", "flow_update", "redesign"], { message: "action 不正确" })
  action?: "component_edit" | "layout_edit" | "flow_update" | "redesign";

  @IsOptional()
  @IsString({ message: "selectedText 格式不正确" })
  @MaxLength(8000, { message: "selectedText 不能超过 8000 个字符" })
  selectedText?: string;

  @IsOptional()
  @IsObject({ message: "interactionEvent 格式不正确" })
  interactionEvent?: Record<string, unknown>;

  @IsOptional()
  @IsArray({ message: "attachmentFileIds 格式不正确" })
  @ArrayMaxSize(10, { message: "单次最多携带 10 个附件" })
  @IsString({ each: true, message: "attachmentFileIds 格式不正确" })
  attachmentFileIds?: string[];
}

export class ConfirmPrototypeDto {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString({ message: "确认说明格式不正确" })
  @MaxLength(500, { message: "确认说明不能超过 500 个字符" })
  reason?: string;
}
