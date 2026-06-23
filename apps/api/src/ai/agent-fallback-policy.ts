import { AgentName, ModelTaskType } from "@prisma/client";
import type { ModelGatewayErrorCode } from "../model-gateway/model-gateway.types";

export type AgentFallbackLevel =
  | "acceptable_result"
  | "degraded_preview"
  | "model_unavailable";

export type AgentFallbackAction =
  | "continue"
  | "review_required"
  | "notify_user";

export type AgentFallbackMetadata = {
  used: true;
  level: AgentFallbackLevel;
  action: AgentFallbackAction;
  agentName: AgentName;
  taskType: ModelTaskType;
  fallbackMode: string;
  errorCode: ModelGatewayErrorCode;
  errorMessage: string;
  reason: string;
  userMessage: string;
  canContinue: boolean;
  allowsConfirmation: boolean;
  allowsKnowledgeExtraction: boolean;
  allowsExport: boolean;
  occurredAt: string;
};

export type AgentFallbackDecision = {
  allowed: boolean;
  metadata?: AgentFallbackMetadata;
};

export function decideAgentFallback(input: {
  agentName: AgentName;
  taskType: ModelTaskType;
  error: unknown;
  fallbackMode?: string;
}): AgentFallbackDecision {
  void input;
  return { allowed: false };
}

export function fallbackStepOutput<T>(
  output: T,
  fallback?: AgentFallbackMetadata,
) {
  return fallback ? { output, fallback } : output;
}
