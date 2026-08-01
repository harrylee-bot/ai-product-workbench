import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompleteHistory,
  assertConcurrentOppositeScope,
  assertFinalOutputContainsEvidence,
  assertKnowledgeCatalogHidden,
  assertKnowledgeEvidenceAbsent,
  assertKnowledgeRetrievalProof,
  assertNoKnowledgeCapabilityLeak,
  assertRedactedKnowledgeEvidence,
  buildKnowledgeSmokeEvidence,
  readKnowledgeSmokeEnvironment,
  redactKnowledgeCapability,
  safeKnowledgeSmokeError,
} from "./workbench-deerflow-knowledge-smoke-lib.mjs";

const baseEnvironment = {
  NODE_ENV: "production",
  DEERFLOW_GATEWAY_URL: "https://deerflow.example.test",
  DEERFLOW_LANGGRAPH_URL: "https://deerflow.example.test/api",
  DEERFLOW_INTERNAL_AUTH_TOKEN: "internal-token",
  WORKBENCH_DATABASE_URL: "postgresql://workbench.example.test/workbench",
  WORKBENCH_KNOWLEDGE_TOOL_URL: "https://workbench.example.test/api/v1/runtime/knowledge/retrieve",
  WORKBENCH_KNOWLEDGE_TOOL_SECRET: "base64url-secret",
  WORKBENCH_S3_BUCKET: "workbench",
  WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID: "key-id",
  WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY: "key-secret",
  WORKBENCH_SOURCE_COMMIT: "a".repeat(40),
  WORKBENCH_RUNTIME_WORKER_IMAGE_REF: `registry.example.test/workbench/runtime-worker@sha256:${"b".repeat(64)}`,
  WORKBENCH_DEERFLOW_IMAGE_REF: `registry.example.test/workbench/deerflow@sha256:${"c".repeat(64)}`,
  WORKBENCH_DEERFLOW_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID: "run-1",
  WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID: "principal-1",
  WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID: "project-1",
  WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID: "release-1",
  WORKBENCH_KNOWLEDGE_SMOKE_QUERY: "产品知识探针对应的发布规范是什么？",
  WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE: "KB-PROBE-7F31A9C2",
  WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION: "00-知识验收/生产探针.md",
  WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID: "run-null-1",
  WORKBENCH_KNOWLEDGE_SMOKE_NULL_PRINCIPAL_ID: "principal-null-1",
  WORKBENCH_KNOWLEDGE_SMOKE_NULL_PROJECT_ID: "project-null-1",
  WORKBENCH_KNOWLEDGE_SMOKE_NULL_QUERY: "在没有知识发布的情况下尝试使用指定工具。",
};

const retrievalResult = {
  protocol: "workbench.knowledge-retrieval-result.v1",
  evidence: {
    schema: "workbench.knowledge-retrieval-evidence.v1",
    release: { id: "release-1", key: "vault", version: 3 },
  },
  items: [{
    rank: 1,
    citation: {
      id: "citation-1",
      documentId: "document-1",
      chunkId: "chunk-1",
      sourcePath: "00-知识验收/生产探针.md",
      quote: "唯一验收内容 KB-PROBE-7F31A9C2",
    },
  }],
};

test("production Knowledge smoke requires every explicit prerequisite", () => {
  assert.throws(
    () => readKnowledgeSmokeEnvironment({ ...baseEnvironment, WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID: "" }),
    /KNOWLEDGE_SMOKE_MISSING_ENV:WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID/u,
  );
  assert.throws(
    () => readKnowledgeSmokeEnvironment({ ...baseEnvironment, NODE_ENV: "test" }),
    /KNOWLEDGE_SMOKE_NODE_ENV_MUST_BE_PRODUCTION/u,
  );
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      WORKBENCH_KNOWLEDGE_TOOL_URL: "http://workbench.example.test/retrieve",
    }),
    /KNOWLEDGE_SMOKE_INVALID_URL:WORKBENCH_KNOWLEDGE_TOOL_URL/u,
  );
  const parsed = readKnowledgeSmokeEnvironment(baseEnvironment);
  assert.equal(parsed.binding.candidateCommit, "a".repeat(40));
  assert.equal(parsed.binding.runtimeWorkerImageDigest, `sha256:${"b".repeat(64)}`);
  assert.equal(parsed.valid.releaseId, "release-1");
  assert.equal(parsed.nullRelease.releaseId, null);
});

