import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertDeploymentBinding,
  assertCompleteHistory,
  assertConcurrentOppositeScope,
  assertExternalRunBinding,
  assertFinalOutputContainsEvidence,
  assertHistoryBoundToExternalRun,
  assertKnowledgeCatalogHidden,
  createKnowledgeCatalogObservation,
  extractDeploymentBinding,
  assertKnowledgeEvidenceAbsent,
  assertKnowledgeGrantScope,
  assertKnowledgeRetrievalProof,
  assertNoKnowledgeCapabilityLeak,
  assertRedactedKnowledgeEvidence,
  assertRuntimeAttemptIdentityBinding,
  assertRuntimeWorkerExecutionBinding,
  assertRuntimeWorkerExecutionTrustPolicy,
  buildKnowledgeSmokeEvidence,
  collectKnownSmokeSecrets,
  readKnowledgeSmokeEnvironment,
  redactKnowledgeCapability,
  runtimeExecuteSmokeJob,
  safeKnowledgeSmokeError,
} from "./workbench-deerflow-knowledge-smoke-lib.mjs";

const workerExecutionKeys = generateKeyPairSync("ed25519");
const workerExecutionKeySha256 = createHash("sha256")
  .update(workerExecutionKeys.publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");
const workerExecutionKeyId = `sha256:${workerExecutionKeySha256}`;
const workerExecutionSignerId = "runtime-worker-production";
const environmentId = "workbench-production";
const workerExecutionTrustPolicy = {
  environmentId,
  keys: new Map([[workerExecutionKeyId, {
    publicKey: workerExecutionKeys.publicKey,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validUntil: new Date("2027-01-01T00:00:00.000Z"),
    revokedAt: null,
  }]]),
  approvalAuthorities: [],
  receiptAuthorities: [{
    scopeId: "production-runtime.worker-execution",
    signerId: workerExecutionSignerId,
    keyId: workerExecutionKeyId,
  }],
};

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
  WORKBENCH_ENVIRONMENT_ID: environmentId,
  WORKBENCH_RUNTIME_WORKER_IMAGE_REF: `registry.example.test/workbench/runtime-worker@sha256:${"b".repeat(64)}`,
  WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID: workerExecutionKeyId,
  WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID: workerExecutionSignerId,
  WORKBENCH_DEERFLOW_IMAGE_REF: `registry.example.test/workbench/deerflow@sha256:${"c".repeat(64)}`,
  WORKBENCH_DEERFLOW_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  WORKBENCH_PRODUCTION_TRUST_POLICY_PATH: "/etc/workbench/production-trust-policy.json",
  WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256: "d".repeat(64),
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
const smokeRunnerSource = readFileSync(
  new URL("./workbench-deerflow-knowledge-smoke.mjs", import.meta.url),
  "utf8",
);

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

function dockerReplica({ containerId, hostname, imageRef, imageDigest, imageId, commit }) {
  return {
    containerId,
    hostname,
    configuredImageRef: imageRef,
    containerImageId: imageId,
    running: true,
    status: "running",
    healthStatus: "healthy",
    imageId,
    imageLabels: { "org.opencontainers.image.revision": commit },
    repoDigests: [imageRef.slice(0, imageRef.lastIndexOf("@") + 1) + imageDigest],
    environmentId,
    executionKeyId: workerExecutionKeyId,
    executionSignerId: workerExecutionSignerId,
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function signedWorkerExecution(result, jobId, runtimeAttemptId, containerHostname) {
  const statement = {
    candidateCommit: baseEnvironment.WORKBENCH_SOURCE_COMMIT,
    containerHostname,
    environmentId,
    jobId,
    resultSha256: createHash("sha256").update(canonicalJson(result)).digest("hex"),
    runtimeAttemptId,
    runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
    scopeId: "production-runtime.worker-execution",
    signedAtUtc: "2026-08-03T00:00:01.000Z",
    signerId: workerExecutionSignerId,
  };
  const protocol = "workbench.runtime-worker-execution.v2";
  return {
    protocol,
    statement,
    signature: {
      algorithm: "Ed25519",
      keyId: workerExecutionKeyId,
      value: sign(
        null,
        Buffer.from(canonicalJson({ protocol, statement })),
        workerExecutionKeys.privateKey,
      ).toString("base64url"),
    },
  };
}

function forgedCatalogObservation(toolNames, knowledgeVisible, extra = {}) {
  const payload = {
    knowledgeVisible,
    protocol: "workbench.runtime.tool-catalog-observation.v1",
    toolNames,
  };
  const sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, sha256, ...extra };
}

function catalogAiMessage(toolNames, knowledgeVisible, values = {}) {
  return {
    type: "ai",
    content: "",
    ...values,
    response_metadata: {
      ...(values.response_metadata ?? {}),
      workbench_tool_catalog_observation: createKnowledgeCatalogObservation(
        toolNames,
        knowledgeVisible,
      ),
    },
  };
}

function observedCatalogAiMessage(observation, values = {}) {
  return {
    type: "ai",
    content: "",
    ...values,
    response_metadata: {
      ...(values.response_metadata ?? {}),
      workbench_tool_catalog_observation: observation,
    },
  };
}

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

test("production defaults to the deployed queue and direct mode is always rejected", () => {
  const parsed = readKnowledgeSmokeEnvironment(baseEnvironment);
  assert.equal(parsed.mode, "deployed-queue");
  assert.equal(parsed.timeoutMs, 30 * 60 * 1_000);
  assert.equal(parsed.binding.runtimeWorkerImageRef, baseEnvironment.WORKBENCH_RUNTIME_WORKER_IMAGE_REF);
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      WORKBENCH_KNOWLEDGE_SMOKE_MODE: "direct",
    }),
    /KNOWLEDGE_SMOKE_PRODUCTION_REQUIRES_DEPLOYED_QUEUE/u,
  );
  assert.throws(
    () => readKnowledgeSmokeEnvironment({
      ...baseEnvironment,
      NODE_ENV: "test",
      WORKBENCH_KNOWLEDGE_SMOKE_MODE: "direct",
    }),
    /KNOWLEDGE_SMOKE_NODE_ENV_MUST_BE_PRODUCTION/u,
  );
  for (const name of [
    "WORKBENCH_KNOWLEDGE_SMOKE_DEPLOYMENT_RECEIPT_PATH",
    "WORKBENCH_DEPLOYMENT_RECEIPT_PATH",
    "WORKBENCH_PRODUCTION_DEPLOYMENT_RECEIPT_PATH",
  ]) {
    assert.throws(
      () => readKnowledgeSmokeEnvironment({ ...baseEnvironment, [name]: "/tmp/attacker.json" }),
      /KNOWLEDGE_SMOKE_DEPLOYMENT_RECEIPT_OVERRIDE_FORBIDDEN/u,
    );
  }
});

