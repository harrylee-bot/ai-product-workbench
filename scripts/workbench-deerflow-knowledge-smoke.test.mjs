import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCompleteHistory,
  assertFinalOutputContainsEvidence,
  assertKnowledgeRetrievalProof,
  assertNoKnowledgeCapabilityLeak,
  readKnowledgeSmokeEnvironment,
  redactKnowledgeCapability,
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
  WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID: "run-1",
  WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID: "principal-1",
  WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID: "project-1",
  WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID: "release-1",
  WORKBENCH_KNOWLEDGE_SMOKE_QUERY: "产品知识探针对应的发布规范是什么？",
  WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE: "KB-PROBE-7F31A9C2",
  WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION: "00-知识验收/生产探针.md",
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