test("production evidence binding rejects mutable or mismatched deployed images", () => {
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      WORKBENCH_RUNTIME_WORKER_IMAGE_REF: "registry.example.test/workbench/runtime-worker:latest",
    }),
    /KNOWLEDGE_SMOKE_INVALID_RUNTIME_WORKER_IMAGE_REF/u,
  );
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      WORKBENCH_DEERFLOW_IMAGE_DIGEST: `sha256:${"d".repeat(64)}`,
    }),
    /KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_DIGEST_MISMATCH/u,
  );
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID: "run-1",
    }),
    /KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_RUNS_MUST_DIFFER/u,
  );
});

test("probe and citation cannot be supplied to the model through the query", () => {
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      WORKBENCH_KNOWLEDGE_SMOKE_QUERY: `查找 ${baseEnvironment.WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE}`,
    }),
    /KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_QUERY/u,
  );
});

test("redaction removes complete and partial capability material", () => {
  const raw = `WORKBENCH_KNOWLEDGE_CAPABILITY=wbkg1.${"a".repeat(64)}.${"b".repeat(43)}`;
  const redacted = redactKnowledgeCapability(raw);
  assert.doesNotMatch(redacted, /WORKBENCH_KNOWLEDGE_CAPABILITY|wbkg1\./u);
  assert.match(redacted, /REDACTED_KNOWLEDGE_CAPABILITY/u);
});

test("leak scan reports only a safe structural path", () => {
  assert.throws(
    () => assertNoKnowledgeCapabilityLeak([{
      label: "state",
      value: { messages: [{ content: `wbkg1.${"x".repeat(16)}` }] },
    }]),
    (error) => {
      assert.match(error.message, /^KNOWLEDGE_SMOKE_CAPABILITY_LEAK:state:/u);
      assert.doesNotMatch(error.message, /wbkg1\.|x{8}/u);
      return true;
    },
  );
  assert.throws(
    () => assertNoKnowledgeCapabilityLeak([{ label: "run", value: { WORKBENCH_KNOWLEDGE_CAPABILITY: "hidden" } }]),
    /KNOWLEDGE_SMOKE_CAPABILITY_LEAK:run/u,
  );
});

test("trusted ToolMessage and immutable ledger response must share the probe citation", () => {
  const state = {
    values: {
      messages: [
        {
          type: "ai",
          tool_calls: [{ id: "call-1", name: "workbench_knowledge_retrieve", args: { query: "probe" } }],
        },
        {
          type: "tool",
          name: "workbench_knowledge_retrieve",
          tool_call_id: "call-1",
          content: JSON.stringify(retrievalResult),
        },
      ],
    },
  };
  const proof = assertKnowledgeRetrievalProof({
    deerFlowSurfaces: [state],
    ledgerResponses: [structuredClone(retrievalResult)],
    releaseId: "release-1",
    expectedProbe: "KB-PROBE-7F31A9C2",
    expectedCitation: "00-知识验收/生产探针.md",
  });
  assert.equal(proof.deerFlowResults, 1);
  assert.equal(proof.ledgerResults, 1);
  assert.match(proof.citationFingerprint, /^[0-9a-f]{64}$/u);
});

