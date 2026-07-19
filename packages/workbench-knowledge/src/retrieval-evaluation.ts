import { performance } from "node:perf_hooks";

import { canonicalSha256 } from "./checksum.js";
import { routesForKnowledgeScope, type KnowledgeRetrievalRouteScope } from "./retrieval.js";
import type { JsonValue, KnowledgeRoute } from "./types.js";

export type KnowledgeRetrievalEvaluationDatasetV1 = {
  readonly schema: "workbench.knowledge-retrieval-evaluation-dataset.v1";
  readonly id: string;
  readonly language: "zh-Hans-CN";
  readonly k: number;
  readonly thresholds: {
    readonly minimumRecallAtK: number;
    readonly minimumNdcgAtK: number;
    readonly maximumP95LatencyMs: number;
  };
  readonly cases: readonly KnowledgeRetrievalEvaluationCase[];
};

export type KnowledgeRetrievalEvaluationCase = {
  readonly id: string;
  readonly query: string;
  readonly routeScope: KnowledgeRetrievalRouteScope;
  readonly expected: readonly {
    readonly chunkId: string;
    readonly relevance: number;
  }[];
};

export type KnowledgeRetrievalEvaluationCandidate = {
  readonly chunkId: string;
  readonly route: KnowledgeRoute;
};

export type KnowledgeRetrievalEvaluationResultsV1 = {
  readonly schema: "workbench.knowledge-retrieval-evaluation-results.v1";
  readonly datasetId: string;
  readonly datasetSha256: string;
  readonly cases: readonly {
    readonly caseId: string;
    readonly latencyMs: number;
    readonly items: readonly KnowledgeRetrievalEvaluationCandidate[];
  }[];
};

export type KnowledgeRetrievalEvaluationReport = {
  readonly schema: "workbench.knowledge-retrieval-evaluation-report.v1";
  readonly passed: boolean;
  readonly dataset: {
    readonly id: string;
    readonly sha256: string;
    readonly language: "zh-Hans-CN";
    readonly caseCount: number;
    readonly k: number;
  };
  readonly thresholds: KnowledgeRetrievalEvaluationDatasetV1["thresholds"];
  readonly metrics: {
    readonly recallAtK: number;
    readonly ndcgAtK: number;
    readonly p95LatencyMs: number;
  };
  readonly gates: {
    readonly recallAtK: EvaluationMinimumGate;
    readonly ndcgAtK: EvaluationMinimumGate;
    readonly p95LatencyMs: EvaluationMaximumGate;
    readonly routeIsolation: {
      readonly passed: boolean;
      readonly leakedItemCount: number;
      readonly productionScopeSourceLookupCount: number;
      readonly nonQueryableRouteCount: number;
    };
  };
  readonly failures: readonly string[];
  readonly cases: readonly KnowledgeRetrievalEvaluationCaseReport[];
};

type EvaluationMinimumGate = {
  readonly passed: boolean;
  readonly actual: number;
  readonly minimum: number;
};

type EvaluationMaximumGate = {
  readonly passed: boolean;
  readonly actual: number;
  readonly maximum: number;
};

export type KnowledgeRetrievalEvaluationCaseReport = {
  readonly id: string;
  readonly query: string;
  readonly routeScope: KnowledgeRetrievalRouteScope;
  readonly relevantCount: number;
  readonly relevantHitCountAtK: number;
  readonly retrievedCount: number;
  readonly recallAtK: number;
  readonly ndcgAtK: number;
  readonly latencyMs: number;
  readonly leakedItems: readonly {
    readonly rank: number;
    readonly chunkId: string;
    readonly route: KnowledgeRoute;
  }[];
};

export type KnowledgeRetrievalEvaluationRequest = {
  readonly caseId: string;
  readonly query: string;
  readonly routeScope: KnowledgeRetrievalRouteScope;
  readonly limit: number;
};

