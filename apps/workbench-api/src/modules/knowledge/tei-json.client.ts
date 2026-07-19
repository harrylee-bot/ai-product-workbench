import type { TeiServiceConfig } from "./knowledge-retrieval.config.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class KnowledgeProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super("Knowledge provider request failed", options);
    this.name = "KnowledgeProviderError";
  }
}

export class TeiJsonClient {
  constructor(
    private readonly config: TeiServiceConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  async requestJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body && Buffer.byteLength(body, "utf8") > this.config.maximumRequestBytes) {
      throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_REQUEST_TOO_LARGE", false);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.requestTimeoutMs);
    timeout.unref();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.request(`${this.config.origin}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
          ...init.headers,
        },
      });
      const text = await readBoundedText(response, this.config.maximumResponseBytes);
      if (!response.ok) {
        throw new KnowledgeProviderError(`KNOWLEDGE_PROVIDER_HTTP_${response.status}`, RETRYABLE_STATUS.has(response.status));
      }
      if (!response.headers.get("content-type")?.toLocaleLowerCase("en-US").includes("application/json")) {
        throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_CONTENT_TYPE_INVALID", false);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_JSON_INVALID", false, { cause });
      }
    } catch (cause) {
      if (cause instanceof KnowledgeProviderError) throw cause;
      if (timedOut) throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_TIMEOUT", true, { cause });
      if (signal?.aborted) throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_ABORTED", true, { cause });
      throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_UNAVAILABLE", true, { cause });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const byteLength = Number(declared);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes) {
      throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_RESPONSE_TOO_LARGE", false);
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_RESPONSE_TOO_LARGE", false);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_RESPONSE_ENCODING_INVALID", false, { cause });
  }
}
