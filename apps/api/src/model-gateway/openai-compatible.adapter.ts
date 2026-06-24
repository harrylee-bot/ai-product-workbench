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

type ActiveFetch = {
  response: Response;
  timeoutMs: number;
  abort: () => void;
};

@Injectable()
export class OpenAICompatibleAdapter {
  async chat(input: AdapterChatInput): Promise<AdapterChatResult> {
    const request = await this.fetchWithHeaderTimeout(input.route, {
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

    await this.assertOk(request);
    const rawBody = await this.readBodyTextWithIdleTimeout(
      request,
      "模型响应读取超时：响应体在超时时间内没有继续返回内容",
    );
    const data = this.parseChatResponse(rawBody);
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
    const request = await this.fetchWithHeaderTimeout(input.route, {
      method: "POST",
      headers: this.buildHeaders(input.route.apiKey, input.route.defaultHeaders),
      body: JSON.stringify({
        model: input.route.modelName,
        messages: input.messages,
        temperature: input.route.temperature,
        max_tokens: input.route.maxTokens,
        stream: true,
        response_format:
          input.responseFormat === ModelResponseFormat.json && input.route.supportsJsonMode
            ? { type: "json_object" }
            : undefined,
      }),
    });

    await this.assertOk(request);

    if (!request.response.body) {
      throw new ModelGatewayError("MODEL_STREAM_FAILED", "模型流式响应为空");
    }

    const reader = request.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: TokenUsage | undefined;

    while (true) {
      const { value, done } = await this.readStreamChunkWithIdleTimeout(
        reader,
        input.route.timeoutMs,
        request.abort,
        "模型流式输出停滞超时：超过配置时间没有收到新的响应内容",
      );
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

  private async fetchWithHeaderTimeout(route: AdapterChatInput["route"], init: RequestInit): Promise<ActiveFetch> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, route.timeoutMs);

    try {
      const response = await fetch(this.chatCompletionsUrl(route.baseUrl), {
        ...init,
        signal: controller.signal,
      });
      return {
        response,
        timeoutMs: route.timeoutMs,
        abort: () => controller.abort(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        const message = timedOut
          ? "模型请求超时：超过配置时间没有收到供应商响应"
          : "模型请求已中断";
        throw new ModelGatewayError("MODEL_CALL_TIMEOUT", message, error);
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

  private async assertOk(request: ActiveFetch) {
    if (request.response.ok) return;

    const body = await this.safeReadBody(request);
    if (request.response.status === 401 || request.response.status === 403) {
      throw new ModelGatewayError(
        "MODEL_PROVIDER_UNAUTHORIZED",
        this.sanitizeError(`模型供应商鉴权失败: ${body || request.response.statusText}`),
      );
    }

    throw new ModelGatewayError(
      "MODEL_CALL_FAILED",
      this.sanitizeError(`模型调用失败: ${body || request.response.statusText}`),
    );
  }

  private async safeReadBody(request: ActiveFetch) {
    try {
      return await this.readBodyTextWithIdleTimeout(
        request,
        "模型错误响应读取超时：响应体在超时时间内没有继续返回内容",
      );
    } catch {
      return "";
    }
  }

  private async readBodyTextWithIdleTimeout(
    request: ActiveFetch,
    timeoutMessage: string,
  ) {
    if (!request.response.body) {
      return request.response.text();
    }

    const reader = request.response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const { value, done } = await this.readStreamChunkWithIdleTimeout(
        reader,
        request.timeoutMs,
        request.abort,
        timeoutMessage,
      );
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    return text;
  }

  private async readStreamChunkWithIdleTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    abort: () => void,
    timeoutMessage: string,
  ) {
    const idleTimeoutMs = Math.max(timeoutMs, 1_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort();
            reject(new ModelGatewayError("MODEL_CALL_TIMEOUT", timeoutMessage));
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private parseChatResponse(rawBody: string) {
    try {
      return JSON.parse(rawBody) as OpenAICompatibleChatResponse;
    } catch (error) {
      throw new ModelGatewayError("MODEL_CALL_FAILED", "模型供应商响应不是合法 JSON", error);
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
