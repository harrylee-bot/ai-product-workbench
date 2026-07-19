import { describe, expect, it } from "vitest";

import {
  KnowledgeConformanceContractError,
  canonicalSha256,
  embeddingConformanceInputs,
  evaluateEmbeddingConformance,
  evaluateRerankerConformance,
  parseEmbeddingConformanceProbeV1,
  parseEmbeddingProfileV1,
  parseRerankerConformanceProbeV1,
  parseRetrievalProfileV1,
  type JsonValue,
} from "../src/index.js";

const embeddingProbe = {
  schema: "workbench.embedding-conformance-probe.v1",
  profileId: "embedding-conformance-r1",
  dimension: 3,
  normTolerance: 0.001,
  inputs: [
    { id: "zh-query", kind: "query", text: "产品需求评审", tokenCount: 6 },
    { id: "zh-document", kind: "document", text: "需求评审需要验收标准", tokenCount: 8 },
    { id: "en-negative", kind: "document", text: "unrelated weather report", tokenCount: 5 },
  ],
  cosineExpectations: [
    { leftInputId: "zh-query", rightInputId: "zh-document", minimum: 0.79, maximum: 0.81 },
    { leftInputId: "zh-query", rightInputId: "en-negative", minimum: -0.01, maximum: 0.01 },
  ],
} as const;

const embeddingProfile = parseEmbeddingProfileV1({
  schema: "workbench.embedding-profile.v1",
  id: embeddingProbe.profileId,
  protocol: "tei.embed.v1",
  engine: {
    id: "text-embeddings-inference",
    version: "1.8.3",
    imageDigest: `sha256:${"1".repeat(64)}`,
  },
  model: {
    id: "example/embedding-model",
    revision: "model-revision-1",
    artifactSha256: "2".repeat(64),
  },
  tokenizer: {
    id: "example/embedding-tokenizer",
    revision: "tokenizer-revision-1",
    artifactSha256: "3".repeat(64),
    modelMaximumTokens: 512,
    chunkMaximumTokens: 128,
    overflow: "reject",
  },
  input: {
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    normalization: "utf8-nfc-lf-v1",
  },
  output: {
    dimension: embeddingProbe.dimension,
    dtype: "float32",
    pooling: "cls",
    normalization: "l2",
    distance: "cosine",
  },
  batch: { maximumInputs: 8, maximumTokens: 1024 },
  conformanceProbeSha256: canonicalSha256(embeddingProbe as unknown as JsonValue),
});

const rerankerProbe = {
  schema: "workbench.reranker-conformance-probe.v1",
  retrievalProfileId: "retrieval-conformance-r1",
  cases: [{
    id: "requirements-ranking",
    query: "产品需求评审",
    candidates: [
      { id: "relevant", text: "产品需求评审需要明确验收标准", expectedRank: 1, minimumScore: 0.8 },
      { id: "partial", text: "产品需求文档模板", expectedRank: 2 },
      { id: "negative", text: "明日天气预报", expectedRank: 3, maximumScore: 0.2 },
    ],
  }],
} as const;

