import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayError } from "../../model-gateway/model-gateway.error";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ModelGatewayErrorCode, ModelMessage } from "../../model-gateway/model-gateway.types";
import type { AgentFallbackAction, AgentFallbackLevel, AgentFallbackMetadata } from "../agent-fallback-policy";
import type { AgentInvocation, AgentOutput } from "../ai-vibe.types";

const DEFAULT_AGENT_RETRY_COUNT = 0;

export abstract class BaseAgentService<TInput, TOutput> {
  abstract readonly agentName: AgentName;
  abstract readonly taskType: ModelTaskType;

  constructor(protected readonly modelGateway: ModelGatewayService) {}

  async run(invocation: AgentInvocation<TInput, TOutput>): Promise<AgentOutput<TOutput>> {
    const messages = this.buildMessages(invocation.input);
    try {
      return await this.runWithRetries(async () => {
        const result = await this.modelGateway.generateJson<TOutput>({
          taskType: this.taskType,
          agentName: this.agentName,
          runId: invocation.runId,
          traceId: invocation.traceId,
          userId: invocation.userId,
          messages,
          jsonSchema: this.jsonSchema(),
          timeoutMs: this.modelTimeoutMs(invocation.input),
          retryCount: this.modelRetryCount(invocation.input),
          jsonParseRetryCount: this.jsonParseRetryCount(invocation.input),
          temperature: this.modelTemperature(invocation.input),
          maxTokens: this.modelMaxTokens(invocation.input),
        });

        return {
          data: this.normalize(result.data, invocation.input),
          modelCallLogId: result.modelCallLogId,
        };
      }, this.agentRetryCount(invocation.input));
    } catch (error) {
      const fallback = this.fallbackOnError(error, invocation.input);
      if (fallback) {
        return {
          data: this.normalize(this.fallback(invocation.input), invocation.input),
          fallback,
        };
      }

      throw error;
    }
  }

  protected abstract buildMessages(input: TInput): ModelMessage[];

  protected abstract fallback(input: TInput): TOutput;

  protected normalize(output: TOutput, _input: TInput): TOutput {
    return output;
  }

  protected jsonSchema(): unknown {
    return {};
  }

  protected agentRetryCount(_input: TInput) {
    return DEFAULT_AGENT_RETRY_COUNT;
  }

  protected modelRetryCount(_input: TInput): number | undefined {
    return undefined;
  }

  protected jsonParseRetryCount(_input: TInput): number | undefined {
    return undefined;
  }

  protected modelTimeoutMs(_input: TInput): number | undefined {
    return undefined;
  }

  protected modelTemperature(_input: TInput): number | undefined {
    return undefined;
  }

  protected modelMaxTokens(_input: TInput): number | undefined {
    return undefined;
  }

  protected fallbackOnError(error: unknown, input: TInput): AgentFallbackMetadata | undefined {
    const fallbackMode = this.fallbackMode(input);
    if (!fallbackMode) return undefined;

    return {
      used: true,
      level: this.fallbackLevel(input),
      action: this.fallbackAction(input),
      agentName: this.agentName,
      taskType: this.taskType,
      fallbackMode,
      errorCode: modelErrorCode(error),
      errorMessage: errorText(error),
      reason: this.fallbackReason(error, input),
      userMessage: this.fallbackUserMessage(error, input),
      canContinue: true,
      allowsConfirmation: this.fallbackAllowsConfirmation(input),
      allowsKnowledgeExtraction: this.fallbackAllowsKnowledgeExtraction(input),
      allowsExport: this.fallbackAllowsExport(input),
      occurredAt: new Date().toISOString(),
    };
  }

  protected fallbackMode(_input: TInput): string | undefined {
    return undefined;
  }

  protected fallbackLevel(_input: TInput): AgentFallbackLevel {
    return "degraded_preview";
  }

  protected fallbackAction(_input: TInput): AgentFallbackAction {
    return "review_required";
  }

  protected fallbackReason(error: unknown, _input: TInput) {
    return `${this.agentName} 模型调用不可用，已使用确定性规则兜底。原始错误：${errorText(error)}`;
  }

  protected fallbackUserMessage(_error: unknown, _input: TInput) {
    return `${this.agentName} 暂时无法使用模型，已使用规则兜底并继续执行。`;
  }

  protected fallbackAllowsConfirmation(_input: TInput) {
    return true;
  }

  protected fallbackAllowsKnowledgeExtraction(_input: TInput) {
    return false;
  }

  protected fallbackAllowsExport(_input: TInput) {
    return true;
  }

  private async runWithRetries(
    runOnce: () => Promise<AgentOutput<TOutput>>,
    retryCount: number,
  ) {
    let lastError: unknown;
    for (let retry = 0; retry <= retryCount; retry += 1) {
      try {
        return await runOnce();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("Agent 执行失败");
  }
}

function modelErrorCode(error: unknown): ModelGatewayErrorCode {
  return error instanceof ModelGatewayError ? error.code : "MODEL_CALL_FAILED";
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : "模型调用失败";
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact || "模型调用失败";
}
