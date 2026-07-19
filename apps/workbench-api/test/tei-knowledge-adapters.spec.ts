import {
  parseEmbeddingProfileV1,
  type EmbeddingProfileV1,
} from "@workbench/workbench-knowledge";
import { TeiQueryEmbeddingAdapter } from "../src/modules/knowledge/tei-query-embedding.adapter.js";
import { TeiRerankerAdapter } from "../src/modules/knowledge/tei-reranker.adapter.js";
import { KnowledgeProviderError } from "../src/modules/knowledge/tei-json.client.js";

const profile = parseEmbeddingProfileV1(embeddingSpec());

describe("Knowledge TEI adapters", () => {
  it("validates the pinned embedding runtime, token budget, vector dimension and norm", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/info")) return jsonResponse(embeddingInfo());
      if (url.endsWith("/tokenize")) return jsonResponse([[{ id: 1 }, { id: 2 }]]);
      if (url.endsWith("/embed")) return jsonResponse([[1, 0, 0]]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const adapter = new TeiQueryEmbeddingAdapter({
      ...serviceConfig("https://embedding.test"),
      imageDigest: profile.spec.engine.imageDigest!,
      profileId: profile.spec.id,
      profileSpecSha256: profile.specSha256,
    }, request);

    await expect(adapter.embedQuery(profile, "query:产品工作台")).resolves.toEqual([1, 0, 0]);
    expect(requests.map((item) => item.url)).toEqual([
      "https://embedding.test/info",
      "https://embedding.test/tokenize",
      "https://embedding.test/embed",
    ]);
    expect(requests[2]?.body).toEqual({
      inputs: ["query:产品工作台"],
      dimensions: 3,
      normalize: true,
      truncate: false,
    });
  });

  it("uses a separately pinned reranker and maps provider indexes back to chunk ids", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/info")) return jsonResponse(rerankerInfo());
      if (url.endsWith("/rerank")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          query: "产品工作台",
          texts: ["first", "second"],
          truncate: false,
          raw_scores: false,
          return_text: false,
        });
        return jsonResponse([{ index: 1, score: 0.9 }, { index: 0, score: 0.4 }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const adapter = new TeiRerankerAdapter(rerankerConfig(), request);

    await expect(adapter.rerank({
      query: "产品工作台",
      candidates: [
        { chunkId: "chunk_1", content: "first" },
        { chunkId: "chunk_2", content: "second" },
      ],
    })).resolves.toEqual([
      { chunkId: "chunk_2", score: 0.9 },
      { chunkId: "chunk_1", score: 0.4 },
    ]);
  });

  it("drops provider response details from failures", async () => {
    const request = vi.fn(async () => jsonResponse({ secret: "provider-secret", detail: "raw failure" }, 503));
    const adapter = new TeiQueryEmbeddingAdapter({
      ...serviceConfig("https://embedding.test"),
      imageDigest: profile.spec.engine.imageDigest!,
      profileId: profile.spec.id,
      profileSpecSha256: profile.specSha256,
    }, request);

    const error = await adapter.embedQuery(profile, "query").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(KnowledgeProviderError);
    expect(error).toMatchObject({ code: "KNOWLEDGE_PROVIDER_HTTP_503", retryable: true });
    expect(JSON.stringify(error)).not.toContain("provider-secret");
    expect(String(error)).not.toContain("raw failure");
  });
});

function serviceConfig(origin: string) {
  return {
    origin,
    requestTimeoutMs: 1_000,
    maximumRequestBytes: 64 * 1_024,
    maximumResponseBytes: 64 * 1_024,
  };
}

function rerankerConfig() {
  return {
    ...serviceConfig("https://reranker.test"),
    imageDigest: `sha256:${"7".repeat(64)}`,
    modelId: "BAAI/bge-reranker-v2-m3",
    modelRevision: "commit-reranker-r1",
    teiVersion: "1.8.3",
    maximumInputTokens: 512,
  };
}

function embeddingInfo() {
  return {
    model_id: profile.spec.model.id,
    model_sha: profile.spec.model.revision,
    version: profile.spec.engine.version,
    max_input_length: 512,
    max_batch_tokens: 8_192,
    max_client_batch_size: 32,
    auto_truncate: false,
  };
}

function rerankerInfo() {
  return {
    model_id: "BAAI/bge-reranker-v2-m3",
    model_sha: "commit-reranker-r1",
    version: "1.8.3",
    max_input_length: 512,
    max_batch_tokens: 8_192,
    max_client_batch_size: 24,
    auto_truncate: false,
  };
}

function embeddingSpec(): EmbeddingProfileV1 {
  return {
    schema: "workbench.embedding-profile.v1",
    id: "integration-embedding-r1",
    protocol: "tei.embed.v1",
    engine: {
      id: "huggingface/text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"1".repeat(64)}`,
    },
    model: { id: "integration/model", revision: "commit-r1", artifactSha256: "2".repeat(64) },
    tokenizer: {
      id: "integration/tokenizer",
      revision: "commit-r1",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 512,
      chunkMaximumTokens: 256,
      overflow: "reject",
    },
    input: { queryPrefix: "query:", documentPrefix: "passage:", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 32, maximumTokens: 8_192 },
    conformanceProbeSha256: "4".repeat(64),
  };
}

function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "content-type": "application/json" } });
}
