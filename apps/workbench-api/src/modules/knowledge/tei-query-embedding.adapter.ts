import type { CanonicalEmbeddingProfileV1 } from "@workbench/workbench-knowledge";
import type { KnowledgeEmbeddingProviderConfig } from "./knowledge-retrieval.config.js";
import type { KnowledgeQueryEmbeddingPort } from "./knowledge-retrieval.types.js";
import { KnowledgeProviderError, TeiJsonClient } from "./tei-json.client.js";
import { parseTeiRuntimeInfo } from "./tei-runtime-info.js";

const L2_TOLERANCE = 0.001;

export class TeiQueryEmbeddingAdapter implements KnowledgeQueryEmbeddingPort {
  private readonly client: TeiJsonClient;

  constructor(
    private readonly config: KnowledgeEmbeddingProviderConfig,
    request: typeof fetch = fetch,
  ) {
    this.client = new TeiJsonClient(config, request);
  }

  async embedQuery(
    profile: CanonicalEmbeddingProfileV1,
    text: string,
    signal?: AbortSignal,
  ): Promise<readonly number[]> {
    await this.assertReady(profile, signal);

    const tokenized = await this.client.requestJson("/tokenize", {
      method: "POST",
      body: JSON.stringify({ inputs: [text], add_special_tokens: true }),
    }, signal);
    const tokenCount = parseSingleTokenCount(tokenized);
    if (tokenCount > profile.spec.tokenizer.modelMaximumTokens) {
      throw new KnowledgeProviderError("KNOWLEDGE_QUERY_TOKEN_LIMIT_EXCEEDED", false);
    }

    const embedded = await this.client.requestJson("/embed", {
      method: "POST",
      body: JSON.stringify({
        inputs: [text],
        dimensions: profile.dimension,
        normalize: true,
        truncate: false,
      }),
    }, signal);
    return parseSingleVector(embedded, profile.dimension);
  }

  async assertReady(profile: CanonicalEmbeddingProfileV1, signal?: AbortSignal): Promise<void> {
    this.assertConfiguredProfile(profile);
    const info = parseTeiRuntimeInfo(await this.client.requestJson("/info", { method: "GET" }, signal));
    if (
      info.model_id !== profile.spec.model.id
      || info.model_sha !== profile.spec.model.revision
      || info.version !== profile.spec.engine.version
      || info.max_input_length < profile.spec.tokenizer.modelMaximumTokens
      || info.max_batch_tokens < profile.spec.batch.maximumTokens
      || info.max_client_batch_size < profile.spec.batch.maximumInputs
    ) {
      throw new KnowledgeProviderError("KNOWLEDGE_QUERY_PROFILE_IDENTITY_MISMATCH", false);
    }
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
      throw new KnowledgeProviderError("KNOWLEDGE_QUERY_PROFILE_CONFIGURATION_MISMATCH", false);
    }
  }
}

function parseSingleTokenCount(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
    throw new KnowledgeProviderError("KNOWLEDGE_QUERY_TOKENIZE_RESPONSE_INVALID", false);
  }
  if (value[0].some((token) => (
    typeof token !== "object"
    || token === null
    || !Number.isSafeInteger((token as { id?: unknown }).id)
  ))) {
    throw new KnowledgeProviderError("KNOWLEDGE_QUERY_TOKENIZE_RESPONSE_INVALID", false);
  }
  return value[0].length;
}

function parseSingleVector(value: unknown, dimension: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0]) || value[0].length !== dimension) {
    throw new KnowledgeProviderError("KNOWLEDGE_QUERY_VECTOR_DIMENSION_INVALID", false);
  }
  const vector = value[0].map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new KnowledgeProviderError("KNOWLEDGE_QUERY_VECTOR_VALUE_INVALID", false);
    }
    return Math.fround(item);
  });
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > L2_TOLERANCE) {
    throw new KnowledgeProviderError("KNOWLEDGE_QUERY_VECTOR_NORM_INVALID", false);
  }
  return vector;
}
