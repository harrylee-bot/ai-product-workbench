import { canonicalJson, sha256 } from "./checksum.js";
import type { JsonValue } from "./types.js";
import type { KnowledgeRetrievalPolicy } from "./retrieval.js";

export interface RetrievalProfileV1 {
  readonly schema: "workbench.retrieval-profile.v1";
  readonly id: string;
  readonly embedding: {
    readonly profileId: string;
    readonly profileSpecSha256: string;
    readonly dimension: number;
  };
  readonly segmenter: {
    readonly implementationId: string;
    readonly version: string;
    readonly artifactSha256: string;
    readonly algorithm: "cut_for_search";
    readonly hmm: false;
    readonly dictionarySha256: string;
    readonly stopwordsSha256: string;
    readonly normalization: "utf8-nfc-lf-v1";
  };
  readonly recall: {
    readonly lexical: {
      readonly algorithm: "plainto_tsquery-simple-ts_rank_cd-32-v1";
      readonly limit: number;
    };
    readonly dense: {
      readonly distance: "cosine";
      readonly limit: number;
    };
    readonly fusion: {
      readonly algorithm: "rrf";
      readonly k: number;
      readonly tieBreak: "workbench-rrf-v1";
    };
  };
  readonly reranker: {
    readonly protocol: "tei.rerank.v1";
    readonly engine: {
      readonly id: string;
      readonly version: string;
      readonly imageDigest: string;
    };
    readonly model: {
      readonly id: string;
      readonly revision: string;
      readonly artifactSha256: string;
    };
    readonly tokenizer: {
      readonly id: string;
      readonly revision: string;
      readonly artifactSha256: string;
      readonly maximumInputTokens: number;
      readonly overflow: "reject";
    };
    readonly candidateLimit: number;
    readonly finalResultLimit: number;
    readonly failurePolicy: "degrade_to_rrf";
    readonly conformanceProbeSha256: string;
  };
  readonly routingPolicy: "workbench-knowledge-route-v1";
  readonly citationSchema: "workbench.knowledge-citation.v1";
}

export interface CanonicalRetrievalProfileV1 {
  readonly spec: RetrievalProfileV1;
  readonly canonicalJson: string;
  readonly specSha256: string;
  readonly embeddingProfileId: string;
  readonly embeddingProfileSpecSha256: string;
  readonly embeddingDimension: number;
}

export class RetrievalProfileContractError extends TypeError {
  readonly code = "RETRIEVAL_PROFILE_INVALID";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "RetrievalProfileContractError";
  }
}

const mutableRevisionAliases = new Set(["default", "head", "latest", "main", "master"]);

