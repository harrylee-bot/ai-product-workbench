import { z } from "zod";
import type { CanonicalEmbeddingProfileV1 } from "@workbench/workbench-knowledge";
import { RetryableKnowledgeBuildError, TerminalKnowledgeBuildError } from "./knowledge.errors.js";
import type {
  KnowledgeEmbeddingInput,
  KnowledgeEmbeddingPort,
  KnowledgeEmbeddingResult,
} from "./embedding.port.js";

export type TeiEmbeddingAdapterConfig = {
  readonly origin: string;
  readonly apiKey?: string;
  readonly requestTimeoutMs: number;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly imageDigest: string;
  readonly profileId: string;
  readonly profileSpecSha256: string;
};

const infoSchema = z.object({
  model_id: z.string().min(1),
  model_sha: z.string().min(1),
  version: z.string().min(1),
  max_input_length: z.number().int().positive(),
  max_batch_tokens: z.number().int().positive(),
  max_client_batch_size: z.number().int().positive(),
  auto_truncate: z.literal(false),
}).passthrough();

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const L2_TOLERANCE = 0.001;
// The CPU Candle backend used by the pinned production TEI image advertises a
// client batch size of 32 but currently accepts at most 2 inputs per model
// request. Keep the profile contract at 32 and split provider calls here so a
// valid knowledge batch does not fail with HTTP 429 Model is overloaded.
const PROVIDER_EMBED_BATCH_LIMIT = 2;

export class TeiEmbeddingAdapter implements KnowledgeEmbeddingPort {
  constructor(
    private readonly config: TeiEmbeddingAdapterConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  async assertProfile(profile: CanonicalEmbeddingProfileV1, signal?: AbortSignal): Promise<void> {
    this.assertConfiguredProfile(profile);
    const info = infoSchema.safeParse(await this.requestJson("/info", { method: "GET" }, signal));
    if (!info.success) {
      throw new TerminalKnowledgeBuildError(
        "TEI_INFO_INVALID",
        "TEI returned an invalid model identity response",
        { cause: info.error },
      );
    }
    const expected = profile.spec;
    if (
      info.data.model_id !== expected.model.id
      || info.data.model_sha !== expected.model.revision
      || info.data.version !== expected.engine.version
      || info.data.max_input_length < expected.tokenizer.modelMaximumTokens
      || info.data.max_batch_tokens < expected.batch.maximumTokens
      || info.data.max_client_batch_size < expected.batch.maximumInputs
    ) {
      throw new TerminalKnowledgeBuildError(
        "TEI_PROFILE_IDENTITY_MISMATCH",
        "TEI runtime identity or capacity does not match the pinned embedding profile",
      );
    }
  }

  async embedDocuments(
    profile: CanonicalEmbeddingProfileV1,
    inputs: readonly KnowledgeEmbeddingInput[],
    signal?: AbortSignal,
  ): Promise<KnowledgeEmbeddingResult> {
    this.assertConfiguredProfile(profile);
    if (inputs.length < 1 || inputs.length > profile.spec.batch.maximumInputs) {
      throw new TerminalKnowledgeBuildError(
        "TEI_BATCH_INPUT_COUNT_INVALID",
        "Embedding batch input count exceeds its pinned profile",
      );
    }
    const texts = inputs.map((input) => input.text);
    const tokenCounts: number[] = [];
    for (let offset = 0; offset < texts.length; offset += PROVIDER_EMBED_BATCH_LIMIT) {
      const batch = texts.slice(offset, offset + PROVIDER_EMBED_BATCH_LIMIT);
      const tokenized = await this.requestJson("/tokenize", {
        method: "POST",
        body: JSON.stringify({ inputs: batch, add_special_tokens: true }),
      }, signal);
      tokenCounts.push(...parseTokenCounts(tokenized, batch.length));
    }
    if (tokenCounts.some((count) => count > profile.spec.tokenizer.chunkMaximumTokens)) {
      throw new TerminalKnowledgeBuildError(
        "TEI_INPUT_TOKEN_LIMIT_EXCEEDED",
        "Embedding input exceeds the pinned tokenizer chunk limit",
      );
    }
    const totalTokens = tokenCounts.reduce((total, count) => total + count, 0);
    if (totalTokens > profile.spec.batch.maximumTokens) {
      throw new TerminalKnowledgeBuildError(
        "TEI_BATCH_TOKEN_LIMIT_EXCEEDED",
        "Embedding batch exceeds the pinned tokenizer batch limit",
      );
    }

    const vectors: (readonly number[])[] = [];
    for (let offset = 0; offset < texts.length; offset += PROVIDER_EMBED_BATCH_LIMIT) {
      const batch = texts.slice(offset, offset + PROVIDER_EMBED_BATCH_LIMIT);
      const response = await this.requestJson("/embed", {
        method: "POST",
        body: JSON.stringify({
          inputs: batch,
          dimensions: profile.dimension,
          normalize: true,
          truncate: false,
        }),
      }, signal);
      vectors.push(...parseVectors(response, batch.length, profile.dimension));
    }
    return { vectors, tokenCounts };
  }

  private assertConfiguredProfile(profile: CanonicalEmbeddingProfileV1): void {
    if (
      profile.spec.protocol !== "tei.embed.v1"
      || profile.spec.id !== this.config.profileId
      || profile.specSha256 !== this.config.profileSpecSha256
      || !profile.spec.engine.imageDigest
      || profile.spec.engine.imageDigest !== this.config.imageDigest
      || profile.spec.output.dtype !== "float32"
      || profile.spec.output.normalization !== "l2"
      || profile.spec.output.distance !== "cosine"
    ) {
      throw new TerminalKnowledgeBuildError(
        "TEI_PROFILE_CONFIGURATION_MISMATCH",
        "Worker TEI configuration does not match the pinned embedding profile",
      );
    }
  }

  private async requestJson(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw new RetryableKnowledgeBuildError("TEI_REQUEST_ABORTED", "TEI request was interrupted", { cause: signal.reason });
    }
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body && Buffer.byteLength(body, "utf8") > this.config.maximumRequestBytes) {
      throw new TerminalKnowledgeBuildError("TEI_REQUEST_TOO_LARGE", "TEI request exceeds the configured byte limit");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("TEI_REQUEST_TIMEOUT"));
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
        const ErrorType = RETRYABLE_STATUS.has(response.status)
          ? RetryableKnowledgeBuildError
          : TerminalKnowledgeBuildError;
        throw new ErrorType(
          `TEI_HTTP_${response.status}`,
          RETRYABLE_STATUS.has(response.status)
            ? "TEI is temporarily unavailable"
            : "TEI rejected the pinned embedding request",
        );
      }
      if (!response.headers.get("content-type")?.toLocaleLowerCase("en-US").includes("application/json")) {
        throw new TerminalKnowledgeBuildError("TEI_CONTENT_TYPE_INVALID", "TEI response is not JSON");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (cause) {
        throw new TerminalKnowledgeBuildError("TEI_JSON_INVALID", "TEI returned invalid JSON", { cause });
      }
    } catch (cause) {
      if (cause instanceof RetryableKnowledgeBuildError || cause instanceof TerminalKnowledgeBuildError) throw cause;
      if (timedOut) {
        throw new RetryableKnowledgeBuildError("TEI_REQUEST_TIMEOUT", "TEI request timed out", { cause });
      }
      if (signal?.aborted) {
        throw new RetryableKnowledgeBuildError("TEI_REQUEST_ABORTED", "TEI request was interrupted", { cause });
      }
      throw new RetryableKnowledgeBuildError("TEI_REQUEST_FAILED", "TEI request failed", { cause });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function parseTokenCounts(value: unknown, expectedCount: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new TerminalKnowledgeBuildError("TEI_TOKENIZE_RESPONSE_INVALID", "TEI token count does not match the batch");
  }
  return value.map((tokens) => {
    if (!Array.isArray(tokens) || tokens.some((token) => (
      typeof token !== "object"
      || token === null
      || !Number.isSafeInteger((token as { id?: unknown }).id)
    ))) {
      throw new TerminalKnowledgeBuildError("TEI_TOKENIZE_RESPONSE_INVALID", "TEI returned invalid tokenizer output");
    }
    return tokens.length;
  });
}