test("live Docker observations bind every healthy replica to immutable images", () => {
  const commit = "a".repeat(40);
  const workerDigest = "sha256:" + "b".repeat(64);
  const deerFlowDigest = "sha256:" + "c".repeat(64);
  const expected = {
    candidateCommit: commit,
    environmentId,
    runtimeWorkerImageRef: "registry.example.test/runtime-worker@" + workerDigest,
    runtimeWorkerImageDigest: workerDigest,
    runtimeWorkerExecutionKeyId: workerExecutionKeyId,
    runtimeWorkerExecutionSignerId: workerExecutionSignerId,
    deerFlowImageRef: "registry.example.test/deerflow@" + deerFlowDigest,
    deerFlowImageDigest: deerFlowDigest,
  };
  const runtimeWorker = dockerReplica({
    containerId: "1".repeat(64),
    hostname: "worker-1",
    imageRef: expected.runtimeWorkerImageRef,
    imageDigest: workerDigest,
    imageId: "sha256:" + "e".repeat(64),
    commit,
  });
  const deerFlow = dockerReplica({
    containerId: "2".repeat(64),
    hostname: "deerflow-1",
    imageRef: expected.deerFlowImageRef,
    imageDigest: deerFlowDigest,
    imageId: "sha256:" + "f".repeat(64),
    commit,
  });
  const observation = {
    source: "docker-inspect",
    runtimeWorkers: [
      runtimeWorker,
      { ...runtimeWorker, containerId: "3".repeat(64), hostname: "worker-2" },
    ],
    deerFlows: [deerFlow],
  };
  const binding = assertDeploymentBinding(expected, observation);
  assert.equal(binding.runtimeWorkerReplicaCount, 2);
  assert.deepEqual(binding.runtimeWorkerContainerHostnames, ["worker-1", "worker-2"]);
  assert.equal(binding.runtimeWorkerSourceCommit, commit);
  assert.deepEqual(extractDeploymentBinding(observation), binding);

  assert.throws(
    () => extractDeploymentBinding({ source: "receipt", runtimeWorkers: [], deerFlows: [] }),
    /KNOWLEDGE_SMOKE_DEPLOYMENT_OBSERVATION_INVALID/u,
  );
  assert.throws(
    () => assertDeploymentBinding(expected, {
      ...observation,
      runtimeWorkers: [{
        ...runtimeWorker,
        containerImageId: "sha256:" + "9".repeat(64),
      }],
    }),
    /KNOWLEDGE_SMOKE_RUNTIME_WORKER_CONTAINER_INVALID/u,
  );
  for (const state of [
    { running: false, status: "exited", healthStatus: "healthy" },
    { running: true, status: "running", healthStatus: "unhealthy" },
  ]) {
    assert.throws(
      () => assertDeploymentBinding(expected, {
        ...observation,
        runtimeWorkers: [{ ...runtimeWorker, ...state }],
      }),
      /KNOWLEDGE_SMOKE_RUNTIME_WORKER_CONTAINER_INVALID/u,
    );
  }
  assert.throws(
    () => assertDeploymentBinding(expected, {
      ...observation,
      runtimeWorkers: [
        runtimeWorker,
        {
          ...runtimeWorker,
          containerId: "3".repeat(64),
          hostname: "worker-2",
          configuredImageRef: "registry.example.test/runtime-worker@sha256:" + "7".repeat(64),
          repoDigests: ["registry.example.test/runtime-worker@sha256:" + "7".repeat(64)],
        },
      ],
    }),
    /KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_(?:REF|DIGEST)_CONFLICT/u,
  );
  assert.throws(
    () => assertDeploymentBinding(expected, {
      ...observation,
      deerFlows: [{
        ...deerFlow,
        imageLabels: {
          "io.workbench.deerflow.source-commit": commit,
        },
      }],
    }),
    /KNOWLEDGE_SMOKE_DEERFLOW_CONTAINER_INVALID/u,
  );
  assert.throws(
    () => assertDeploymentBinding(expected, {
      ...observation,
      runtimeWorkers: [{
        ...runtimeWorker,
        repoDigests: [
          expected.runtimeWorkerImageRef,
          "registry.example.test/runtime-worker@sha256:" + "8".repeat(64),
        ],
      }],
    }),
    /KNOWLEDGE_SMOKE_RUNTIME_WORKER_REPO_DIGEST_CONFLICT/u,
  );
});