export function parseRetrievalProfileV1(input: unknown): CanonicalRetrievalProfileV1 {
  const root = strictObject(input, "$", [
    "schema",
    "id",
    "embedding",
    "segmenter",
    "recall",
    "reranker",
    "routingPolicy",
    "citationSchema",
  ]);
  literal(root.schema, "workbench.retrieval-profile.v1", "$.schema");

  const embedding = strictObject(root.embedding, "$.embedding", [
    "profileId",
    "profileSpecSha256",
    "dimension",
  ]);
  const segmenter = strictObject(root.segmenter, "$.segmenter", [
    "implementationId",
    "version",
    "artifactSha256",
    "algorithm",
    "hmm",
    "dictionarySha256",
    "stopwordsSha256",
    "normalization",
  ]);
  const recall = strictObject(root.recall, "$.recall", ["lexical", "dense", "fusion"]);
  const lexical = strictObject(recall.lexical, "$.recall.lexical", ["algorithm", "limit"]);
  const dense = strictObject(recall.dense, "$.recall.dense", ["distance", "limit"]);
  const fusion = strictObject(recall.fusion, "$.recall.fusion", ["algorithm", "k", "tieBreak"]);
  const reranker = strictObject(root.reranker, "$.reranker", [
    "protocol",
    "engine",
    "model",
    "tokenizer",
    "candidateLimit",
    "finalResultLimit",
    "failurePolicy",
    "conformanceProbeSha256",
  ]);
  const rerankerEngine = strictObject(reranker.engine, "$.reranker.engine", [
    "id",
    "version",
    "imageDigest",
  ]);
  const rerankerModel = strictObject(reranker.model, "$.reranker.model", [
    "id",
    "revision",
    "artifactSha256",
  ]);
  const rerankerTokenizer = strictObject(reranker.tokenizer, "$.reranker.tokenizer", [
    "id",
    "revision",
    "artifactSha256",
    "maximumInputTokens",
    "overflow",
  ]);

  const lexicalLimit = positiveSafeInteger(lexical.limit, "$.recall.lexical.limit", 100_000);
  const denseLimit = positiveSafeInteger(dense.limit, "$.recall.dense.limit", 100_000);
  const candidateLimit = positiveSafeInteger(reranker.candidateLimit, "$.reranker.candidateLimit", 100_000);
  const finalResultLimit = positiveSafeInteger(reranker.finalResultLimit, "$.reranker.finalResultLimit", 12);
  if (candidateLimit > lexicalLimit + denseLimit) {
    fail("$.reranker.candidateLimit", "must not exceed the combined lexical and dense candidate limits");
  }
  if (finalResultLimit > candidateLimit) {
    fail("$.reranker.finalResultLimit", "must not exceed reranker.candidateLimit");
  }

  const spec: RetrievalProfileV1 = {
    schema: "workbench.retrieval-profile.v1",
    id: profileId(root.id, "$.id"),
    embedding: {
      profileId: profileId(embedding.profileId, "$.embedding.profileId"),
      profileSpecSha256: digest(embedding.profileSpecSha256, "$.embedding.profileSpecSha256"),
      dimension: positiveSafeInteger(embedding.dimension, "$.embedding.dimension", 16_000),
    },
    segmenter: {
      implementationId: text(segmenter.implementationId, "$.segmenter.implementationId"),
      version: immutableRevision(segmenter.version, "$.segmenter.version"),
      artifactSha256: digest(segmenter.artifactSha256, "$.segmenter.artifactSha256"),
      algorithm: literal(segmenter.algorithm, "cut_for_search", "$.segmenter.algorithm"),
      hmm: literal(segmenter.hmm, false, "$.segmenter.hmm"),
      dictionarySha256: digest(segmenter.dictionarySha256, "$.segmenter.dictionarySha256"),
      stopwordsSha256: digest(segmenter.stopwordsSha256, "$.segmenter.stopwordsSha256"),
      normalization: literal(segmenter.normalization, "utf8-nfc-lf-v1", "$.segmenter.normalization"),
    },
    recall: {
      lexical: {
        algorithm: literal(
          lexical.algorithm,
          "plainto_tsquery-simple-ts_rank_cd-32-v1",
          "$.recall.lexical.algorithm",
        ),
        limit: lexicalLimit,
      },
      dense: {
        distance: literal(dense.distance, "cosine", "$.recall.dense.distance"),
        limit: denseLimit,
      },
      fusion: {
        algorithm: literal(fusion.algorithm, "rrf", "$.recall.fusion.algorithm"),
        k: positiveSafeInteger(fusion.k, "$.recall.fusion.k", 1_000_000),
        tieBreak: literal(fusion.tieBreak, "workbench-rrf-v1", "$.recall.fusion.tieBreak"),
      },
    },
    reranker: {
      protocol: literal(reranker.protocol, "tei.rerank.v1", "$.reranker.protocol"),
      engine: {
        id: text(rerankerEngine.id, "$.reranker.engine.id"),
        version: immutableRevision(rerankerEngine.version, "$.reranker.engine.version"),
        imageDigest: imageDigest(rerankerEngine.imageDigest, "$.reranker.engine.imageDigest"),
      },
      model: {
        id: text(rerankerModel.id, "$.reranker.model.id"),
        revision: immutableRevision(rerankerModel.revision, "$.reranker.model.revision"),
        artifactSha256: digest(rerankerModel.artifactSha256, "$.reranker.model.artifactSha256"),
      },
      tokenizer: {
        id: text(rerankerTokenizer.id, "$.reranker.tokenizer.id"),
        revision: immutableRevision(rerankerTokenizer.revision, "$.reranker.tokenizer.revision"),
        artifactSha256: digest(
          rerankerTokenizer.artifactSha256,
          "$.reranker.tokenizer.artifactSha256",
        ),
        maximumInputTokens: positiveSafeInteger(
          rerankerTokenizer.maximumInputTokens,
          "$.reranker.tokenizer.maximumInputTokens",
          131_072,
        ),
        overflow: literal(rerankerTokenizer.overflow, "reject", "$.reranker.tokenizer.overflow"),
      },
      candidateLimit,
      finalResultLimit,
      failurePolicy: literal(reranker.failurePolicy, "degrade_to_rrf", "$.reranker.failurePolicy"),
      conformanceProbeSha256: digest(
        reranker.conformanceProbeSha256,
        "$.reranker.conformanceProbeSha256",
      ),
    },
    routingPolicy: literal(root.routingPolicy, "workbench-knowledge-route-v1", "$.routingPolicy"),
    citationSchema: literal(root.citationSchema, "workbench.knowledge-citation.v1", "$.citationSchema"),
  };
  const serialized = canonicalJson(spec as unknown as JsonValue);
  return deepFreeze({
    spec,
    canonicalJson: serialized,
    specSha256: sha256(serialized),
    embeddingProfileId: spec.embedding.profileId,
    embeddingProfileSpecSha256: spec.embedding.profileSpecSha256,
    embeddingDimension: spec.embedding.dimension,
  });
}

