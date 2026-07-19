import { describe, expect, it } from "vitest";
import {
  RetrievalProfileContractError,
  parseRetrievalProfileV1,
  type RetrievalProfileV1,
} from "../src/index.js";

describe("RetrievalProfile v1", () => {
  it("canonicalizes and hashes the complete immutable retrieval identity", () => {
    const parsed = parseRetrievalProfileV1(profile());

    expect(parsed.spec.id).toBe("knowledge-hybrid-r1");
    expect(parsed.specSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(parsed.canonicalJson)).toEqual(parsed.spec);
    expect(parsed).toMatchObject({
      embeddingProfileId: "qwen3-embedding-0.6b-1024-r1",
      embeddingProfileSpecSha256: "1".repeat(64),
      embeddingDimension: 1_024,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.spec.reranker.model)).toBe(true);
  });

  it("produces the same identity regardless of input property order", () => {
    const original = profile();
    const reordered = {
      citationSchema: original.citationSchema,
      routingPolicy: original.routingPolicy,
      reranker: original.reranker,
      recall: original.recall,
      segmenter: original.segmenter,
      embedding: original.embedding,
      id: original.id,
      schema: original.schema,
    };

    expect(parseRetrievalProfileV1(reordered).specSha256).toBe(
      parseRetrievalProfileV1(original).specSha256,
    );
  });

  it("changes identity when any pinned retrieval behavior changes", () => {
    const original = parseRetrievalProfileV1(profile()).specSha256;
    const variants = [
      { segmenter: { stopwordsSha256: "9".repeat(64) } },
      { recall: { lexical: { limit: 41 } } },
      { recall: { fusion: { k: 61 } } },
      { reranker: { model: { revision: "commit-reranker-r2" } } },
      { reranker: { finalResultLimit: 11 } },
    ].map((change) => parseRetrievalProfileV1(merge(profile(), change)).specSha256);

    expect(new Set([original, ...variants])).toHaveLength(variants.length + 1);
  });

  it("rejects a missing nested field instead of applying a default", () => {
    const candidate = structuredClone(profile()) as unknown as Record<string, unknown>;
    const reranker = candidate.reranker as Record<string, unknown>;
    const model = reranker.model as Record<string, unknown>;
    delete model.artifactSha256;

    expect(() => parseRetrievalProfileV1(candidate)).toThrow("$.reranker.model.artifactSha256");
    expect(() => parseRetrievalProfileV1(candidate)).toThrow("is required");
  });

  it.each([
    ["unknown root field", { extra: true }, "$.extra"],
    ["unknown nested field", { reranker: { extra: true } }, "$.reranker.extra"],
    ["invalid schema", { schema: "workbench.retrieval-profile.v2" }, "$.schema"],
    ["invalid profile id", { id: "Knowledge Hybrid" }, "$.id"],
    ["invalid embedding dimension", { embedding: { dimension: 16_001 } }, "$.embedding.dimension"],
    ["mutable segmenter version", { segmenter: { version: "latest" } }, "$.segmenter.version"],
    ["mutable TEI version", { reranker: { engine: { version: "main" } } }, "$.reranker.engine.version"],
    ["mutable model revision", { reranker: { model: { revision: "HEAD" } } }, "$.reranker.model.revision"],
    ["mutable tokenizer revision", { reranker: { tokenizer: { revision: "master" } } }, "$.reranker.tokenizer.revision"],
    ["invalid segmenter artifact", { segmenter: { artifactSha256: "unverified" } }, "$.segmenter.artifactSha256"],
    ["invalid dictionary artifact", { segmenter: { dictionarySha256: "2".repeat(63) } }, "$.segmenter.dictionarySha256"],
    ["invalid stopword artifact", { segmenter: { stopwordsSha256: "2".repeat(63) } }, "$.segmenter.stopwordsSha256"],
    ["invalid embedding profile digest", { embedding: { profileSpecSha256: "1".repeat(63) } }, "$.embedding.profileSpecSha256"],
    ["zero lexical limit", { recall: { lexical: { limit: 0 } } }, "$.recall.lexical.limit"],
    ["fractional dense limit", { recall: { dense: { limit: 1.5 } } }, "$.recall.dense.limit"],
    ["zero RRF constant", { recall: { fusion: { k: 0 } } }, "$.recall.fusion.k"],
    ["invalid reranker image", { reranker: { engine: { imageDigest: "latest" } } }, "$.reranker.engine.imageDigest"],
    ["invalid reranker model artifact", { reranker: { model: { artifactSha256: "mutable" } } }, "$.reranker.model.artifactSha256"],
    ["invalid reranker tokenizer artifact", { reranker: { tokenizer: { artifactSha256: "mutable" } } }, "$.reranker.tokenizer.artifactSha256"],
    ["invalid reranker token budget", { reranker: { tokenizer: { maximumInputTokens: 131_073 } } }, "$.reranker.tokenizer.maximumInputTokens"],
    ["invalid failure policy", { reranker: { failurePolicy: "ignore" } }, "$.reranker.failurePolicy"],
    ["invalid probe digest", { reranker: { conformanceProbeSha256: "mutable" } }, "$.reranker.conformanceProbeSha256"],
    ["final limit beyond rerank candidates", { reranker: { candidateLimit: 8, finalResultLimit: 9 } }, "$.reranker.finalResultLimit"],
    ["final limit beyond result contract", { reranker: { candidateLimit: 24, finalResultLimit: 13 } }, "$.reranker.finalResultLimit"],
    ["rerank pool beyond recall pool", { recall: { lexical: { limit: 4 }, dense: { limit: 4 } }, reranker: { candidateLimit: 9 } }, "$.reranker.candidateLimit"],
  ] as const)("rejects %s", (_name, change, expectedPath) => {
    const candidate = merge(profile(), change);
    expect(() => parseRetrievalProfileV1(candidate)).toThrow(RetrievalProfileContractError);
    expect(() => parseRetrievalProfileV1(candidate)).toThrow(expectedPath);
  });

  it.each([
    ["segmenter mode", { segmenter: { algorithm: "cut" } }, "$.segmenter.algorithm"],
    ["segmenter HMM", { segmenter: { hmm: true } }, "$.segmenter.hmm"],
    ["lexical semantics", { recall: { lexical: { algorithm: "websearch" } } }, "$.recall.lexical.algorithm"],
    ["dense distance", { recall: { dense: { distance: "l2" } } }, "$.recall.dense.distance"],
    ["fusion algorithm", { recall: { fusion: { algorithm: "weighted" } } }, "$.recall.fusion.algorithm"],
    ["fusion tie break", { recall: { fusion: { tieBreak: "provider-order" } } }, "$.recall.fusion.tieBreak"],
    ["reranker protocol", { reranker: { protocol: "openai.rerank.v1" } }, "$.reranker.protocol"],
    ["token overflow", { reranker: { tokenizer: { overflow: "truncate" } } }, "$.reranker.tokenizer.overflow"],
    ["routing policy", { routingPolicy: "mutable" }, "$.routingPolicy"],
    ["citation schema", { citationSchema: "mutable" }, "$.citationSchema"],
  ] as const)("pins %s", (_name, change, expectedPath) => {
    expect(() => parseRetrievalProfileV1(merge(profile(), change))).toThrow(expectedPath);
  });
});

