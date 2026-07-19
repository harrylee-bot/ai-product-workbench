import { canonicalSha256 } from "./checksum.js";
import type { CanonicalEmbeddingProfileV1 } from "./embedding-profile.js";
import type { CanonicalRetrievalProfileV1 } from "./retrieval-profile.js";
import type { JsonValue } from "./types.js";

export type EmbeddingConformanceProbeV1 = {
  readonly schema: "workbench.embedding-conformance-probe.v1";
  readonly profileId: string;
  readonly dimension: number;
  readonly normTolerance: number;
  readonly inputs: readonly {
    readonly id: string;
    readonly kind: "query" | "document";
    readonly text: string;
    readonly tokenCount: number;
  }[];
  readonly cosineExpectations: readonly {
    readonly leftInputId: string;
    readonly rightInputId: string;
    readonly minimum: number;
    readonly maximum: number;
  }[];
};

export type EmbeddingConformanceResult = {
  readonly tokenCounts: readonly number[];
  readonly vectors: readonly (readonly number[])[];
};

export type EmbeddingConformanceReport = {
  readonly schema: "workbench.embedding-conformance-report.v1";
  readonly passed: boolean;
  readonly probeSha256: string;
  readonly failures: readonly string[];
  readonly inputs: readonly {
    readonly id: string;
    readonly expectedTokenCount: number;
    readonly actualTokenCount: number;
    readonly norm: number;
  }[];
  readonly cosine: readonly {
    readonly leftInputId: string;
    readonly rightInputId: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly actual: number;
  }[];
};

export type RerankerConformanceProbeV1 = {
  readonly schema: "workbench.reranker-conformance-probe.v1";
  readonly retrievalProfileId: string;
  readonly cases: readonly {
    readonly id: string;
    readonly query: string;
    readonly candidates: readonly {
      readonly id: string;
      readonly text: string;
      readonly expectedRank: number;
      readonly minimumScore?: number;
      readonly maximumScore?: number;
    }[];
  }[];
};

export type RerankerConformanceResult = {
  readonly caseId: string;
  readonly scores: readonly {
    readonly candidateId: string;
    readonly score: number;
  }[];
};

export type RerankerConformanceReport = {
  readonly schema: "workbench.reranker-conformance-report.v1";
  readonly passed: boolean;
  readonly probeSha256: string;
  readonly failures: readonly string[];
  readonly cases: readonly {
    readonly id: string;
    readonly ranking: readonly {
      readonly candidateId: string;
      readonly expectedRank: number;
      readonly actualRank: number;
      readonly score: number;
    }[];
  }[];
};

export class KnowledgeConformanceContractError extends TypeError {
  readonly code = "KNOWLEDGE_CONFORMANCE_INVALID";

  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "KnowledgeConformanceContractError";
  }
}

