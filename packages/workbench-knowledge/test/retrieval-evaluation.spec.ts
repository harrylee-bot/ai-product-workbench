import { describe, expect, it } from "vitest";

import {
  KnowledgeRetrievalEvaluationContractError,
  evaluateKnowledgeRetrieval,
  knowledgeRetrievalEvaluationDatasetSha256,
  parseKnowledgeRetrievalEvaluationDatasetV1,
  parseKnowledgeRetrievalEvaluationResultsV1,
  renderKnowledgeRetrievalEvaluationMarkdown,
  runKnowledgeRetrievalEvaluation,
} from "../src/index.js";

const dataset = parseKnowledgeRetrievalEvaluationDatasetV1({
  schema: "workbench.knowledge-retrieval-evaluation-dataset.v1",
  id: "zh-knowledge-r1",
  language: "zh-Hans-CN",
  k: 2,
  thresholds: {
    minimumRecallAtK: 0.7,
    minimumNdcgAtK: 0.8,
    maximumP95LatencyMs: 25,
  },
  cases: [
    {
      id: "prd-review",
      query: "需求评审需要检查哪些内容？",
      routeScope: "production",
      expected: [
        { chunkId: "chunk_a", relevance: 1 },
        { chunkId: "chunk_b", relevance: 1 },
      ],
    },
    {
      id: "source-audit",
      query: "这个结论的原始来源是什么？",
      routeScope: "source_lookup",
      expected: [{ chunkId: "chunk_c", relevance: 1 }],
    },
  ],
});

function results(overrides: Record<string, unknown> = {}) {
  return parseKnowledgeRetrievalEvaluationResultsV1({
    schema: "workbench.knowledge-retrieval-evaluation-results.v1",
    datasetId: dataset.id,
    datasetSha256: knowledgeRetrievalEvaluationDatasetSha256(dataset),
    cases: [
      {
        caseId: "prd-review",
        latencyMs: 10,
        items: [
          { chunkId: "chunk_a", route: "production" },
          { chunkId: "chunk_x", route: "production" },
        ],
      },
      {
        caseId: "source-audit",
        latencyMs: 20,
        items: [{ chunkId: "chunk_c", route: "source_lookup" }],
      },
    ],
    ...overrides,
  }, dataset);
}

describe("Knowledge retrieval evaluation", () => {
  it("computes macro Recall@K, nDCG@K, nearest-rank p95 latency, and Markdown", () => {
    const report = evaluateKnowledgeRetrieval(dataset, results());

    expect(report.passed).toBe(true);
    expect(report.metrics.recallAtK).toBe(0.75);
    expect(report.metrics.ndcgAtK).toBeCloseTo(0.8065735964, 10);
    expect(report.metrics.p95LatencyMs).toBe(20);
    expect(report.gates.routeIsolation).toMatchObject({ passed: true, leakedItemCount: 0 });
    expect(renderKnowledgeRetrievalEvaluationMarkdown(report)).toContain("产品工作台 Knowledge Retrieval Evaluation");
  });

  it("fails the hard route-isolation gate when source_lookup leaks into production", () => {
    const leakingResults = results({
      cases: [
        {
          caseId: "prd-review",
          latencyMs: 10,
          items: [
            { chunkId: "chunk_a", route: "production" },
            { chunkId: "chunk_x", route: "source_lookup" },
          ],
        },
        {
          caseId: "source-audit",
          latencyMs: 20,
          items: [{ chunkId: "chunk_c", route: "production" }],
        },
      ],
    });
    const report = evaluateKnowledgeRetrieval(dataset, leakingResults);

    expect(report.passed).toBe(false);
    expect(report.failures).toContain("KNOWLEDGE_ROUTE_LEAKAGE");
    expect(report.gates.routeIsolation).toEqual({
      passed: false,
      leakedItemCount: 1,
      productionScopeSourceLookupCount: 1,
      nonQueryableRouteCount: 0,
    });
  });

  it("runs an injected retriever and rejects results pinned to another dataset", async () => {
    const timestamps = [0, 11, 20, 37];
    const report = await runKnowledgeRetrievalEvaluation(dataset, async ({ caseId, limit }) => {
      expect(limit).toBe(2);
      return caseId === "prd-review"
        ? [{ chunkId: "chunk_a", route: "production" }]
        : [{ chunkId: "chunk_c", route: "source_lookup" }];
    }, { now: () => timestamps.shift()! });

    expect(report.cases.map((item) => item.latencyMs)).toEqual([11, 17]);
    expect(() => parseKnowledgeRetrievalEvaluationResultsV1({
      ...results(),
      datasetSha256: "0".repeat(64),
    }, dataset)).toThrowError(KnowledgeRetrievalEvaluationContractError);
  });
});
