import { BadRequestException, Injectable } from "@nestjs/common";
import {
  ModelCallStatus,
  ModelProviderType,
  ModelResponseFormat,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";
import { ModelGatewayError } from "./model-gateway.error";
import { OpenAICompatibleAdapter } from "./openai-compatible.adapter";
import type {
  GenerateJsonInput,
  GenerateJsonResult,
  GenerateTextInput,
  GenerateTextResult,
  ModelMessage,
  ResolvedModelRoute,
  StreamTextInput,
  TokenUsage,
} from "./model-gateway.types";

type ModelRouteRecord = Prisma.ModelTaskProfileGetPayload<{
  include: {
    modelConfig: {
      include: {
        provider: true;
      };
    };
  };
}>;

@Injectable()
export class ModelGatewayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: ApiKeyEncryptionService,
    private readonly openAICompatibleAdapter: OpenAICompatibleAdapter,
  ) {}

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const route = await this.resolveRoute(input);
    const log = await this.createRunningLog(input, route);
    const startedAt = Date.now();

    try {
      const result = await this.withRetry(route.retryCount, () =>
        this.openAICompatibleAdapter.chat({
          route,
          messages: input.messages,
          responseFormat: ModelResponseFormat.text,
        }),
      );

      await this.markSucceeded(log.id, startedAt, result.content, result.usage);

      return {
        content: result.content,
        modelCallLogId: log.id,
        usage: result.usage,
      };
    } catch (error) {
      await this.markFailed(log.id, startedAt, error);
      throw error;
    }
  }

  async generateJson<T = unknown>(input: GenerateJsonInput): Promise<GenerateJsonResult<T>> {
    const route = await this.resolveRoute({
      ...input,
      messages: this.withJsonInstruction(input.messages, input.jsonSchema),
    });
    const log = await this.createRunningLog(input, route);
    const startedAt = Date.now();
    const parseRetryCount = Math.max(input.jsonParseRetryCount ?? 1, 0);
    let lastRawContent = "";
    let lastUsage: TokenUsage | undefined;

    try {
      for (let attempt = 0; attempt <= parseRetryCount; attempt += 1) {
        const messages =
          attempt === 0
            ? this.withJsonInstruction(input.messages, input.jsonSchema)
            : this.withJsonRetryInstruction(input.messages, input.jsonSchema, lastRawContent);

        let partialContent = "";
        const result = await this.withRetry(route.retryCount, () =>
          route.supportsStreaming
            ? this.openAICompatibleAdapter.stream({
                route: {
                  ...route,
                  responseFormat: ModelResponseFormat.json,
                },
                messages,
                responseFormat: ModelResponseFormat.json,
                onDelta: (delta) => {
                  partialContent += delta;
                },
              })
            : this.openAICompatibleAdapter.chat({
                route: {
                  ...route,
                  responseFormat: ModelResponseFormat.json,
                },
                messages,
                responseFormat: ModelResponseFormat.json,
              }),
        ).catch((error) => {
          if (partialContent) lastRawContent = partialContent;
          throw error;
        });
        lastRawContent = result.content;
        lastUsage = result.usage;

        const parsed = this.tryParseJson<T>(result.content);
        if (parsed.ok) {
          await this.markSucceeded(log.id, startedAt, result.content, result.usage);
          return {
            data: parsed.data,
            rawContent: result.content,
            modelCallLogId: log.id,
            usage: result.usage,
          };
        }
      }

      throw new ModelGatewayError("MODEL_JSON_PARSE_FAILED", "模型输出不是合法 JSON");
    } catch (error) {
      await this.markFailed(log.id, startedAt, error, lastRawContent, lastUsage);
      throw error;
    }
  }

  async streamText(input: StreamTextInput) {
    const route = await this.resolveRoute(input);
    if (!route.supportsStreaming) {
      throw new ModelGatewayError("MODEL_CONFIG_DISABLED", "当前模型不支持流式输出");
    }

    const log = await this.createRunningLog(input, route);
    const startedAt = Date.now();

    try {
      const result = await this.withRetry(route.retryCount, () =>
        this.openAICompatibleAdapter.stream({
          route,
          messages: input.messages,
          onDelta: input.onDelta,
        }),
      );

      await this.markSucceeded(log.id, startedAt, result.content, result.usage);
      await input.onComplete?.(result.content, result.usage);

      return {
        content: result.content,
        modelCallLogId: log.id,
        usage: result.usage,
      };
    } catch (error) {
      await this.markFailed(log.id, startedAt, error);
      throw error instanceof ModelGatewayError
        ? error
        : new ModelGatewayError("MODEL_STREAM_FAILED", "模型流式调用失败", error);
    }
  }

  stripJsonCodeFence(content: string) {
    const trimmed = content.trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return (fence?.[1] ?? trimmed).trim();
  }

  private async resolveRoute(input: GenerateTextInput): Promise<ResolvedModelRoute> {
    const profile = await this.prisma.modelTaskProfile.findUnique({
      where: { taskType: input.taskType },
      include: {
        modelConfig: {
          include: {
            provider: true,
          },
        },
      },
    });

    if (!profile || !profile.isEnabled) {
      throw new ModelGatewayError("MODEL_TASK_PROFILE_NOT_FOUND", "任务模型配置不存在或未启用");
    }

    return this.toResolvedRoute(profile, input);
  }

  private toResolvedRoute(profile: ModelRouteRecord, input: GenerateTextInput): ResolvedModelRoute {
    const { modelConfig } = profile;
    const { provider } = modelConfig;

    if (!modelConfig.isEnabled) {
      throw new ModelGatewayError("MODEL_CONFIG_DISABLED", "模型配置未启用");
    }

    if (!provider.isEnabled) {
      throw new ModelGatewayError("MODEL_PROVIDER_DISABLED", "模型供应商未启用");
    }

    if (provider.type !== ModelProviderType.openai_compatible) {
      throw new ModelGatewayError("MODEL_PROVIDER_NOT_FOUND", "模型供应商协议不支持");
    }

    return {
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: this.encryption.decrypt(provider.apiKeyEncrypted),
      defaultHeaders: this.toStringRecord(provider.defaultHeaders),
      providerTimeoutMs: provider.timeoutMs,
      modelConfigId: modelConfig.id,
      modelName: modelConfig.modelName,
      supportsStreaming: modelConfig.supportsStreaming,
      supportsJsonMode: modelConfig.supportsJsonMode,
      defaultTemperature: modelConfig.defaultTemperature,
      defaultMaxTokens: modelConfig.defaultMaxTokens ?? undefined,
      taskType: profile.taskType,
      responseFormat: profile.responseFormat,
      retryCount: Math.max(input.retryCount ?? profile.retryCount, 0),
      timeoutMs: input.timeoutMs ?? profile.timeoutMs ?? provider.timeoutMs,
      temperature: input.temperature ?? profile.temperature ?? modelConfig.defaultTemperature,
      maxTokens: input.maxTokens ?? profile.maxTokens ?? modelConfig.defaultMaxTokens ?? undefined,
    };
  }

  private async createRunningLog(input: GenerateTextInput, route: ResolvedModelRoute) {
    return this.prisma.modelCallLog.create({
      data: {
        traceId: input.traceId,
        runId: input.runId,
        runtimeName: input.runtimeName,
        taskType: input.taskType,
        providerId: route.providerId,
        modelConfigId: route.modelConfigId,
        modelName: route.modelName,
        status: ModelCallStatus.running,
        inputSummary: this.summarizeMessages(input.messages),
      },
    });
  }

  private async markSucceeded(
    logId: string,
    startedAt: number,
    output: string,
    usage?: TokenUsage,
  ) {
    await this.prisma.modelCallLog.update({
      where: { id: logId },
      data: {
        status: ModelCallStatus.succeeded,
        outputSummary: this.summarizeText(output),
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
      },
    });
  }

  private async markFailed(
    logId: string,
    startedAt: number,
    error: unknown,
    output?: string,
    usage?: TokenUsage,
  ) {
    const gatewayError = this.toGatewayError(error);
    await this.prisma.modelCallLog.update({
      where: { id: logId },
      data: {
        status: ModelCallStatus.failed,
        outputSummary: output ? this.summarizeText(output) : undefined,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
        durationMs: Date.now() - startedAt,
        completedAt: new Date(),
        errorCode: gatewayError.code,
        errorMessage: this.sanitizeErrorMessage(gatewayError.message),
      },
    });
  }

  private async withRetry<T>(retryCount: number, fn: () => Promise<T>) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (this.toGatewayError(error).code === "MODEL_CALL_TIMEOUT" && attempt < retryCount) {
          continue;
        }

        if (attempt < retryCount) continue;
        break;
      }
    }

    throw lastError;
  }

  private withJsonInstruction(messages: ModelMessage[], jsonSchema?: unknown): ModelMessage[] {
    return [
      {
        role: "system",
        content: [
          "你必须只输出合法 JSON，不要输出 Markdown，不要输出解释文本。",
          jsonSchema ? `JSON Schema 或结构描述：${JSON.stringify(jsonSchema)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      ...messages,
    ];
  }

  private withJsonRetryInstruction(
    messages: ModelMessage[],
    jsonSchema: unknown,
    invalidOutput: string,
  ): ModelMessage[] {
    return [
      ...this.withJsonInstruction(messages, jsonSchema),
      {
        role: "user",
        content: [
          "上一次输出无法被 JSON.parse 解析。",
          "请重新输出，且只能输出一个合法 JSON 对象或数组。",
          `无效输出摘要：${this.summarizeText(invalidOutput, 800)}`,
        ].join("\n"),
      },
    ];
  }

  private tryParseJson<T>(content: string): { ok: true; data: T } | { ok: false } {
    try {
      return { ok: true, data: JSON.parse(this.stripJsonCodeFence(content)) as T };
    } catch {
      return { ok: false };
    }
  }

  private summarizeMessages(messages: ModelMessage[]) {
    return this.summarizeText(messages.map((message) => `${message.role}: ${message.content}`).join("\n"));
  }

  private summarizeText(text: string, maxLength = 2000) {
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, maxLength)}...`;
  }

  private toStringRecord(value: Prisma.JsonValue | null): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .filter(([key]) => key.toLowerCase() !== "authorization"),
    );
  }

  private toGatewayError(error: unknown) {
    if (error instanceof ModelGatewayError) return error;
    if (error instanceof BadRequestException) {
      return new ModelGatewayError("MODEL_CALL_FAILED", error.message, error);
    }
    if (error instanceof Error) return new ModelGatewayError("MODEL_CALL_FAILED", error.message, error);
    return new ModelGatewayError("MODEL_CALL_FAILED", "模型调用失败", error);
  }

  private sanitizeErrorMessage(message: string) {
    return message
      .replace(/sk-[A-Za-z0-9_-]+/g, "sk-****")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ****")
      .slice(0, 2000);
  }
}