export function parseEmbeddingConformanceProbeV1(
  input: unknown,
  profile: CanonicalEmbeddingProfileV1,
): EmbeddingConformanceProbeV1 {
  const root = strictObject(input, "$", [
    "schema",
    "profileId",
    "dimension",
    "normTolerance",
    "inputs",
    "cosineExpectations",
  ]);
  literal(root.schema, "workbench.embedding-conformance-probe.v1", "$.schema");
  const inputs = array(root.inputs, "$.inputs", 3, 32).map((value, index) => {
    const path = `$.inputs[${index}]`;
    const item = strictObject(value, path, ["id", "kind", "text", "tokenCount"]);
    return {
      id: identifier(item.id, `${path}.id`),
      kind: oneOf(item.kind, ["query", "document"] as const, `${path}.kind`),
      text: normalizedText(item.text, `${path}.text`, 20_000),
      tokenCount: positiveInteger(item.tokenCount, `${path}.tokenCount`, 1_000_000),
    };
  });
  assertUnique(inputs.map((item) => item.id), "$.inputs", "input id");
  if (!inputs.some((item) => item.kind === "query") || !inputs.some((item) => item.kind === "document")) {
    fail("$.inputs", "must contain at least one query and one document input");
  }
  const inputIds = new Set(inputs.map((item) => item.id));
  const seenPairs = new Set<string>();
  const cosineExpectations = array(root.cosineExpectations, "$.cosineExpectations", 1, 496)
    .map((value, index) => {
      const path = `$.cosineExpectations[${index}]`;
      const item = strictObject(value, path, [
        "leftInputId",
        "rightInputId",
        "minimum",
        "maximum",
      ]);
      const leftInputId = identifier(item.leftInputId, `${path}.leftInputId`);
      const rightInputId = identifier(item.rightInputId, `${path}.rightInputId`);
      if (leftInputId === rightInputId) fail(path, "must compare two different inputs");
      if (!inputIds.has(leftInputId) || !inputIds.has(rightInputId)) {
        fail(path, "must reference existing input ids");
      }
      const pairKey = [leftInputId, rightInputId].sort().join("\u0000");
      if (seenPairs.has(pairKey)) fail(path, "duplicates an existing cosine pair");
      seenPairs.add(pairKey);
      const minimum = boundedNumber(item.minimum, `${path}.minimum`, -1, 1);
      const maximum = boundedNumber(item.maximum, `${path}.maximum`, -1, 1);
      if (minimum > maximum) fail(path, "minimum must not exceed maximum");
      return { leftInputId, rightInputId, minimum, maximum };
    });

  const probe: EmbeddingConformanceProbeV1 = {
    schema: "workbench.embedding-conformance-probe.v1",
    profileId: identifier(root.profileId, "$.profileId"),
    dimension: positiveInteger(root.dimension, "$.dimension", 16_000),
    normTolerance: boundedNumber(root.normTolerance, "$.normTolerance", Number.EPSILON, 0.01),
    inputs,
    cosineExpectations,
  };
  if (probe.profileId !== profile.spec.id || probe.dimension !== profile.dimension) {
    fail("$", "probe identity or dimension does not match the embedding profile");
  }
  assertProbeDigest(probe, profile.spec.conformanceProbeSha256, "embedding");
  return deepFreeze(probe);
}

export function embeddingConformanceInputs(
  probe: EmbeddingConformanceProbeV1,
  profile: CanonicalEmbeddingProfileV1,
): readonly string[] {
  return probe.inputs.map((input) => {
    const prefix = input.kind === "query"
      ? profile.spec.input.queryPrefix
      : profile.spec.input.documentPrefix;
    return `${prefix}${input.text.normalize("NFC").replace(/\r\n?/gu, "\n")}`;
  });
}

export function evaluateEmbeddingConformance(
  probe: EmbeddingConformanceProbeV1,
  result: EmbeddingConformanceResult,
): EmbeddingConformanceReport {
  if (result.tokenCounts.length !== probe.inputs.length || result.vectors.length !== probe.inputs.length) {
    fail("$.result", "token counts and vectors must match the probe input count");
  }
  const failures: string[] = [];
  const vectors = result.vectors.map((vector, index) => {
    if (vector.length !== probe.dimension) {
      fail(`$.result.vectors[${index}]`, `must contain ${probe.dimension} values`);
    }
    return vector.map((value, valueIndex) => finiteNumber(
      value,
      `$.result.vectors[${index}][${valueIndex}]`,
    ));
  });
  const inputs = probe.inputs.map((input, index) => {
    const actualTokenCount = nonnegativeInteger(
      result.tokenCounts[index],
      `$.result.tokenCounts[${index}]`,
      1_000_000,
    );
    const norm = vectorNorm(vectors[index]!);
    if (actualTokenCount !== input.tokenCount) {
      failures.push(`TOKEN_COUNT_MISMATCH:${input.id}:${input.tokenCount}:${actualTokenCount}`);
    }
    if (Math.abs(norm - 1) > probe.normTolerance) {
      failures.push(`VECTOR_NORM_MISMATCH:${input.id}:${norm}`);
    }
    return {
      id: input.id,
      expectedTokenCount: input.tokenCount,
      actualTokenCount,
      norm,
    };
  });
  const byId = new Map(probe.inputs.map((input, index) => [input.id, vectors[index]!]));
  const cosine = probe.cosineExpectations.map((expectation) => {
    const actual = cosineSimilarity(
      byId.get(expectation.leftInputId)!,
      byId.get(expectation.rightInputId)!,
    );
    if (actual < expectation.minimum || actual > expectation.maximum) {
      failures.push(
        `COSINE_OUT_OF_RANGE:${expectation.leftInputId}:${expectation.rightInputId}:${actual}`,
      );
    }
    return { ...expectation, actual };
  });
  return deepFreeze({
    schema: "workbench.embedding-conformance-report.v1",
    passed: failures.length === 0,
    probeSha256: canonicalSha256(probe as unknown as JsonValue),
    failures,
    inputs,
    cosine,
  });
}