export type KnowledgeRetrievalEvaluationRetriever = (
  request: KnowledgeRetrievalEvaluationRequest,
) => Promise<readonly KnowledgeRetrievalEvaluationCandidate[]>;

export class KnowledgeRetrievalEvaluationContractError extends TypeError {
  readonly code = "KNOWLEDGE_RETRIEVAL_EVALUATION_INVALID";

  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "KnowledgeRetrievalEvaluationContractError";
  }
}

export function parseKnowledgeRetrievalEvaluationDatasetV1(
  input: unknown,
): KnowledgeRetrievalEvaluationDatasetV1 {
  const root = strictObject(input, "$", ["schema", "id", "language", "k", "thresholds", "cases"]);
  literal(root.schema, "workbench.knowledge-retrieval-evaluation-dataset.v1", "$.schema");
  literal(root.language, "zh-Hans-CN", "$.language");
  const k = positiveInteger(root.k, "$.k", 1_000);
  const thresholdsValue = strictObject(root.thresholds, "$.thresholds", [
    "minimumRecallAtK",
    "minimumNdcgAtK",
    "maximumP95LatencyMs",
  ]);
  const thresholds = {
    minimumRecallAtK: boundedNumber(thresholdsValue.minimumRecallAtK, "$.thresholds.minimumRecallAtK", 0, 1),
    minimumNdcgAtK: boundedNumber(thresholdsValue.minimumNdcgAtK, "$.thresholds.minimumNdcgAtK", 0, 1),
    maximumP95LatencyMs: boundedNumber(
      thresholdsValue.maximumP95LatencyMs,
      "$.thresholds.maximumP95LatencyMs",
      Number.EPSILON,
      86_400_000,
    ),
  };
  const cases = array(root.cases, "$.cases", 1, 10_000).map((value, caseIndex) => {
    const path = `$.cases[${caseIndex}]`;
    const item = strictObject(value, path, ["id", "query", "routeScope", "expected"]);
    const expected = array(item.expected, `${path}.expected`, 1, 10_000).map((expectedValue, expectedIndex) => {
      const expectedPath = `${path}.expected[${expectedIndex}]`;
      const entry = strictObject(expectedValue, expectedPath, ["chunkId", "relevance"]);
      return {
        chunkId: identifier(entry.chunkId, `${expectedPath}.chunkId`),
        relevance: positiveInteger(entry.relevance, `${expectedPath}.relevance`, 3),
      };
    });
    assertUnique(expected.map((entry) => entry.chunkId), `${path}.expected`, "chunkId");
    return {
      id: identifier(item.id, `${path}.id`),
      query: normalizedText(item.query, `${path}.query`, 4_000),
      routeScope: oneOf(item.routeScope, ["production", "source_lookup"] as const, `${path}.routeScope`),
      expected,
    };
  });
  assertUnique(cases.map((item) => item.id), "$.cases", "case id");
  return deepFreeze({
    schema: "workbench.knowledge-retrieval-evaluation-dataset.v1",
    id: identifier(root.id, "$.id"),
    language: "zh-Hans-CN",
    k,
    thresholds,
    cases,
  });
}

export function knowledgeRetrievalEvaluationDatasetSha256(
  dataset: KnowledgeRetrievalEvaluationDatasetV1,
): string {
  return canonicalSha256(dataset as unknown as JsonValue);
}