test("live Docker discovery includes stopped and failed service replicas", () => {
  assert.match(
    smokeRunnerSource,
    /"docker", \[\s*"ps",\s*"--all",\s*"--quiet"/u,
  );
});

test("production smoke scans provider persistence and requires a clean candidate checkout", () => {
  assert.match(smokeRunnerSource, /runtimeExternalEvent\.findMany/u);
  assert.match(smokeRunnerSource, /payload: true/u);
  assert.match(smokeRunnerSource, /runtimeProviderState\.findMany/u);
  assert.match(smokeRunnerSource, /rawAssistantText: true/u);
  assert.match(smokeRunnerSource, /providerIdempotencyKey: true/u);
  assert.match(smokeRunnerSource, /executionLeaseExpiresAt: true/u);
  assert.match(smokeRunnerSource, /leaseToken: true/u);
  assert.match(smokeRunnerSource, /runtimeBinding:\s*\{[\s\S]*metadata: true/u);
  assert.match(smokeRunnerSource, /where: \{ id: receipt\.id, runId: smoke\.runId, attempt: receipt\.attempt \}/u);
  assert.match(smokeRunnerSource, /--porcelain=v1/u);
  assert.match(smokeRunnerSource, /KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_DIRTY/u);
});

test("queue smoke payload is strict and cannot be empty", () => {
  assert.deepEqual(runtimeExecuteSmokeJob("run-queue"), {
    runId: "run-queue",
    approvalIds: [],
  });
  assert.throws(
    () => runtimeExecuteSmokeJob(""),
    /KNOWLEDGE_SMOKE_QUEUE_PAYLOAD_INVALID/u,
  );
});

test("queue completion is bound to the exact candidate worker consumer and RuntimeAttempt", () => {
  const expected = [
    { runId: "run-queue", runtimeAttemptId: "attempt-queue" },
    { runId: "run-null", runtimeAttemptId: "attempt-null" },
  ];
  const jobs = expected.map((execution, index) => {
    const jobId = `job-${index + 1}`;
    const containerHostname = index === 0 ? "worker-1" : "worker-2";
    const result = {
      runId: execution.runId,
      artifactCount: 1,
    };
    return {
      id: jobId,
      state: "completed",
      data: runtimeExecuteSmokeJob(execution.runId),
      output: {
        ...result,
        workerExecution: signedWorkerExecution(
          result,
          jobId,
          execution.runtimeAttemptId,
          containerHostname,
        ),
      },
    };
  });
  const deployment = {
    candidateCommit: baseEnvironment.WORKBENCH_SOURCE_COMMIT,
    environmentId,
    runtimeWorkerContainerHostnames: ["worker-1", "worker-2"],
    runtimeWorkerExecutionKeyId: workerExecutionKeyId,
    runtimeWorkerExecutionSignerId: workerExecutionSignerId,
    runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
  };
  const executionWindow = {
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:00:02.000Z",
  };
  assert.deepEqual(assertRuntimeWorkerExecutionTrustPolicy(
    workerExecutionTrustPolicy,
    deployment,
  ), {
    environmentId,
    keyId: workerExecutionKeyId,
    scopeId: "production-runtime.worker-execution",
    signerId: workerExecutionSignerId,
  });
  assert.deepEqual(
    assertRuntimeWorkerExecutionBinding(
      jobs,
      expected,
      deployment,
      workerExecutionTrustPolicy,
      executionWindow,
    ),
    {
      queueConsumerBound: true,
      queueJobCount: 2,
      runtimeWorkerConsumerCount: 2,
    },
  );
  for (const forged of [
    { ...jobs[0], output: { ...jobs[0].output, workerExecution: undefined } },
    { ...jobs[0], output: { ...jobs[0].output, skipped: true } },
    { ...jobs[0], data: { ...jobs[0].data, approvalIds: ["forged-approval"] } },
    {
      ...jobs[0],
      output: {
        ...jobs[0].output,
        workerExecution: {
          ...jobs[0].output.workerExecution,
          statement: {
            ...jobs[0].output.workerExecution.statement,
            containerHostname: "old-worker",
          },
        },
      },
    },
    {
      ...jobs[0],
      output: {
        ...jobs[0].output,
        workerExecution: {
          ...jobs[0].output.workerExecution,
          statement: {
            ...jobs[0].output.workerExecution.statement,
            runtimeAttemptId: "other-attempt",
          },
        },
      },
    },
  ]) {
    assert.throws(
      () => assertRuntimeWorkerExecutionBinding(
        [forged, jobs[1]],
        expected,
        deployment,
        workerExecutionTrustPolicy,
        executionWindow,
      ),
      /KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_MISMATCH/u,
    );
  }
});

test("worker execution receipt key cannot authorize production approvals", () => {
  const expected = [{ runId: "run-queue", runtimeAttemptId: "attempt-queue" }];
  const result = { runId: "run-queue", artifactCount: 1 };
  const jobs = [{
    id: "job-1",
    state: "completed",
    data: runtimeExecuteSmokeJob("run-queue"),
    output: {
      ...result,
      workerExecution: signedWorkerExecution(result, "job-1", "attempt-queue", "worker-1"),
    },
  }];
  const deployment = {
    candidateCommit: baseEnvironment.WORKBENCH_SOURCE_COMMIT,
    environmentId,
    runtimeWorkerContainerHostnames: ["worker-1"],
    runtimeWorkerExecutionKeyId: workerExecutionKeyId,
    runtimeWorkerExecutionSignerId: workerExecutionSignerId,
    runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
  };
  const sharedKeyTrustPolicy = {
    ...workerExecutionTrustPolicy,
    approvalAuthorities: [{
      role: "Release",
      approverId: "release-approver",
      keyId: workerExecutionKeyId,
    }],
  };

  assert.throws(
    () => assertRuntimeWorkerExecutionTrustPolicy(sharedKeyTrustPolicy, deployment),
    /KNOWLEDGE_SMOKE_TRUST_POLICY_INVALID/u,
  );
  assert.throws(
    () => assertRuntimeWorkerExecutionBinding(
      jobs,
      expected,
      deployment,
      sharedKeyTrustPolicy,
      {
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:02.000Z",
      },
    ),
    /KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_MISMATCH/u,
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
  const raw = [
    `WORKBENCH_KNOWLEDGE_CAPABILITY=wbkg1.${"a".repeat(64)}.${"b".repeat(43)}`,
    `WORKBENCH_CANVAS_CAPABILITY=wbct1.${"c".repeat(64)}.${"d".repeat(43)}`,
  ].join("\n");
  const redacted = redactKnowledgeCapability(raw);
  assert.doesNotMatch(
    redacted,
    /WORKBENCH_(?:KNOWLEDGE|CANVAS)_CAPABILITY|wb(?:kg|ct)1\./u,
  );
  assert.match(redacted, /REDACTED_CAPABILITY/u);
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
  assert.throws(
    () => assertNoKnowledgeCapabilityLeak([{
      label: "run",
      value: { nested: `wbct1.${"y".repeat(32)}` },
    }]),
    /KNOWLEDGE_SMOKE_CAPABILITY_LEAK:run/u,
  );
});

test("leak scan rejects base64url and hex encoded capability tokens", () => {
  for (const token of [
    `wbkg1.${"a".repeat(64)}.${"b".repeat(43)}`,
    `wbct1.${"c".repeat(64)}.${"d".repeat(43)}`,
  ]) {
    const base64url = Buffer.from(token, "utf8").toString("base64url");
    const hex = Buffer.from(token, "utf8").toString("hex");
    for (const encoded of [base64url, hex]) {
      assert.throws(
        () => assertNoKnowledgeCapabilityLeak([{ label: "state", value: { payload: encoded } }]),
        /KNOWLEDGE_SMOKE_CAPABILITY_LEAK/u,
      );
    }
    assert.throws(
      () => assertNoKnowledgeCapabilityLeak([{
        label: "bytes",
        value: { payload: Uint8Array.from(Buffer.from(base64url, "utf8")) },
      }]),
      /KNOWLEDGE_SMOKE_CAPABILITY_LEAK/u,
    );
  }
});

test("leak scan rejects raw, encoded, and byte-array secrets without exposing details", () => {
  const secret = "known-secret-value";
  assert.equal(
    assertNoKnowledgeCapabilityLeak([{ label: "attempt", value: { payload: "safe" } }], [secret]),
    2,
  );
  assert.throws(
    () => assertNoKnowledgeCapabilityLeak(
      [{ label: "attempt", value: { payload: `prefix-${secret}-suffix` } }],
      [secret],
    ),
    (error) => {
      assert.equal(error.message, "KNOWLEDGE_SMOKE_SENSITIVE_VALUE_LEAK");
      assert.doesNotMatch(error.message, /known-secret|attempt|payload/u);
      return true;
    },
  );
  assert.throws(
    () => assertNoKnowledgeCapabilityLeak(
      [{ label: "event", value: { payload: Buffer.from(secret).toString("base64") } }],
      [secret],
    ),
    /KNOWLEDGE_SMOKE_SENSITIVE_VALUE_LEAK/u,
  );
  const secretBytes = Uint8Array.from([12, 34, 56, 78, 90]);
  assert.throws(
    () => assertNoKnowledgeCapabilityLeak(
      [{ label: "provider-state", value: { bytes: [0, ...secretBytes, 255] } }],
      [secretBytes],
    ),
    /KNOWLEDGE_SMOKE_SENSITIVE_VALUE_LEAK/u,
  );
});

test("configured short credentials fail closed while short ordinary identifiers do not", () => {
  assert.throws(
    () => collectKnownSmokeSecrets({ deerFlowInternalToken: "x" }, {}),
    /KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT/u,
  );
  assert.throws(
    () => collectKnownSmokeSecrets({}, { DEERFLOW_INTERNAL_AUTH_TOKEN: "xyz" }),
    /KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT/u,
  );
  assert.throws(
    () => collectKnownSmokeSecrets({ databaseUrl: "postgresql://user:x@db/workbench" }, {}),
    /KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT/u,
  );
  assert.throws(
    () => collectKnownSmokeSecrets({ canvasTool: { secret: Uint8Array.of(1, 2, 3) } }, {}),
    /KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT/u,
  );
  assert.doesNotThrow(
    () => collectKnownSmokeSecrets({ deerFlowGatewayUrl: "x" }, {}),
  );
});

test("runtime attempt receipt is bound to the exact run attempt and thread", () => {
  const providerIdempotencyKey = `wbrt:${createHash("sha256").update("attempt-1").digest("hex")}`;
  const receipt = {
    id: "attempt-1",
    runId: "run-1",
    runtimeBindingId: "binding-1",
    attempt: 1,
    adapter: "deerflow",
    providerIdempotencyKey,
    externalThreadId: "external-thread-1",
    runtimeBinding: {
      id: "binding-1",
      threadId: "thread-1",
      adapter: "deerflow",
      externalThreadId: "external-thread-1",
      metadata: {
        workbenchProjectId: "project-1",
        workbenchThreadId: "thread-1",
        workbenchPrincipalId: "principal-1",
      },
    },
  };
  assert.equal(assertRuntimeAttemptIdentityBinding({
    receipt,
    runId: "run-1",
    attempt: 1,
    projectId: "project-1",
    principalId: "principal-1",
    threadId: "thread-1",
  }), receipt);
  for (const forged of [
    { ...receipt, id: "" },
    { ...receipt, runId: "other-run" },
    { ...receipt, attempt: 2 },
    { ...receipt, externalThreadId: "other-thread" },
    { ...receipt, runtimeBindingId: undefined },
    { ...receipt, runtimeBinding: { ...receipt.runtimeBinding, id: undefined } },
    { ...receipt, adapter: undefined },
    { ...receipt, runtimeBinding: { ...receipt.runtimeBinding, adapter: undefined } },
  ]) {
    assert.throws(
      () => assertRuntimeAttemptIdentityBinding({
        receipt: forged,
        runId: "run-1",
        attempt: 1,
        projectId: "project-1",
        principalId: "principal-1",
        threadId: "thread-1",
      }),
      /KNOWLEDGE_SMOKE_RUNTIME_ATTEMPT_IDENTITY_MISMATCH/u,
    );
  }
});

test("knowledge grants, budgets, and invocations must share both scope identities", () => {
  const valid = {
    grants: [{
      id: "grant-1",
      runtimeAttemptId: "attempt-1",
      runId: "run-1",
      principalId: "principal-1",
      projectId: "project-1",
      releaseId: "release-1",
      budget: { runtimeAttemptId: "attempt-1" },
      invocations: [{ id: "invocation-1", runtimeAttemptId: "attempt-1", lastGrantId: "grant-1" }],
    }],
    budgets: [{
      runtimeAttemptId: "attempt-1",
      runtimeAttempt: { id: "attempt-1", runId: "run-1" },
    }],
    invocationCount: 1,
  };
  const expected = {
    runtimeAttemptId: "attempt-1",
    runId: "run-1",
    principalId: "principal-1",
    projectId: "project-1",
    releaseId: "release-1",
  };
  assert.doesNotThrow(() => assertKnowledgeGrantScope(valid, expected));
  for (const forged of [
    { ...valid, grants: [{ ...valid.grants[0], runId: "other-run" }] },
    { ...valid, grants: [{ ...valid.grants[0], runtimeAttemptId: "other-attempt" }] },
    { ...valid, budgets: [{ ...valid.budgets[0], runtimeAttempt: { id: "attempt-1", runId: "other-run" } }] },
    { ...valid, grants: [{ ...valid.grants[0], invocations: [{ ...valid.grants[0].invocations[0], lastGrantId: "other-grant" }] }] },
  ]) {
    assert.throws(
      () => assertKnowledgeGrantScope(forged, expected),
      /KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH/u,
    );
  }
});

test("trusted ToolMessage and immutable ledger response must share the probe citation", () => {
  const state = {
    values: {
      messages: [
        catalogAiMessage(["workbench_knowledge_retrieve"], true, {
          tool_calls: [{ id: "call-1", name: "workbench_knowledge_retrieve", args: { query: "probe" } }],
        }),
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
      deerFlowSurfaces: [{ messages: [
        catalogAiMessage(
          ["workbench_knowledge_retrieve"],
          true,
          { content: JSON.stringify(retrievalResult) },
        ),
      ] }],
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
    deerFlowSurfaces: [{ messages: [
      catalogAiMessage(["workbench_knowledge_retrieve"], true),
      ...toolState.messages,
    ] }],
      ledgerResponses: [mismatched],
      releaseId: "release-1",
      expectedProbe: "KB-PROBE-7F31A9C2",
      expectedCitation: "00-知识验收/生产探针.md",
    }),
    /KNOWLEDGE_SMOKE_DEERFLOW_LEDGER_MISMATCH/u,
  );
});

test("null-release catalog proof rejects tool declarations, ToolMessages, and capability fallback", () => {
  const hidden = assertKnowledgeCatalogHidden([
    { values: { messages: [
      catalogAiMessage([], false, { content: "tool is unavailable" }),
    ] } },
  ]);
  assert.match(hidden.catalogSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(hidden, {
    observationObserved: true,
    catalogSha256: hidden.catalogSha256,
    declaredToolCalls: 0,
    namedToolMessages: 0,
    retrievalResults: 0,
    capabilityMissingObserved: false,
  });
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [
      catalogAiMessage([], false, {
      tool_calls: [{ id: "forged", name: "workbench_knowledge_retrieve", args: {} }],
      }),
    ] }]),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [
      catalogAiMessage([], false),
      {
      type: "tool",
      name: "workbench_knowledge_retrieve",
      content: "blocked",
      },
    ] }]),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [
      catalogAiMessage([], false, {
      content: "WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING",
      }),
    ] }]),
    /KNOWLEDGE_SMOKE_NULL_RELEASE_REACHED_CAPABILITY_DEFENSE/u,
  );
});