export function parseRerankerConformanceProbeV1(
  input: unknown,
  profile: CanonicalRetrievalProfileV1,
): RerankerConformanceProbeV1 {
  const root = strictObject(input, "$", ["schema", "retrievalProfileId", "cases"]);
  literal(root.schema, "workbench.reranker-conformance-probe.v1", "$.schema");
  const cases = array(root.cases, "$.cases", 1, 32).map((value, caseIndex) => {
    const path = `$.cases[${caseIndex}]`;
    const item = strictObject(value, path, ["id", "query", "candidates"]);
    const candidates = array(
      item.candidates,
      `${path}.candidates`,
      2,
      profile.spec.reranker.candidateLimit,
    ).map((candidateValue, candidateIndex) => {
      const candidatePath = `${path}.candidates[${candidateIndex}]`;
      const candidate = strictObject(
        candidateValue,
        candidatePath,
        ["id", "text", "expectedRank", "minimumScore", "maximumScore"],
        ["minimumScore", "maximumScore"],
      );
      const minimumScore = candidate.minimumScore === undefined
        ? undefined
        : finiteNumber(candidate.minimumScore, `${candidatePath}.minimumScore`);
      const maximumScore = candidate.maximumScore === undefined
        ? undefined
        : finiteNumber(candidate.maximumScore, `${candidatePath}.maximumScore`);
      if (minimumScore !== undefined && maximumScore !== undefined && minimumScore > maximumScore) {
        fail(candidatePath, "minimumScore must not exceed maximumScore");
      }
      return {
        id: identifier(candidate.id, `${candidatePath}.id`),
        text: normalizedText(candidate.text, `${candidatePath}.text`, 100_000),
        expectedRank: positiveInteger(
          candidate.expectedRank,
          `${candidatePath}.expectedRank`,
          profile.spec.reranker.candidateLimit,
        ),
        ...(minimumScore === undefined ? {} : { minimumScore }),
        ...(maximumScore === undefined ? {} : { maximumScore }),
      };
    });
    assertUnique(candidates.map((candidate) => candidate.id), `${path}.candidates`, "candidate id");
    const ranks = candidates.map((candidate) => candidate.expectedRank).sort((left, right) => left - right);
    if (!ranks.every((rank, index) => rank === index + 1)) {
      fail(`${path}.candidates`, "expectedRank values must be contiguous from 1");
    }
    return {
      id: identifier(item.id, `${path}.id`),
      query: normalizedText(item.query, `${path}.query`, 20_000),
      candidates,
    };
  });
  assertUnique(cases.map((item) => item.id), "$.cases", "case id");
  const probe: RerankerConformanceProbeV1 = {
    schema: "workbench.reranker-conformance-probe.v1",
    retrievalProfileId: identifier(root.retrievalProfileId, "$.retrievalProfileId"),
    cases,
  };
  if (probe.retrievalProfileId !== profile.spec.id) {
    fail("$.retrievalProfileId", "must match the retrieval profile");
  }
  assertProbeDigest(probe, profile.spec.reranker.conformanceProbeSha256, "reranker");
  return deepFreeze(probe);
}