/**
 * Derive the executable query policy from the immutable profile pin.
 * Keeping this conversion beside the profile contract prevents a runtime
 * default from silently diverging from the profile recorded in a release.
 */
export function knowledgeRetrievalPolicyFromProfile(
  profile: CanonicalRetrievalProfileV1,
): KnowledgeRetrievalPolicy {
  return Object.freeze({
    lexicalCandidateLimit: profile.spec.recall.lexical.limit,
    denseCandidateLimit: profile.spec.recall.dense.limit,
    reciprocalRankK: profile.spec.recall.fusion.k,
    rerankCandidateLimit: profile.spec.reranker.candidateLimit,
    finalResultLimit: profile.spec.reranker.finalResultLimit,
  });
}

function strictObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed by retrieval-profile.v1");
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "is required");
  }
  return record;
}

function text(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (!value || value.length > maximum) fail(path, `must contain between 1 and ${maximum} characters`);
  if (value !== value.trim()) fail(path, "must not contain surrounding whitespace");
  if (value !== value.normalize("NFC")) fail(path, "must be NFC normalized");
  if (/[\u0000-\u001f\u007f]/u.test(value)) fail(path, "must not contain control characters");
  return value;
}

function profileId(value: unknown, path: string): string {
  const id = text(value, path, 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    fail(path, "must be a lowercase stable identifier containing only letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}

function immutableRevision(value: unknown, path: string): string {
  const revision = text(value, path, 256);
  if (mutableRevisionAliases.has(revision.toLocaleLowerCase("en-US"))) {
    fail(path, "must pin an immutable revision instead of a mutable alias");
  }
  return revision;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(path, "must be a lowercase SHA-256 digest");
  }
  return value;
}

function imageDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail(path, "must be a sha256:<lowercase hex> image digest");
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(path, `must be a positive safe integer no greater than ${maximum}`);
  }
  return value as number;
}

function literal<const T extends string | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function fail(path: string, message: string): never {
  throw new RetrievalProfileContractError(path, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