test("a model-only answer or mismatched ledger cannot pass proof", () => {
  assert.throws(
    () => assertKnowledgeRetrievalProof({
      deerFlowSurfaces: [{ messages: [{ type: "ai", content: JSON.stringify(retrievalResult) }] }],
      ledgerResponses: [retrievalResult],
      releaseId: "release-1",
      expectedProbe: "KB-PROBE-7F31A9C2",
      expectedCitation: "00-知识验收/生产探针.md",
    }),
    /KNOWLEDGE_SMOKE_TRUSTED_TOOL_CALL_NOT_OBSERVED/u,
  );
  const mismatched = structuredClone(retrievalResult);
  mismatched.items[0].citation.chunkId = "different-chunk";
  const toolState = {
    messages: [{
      type: "tool",
      name: "workbench_knowledge_retrieve",
      tool_call_id: "call-1",
      content: JSON.stringify(retrievalResult),
    }],
  };
  assert.throws(
    () => assertKnowledgeRetrievalProof({
      deerFlowSurfaces: [toolState],
      ledgerResponses: [mismatched],
      releaseId: "release-1",
      expectedProbe: "KB-PROBE-7F31A9C2",
      expectedCitation: "00-知识验收/生产探针.md",
    }),
    /KNOWLEDGE_SMOKE_DEERFLOW_LEDGER_MISMATCH/u,
  );
});

test("null-release catalog proof rejects tool declarations, ToolMessages, and capability fallback", () => {
  assert.deepEqual(assertKnowledgeCatalogHidden([
    { values: { messages: [{ type: "ai", content: "tool is unavailable" }] } },
  ]), {
    declaredToolCalls: 0,
    namedToolMessages: 0,
    retrievalResults: 0,
    capabilityMissingObserved: false,
  });
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [{
      type: "ai",
      tool_calls: [{ id: "forged", name: "workbench_knowledge_retrieve", args: {} }],
    }] }]),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [{
      type: "tool",
      name: "workbench_knowledge_retrieve",
      content: "blocked",
    }] }]),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [{
      type: "ai",
      content: "WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING",
    }] }]),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_REACHED_CAPABILITY_DEFENSE/u,
  );
});

test("null-release persisted surfaces cannot contain valid-scope retrieval evidence", () => {
  assert.equal(assertKnowledgeEvidenceAbsent(
    [{ messages: [{ type: "ai", content: "Knowledge is unavailable" }] }],
    "KB-PROBE-7F31A9C2",
    "00-知识验收/生产探针.md",
  ), true);
  assert.throws(
    () => assertKnowledgeEvidenceAbsent(
      [{ output: "unexpected KB-PROBE-7F31A9C2" }],
      "KB-PROBE-7F31A9C2",
      "00-知识验收/生产探针.md",
    ),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_RETRIEVAL_EVIDENCE_LEAK/u,
  );
});

test("opposite scopes must be distinct, concurrent, and endpoint-isolated", () => {
  const valid = {
    runId: "run-valid",
    runtimeAttemptId: "attempt-valid",
    externalThreadId: "thread-valid",
    externalRunId: "external-valid",
    releaseId: "release-valid",
    grantCount: 1,
    invocationCount: 1,
    successfulInvocationCount: 1,
    startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:10.000Z",
  };
  const nullRelease = {
    runId: "run-null",
    runtimeAttemptId: "attempt-null",
    externalThreadId: "thread-null",
    externalRunId: "external-null",
    releaseId: null,
    grantCount: 0,
    invocationCount: 0,
    successfulInvocationCount: 0,
    startedAt: "2026-08-01T00:00:01.000Z",
    finishedAt: "2026-08-01T00:00:05.000Z",
  };
  assert.deepEqual(assertConcurrentOppositeScope({ valid, nullRelease }), {
    concurrentExecutionObserved: true,
    distinctRuntimeScopes: true,
    validScopeEndpointCalls: 1,
    nullScopeEndpointCalls: 0,
  });
  assert.throws(
    () => assertConcurrentOppositeScope({
      valid,
      nullRelease: {
        ...nullRelease,
        startedAt: "2026-08-01T00:00:11.000Z",
        finishedAt: "2026-08-01T00:00:12.000Z",
      },
    }),
    /KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_DID_NOT_OVERLAP/u,
  );
  assert.throws(
    () => assertConcurrentOppositeScope({
      valid,
      nullRelease: { ...nullRelease, invocationCount: 1 },
    }),
    /KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_ISOLATION_FAILED/u,
  );
});