export function parseKnowledgeRetrievalEvaluationResultsV1(
  input: unknown,
  dataset: KnowledgeRetrievalEvaluationDatasetV1,
): KnowledgeRetrievalEvaluationResultsV1 {
  const root = strictObject(input, "$", ["schema", "datasetId", "datasetSha256", "cases"]);
  literal(root.schema, "workbench.knowledge-retrieval-evaluation-results.v1", "$.schema");
  const datasetId = identifier(root.datasetId, "$.datasetId");
  const datasetSha256 = sha256Digest(root.datasetSha256, "$.datasetSha256");
  if (datasetId !== dataset.id) fail("$.datasetId", "must match the evaluation dataset id");
  if (datasetSha256 !== knowledgeRetrievalEvaluationDatasetSha256(dataset)) {
    fail("$.datasetSha256", "must match the canonical evaluation dataset SHA-256");
  }
  const cases = array(root.cases, "$.cases", dataset.cases.length, dataset.cases.length)
    .map((value, caseIndex) => {
      const path = `$.cases[${caseIndex}]`;
      const item = strictObject(value, path, ["caseId", "latencyMs", "items"]);
      const items = array(item.items, `${path}.items`, 0, 10_000).map((candidateValue, candidateIndex) => {
        const candidatePath = `${path}.items[${candidateIndex}]`;
        const candidate = strictObject(candidateValue, candidatePath, ["chunkId", "route"]);
        return {
          chunkId: identifier(candidate.chunkId, `${candidatePath}.chunkId`),
          route: oneOf(
            candidate.route,
            ["production", "source_lookup", "excluded", "quarantine"] as const,
            `${candidatePath}.route`,
          ),
        };
      });
      assertUnique(items.map((candidate) => candidate.chunkId), `${path}.items`, "chunkId");
      return {
        caseId: identifier(item.caseId, `${path}.caseId`),
        latencyMs: boundedNumber(item.latencyMs, `${path}.latencyMs`, 0, 86_400_000),
        items,
      };
    });
  assertUnique(cases.map((item) => item.caseId), "$.cases", "case id");
  const expectedCaseIds = new Set(dataset.cases.map((item) => item.id));
  for (const result of cases) {
    if (!expectedCaseIds.has(result.caseId)) fail("$.cases", `contains unknown case ${result.caseId}`);
  }
  return deepFreeze({
    schema: "workbench.knowledge-retrieval-evaluation-results.v1",
    datasetId,
    datasetSha256,
    cases,
  });
}

