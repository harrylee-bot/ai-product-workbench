import {
  canonicalSha256,
  parseEmbeddingProfileV1,
  parseRetrievalProfileV1,
  type EmbeddingProfileV1,
  type JsonValue,
  type RetrievalProfileV1,
} from "@workbench/workbench-knowledge";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeRetrievalService } from "../src/modules/knowledge/knowledge-retrieval.service.js";
import {
  KnowledgeRetrievalError,
  type KnowledgeRetrievalDependencies,
  type KnowledgeReleasePin,
  type KnowledgeRetrievalCandidate,
  type KnowledgeRetrievalStore,
} from "../src/modules/knowledge/knowledge-retrieval.types.js";

describe("KnowledgeRetrievalService", () => {
  it("runs explicit lexical mode without dense or reranker dependencies", async () => {
    const store = fakeStore({ lexical: [candidate("chunk_a", "production")] });
    const service = serviceWith(store);

    const result = await service.retrieve(command({ mode: "lexical" }));

    expect(store.lexicalCandidates).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: "release_1",
      routes: ["production"],
      queryText: "产品 工作台",
      limit: 40,
    }));
    expect(store.denseCandidates).not.toHaveBeenCalled();
    expect(result.evidence).toMatchObject({
      mode: "lexical",
      degraded: false,
      reranker: { status: "not_requested" },
      candidateCounts: { lexical: 1, dense: 0, fused: 1 },
    });
    expect(result.items[0]?.citation).toMatchObject({
      schema: "workbench.knowledge-citation.v1",
      chunkId: "chunk_a",
      sourcePath: "00-rules/chunk_a.md",
      route: "production",
    });
  });

  it("pins the immutable embedding identity for dense query and applies reranking", async () => {
    const store = fakeStore({
      lexical: [candidate("chunk_a", "production"), candidate("chunk_b", "production")],
      dense: [candidate("chunk_b", "production"), candidate("chunk_c", "production")],
    });
    const embedQuery = vi.fn().mockResolvedValue([1, 0, 0]);
    const rerank = vi.fn().mockResolvedValue([
      { chunkId: "chunk_a", score: 0.2 },
      { chunkId: "chunk_b", score: 0.5 },
      { chunkId: "chunk_c", score: 0.9 },
    ]);
    const service = serviceWith(store, {
      queryEmbedding: { embedQuery },
      reranker: { identity: { id: "reranker-r1", revision: "commit-1" }, rerank },
    });

    const result = await service.retrieve(command());

    const pinned = parseEmbeddingProfileV1(embeddingSpec());
    expect(embedQuery).toHaveBeenCalledWith(
      expect.objectContaining({ specSha256: pinned.specSha256, dimension: 3 }),
      "Instruct: retrieve product knowledge\nQuery: 产品工作台",
      undefined,
    );
    expect(store.denseCandidates).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: "release_1",
      profileId: pinned.spec.id,
      profileSpecSha256: pinned.specSha256,
      dimension: 3,
      routes: ["production"],
      vector: [1, 0, 0],
      limit: 40,
    }));
    expect(result.items.map((item) => item.citation.chunkId)).toEqual(["chunk_c", "chunk_b", "chunk_a"]);
    expect(result.evidence).toMatchObject({
      degraded: false,
      reranker: { status: "applied", id: "reranker-r1", revision: "commit-1" },
      embeddingProfile: {
        id: pinned.spec.id,
        specSha256: pinned.specSha256,
        dimension: 3,
      },
    });
  });

  it("fails closed when hybrid embedding is not configured", async () => {
    const service = serviceWith(fakeStore());

    await expect(service.retrieve(command())).rejects.toMatchObject({
      code: "KNOWLEDGE_QUERY_EMBEDDING_NOT_CONFIGURED",
    });
  });

  it("returns explicit degraded evidence when the independent reranker fails", async () => {
    const store = fakeStore({ lexical: [candidate("chunk_a", "production")] });
    const service = serviceWith(store, {
      queryEmbedding: { async embedQuery() { return [1, 0, 0]; } },
      reranker: {
        identity: { id: "reranker-r1", revision: "commit-1" },
        async rerank() { throw new Error("provider detail must not cross the port"); },
      },
    });

    const result = await service.retrieve(command());

    expect(result.items.map((item) => item.citation.chunkId)).toEqual(["chunk_a"]);
    expect(result.evidence).toMatchObject({
      degraded: true,
      reranker: {
        status: "degraded",
        id: "reranker-r1",
        revision: "commit-1",
        reason: "RERANKER_REQUEST_FAILED",
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider detail");
  });

  it("preserves the complete RRF tie-break order when reranker scores tie", async () => {
    const store = fakeStore({
      lexical: [candidate("chunk_b", "production"), candidate("chunk_a", "production")],
      dense: [candidate("chunk_a", "production"), candidate("chunk_b", "production")],
    });
    const service = serviceWith(store, {
      queryEmbedding: { async embedQuery() { return [1, 0, 0]; } },
      reranker: {
        identity: { id: "reranker-r1", revision: "commit-1" },
        async rerank(input) {
          return input.candidates.map(({ chunkId }) => ({ chunkId, score: 0.5 }));
        },
      },
    });

    const result = await service.retrieve(command());

    expect(result.items.map((item) => item.citation.chunkId)).toEqual(["chunk_b", "chunk_a"]);
  });

  it("does not query release or candidates before project membership is proven", async () => {
    const store = fakeStore();
    const access = { findProject: vi.fn().mockRejectedValue({ status: 404 }) };
    const service = new KnowledgeRetrievalService(access as never, store, {
      segmenter: { identity: segmenterIdentity, segment: () => ["产品"] },
    });

    await expect(service.retrieve(command({ mode: "lexical" }))).rejects.toMatchObject({ status: 404 });
    expect(store.findScopedRelease).not.toHaveBeenCalled();
    expect(store.lexicalCandidates).not.toHaveBeenCalled();
  });

  it("admits source_lookup only through the explicit route scope", async () => {
    const store = fakeStore({ lexical: [candidate("chunk_source", "source_lookup")] });
    const service = serviceWith(store);

    const result = await service.retrieve(command({ mode: "lexical", routeScope: "source_lookup" }));

    expect(store.lexicalCandidates).toHaveBeenCalledWith(expect.objectContaining({
      routes: ["production", "source_lookup"],
    }));
    expect(result.items[0]?.citation.route).toBe("source_lookup");
  });

  it("rejects a release/profile identity mismatch before reading candidates", async () => {
    const store = fakeStore({
      release: { ...releasePin(), embeddingDimension: 4 },
    });
    const service = serviceWith(store);

    await expect(service.retrieve(command({ mode: "lexical" }))).rejects.toBeInstanceOf(KnowledgeRetrievalError);
    await expect(service.retrieve(command({ mode: "lexical" }))).rejects.toMatchObject({
      code: "KNOWLEDGE_RETRIEVAL_INTEGRITY_ERROR",
    });
    expect(store.lexicalCandidates).not.toHaveBeenCalled();
  });

  it("rejects a query segmenter that differs from the immutable release manifest", async () => {
    const store = fakeStore();
    const service = new KnowledgeRetrievalService(
      { findProject: vi.fn().mockResolvedValue({ workspaceId: "workspace_1" }) } as never,
      store,
      {
        segmenter: {
          identity: { ...segmenterIdentity, dictionarySha256: "7".repeat(64) },
          segment: () => ["产品"],
        },
      },
    );

    await expect(service.retrieve(command({ mode: "lexical" }))).rejects.toMatchObject({
      code: "KNOWLEDGE_RETRIEVAL_INTEGRITY_ERROR",
      safeDetail: "Release manifest segmenter pin does not match the query segmenter",
    });
    expect(store.lexicalCandidates).not.toHaveBeenCalled();
  });
});

function serviceWith(
  store: ReturnType<typeof fakeStore>,
  dependencies: Partial<Pick<KnowledgeRetrievalDependencies, "queryEmbedding" | "reranker">> = {},
) {
  return new KnowledgeRetrievalService(
    { findProject: vi.fn().mockResolvedValue({ id: "project_1", workspaceId: "workspace_1" }) } as never,
    store,
    {
      segmenter: { identity: segmenterIdentity, segment: () => ["产品", "工作台"] },
      ...dependencies,
    },
  );
}

function fakeStore(options: {
  release?: KnowledgeReleasePin;
  lexical?: readonly KnowledgeRetrievalCandidate[];
  dense?: readonly KnowledgeRetrievalCandidate[];
} = {}) {
  return {
    findScopedRelease: vi.fn().mockResolvedValue(options.release ?? releasePin()),
    lexicalCandidates: vi.fn().mockResolvedValue(options.lexical ?? []),
    denseCandidates: vi.fn().mockResolvedValue(options.dense ?? []),
  } satisfies KnowledgeRetrievalStore;
}

function command(change: Partial<Parameters<KnowledgeRetrievalService["retrieve"]>[0]> = {}) {
  return {
    principalId: "principal_1",
    projectId: "project_1",
    releaseId: "release_1",
    query: "产品工作台",
    mode: "hybrid" as const,
    routeScope: "production" as const,
    ...change,
  };
}

function releasePin(): KnowledgeReleasePin {
  const parsed = parseEmbeddingProfileV1(embeddingSpec());
  const retrieval = parseRetrievalProfileV1(retrievalSpec(parsed));
  const manifest = {
    schema: "workbench.knowledge-release.v1",
    releaseKey: "vault",
    profile: {
      embedding: { id: parsed.spec.id, specSha256: parsed.specSha256 },
      retrieval: { id: retrieval.spec.id, specSha256: retrieval.specSha256 },
      segmenter: manifestSegmenter,
    },
  } as const;
  return {
    id: "release_1",
    key: "vault",
    version: 1,
    workspaceId: "workspace_1",
    status: "ready",
    embeddingProfileId: parsed.spec.id,
    embeddingProfileSpecSha256: parsed.specSha256,
    embeddingDimension: parsed.dimension,
    retrievalProfileId: retrieval.spec.id,
    retrievalProfileSpecSha256: retrieval.specSha256,
    chunksReadyAt: new Date("2026-07-14T00:00:00Z"),
    readyAt: new Date("2026-07-14T00:01:00Z"),
    manifest,
    manifestSha256: canonicalSha256(manifest as unknown as JsonValue),
    embeddingProfile: {
      id: parsed.spec.id,
      spec: parsed.spec,
      specSha256: parsed.specSha256,
      dimension: parsed.dimension,
      status: "adopted",
    },
    retrievalProfile: {
      id: retrieval.spec.id,
      spec: retrieval.spec,
      specSha256: retrieval.specSha256,
      embeddingProfileId: retrieval.embeddingProfileId,
      embeddingProfileSpecSha256: retrieval.embeddingProfileSpecSha256,
      embeddingDimension: retrieval.embeddingDimension,
      status: "adopted",
    },
  };
}

const segmenterIdentity = {
  implementationId: "jieba-wasm/cut_for_search/hmm=false",
  version: "2.4.0",
  artifactSha256: "5".repeat(64),
  algorithm: "cut_for_search",
  hmm: false,
  dictionarySha256: "5".repeat(64),
  stopwordsSha256: "6".repeat(64),
} as const;

const manifestSegmenter = {
  id: segmenterIdentity.implementationId,
  version: segmenterIdentity.version,
  dictionaryChecksum: segmenterIdentity.dictionarySha256,
  stopwordsChecksum: segmenterIdentity.stopwordsSha256,
} as const;

function candidate(chunkId: string, route: "production" | "source_lookup"): KnowledgeRetrievalCandidate {
  return {
    chunkId,
    documentId: `document_${chunkId}`,
    sourcePath: `00-rules/${chunkId}.md`,
    sourceLocator: null,
    title: `Title ${chunkId}`,
    route,
    headingPath: ["规则"],
    chunkSequence: 0,
    content: `Content ${chunkId}`,
    lexicalScore: 0.5,
    denseScore: 0.5,
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
    model: {
      id: "integration/model",
      revision: "commit-1",
      artifactSha256: "2".repeat(64),
    },
    tokenizer: {
      id: "integration/tokenizer",
      revision: "commit-1",
      artifactSha256: "3".repeat(64),
      modelMaximumTokens: 512,
      chunkMaximumTokens: 256,
      overflow: "reject",
    },
    input: {
      queryPrefix: "Instruct: retrieve product knowledge\nQuery: ",
      documentPrefix: "",
      normalization: "utf8-nfc-lf-v1",
    },
    output: {
      dimension: 3,
      dtype: "float32",
      pooling: "cls",
      normalization: "l2",
      distance: "cosine",
    },
    batch: { maximumInputs: 32, maximumTokens: 8_192 },
    conformanceProbeSha256: "4".repeat(64),
  };
}

function retrievalSpec(
  embedding = parseEmbeddingProfileV1(embeddingSpec()),
): RetrievalProfileV1 {
  return {
    schema: "workbench.retrieval-profile.v1",
    id: "integration-retrieval-r1",
    embedding: {
      profileId: embedding.spec.id,
      profileSpecSha256: embedding.specSha256,
      dimension: embedding.dimension,
    },
    segmenter: {
      ...segmenterIdentity,
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
        id: "huggingface/text-embeddings-inference",
        version: "1.8.3",
        imageDigest: `sha256:${"7".repeat(64)}`,
      },
      model: {
        id: "reranker-r1",
        revision: "commit-1",
        artifactSha256: "8".repeat(64),
      },
      tokenizer: {
        id: "reranker-tokenizer",
        revision: "commit-1",
        artifactSha256: "9".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 24,
      finalResultLimit: 10,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "a".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
}