function parseVectors(value: unknown, expectedCount: number, dimension: number): readonly (readonly number[])[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new TerminalKnowledgeBuildError("TEI_VECTOR_COUNT_INVALID", "TEI vector count does not match the batch");
  }
  return value.map((candidate) => {
    if (!Array.isArray(candidate) || candidate.length !== dimension) {
      throw new TerminalKnowledgeBuildError("TEI_VECTOR_DIMENSION_INVALID", "TEI vector dimension is invalid");
    }
    const vector = candidate.map((item) => {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        throw new TerminalKnowledgeBuildError("TEI_VECTOR_VALUE_INVALID", "TEI vector contains a non-finite value");
      }
      return Math.fround(item);
    });
    const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > L2_TOLERANCE) {
      throw new TerminalKnowledgeBuildError("TEI_VECTOR_NORM_INVALID", "TEI vector is not L2 normalized");
    }
    return vector;
  });
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const byteLength = Number(declared);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes) {
      throw new TerminalKnowledgeBuildError("TEI_RESPONSE_TOO_LARGE", "TEI response exceeds the configured byte limit");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TerminalKnowledgeBuildError("TEI_RESPONSE_TOO_LARGE", "TEI response exceeds the configured byte limit");
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
      throw new TerminalKnowledgeBuildError(
        "TEI_RESPONSE_ENCODING_INVALID",
        "TEI response is not valid UTF-8",
        { cause },
      );
    }
  } finally {
    reader.releaseLock();
  }
}