test("deployed evidence is candidate/image-bound and contains no raw scope or content values", () => {
  const rawValues = [
    "run-valid", "project-valid", "attempt-valid", "external-valid", "release-valid",
    "run-null", "project-null", "attempt-null", "external-null",
    "private query", "KB-PROBE-7F31A9C2", "00-知识验收/生产探针.md",
  ];
  const evidence = buildKnowledgeSmokeEvidence({
    binding: {
      candidateCommit: "a".repeat(40),
      runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
      deerFlowImageDigest: `sha256:${"c".repeat(64)}`,
    },
    valid: {
      scopeIds: rawValues.slice(0, 4),
      releaseId: "release-valid",
      successfulInvocationCount: 1,
      checkpointStatesScanned: 4,
      structuredValuesScanned: 80,
      proof: {
        declaredToolCalls: 1,
        namedToolMessages: 1,
        deerFlowResults: 1,
        ledgerResults: 1,
        citationFingerprint: "d".repeat(64),
      },
    },
    nullRelease: {
      scopeIds: rawValues.slice(5, 9),
      grantCount: 0,
      endpointCalls: 0,
      catalog: {
        declaredToolCalls: 0,
        namedToolMessages: 0,
        retrievalResults: 0,
        capabilityMissingObserved: false,
      },
      checkpointStatesScanned: 3,
      structuredValuesScanned: 60,
    },
    isolation: {
      concurrentExecutionObserved: true,
      distinctRuntimeScopes: true,
      validScopeEndpointCalls: 1,
      nullScopeEndpointCalls: 0,
    },
    forbiddenValues: rawValues,
  });
  assert.equal(evidence.schema, "workbench.deerflow-knowledge-deployed-evidence.v2");
  assert.equal(evidence.validPinnedRelease.catalogVisible, true);
  assert.equal(evidence.nullRelease.catalogHidden, true);
  assert.equal(evidence.nullRelease.endpointCalls, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /run-valid|release-valid|private query|KB-PROBE/u);
  assert.throws(
    () => assertRedactedKnowledgeEvidence({ runId: "run-valid" }, ["run-valid"]),
    /KNOWLEDGE_SMOKE_EVIDENCE_RAW_VALUE_LEAK/u,
  );
});

test("unexpected failures are reduced to a stable non-sensitive code", () => {
  assert.equal(
    safeKnowledgeSmokeError(new Error("provider failed for run-secret with https://internal.example.test")),
    "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE",
  );
  assert.equal(
    safeKnowledgeSmokeError(new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO")),
    "KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO",
  );
  assert.equal(
    safeKnowledgeSmokeError(new Error("SECRET_USER_DATA")),
    "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE",
  );
});

test("final output and checkpoint coverage fail closed", () => {
  assert.doesNotThrow(() => assertFinalOutputContainsEvidence(
    { text: "KB-PROBE-7F31A9C2，来源 00-知识验收/生产探针.md" },
    "KB-PROBE-7F31A9C2",
    "00-知识验收/生产探针.md",
  ));
  assert.throws(
    () => assertFinalOutputContainsEvidence({ text: "no evidence" }, "KB-PROBE-7F31A9C2", "source.md"),
    /KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_PROBE/u,
  );
  assert.throws(
    () => assertCompleteHistory(Array.from({ length: 10 }), 10),
    /KNOWLEDGE_SMOKE_STATE_HISTORY_TRUNCATED/u,
  );
});