function profile(): RetrievalProfileV1 {
  return {
    schema: "workbench.retrieval-profile.v1",
    id: "knowledge-hybrid-r1",
    embedding: {
      profileId: "qwen3-embedding-0.6b-1024-r1",
      profileSpecSha256: "1".repeat(64),
      dimension: 1_024,
    },
    segmenter: {
      implementationId: "jieba-wasm",
      version: "2.4.0",
      artifactSha256: "2".repeat(64),
      algorithm: "cut_for_search",
      hmm: false,
      dictionarySha256: "3".repeat(64),
      stopwordsSha256: "4".repeat(64),
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
        imageDigest: `sha256:${"5".repeat(64)}`,
      },
      model: {
        id: "BAAI/bge-reranker-v2-m3",
        revision: "commit-reranker-r1",
        artifactSha256: "6".repeat(64),
      },
      tokenizer: {
        id: "BAAI/bge-reranker-v2-m3",
        revision: "commit-reranker-r1",
        artifactSha256: "7".repeat(64),
        maximumInputTokens: 512,
        overflow: "reject",
      },
      candidateLimit: 24,
      finalResultLimit: 10,
      failurePolicy: "degrade_to_rrf",
      conformanceProbeSha256: "8".repeat(64),
    },
    routingPolicy: "workbench-knowledge-route-v1",
    citationSchema: "workbench.knowledge-citation.v1",
  };
}

function merge(base: RetrievalProfileV1, change: Readonly<Record<string, unknown>>): unknown {
  return mergeObject(structuredClone(base) as unknown as Record<string, unknown>, change);
}

function mergeObject(
  base: Record<string, unknown>,
  change: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(change)) {
    if (
      key in base
      && isObject(base[key])
      && isObject(value)
    ) {
      base[key] = mergeObject(base[key] as Record<string, unknown>, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
