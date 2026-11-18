import { setTimeout as delay } from "node:timers/promises";
import type { KnowledgeRerankerProviderConfig } from "./knowledge-retrieval.config.js";
import type {
  KnowledgeRerankerPort,
  KnowledgeRerankInput,
  KnowledgeRerankScore,
} from "./knowledge-retrieval.types.js";
import { KnowledgeProviderError, TeiJsonClient } from "./tei-json.client.js";
import { parseTeiRuntimeInfo } from "./tei-runtime-info.js";

export class TeiRerankerAdapter implements KnowledgeRerankerPort {
  readonly identity;
  private readonly client: TeiJsonClient;

  constructor(
    private readonly config: KnowledgeRerankerProviderConfig,
    request: typeof fetch = fetch,
  ) {
    this.identity = Object.freeze({ id: config.modelId, revision: config.modelRevision });
    this.client = new TeiJsonClient(config, request);
  }

  async rerank(input: KnowledgeRerankInput, signal?: AbortSignal): Promise<readonly KnowledgeRerankScore[]> {
    // TEI reserves one concurrency permit per query/document pair. A single
    // otherwise legal client batch can exceed the server's permit capacity.
    let batchSize = await this.assertReady(input.candidates.length, signal);
    const scores: KnowledgeRerankScore[] = [];
    let busyRetries = 0;
    for (let offset = 0; offset < input.candidates.length;) {
      const candidates = input.candidates.slice(offset, offset + batchSize);
      try {
        const response = await this.client.requestJson("/rerank", {
          method: "POST",
          body: JSON.stringify({
            query: input.query, texts: candidates.map(candidate => candidate.content),
            truncate: false, raw_scores: false, return_text: false,
          }),
        }, signal);
        scores.push(...parseRerankerScores(response, candidates));
        offset += candidates.length;
      } catch (error) {
        if (!(error instanceof KnowledgeProviderError) || error.code !== "KNOWLEDGE_PROVIDER_HTTP_429" || busyRetries >= 3) throw error;
        // Other API requests may already hold the advertised permits. Retry
        // only the rejected batch; completed pairs retain their original scores.
        batchSize = Math.max(1, Math.floor(batchSize / 2));
        await delay(250 * 2 ** busyRetries, undefined, { signal });
        busyRetries++;
      }
    }
    return scores;
  }

  async assertReady(candidateCount: number, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) {
      throw new KnowledgeProviderError("KNOWLEDGE_RERANKER_BATCH_SIZE_INVALID", false);
    }
    const info = parseTeiRuntimeInfo(await this.client.requestJson("/info", { method: "GET" }, signal));
    if (
      info.model_id !== this.config.modelId
      || info.model_sha !== this.config.modelRevision
      || info.version !== this.config.teiVersion
      || info.max_input_length < this.config.maximumInputTokens
    ) {
      throw new KnowledgeProviderError("KNOWLEDGE_RERANKER_IDENTITY_MISMATCH", false);
    }
    return Math.min(candidateCount, info.max_client_batch_size,
      info.max_concurrent_requests ?? candidateCount, info.max_batch_requests ?? candidateCount);
  }
}

function parseRerankerScores(
  value: unknown,
  candidates: KnowledgeRerankInput["candidates"],
): readonly KnowledgeRerankScore[] {
  if (!Array.isArray(value) || value.length !== candidates.length) {
    throw new KnowledgeProviderError("KNOWLEDGE_RERANKER_RESPONSE_INVALID", false);
  }
  const seen = new Set<number>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new KnowledgeProviderError("KNOWLEDGE_RERANKER_RESPONSE_INVALID", false);
    }
    const { index, score } = item as { index?: unknown; score?: unknown };
    if (
      !Number.isSafeInteger(index)
      || (index as number) < 0
      || (index as number) >= candidates.length
      || seen.has(index as number)
      || typeof score !== "number"
      || !Number.isFinite(score)
    ) {
      throw new KnowledgeProviderError("KNOWLEDGE_RERANKER_RESPONSE_INVALID", false);
    }
    seen.add(index as number);
    return { chunkId: candidates[index as number]!.chunkId, score };
  });
}