test("catalog visibility proof fails closed when the model-bound observation is absent or forged", () => {
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [{ type: "ai", content: "no tool call" }] }]),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [{
      type: "system",
      content: JSON.stringify(createKnowledgeCatalogObservation([], false)),
    }] }]),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [{
      type: "ai",
      content: { messages: [catalogAiMessage([], false)] },
    }] }]),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [
      catalogAiMessage([], false),
      { type: "ai", content: "unstamped later model response" },
    ] }]),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING/u,
  );
  const forged = {
    ...createKnowledgeCatalogObservation([], false),
    knowledgeVisible: true,
  };
  assert.throws(
    () => assertKnowledgeCatalogHidden([{ messages: [observedCatalogAiMessage(forged)] }]),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_(?:OBSERVATION_INVALID|MEMBERSHIP_MISMATCH)/u,
  );
  for (const semanticForgery of [
    forgedCatalogObservation([], true),
    forgedCatalogObservation(["workbench_knowledge_retrieve"], false),
    forgedCatalogObservation(["workbench_knowledge_retrieve", "workbench_knowledge_retrieve"], true),
    forgedCatalogObservation(["workbench_unknown_tool"], false),
    forgedCatalogObservation(["Read_File"], false),
    forgedCatalogObservation([], false, { extra: "forbidden" }),
  ]) {
    assert.throws(
      () => assertKnowledgeCatalogHidden([{
        messages: [observedCatalogAiMessage(semanticForgery)],
      }]),
      /KNOWLEDGE_SMOKE_MODEL_CATALOG_(?:OBSERVATION_INVALID|MEMBERSHIP_MISMATCH|TOOL_NAMES_(?:INVALID|DUPLICATED))/u,
    );
  }
  assert.throws(
    () => createKnowledgeCatalogObservation([], true),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_MEMBERSHIP_MISMATCH/u,
  );
  assert.throws(
    () => createKnowledgeCatalogObservation(["workbench_unknown_tool"], false),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_TOOL_NAMES_INVALID/u,
  );
  assert.throws(
    () => assertKnowledgeCatalogHidden([{
      messages: [
        catalogAiMessage([], false),
        catalogAiMessage(["workbench_knowledge_retrieve"], true),
      ],
    }]),
    /KNOWLEDGE_SMOKE_MODEL_CATALOG_VISIBILITY_MISMATCH/u,
  );
});