export function evaluateKnowledgeRetrieval(
  dataset: KnowledgeRetrievalEvaluationDatasetV1,
  results: KnowledgeRetrievalEvaluationResultsV1,
): KnowledgeRetrievalEvaluationReport {
  const parsedResults = parseKnowledgeRetrievalEvaluationResultsV1(results, dataset);
  const resultByCase = new Map(parsedResults.cases.map((result) => [result.caseId, result] as const));
  const cases = dataset.cases.map((evaluationCase) => {
    const result = resultByCase.get(evaluationCase.id);
    if (!result) fail("$.results.cases", `is missing case ${evaluationCase.id}`);
    const relevanceByChunkId = new Map(
      evaluationCase.expected.map((expected) => [expected.chunkId, expected.relevance] as const),
    );
    const atK = result.items.slice(0, dataset.k);
    const relevantHitCountAtK = atK.reduce(
      (count, candidate) => count + (relevanceByChunkId.has(candidate.chunkId) ? 1 : 0),
      0,
    );
    const actualGains = atK.map((candidate) => relevanceByChunkId.get(candidate.chunkId) ?? 0);
    const idealGains = [...relevanceByChunkId.values()].sort((left, right) => right - left).slice(0, dataset.k);
    const idealDcg = discountedCumulativeGain(idealGains);
    const allowedRoutes = new Set<string>(routesForKnowledgeScope(evaluationCase.routeScope));
    const leakedItems = result.items.flatMap((candidate, index) => (
      allowedRoutes.has(candidate.route)
        ? []
        : [{ rank: index + 1, chunkId: candidate.chunkId, route: candidate.route }]
    ));
    return {
      id: evaluationCase.id,
      query: evaluationCase.query,
      routeScope: evaluationCase.routeScope,
      relevantCount: evaluationCase.expected.length,
      relevantHitCountAtK,
      retrievedCount: result.items.length,
      recallAtK: relevantHitCountAtK / evaluationCase.expected.length,
      ndcgAtK: discountedCumulativeGain(actualGains) / idealDcg,
      latencyMs: result.latencyMs,
      leakedItems,
    } satisfies KnowledgeRetrievalEvaluationCaseReport;
  });
  const recallAtK = mean(cases.map((item) => item.recallAtK));
  const ndcgAtK = mean(cases.map((item) => item.ndcgAtK));
  const p95LatencyMs = nearestRankPercentile(cases.map((item) => item.latencyMs), 0.95);
  const leakedItems = cases.flatMap((item) => item.leakedItems.map((leak) => ({
    routeScope: item.routeScope,
    ...leak,
  })));
  const productionScopeSourceLookupCount = leakedItems.filter((item) => (
    item.routeScope === "production" && item.route === "source_lookup"
  )).length;
  const nonQueryableRouteCount = leakedItems.filter((item) => (
    item.route === "excluded" || item.route === "quarantine"
  )).length;
  const recallGate = {
    passed: recallAtK >= dataset.thresholds.minimumRecallAtK,
    actual: recallAtK,
    minimum: dataset.thresholds.minimumRecallAtK,
  };
  const ndcgGate = {
    passed: ndcgAtK >= dataset.thresholds.minimumNdcgAtK,
    actual: ndcgAtK,
    minimum: dataset.thresholds.minimumNdcgAtK,
  };
  const latencyGate = {
    passed: p95LatencyMs <= dataset.thresholds.maximumP95LatencyMs,
    actual: p95LatencyMs,
    maximum: dataset.thresholds.maximumP95LatencyMs,
  };
  const routeIsolationGate = {
    passed: leakedItems.length === 0,
    leakedItemCount: leakedItems.length,
    productionScopeSourceLookupCount,
    nonQueryableRouteCount,
  };
  const failures = [
    ...(recallGate.passed ? [] : ["RECALL_AT_K_BELOW_MINIMUM"]),
    ...(ndcgGate.passed ? [] : ["NDCG_AT_K_BELOW_MINIMUM"]),
    ...(latencyGate.passed ? [] : ["P95_LATENCY_ABOVE_MAXIMUM"]),
    ...(routeIsolationGate.passed ? [] : ["KNOWLEDGE_ROUTE_LEAKAGE"]),
  ];
  return deepFreeze({
    schema: "workbench.knowledge-retrieval-evaluation-report.v1",
    passed: failures.length === 0,
    dataset: {
      id: dataset.id,
      sha256: knowledgeRetrievalEvaluationDatasetSha256(dataset),
      language: dataset.language,
      caseCount: dataset.cases.length,
      k: dataset.k,
    },
    thresholds: { ...dataset.thresholds },
    metrics: { recallAtK, ndcgAtK, p95LatencyMs },
    gates: {
      recallAtK: recallGate,
      ndcgAtK: ndcgGate,
      p95LatencyMs: latencyGate,
      routeIsolation: routeIsolationGate,
    },
    failures,
    cases,
  });
}

export async function runKnowledgeRetrievalEvaluation(
  dataset: KnowledgeRetrievalEvaluationDatasetV1,
  retrieve: KnowledgeRetrievalEvaluationRetriever,
  options: { readonly now?: () => number } = {},
): Promise<KnowledgeRetrievalEvaluationReport> {
  const now = options.now ?? (() => performance.now());
  const cases = [];
  for (const evaluationCase of dataset.cases) {
    const startedAt = now();
    const items = await retrieve({
      caseId: evaluationCase.id,
      query: evaluationCase.query,
      routeScope: evaluationCase.routeScope,
      limit: dataset.k,
    });
    const latencyMs = now() - startedAt;
    cases.push({ caseId: evaluationCase.id, latencyMs, items });
  }
  const results = parseKnowledgeRetrievalEvaluationResultsV1({
    schema: "workbench.knowledge-retrieval-evaluation-results.v1",
    datasetId: dataset.id,
    datasetSha256: knowledgeRetrievalEvaluationDatasetSha256(dataset),
    cases,
  }, dataset);
  return evaluateKnowledgeRetrieval(dataset, results);
}

