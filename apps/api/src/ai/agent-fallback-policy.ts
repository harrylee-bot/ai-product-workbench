import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayError } from "../model-gateway/model-gateway.error";
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

const DEFAULT_FALLBACK_CODES: ModelGatewayErrorCode[] = [
  "MODEL_TASK_PROFILE_NOT_FOUND",
  "MODEL_PROVIDER_NOT_FOUND",
  "MODEL_CONFIG_NOT_FOUND",
];

const ALWAYS_FALLBACK_CODES: ModelGatewayErrorCode[] = [
  ...DEFAULT_FALLBACK_CODES,
  "MODEL_PROVIDER_DISABLED",
  "MODEL_CONFIG_DISABLED",
  "MODEL_CALL_FAILED",
  "MODEL_CALL_TIMEOUT",
  "MODEL_API_KEY_INVALID",
  "MODEL_PROVIDER_UNAUTHORIZED",
  "MODEL_JSON_PARSE_FAILED",
];

const MODEL_UNAVAILABLE_CODES: ModelGatewayErrorCode[] = [
  "MODEL_PROVIDER_DISABLED",
  "MODEL_CONFIG_DISABLED",
  "MODEL_CALL_FAILED",
  "MODEL_CALL_TIMEOUT",
  "MODEL_API_KEY_INVALID",
  "MODEL_PROVIDER_UNAUTHORIZED",
  "MODEL_JSON_PARSE_FAILED",
];

const ACCEPTABLE_FALLBACK_TASKS: ModelTaskType[] = [
  ModelTaskType.prd_generation,
  ModelTaskType.prototype_design,
  ModelTaskType.prototype_code_generation,
  ModelTaskType.qa_check,
  ModelTaskType.knowledge_extraction,
];

export function decideAgentFallback(input: {
  agentName: AgentName;
  taskType: ModelTaskType;
  error: unknown;
  fallbackMode?: string;
}): AgentFallbackDecision {
  const fallbackMode = normalizeFallbackMode(input.fallbackMode);
  if (fallbackMode === "never") return { allowed: false };
  if (!(input.error instanceof ModelGatewayError)) return { allowed: false };

  const allowedCodes = fallbackMode === "always" ? ALWAYS_FALLBACK_CODES : DEFAULT_FALLBACK_CODES;
  if (!allowedCodes.includes(input.error.code)) return { allowed: false };

  const level = fallbackLevel(input.taskType, input.error.code);
  const action = fallbackAction(level);
  return {
    allowed: true,
    metadata: {
      used: true,
      level,
      action,
      agentName: input.agentName,
      taskType: input.taskType,
      fallbackMode,
      errorCode: input.error.code,
      errorMessage: input.error.message,
      reason: fallbackReason(level, input.taskType, input.error.code),
      userMessage: fallbackUserMessage(level, input.taskType),
      canContinue: true,
      allowsConfirmation: level === "acceptable_result",
      allowsKnowledgeExtraction: level === "acceptable_result",
      allowsExport: level === "acceptable_result",
      occurredAt: new Date().toISOString(),
    },
  };
}

export function fallbackStepOutput<T>(
  output: T,
  fallback?: AgentFallbackMetadata,
) {
  return fallback ? { output, fallback } : output;
}

function normalizeFallbackMode(value?: string) {
  const mode = value?.trim().toLowerCase();
  if (mode === "never" || mode === "always") return mode;
  return "config_only";
}

function fallbackLevel(taskType: ModelTaskType, errorCode: ModelGatewayErrorCode): AgentFallbackLevel {
  if (MODEL_UNAVAILABLE_CODES.includes(errorCode)) return "model_unavailable";
  if (ACCEPTABLE_FALLBACK_TASKS.includes(taskType)) return "acceptable_result";
  return "degraded_preview";
}

function fallbackAction(level: AgentFallbackLevel): AgentFallbackAction {
  if (level === "acceptable_result") return "continue";
  if (level === "degraded_preview") return "review_required";
  return "notify_user";
}

function fallbackReason(level: AgentFallbackLevel, taskType: ModelTaskType, errorCode: ModelGatewayErrorCode) {
  if (level === "acceptable_result") {
    return `模型配置不可用（${errorCode}），${taskType} 已使用确定性规则生成可继续使用的结果。`;
  }
  if (level === "degraded_preview") {
    return `模型配置不可用（${errorCode}），${taskType} 已使用启发式规则生成降级预览，需要用户确认。`;
  }
  return `模型调用异常（${errorCode}），系统仅提供降级结果，必须提示用户检查模型配置或稍后重试。`;
}

function fallbackUserMessage(level: AgentFallbackLevel, taskType: ModelTaskType) {
  if (level === "acceptable_result") {
    return `${taskType} 使用确定性兜底结果继续执行。`;
  }
  if (level === "degraded_preview") {
    return `${taskType} 当前为降级预览，请在确认前复核。`;
  }
  return `${taskType} 的模型不可用，已进入降级模式，请检查模型配置。`;
}