export function evaluateRerankerConformance(
  probe: RerankerConformanceProbeV1,
  results: readonly RerankerConformanceResult[],
): RerankerConformanceReport {
  if (results.length !== probe.cases.length) fail("$.results", "must match the probe case count");
  const resultByCase = new Map(results.map((result, index) => {
    const caseId = identifier(result.caseId, `$.results[${index}].caseId`);
    return [caseId, result] as const;
  }));
  if (resultByCase.size !== results.length) fail("$.results", "case ids must be unique");

  const failures: string[] = [];
  const cases = probe.cases.map((probeCase) => {
    const result = resultByCase.get(probeCase.id);
    if (!result) fail("$.results", `is missing case ${probeCase.id}`);
    if (result.scores.length !== probeCase.candidates.length) {
      fail(`$.results.${probeCase.id}.scores`, "must match the candidate count");
    }
    const scoreById = new Map(result.scores.map((score, index) => [
      identifier(score.candidateId, `$.results.${probeCase.id}.scores[${index}].candidateId`),
      finiteNumber(score.score, `$.results.${probeCase.id}.scores[${index}].score`),
    ] as const));
    if (scoreById.size !== result.scores.length) {
      fail(`$.results.${probeCase.id}.scores`, "candidate ids must be unique");
    }
    for (const candidate of probeCase.candidates) {
      if (!scoreById.has(candidate.id)) {
        fail(`$.results.${probeCase.id}.scores`, `is missing candidate ${candidate.id}`);
      }
    }
    const actualRanks = [...probeCase.candidates]
      .sort((left, right) => (
        scoreById.get(right.id)! - scoreById.get(left.id)!
        || left.id.localeCompare(right.id, "en")
      ))
      .map((candidate, index) => [candidate.id, index + 1] as const);
    const rankById = new Map(actualRanks);
    const ranking = probeCase.candidates.map((candidate) => {
      const score = scoreById.get(candidate.id)!;
      const actualRank = rankById.get(candidate.id)!;
      if (actualRank !== candidate.expectedRank) {
        failures.push(
          `RERANK_ORDER_MISMATCH:${probeCase.id}:${candidate.id}:${candidate.expectedRank}:${actualRank}`,
        );
      }
      if (candidate.minimumScore !== undefined && score < candidate.minimumScore) {
        failures.push(`RERANK_SCORE_BELOW_MINIMUM:${probeCase.id}:${candidate.id}:${score}`);
      }
      if (candidate.maximumScore !== undefined && score > candidate.maximumScore) {
        failures.push(`RERANK_SCORE_ABOVE_MAXIMUM:${probeCase.id}:${candidate.id}:${score}`);
      }
      return {
        candidateId: candidate.id,
        expectedRank: candidate.expectedRank,
        actualRank,
        score,
      };
    }).sort((left, right) => left.actualRank - right.actualRank);
    return { id: probeCase.id, ranking };
  });
  return deepFreeze({
    schema: "workbench.reranker-conformance-report.v1",
    passed: failures.length === 0,
    probeSha256: canonicalSha256(probe as unknown as JsonValue),
    failures,
    cases,
  });
}

function assertProbeDigest(value: object, expected: string, label: string): void {
  const actual = canonicalSha256(value as JsonValue);
  if (actual !== expected) fail("$", `${label} probe SHA-256 does not match its profile pin`);
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed");
  const optionalKeys = new Set(optional);
  for (const key of keys) {
    if (!optionalKeys.has(key) && !Object.hasOwn(record, key)) fail(`${path}.${key}`, "is required");
  }
  return record;
}

function array(value: unknown, path: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(path, `must contain between ${minimum} and ${maximum} items`);
  }
  return value;
}

function normalizedText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    fail(path, `must contain between 1 and ${maximum} characters`);
  }
  if (value !== value.trim()) fail(path, "must not contain surrounding whitespace");
  if (value !== value.normalize("NFC")) fail(path, "must be NFC normalized");
  if (/\u0000/u.test(value)) fail(path, "must not contain NUL");
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = normalizedText(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result)) {
    fail(path, "must be a stable identifier");
  }
  return result;
}

function positiveInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(path, `must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function nonnegativeInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(path, `must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = finiteNumber(value, path);
  if (result < minimum || result > maximum) fail(path, `must be between ${minimum} and ${maximum}`);
  return result;
}

function literal<const T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T, path: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    fail(path, `must be one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`);
  }
  return value as T[number];
}

function assertUnique(values: readonly string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) fail(path, `${label}s must be unique`);
}

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  const denominator = vectorNorm(left) * vectorNorm(right);
  if (!Number.isFinite(denominator) || denominator <= 0) fail("$.result.vectors", "must have non-zero norm");
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0) / denominator;
}

function fail(path: string, message: string): never {
  throw new KnowledgeConformanceContractError(path, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