const retrievalProfile = parseRetrievalProfileV1({
  schema: "workbench.retrieval-profile.v1",
  id: rerankerProbe.retrievalProfileId,
  embedding: {
    profileId: embeddingProfile.spec.id,
    profileSpecSha256: embeddingProfile.specSha256,
    dimension: embeddingProfile.dimension,
  },
  segmenter: {
    implementationId: "jieba-wasm",
    version: "2.4.0",
    artifactSha256: "4".repeat(64),
    algorithm: "cut_for_search",
    hmm: false,
    dictionarySha256: "4".repeat(64),
    stopwordsSha256: "5".repeat(64),
    normalization: "utf8-nfc-lf-v1",
  },
  recall: {
    lexical: { algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1", limit: 40 },
    dense: { distance: "cosine", limit: 40 },
    fusion: { algorithm: "rrf", k: 60, tieBreak: "workbench-rrf-v1" },
  },
  reranker: {
    protocol: "tei.rerank.v1",
    engine: {
      id: "text-embeddings-inference",
      version: "1.8.3",
      imageDigest: `sha256:${"6".repeat(64)}`,
    },
    model: {
      id: "example/reranker-model",
      revision: "reranker-revision-1",
      artifactSha256: "7".repeat(64),
    },
    tokenizer: {
      id: "example/reranker-tokenizer",
      revision: "reranker-tokenizer-revision-1",
      artifactSha256: "8".repeat(64),
      maximumInputTokens: 512,
      overflow: "reject",
    },
    candidateLimit: 24,
    finalResultLimit: 10,
    failurePolicy: "degrade_to_rrf",
    conformanceProbeSha256: canonicalSha256(rerankerProbe as unknown as JsonValue),
  },
  routingPolicy: "workbench-knowledge-route-v1",
  citationSchema: "workbench.knowledge-citation.v1",
});

describe("Knowledge provider conformance contracts", () => {
  it("binds an embedding probe to its immutable profile and renders profile prefixes", () => {
    const parsed = parseEmbeddingConformanceProbeV1(embeddingProbe, embeddingProfile);

    expect(embeddingConformanceInputs(parsed, embeddingProfile)).toEqual([
      "query: 产品需求评审",
      "passage: 需求评审需要验收标准",
      "passage: unrelated weather report",
    ]);
    expect(() => parseEmbeddingConformanceProbeV1({
      ...embeddingProbe,
      normTolerance: 0.002,
    }, embeddingProfile)).toThrowError(KnowledgeConformanceContractError);
  });

  it("reports embedding token, norm and cosine conformance without hiding failures", () => {
    const parsed = parseEmbeddingConformanceProbeV1(embeddingProbe, embeddingProfile);
    const passed = evaluateEmbeddingConformance(parsed, {
      tokenCounts: [6, 8, 5],
      vectors: [[1, 0, 0], [0.8, 0.6, 0], [0, 1, 0]],
    });
    const failed = evaluateEmbeddingConformance(parsed, {
      tokenCounts: [7, 8, 5],
      vectors: [[1, 0, 0], [0, 1, 0], [0, 1, 0]],
    });

    expect(passed.passed).toBe(true);
    expect(passed.failures).toEqual([]);
    expect(failed.passed).toBe(false);
    expect(failed.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("TOKEN_COUNT_MISMATCH:zh-query"),
      expect.stringContaining("COSINE_OUT_OF_RANGE:zh-query:zh-document"),
    ]));
  });

  it("binds reranker cases to the RetrievalProfile and evaluates stable ordering", () => {
    const parsed = parseRerankerConformanceProbeV1(rerankerProbe, retrievalProfile);
    const passed = evaluateRerankerConformance(parsed, [{
      caseId: "requirements-ranking",
      scores: [
        { candidateId: "partial", score: 0.61 },
        { candidateId: "negative", score: 0.1 },
        { candidateId: "relevant", score: 0.91 },
      ],
    }]);
    const failed = evaluateRerankerConformance(parsed, [{
      caseId: "requirements-ranking",
      scores: [
        { candidateId: "partial", score: 0.95 },
        { candidateId: "negative", score: 0.3 },
        { candidateId: "relevant", score: 0.7 },
      ],
    }]);

    expect(passed.passed).toBe(true);
    expect(passed.cases[0]?.ranking.map((item) => item.candidateId)).toEqual([
      "relevant",
      "partial",
      "negative",
    ]);
    expect(failed.passed).toBe(false);
    expect(failed.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("RERANK_ORDER_MISMATCH"),
      expect.stringContaining("RERANK_SCORE_BELOW_MINIMUM"),
      expect.stringContaining("RERANK_SCORE_ABOVE_MAXIMUM"),
    ]));
  });
});
