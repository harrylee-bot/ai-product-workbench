import { Injectable } from "@nestjs/common";
import { ModelResponseFormat } from "@prisma/client";
import { ModelGatewayError } from "./model-gateway.error";
import type {
  AdapterChatInput,
  AdapterChatResult,
  AdapterStreamInput,
  AdapterStreamResult,
  ModelMessage,
  TokenUsage,
} from "./model-gateway.types";

type OpenAICompatibleUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type OpenAICompatibleChatResponse = {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
  usage?: OpenAICompatibleUsage;
};

type OpenAICompatibleStreamChunk = {
  choices?: Array<{
    delta?: { content?: string | null };
  }>;
  usage?: OpenAICompatibleUsage;
};

@Injectable()
export class OpenAICompatibleAdapter {
  async chat(input: AdapterChatInput): Promise<AdapterChatResult> {
    const response = await this.fetchWithTimeout(input.route, {
      method: "POST",
      headers: this.buildHeaders(input.route.apiKey, input.route.defaultHeaders),
      body: JSON.stringify({
        model: input.route.modelName,
        messages: input.messages,
        temperature: input.route.temperature,
        max_tokens: input.route.maxTokens,
        stream: false,
        response_format:
          input.responseFormat === ModelResponseFormat.json && input.route.supportsJsonMode
            ? { type: "json_object" }
            : undefined,
      }),
    });

    await this.assertOk(response);
    const data = (await response.json()) as OpenAICompatibleChatResponse;
    const content = data.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
      throw new ModelGatewayError("MODEL_CALL_FAILED", "模型响应缺少 content");
    }

    return {
      content,
      usage: this.toUsage(data.usage),
    };
  }

  async stream(input: AdapterStreamInput): Promise<AdapterStreamResult> {
    const response = await this.fetchWithTimeout(input.route, {
      method: "POST",
      headers: this.buildHeaders(input.route.apiKey, input.route.defaultHeaders),
      body: JSON.stringify({
        model: input.route.modelName,
        messages: input.messages,
        temperature: input.route.temperature,
        max_tokens: input.route.maxTokens,
        stream: true,
      }),
    });

    await this.assertOk(response);

    if (!response.body) {
      throw new ModelGatewayError("MODEL_STREAM_FAILED", "模型流式响应为空");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: TokenUsage | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const payload = trimmed.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload) as OpenAICompatibleStreamChunk;
          usage = this.toUsage(chunk.usage) ?? usage;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (!delta) continue;
          content += delta;
          await input.onDelta(delta);
        } catch (error) {
          throw new ModelGatewayError("MODEL_STREAM_FAILED", "模型流式响应解析失败", error);
        }
      }
    }

    return { content, usage };
  }

  private async fetchWithTimeout(route: AdapterChatInput["route"], init: RequestInit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), route.timeoutMs);

    try {
      return await fetch(this.chatCompletionsUrl(route.baseUrl), {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelGatewayError("MODEL_CALL_TIMEOUT", "模型调用超时", error);
      }

      throw new ModelGatewayError("MODEL_CALL_FAILED", "模型调用失败", error);
    } finally {
      clearTimeout(timer);
    }
  }

  private chatCompletionsUrl(baseUrl: string) {
    const normalized = baseUrl.replace(/\/+$/, "");
    const path = normalized.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
    return `${normalized}${path}`;
  }

  private buildHeaders(apiKey: string, defaultHeaders?: Record<string, string>) {
    return {
      "Content-Type": "application/json",
      ...defaultHeaders,
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private async assertOk(response: Response) {
    if (response.ok) return;

    const body = await this.safeReadBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new ModelGatewayError(
        "MODEL_PROVIDER_UNAUTHORIZED",
        this.sanitizeError(`模型供应商鉴权失败: ${body || response.statusText}`),
      );
    }

    throw new ModelGatewayError(
      "MODEL_CALL_FAILED",
      this.sanitizeError(`模型调用失败: ${body || response.statusText}`),
    );
  }

  private async safeReadBody(response: Response) {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  private toUsage(usage?: OpenAICompatibleUsage): TokenUsage | undefined {
    if (!usage) return undefined;
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  private sanitizeError(message: string) {
    return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ****");
  }
}
