import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSha256,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
} from "@workbench/workbench-knowledge";

import {
  prepareKnowledgeConformance,
  runKnowledgeConformance,
} from "./workbench-knowledge-conformance-lib.mjs";

test("conformance orchestration produces a passing report for pinned providers", async () => {
  const fixture = createFixture();
  const prepared = prepareKnowledgeConformance(fixture.input);
  const report = await runKnowledgeConformance({
    prepared,
    embedding: {
      async assertProfile(profile) {
        assert.equal(profile.spec.id, prepared.embeddingProfile.spec.id);
      },
      async embedDocuments(_profile, inputs) {
        assert.deepEqual(inputs.map((input) => input.chunkId), ["query", "document", "negative"]);
        return {
          tokenCounts: [6, 8, 5],
          vectors: [[1, 0, 0], [0.8, 0.6, 0], [0, 1, 0]],
        };
      },
    },
    reranker: {
      async rerank(input) {
        assert.equal(input.query, "产品需求评审");
        return [
          { chunkId: "partial", score: 0.61 },
          { chunkId: "negative", score: 0.1 },
          { chunkId: "relevant", score: 0.91 },
        ];
      },
    },
    now: (() => {
      const values = [100, 112, 200, 207];
      return () => values.shift() ?? 207;
    })(),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.latencyMs, { embedding: 12, rerankerCases: [7] });
  assert.equal(report.embedding.failures.length, 0);
  assert.equal(report.reranker.failures.length, 0);
});

test("conformance preparation rejects a database/provider identity mismatch before calls", () => {
  const fixture = createFixture();
  assert.throws(
    () => prepareKnowledgeConformance({
      ...fixture.input,
      expected: {
        ...fixture.input.expected,
        embeddingImageDigest: `sha256:${"f".repeat(64)}`,
      },
    }),
    /KNOWLEDGE_CONFORMANCE_IMAGE_DIGEST_MISMATCH/,
  );
});

function createFixture() {
  const embeddingProbe = {
    schema: "workbench.embedding-conformance-probe.v1",
    profileId: "conformance-embedding-r1",
    dimension: 3,
    normTolerance: 0.001,
    inputs: [
      { id: "query", kind: "query", text: "产品需求评审", tokenCount: 6 },
      { id: "document", kind: "document", text: "需求评审需要明确验收标准", tokenCount: 8 },
      { id: "negative", kind: "document", text: "unrelated weather report", tokenCount: 5 },
    ],
    cosineExpectations: [
      { leftInputId: "query", rightInputId: "document", minimum: 0.79, maximum: 0.81 },
      { leftInputId: "query", rightInputId: "negative", minimum: -0.01, maximum: 0.01 },
    ],
  };
  const embeddingSpec = {
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
    input: { queryPrefix: "query: ", documentPrefix: "passage: ", normalization: "utf8-nfc-lf-v1" },
    output: { dimension: 3, dtype: "float32", pooling: "cls", normalization: "l2", distance: "cosine" },
    batch: { maximumInputs: 8, maximumTokens: 1024 },
    conformanceProbeSha256: canonicalSha256(embeddingProbe),
  };
  const embeddingProfile = parseEmbeddingProfileV1(embeddingSpec);
  const rerankerProbe = {
    schema: "workbench.reranker-conformance-probe.v1",
    retrievalProfileId: "conformance-retrieval-r1",
    cases: [{
      id: "requirements-ranking",
      query: "产品需求评审",
      candidates: [
        { id: "relevant", text: "产品需求评审需要明确验收标准", expectedRank: 1, minimumScore: 0.8 },
        { id: "partial", text: "产品需求文档模板", expectedRank: 2 },
        { id: "negative", text: "明日天气预报", expectedRank: 3, maximumScore: 0.2 },
      ],
    }],
  };
  const retrievalSpec = {
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
      conformanceProbeSha256: canonicalSha256(rerankerProbe),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
  const retrievalProfile = parseRetrievalProfileV1(retrievalSpec);
  return {
    input: {
      embeddingRow: {
        id: embeddingProfile.spec.id,
        spec: embeddingProfile.spec,
        specSha256: embeddingProfile.specSha256,
        dimension: embeddingProfile.dimension,
        status: "adopted",
      },
      retrievalRow: {
        id: retrievalProfile.spec.id,
        spec: retrievalProfile.spec,
        specSha256: retrievalProfile.specSha256,
        embeddingProfileId: embeddingProfile.spec.id,
        embeddingProfileSpecSha256: embeddingProfile.specSha256,
        embeddingDimension: embeddingProfile.dimension,
        status: "adopted",
      },
      embeddingProbeJson: embeddingProbe,
      rerankerProbeJson: rerankerProbe,
      expected: {
        embeddingProfileId: embeddingProfile.spec.id,
        retrievalProfileId: retrievalProfile.spec.id,
        embeddingImageDigest: embeddingProfile.spec.engine.imageDigest,
        rerankerImageDigest: retrievalProfile.spec.reranker.engine.imageDigest,
      },
    },
  };
}
