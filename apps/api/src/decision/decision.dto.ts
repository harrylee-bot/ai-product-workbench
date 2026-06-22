import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from "class-validator";
import type { FusionDecisionPlan } from "./decision.types";
import type { ConstraintContext } from "../constraint/constraint.types";

export class GenerateDecisionDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "input 不能为空" })
  @IsNotEmpty({ message: "input 不能为空" })
  @MaxLength(2000, { message: "input 不能超过 2000 个字符" })
  input!: string;

  @IsOptional()
  @IsObject()
  constraintContext?: ConstraintContext;
}

export class SelectDecisionDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsObject({ message: "decisionPlan 不能为空" })
  decisionPlan!: FusionDecisionPlan;
}