export function renderKnowledgeRetrievalEvaluationMarkdown(
  report: KnowledgeRetrievalEvaluationReport,
): string {
  const status = (passed: boolean): string => passed ? "PASS" : "FAIL";
  const lines = [
    "# 产品工作台 Knowledge Retrieval Evaluation",
    "",
    `- Dataset: \`${report.dataset.id}\``,
    `- Dataset SHA-256: \`${report.dataset.sha256}\``,
    `- Language: \`${report.dataset.language}\``,
    `- Cases: ${report.dataset.caseCount}`,
    `- K: ${report.dataset.k}`,
    `- Overall: **${status(report.passed)}**`,
    "",
    "## Gates",
    "",
    "| Gate | Actual | Threshold | Result |",
    "| --- | ---: | ---: | --- |",
    `| Recall@${report.dataset.k} | ${formatMetric(report.metrics.recallAtK)} | >= ${formatMetric(report.thresholds.minimumRecallAtK)} | ${status(report.gates.recallAtK.passed)} |`,
    `| nDCG@${report.dataset.k} | ${formatMetric(report.metrics.ndcgAtK)} | >= ${formatMetric(report.thresholds.minimumNdcgAtK)} | ${status(report.gates.ndcgAtK.passed)} |`,
    `| p95 latency | ${formatMilliseconds(report.metrics.p95LatencyMs)} ms | <= ${formatMilliseconds(report.thresholds.maximumP95LatencyMs)} ms | ${status(report.gates.p95LatencyMs.passed)} |`,
    `| Route isolation | ${report.gates.routeIsolation.leakedItemCount} leaks | 0 leaks | ${status(report.gates.routeIsolation.passed)} |`,
    "",
    "## Cases",
    "",
    `| Case | Scope | Recall@${report.dataset.k} | nDCG@${report.dataset.k} | Latency | Leaks |`,
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...report.cases.map((item) => (
      `| ${item.id} | ${item.routeScope} | ${formatMetric(item.recallAtK)} | ${formatMetric(item.ndcgAtK)} | ${formatMilliseconds(item.latencyMs)} ms | ${item.leakedItems.length} |`
    )),
  ];
  if (report.failures.length > 0) {
    lines.push("", "## Failures", "", ...report.failures.map((failure) => `- \`${failure}\``));
  }
  const leaks = report.cases.flatMap((item) => item.leakedItems.map((leak) => ({ caseId: item.id, ...leak })));
  if (leaks.length > 0) {
    lines.push(
      "",
      "## Route Leakage",
      "",
      "| Case | Rank | Chunk | Route |",
      "| --- | ---: | --- | --- |",
      ...leaks.map((leak) => `| ${leak.caseId} | ${leak.rank} | ${leak.chunkId} | ${leak.route} |`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function discountedCumulativeGain(relevance: readonly number[]): number {
  return relevance.reduce((sum, gain, index) => sum + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
}

function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) fail("$.results.cases", "must not be empty");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function strictObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed");
  for (const key of keys) if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "is required");
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
  if (value.includes("\0")) fail(path, "must not contain NUL");
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = normalizedText(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result)) fail(path, "must be a stable identifier");
  return result;
}

function positiveInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(path, `must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function sha256Digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(path, "must be a lowercase SHA-256 digest");
  }
  return value;
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

function formatMetric(value: number): string {
  return value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatMilliseconds(value: number): string {
  return value.toFixed(2).replace(/\.00$/u, "").replace(/(\.\d)0$/u, "$1");
}

function fail(path: string, message: string): never {
  throw new KnowledgeRetrievalEvaluationContractError(path, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