test("catalog proof accepts deferred promotions and returns a deterministic aggregate fingerprint", () => {
  const base = catalogAiMessage(["safe_tool", "workbench_knowledge_retrieve"], true);
  const promoted = catalogAiMessage(
    ["safe_tool", "promoted_tool", "workbench_knowledge_retrieve"],
    true,
    {
      tool_calls: [{
        id: "call-1",
        name: "workbench_knowledge_retrieve",
        args: { query: "probe" },
      }],
    },
  );
  const forward = assertKnowledgeRetrievalProof({
    deerFlowSurfaces: [{ messages: [
      base,
      promoted,
      {
        type: "tool",
        name: "workbench_knowledge_retrieve",
        tool_call_id: "call-1",
        content: JSON.stringify(retrievalResult),
      },
    ] }],
    ledgerResponses: [retrievalResult],
    releaseId: "release-1",
    expectedProbe: "KB-PROBE-7F31A9C2",
    expectedCitation: "00-知识验收/生产探针.md",
  });
  const reverse = assertKnowledgeRetrievalProof({
    deerFlowSurfaces: [{ messages: [
      promoted,
      base,
      {
        type: "tool",
        name: "workbench_knowledge_retrieve",
        tool_call_id: "call-1",
        content: JSON.stringify(retrievalResult),
      },
    ] }],
    ledgerResponses: [retrievalResult],
    releaseId: "release-1",
    expectedProbe: "KB-PROBE-7F31A9C2",
    expectedCitation: "00-知识验收/生产探针.md",
  });
  assert.match(forward.catalogSha256, /^[a-f0-9]{64}$/u);
  assert.equal(forward.catalogSha256, reverse.catalogSha256);
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

test("DeerFlow run and checkpoint proof is bound to the current external Run and RuntimeAttempt", () => {
  const providerIdempotencyKey = `wbrt:${createHash("sha256").update("attempt-1").digest("hex")}`;
  const expected = {
    externalRunId: "external-run-1",
    externalThreadId: "external-thread-1",
    workbenchRunId: "run-1",
    runtimeAttemptId: "attempt-1",
    providerIdempotencyKey,
    attempt: 1,
  };
  const externalRun = {
    run_id: expected.externalRunId,
    thread_id: expected.externalThreadId,
    metadata: {
      workbench_run_id: expected.workbenchRunId,
      workbench_runtime_attempt_id: expected.runtimeAttemptId,
      workbench_provider_idempotency_key: expected.providerIdempotencyKey,
      workbench_attempt: expected.attempt,
    },
  };
  const history = [{
    metadata: {
      run_id: expected.externalRunId,
      workbench_run_id: expected.workbenchRunId,
      workbench_runtime_attempt_id: expected.runtimeAttemptId,
      workbench_provider_idempotency_key: expected.providerIdempotencyKey,
      workbench_attempt: expected.attempt,
    },
    values: { messages: [] },
  }];
  assert.equal(assertExternalRunBinding(externalRun, expected), externalRun);
  assert.equal(assertHistoryBoundToExternalRun(history, expected), history);
  assert.throws(
    () => assertExternalRunBinding({
      ...externalRun,
      metadata: { ...externalRun.metadata, workbench_provider_idempotency_key: "other-key" },
    }, expected),
    /KNOWLEDGE_SMOKE_EXTERNAL_RUN_BINDING_MISMATCH/u,
  );
  assert.throws(
    () => assertHistoryBoundToExternalRun([
      ...history,
      {
        metadata: {
          run_id: "other-external-run",
          workbench_run_id: "other-run",
          workbench_runtime_attempt_id: "other-attempt",
          workbench_provider_idempotency_key: "other-key",
          workbench_attempt: 2,
        },
        values: {
          messages: [catalogAiMessage(["workbench_knowledge_retrieve"], true)],
        },
      },
    ], expected),
    /KNOWLEDGE_SMOKE_EXTERNAL_RUN_HISTORY_MISMATCH/u,
  );
});

test("deployed evidence requires completed persisted-surface coverage and contains no raw values", () => {
  const rawValues = [
    "run-valid", "project-valid", "attempt-valid", "external-valid", "release-valid",
    "run-null", "project-null", "attempt-null", "external-null",
    "private query", "KB-PROBE-7F31A9C2", "00-知识验收/生产探针.md",
  ];
  const evidenceInput = {
    binding: {
      candidateCommit: "a".repeat(40),
      runtimeWorkerImageDigest: `sha256:${"b".repeat(64)}`,
      runtimeWorkerExecutionKeyId: workerExecutionKeyId,
      deerFlowImageDigest: `sha256:${"c".repeat(64)}`,
      source: "docker-inspect",
      queueConsumerBound: true,
      queueJobCount: 2,
      runtimeWorkerConsumerCount: 1,
      runtimeWorkerReplicaCount: 2,
      deerFlowReplicaCount: 1,
    },
    valid: {
      scopeIds: rawValues.slice(0, 4),
      releaseId: "release-valid",
      successfulInvocationCount: 1,
      checkpointStatesScanned: 4,
      structuredValuesScanned: 180,
      persisted: {
        sensitiveScanCompleted: true,
        sensitiveValuesChecked: 9,
        sensitiveValuesScanned: 120,
        runtimeAttempts: 1,
        runtimeBindings: 1,
        runtimeExternalEvents: 4,
        runtimeProviderStates: 1,
        runEvents: 8,
        threadEntries: 1,
        knowledgeBudgets: 1,
        knowledgeGrants: 1,
        knowledgeInvocations: 1,
        sourceSnapshots: 0,
        artifactVersions: 0,
      },
      proof: {
        catalogObservationObserved: true,
        catalogSha256: "e".repeat(64),
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
        observationObserved: true,
        catalogSha256: "f".repeat(64),
        declaredToolCalls: 0,
        namedToolMessages: 0,
        retrievalResults: 0,
        capabilityMissingObserved: false,
      },
      checkpointStatesScanned: 3,
      structuredValuesScanned: 150,
      persisted: {
        sensitiveScanCompleted: true,
        sensitiveValuesChecked: 9,
        sensitiveValuesScanned: 90,
        runtimeAttempts: 1,
        runtimeBindings: 1,
        runtimeExternalEvents: 3,
        runtimeProviderStates: 1,
        runEvents: 7,
        threadEntries: 1,
        knowledgeBudgets: 0,
        knowledgeGrants: 0,
        knowledgeInvocations: 0,
        sourceSnapshots: 0,
        artifactVersions: 0,
      },
    },
    isolation: {
      concurrentExecutionObserved: true,
      distinctRuntimeScopes: true,
      validScopeEndpointCalls: 1,
      nullScopeEndpointCalls: 0,
    },
    forbiddenValues: rawValues,
  };
  const evidence = buildKnowledgeSmokeEvidence(evidenceInput);
  assert.equal(evidence.schema, "workbench.deerflow-knowledge-deployed-evidence.v5");
  assert.equal(evidence.binding.runtimeWorkerExecutionKeyFingerprint, workerExecutionKeySha256);
  assert.equal(evidence.binding.queueConsumerBound, true);
  assert.equal(evidence.validPinnedRelease.catalogVisible, true);
  assert.equal(evidence.nullRelease.catalogHidden, true);
  assert.equal(evidence.nullRelease.endpointCalls, 0);
  assert.equal(evidence.secretsNotPersisted, true);
  assert.equal(evidence.validPinnedRelease.persistedSurfaceCoverage.runtimeProviderStates, 1);
  assert.equal(evidence.nullRelease.persistedSurfaceCoverage.knowledgeBudgets, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /run-valid|release-valid|private query|KB-PROBE/u);
  assert.throws(
    () => buildKnowledgeSmokeEvidence({
      ...evidenceInput,
      valid: {
        ...evidenceInput.valid,
        persisted: { ...evidenceInput.valid.persisted, sensitiveScanCompleted: false },
      },
    }),
    /KNOWLEDGE_SMOKE_EVIDENCE_INCOMPLETE/u,
  );
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
  assert.equal(
    safeKnowledgeSmokeError(new Error("KNOWLEDGE_SMOKE_FAILED:SECRET_VALUE")),
    "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE",
  );
  assert.equal(
    safeKnowledgeSmokeError(new Error("DEERFLOW_GATEWAY_FAILED:502")),
    "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE",
  );
  assert.equal(
    safeKnowledgeSmokeError(new Error("DEERFLOW_MODEL_CATALOG_FAILED:502")),
    "DEERFLOW_MODEL_CATALOG_FAILED",
  );
  assert.equal(
    safeKnowledgeSmokeError(new Error("KNOWLEDGE_SMOKE_MISSING_ENV:SECRET_ENV_NAME")),
    "KNOWLEDGE_SMOKE_MISSING_ENV",
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
