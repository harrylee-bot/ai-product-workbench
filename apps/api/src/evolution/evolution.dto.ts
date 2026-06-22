import { IsNotEmpty, IsObject, IsOptional, IsString } from "class-validator";
import type { FusionDecisionPlan } from "../decision/decision.types";
import type { FusionTraceMetrics, FusionTraceOutcome } from "./evolution.types";

export class TraceEvolutionDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "input 不能为空" })
  @IsNotEmpty({ message: "input 不能为空" })
  input!: string;

  @IsObject({ message: "decisionPlan 不能为空" })
  decisionPlan!: FusionDecisionPlan;

  @IsOptional()
  @IsString()
  outcome?: FusionTraceOutcome;

  @IsOptional()
  @IsObject()
  metrics?: FusionTraceMetrics;
}

export class ApplyEvolutionDto {
  @IsString({ message: "projectId 不能为空" })
  @IsNotEmpty({ message: "projectId 不能为空" })
  projectId!: string;

  @IsString({ message: "traceId 不能为空" })
  @IsNotEmpty({ message: "traceId 不能为空" })
  traceId!: string;

  @IsString({ message: "strategyId 不能为空" })
  @IsNotEmpty({ message: "strategyId 不能为空" })
  strategyId!: string;

  @IsOptional()
  @IsString()
  outcome?: FusionTraceOutcome;

  @IsOptional()
  @IsObject()
  metrics?: FusionTraceMetrics;
}
