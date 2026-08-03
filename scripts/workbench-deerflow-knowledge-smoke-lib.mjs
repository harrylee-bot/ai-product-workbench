import { createHash } from "node:crypto";
import path from "node:path";
import {
  resolveReceiptAuthority,
  verifyTrustedEd25519Signature,
} from "./workbench-production-trust-policy.mjs";

const CAPABILITY_NAME = "WORKBENCH_KNOWLEDGE_CAPABILITY";
const CAPABILITY_NAMES = Object.freeze([
  CAPABILITY_NAME,
  "WORKBENCH_CANVAS_CAPABILITY",
]);
const CAPABILITY_PREFIXES = Object.freeze(["wbkg1.", "wbct1."]);
const TOOL_NAME = "workbench_knowledge_retrieve";
const CAPABILITY_TOKEN = /(?:wbkg1|wbct1)\.[A-Za-z0-9_.-]*/gu;
const TOOL_CATALOG_PROTOCOL = "workbench.runtime.tool-catalog-observation.v1";
const TOOL_CATALOG_METADATA_KEY = "workbench_tool_catalog_observation";
const MAX_SCAN_NODES = 1_000_000;
const MAX_SCAN_DEPTH = 128;
const MAX_EMBEDDED_JSON_BYTES = 2 * 1024 * 1024;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;
const WORKBENCH_TOOL_NAMES = new Set([
  "workbench_artifact_draft_publish",
  "workbench_generation_stage_update",
  "workbench_knowledge_retrieve",
  "workbench_prototype_patch_publish",
  "workbench_runtime_result_submit",
]);
const OCI_REVISION_LABEL = "org.opencontainers.image.revision";
const WORKER_EXECUTION_PROTOCOL = "workbench.runtime-worker-execution.v2";
const WORKER_EXECUTION_SCOPE_ID = "production-runtime.worker-execution";
const WORKER_EXECUTION_STATEMENT_KEYS = [
  "candidateCommit",
  "containerHostname",
  "environmentId",
  "jobId",
  "resultSha256",
  "runtimeAttemptId",
  "runtimeWorkerImageDigest",
  "scopeId",
  "signedAtUtc",
  "signerId",
].sort().join("\u0000");
const DEFAULT_SMOKE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_SMOKE_POLL_INTERVAL_MS = 1_000;
const MAX_SMOKE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_SMOKE_POLL_INTERVAL_MS = 60 * 1_000;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const KEY_ID = /^sha256:[a-f0-9]{64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const MAX_CLOCK_SKEW_MS = 60_000;

// Only these stable codes may cross the smoke process boundary. Details after
// a colon are always discarded so HTTP statuses, environment names, scope
// identifiers, and structural paths cannot reach stderr.
const SAFE_KNOWLEDGE_SMOKE_ERROR_CODES = new Set([
  "DEERFLOW_MODEL_CATALOG_FAILED",
  "DEERFLOW_PINNED_MODEL_UNAVAILABLE",
  "DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED",
  "DEERFLOW_SKILL_CATALOG_FAILED",
  "KNOWLEDGE_SMOKE_ASSISTANT_CONFIGURATION_MISMATCH",
  "KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_DIRTY",
  "KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_MISMATCH",
  "KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_UNAVAILABLE",
  "KNOWLEDGE_SMOKE_CAPABILITY_LEAK",
  "KNOWLEDGE_SMOKE_CANDIDATE_COMMIT_CONFLICT",
  "KNOWLEDGE_SMOKE_CANDIDATE_COMMIT_MISSING",
  "KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_DIGEST_MISMATCH",
  "KNOWLEDGE_SMOKE_DEERFLOW_LEDGER_MISMATCH",
  "KNOWLEDGE_SMOKE_DEERFLOW_PROBE_NOT_FOUND",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_BINDING_MISMATCH",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_BINDING_MISSING",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_CHANGED_DURING_EXECUTION",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_COMPOSE_IDENTITY_MISSING",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_CONTAINER_UNAVAILABLE",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_IMAGE_DIGEST_UNAVAILABLE",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_IMAGE_UNAVAILABLE",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_OBSERVATION_INVALID",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_RECEIPT_OVERRIDE_FORBIDDEN",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_REPLICA_DISCOVERY_FAILED",
  "KNOWLEDGE_SMOKE_DEPLOYMENT_REPLICA_SET_INVALID",
  "KNOWLEDGE_SMOKE_DEERFLOW_CONTAINER_INVALID",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_DIGEST_CONFLICT",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_DIGEST_MISSING",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_ID_CONFLICT",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_ID_MISSING",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_REFERENCE_MISMATCH",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_REF_CONFLICT",
  "KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_REF_MISSING",
  "KNOWLEDGE_SMOKE_DEERFLOW_REPLICAS_MISSING",
  "KNOWLEDGE_SMOKE_DEERFLOW_REPO_DIGEST_CONFLICT",
  "KNOWLEDGE_SMOKE_DEERFLOW_REPO_DIGEST_MISSING",
  "KNOWLEDGE_SMOKE_DEERFLOW_SOURCE_COMMIT_CONFLICT",
  "KNOWLEDGE_SMOKE_DEERFLOW_SOURCE_COMMIT_MISSING",
  "KNOWLEDGE_SMOKE_EVIDENCE_CAPABILITY_LEAK",
  "KNOWLEDGE_SMOKE_EVIDENCE_INCOMPLETE",
  "KNOWLEDGE_SMOKE_EVIDENCE_RAW_VALUE_LEAK",
  "KNOWLEDGE_SMOKE_EXPECTATION_LEAKED_INTO_RUN_PROMPT",
  "KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_NULL_QUERY",
  "KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_QUERY",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_BINDING_MISMATCH",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_HISTORY_MISMATCH",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_HISTORY_MISSING",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_INVALID",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_MISMATCH",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_TRUNCATED",
  "KNOWLEDGE_SMOKE_EXTERNAL_RUN_MISSING",
  "KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_CITATION",
  "KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_PROBE",
  "KNOWLEDGE_SMOKE_FIXTURE_NOT_FRESH",
  "KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH",
  "KNOWLEDGE_SMOKE_HISTORY_INVALID",
  "KNOWLEDGE_SMOKE_HISTORY_LIMIT_INVALID",
  "KNOWLEDGE_SMOKE_INVALID_DEERFLOW_CONTAINER",
  "KNOWLEDGE_SMOKE_INVALID_DEERFLOW_CONFIGURED_IMAGE_REF",
  "KNOWLEDGE_SMOKE_INVALID_DEERFLOW_IMAGE_REF",
  "KNOWLEDGE_SMOKE_INVALID_ENVIRONMENT_ID",
  "KNOWLEDGE_SMOKE_INVALID_EXECUTION_WINDOW",
  "KNOWLEDGE_SMOKE_INVALID_EXPECTED_CITATION",
  "KNOWLEDGE_SMOKE_INVALID_EXPECTED_PROBE",
  "KNOWLEDGE_SMOKE_INVALID_NULL_QUERY",
  "KNOWLEDGE_SMOKE_INVALID_POLL_INTERVAL_MS",
  "KNOWLEDGE_SMOKE_INVALID_QUERY",
  "KNOWLEDGE_SMOKE_INVALID_RUNTIME_WORKER_CONTAINER",
  "KNOWLEDGE_SMOKE_INVALID_RUNTIME_WORKER_CONFIGURED_IMAGE_REF",
  "KNOWLEDGE_SMOKE_INVALID_RUNTIME_WORKER_IMAGE_REF",
  "KNOWLEDGE_SMOKE_INVALID_RUNTIME_WORKER_EXECUTION_KEY_ID",
  "KNOWLEDGE_SMOKE_INVALID_RUNTIME_WORKER_EXECUTION_SIGNER_ID",
  "KNOWLEDGE_SMOKE_INVALID_SOURCE_COMMIT",
  "KNOWLEDGE_SMOKE_INVALID_TIMEOUT_MS",
  "KNOWLEDGE_SMOKE_INVALID_TRUST_POLICY_SHA256",
  "KNOWLEDGE_SMOKE_INVALID_URL",
  "KNOWLEDGE_SMOKE_LEDGER_PROBE_NOT_FOUND",
  "KNOWLEDGE_SMOKE_MISSING_ENV",
  "KNOWLEDGE_SMOKE_MODE_INVALID",
  "KNOWLEDGE_SMOKE_MODEL_CATALOG_MEMBERSHIP_MISMATCH",
  "KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_INVALID",
  "KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING",
  "KNOWLEDGE_SMOKE_MODEL_CATALOG_TOOL_NAMES_DUPLICATED",
  "KNOWLEDGE_SMOKE_MODEL_CATALOG_TOOL_NAMES_INVALID",
  "KNOWLEDGE_SMOKE_MODEL_CATALOG_VISIBILITY_MISMATCH",
  "KNOWLEDGE_SMOKE_MODEL_PIN_MISMATCH",
  "KNOWLEDGE_SMOKE_NODE_ENV_MUST_BE_PRODUCTION",
  "KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN",
  "KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO",
  "KNOWLEDGE_SMOKE_NULL_RELEASE_REACHED_CAPABILITY_DEFENSE",
  "KNOWLEDGE_SMOKE_NULL_RELEASE_RETRIEVAL_EVIDENCE_LEAK",
  "KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_DID_NOT_OVERLAP",
  "KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_ISOLATION_FAILED",
  "KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_MODEL_MISMATCH",
  "KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_RUNS_MUST_DIFFER",
  "KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_THREADS_MUST_DIFFER",
  "KNOWLEDGE_SMOKE_POST_RUN_NOT_SUCCEEDED",
  "KNOWLEDGE_SMOKE_POST_RUN_SCOPE_MISMATCH",
  "KNOWLEDGE_SMOKE_POST_RUN_STATE_MISSING",
  "KNOWLEDGE_SMOKE_PRODUCTION_REQUIRES_DEPLOYED_QUEUE",
  "KNOWLEDGE_SMOKE_PROJECT_MEMBERSHIP_MISSING",
  "KNOWLEDGE_SMOKE_QUERY_NOT_IN_RUN_PROMPT",
  "KNOWLEDGE_SMOKE_QUEUE_ENQUEUE_FAILED",
  "KNOWLEDGE_SMOKE_QUEUE_ENQUEUE_REJECTED",
  "KNOWLEDGE_SMOKE_QUEUE_EXECUTION_ATTEMPT_MISSING",
  "KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_INVALID",
  "KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_MISMATCH",
  "KNOWLEDGE_SMOKE_QUEUE_PAYLOAD_INVALID",
  "KNOWLEDGE_SMOKE_QUEUE_TIMEOUT",
  "KNOWLEDGE_SMOKE_QUEUE_UNAVAILABLE",
  "KNOWLEDGE_SMOKE_RELEASE_NOT_READY_OR_SCOPED",
  "KNOWLEDGE_SMOKE_REQUIRES_FRESH_RUNTIME_THREAD",
  "KNOWLEDGE_SMOKE_REQUIRES_LEAD_AGENT",
  "KNOWLEDGE_SMOKE_RUNTIME_ATTEMPT_IDENTITY_MISMATCH",
  "KNOWLEDGE_SMOKE_RUNTIME_PERSISTED_SURFACE_INCOMPLETE",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_CONTAINER_INVALID",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_DIGEST_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_DIGEST_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_ID_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_ID_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_REFERENCE_MISMATCH",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_REF_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_IMAGE_REF_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_ENVIRONMENT_ID_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_ENVIRONMENT_ID_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_EXECUTION_KEY_ID_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_EXECUTION_KEY_ID_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_EXECUTION_SIGNER_ID_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_EXECUTION_SIGNER_ID_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_REPLICAS_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_REPO_DIGEST_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_REPO_DIGEST_MISSING",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_SOURCE_COMMIT_CONFLICT",
  "KNOWLEDGE_SMOKE_RUNTIME_WORKER_SOURCE_COMMIT_MISSING",
  "KNOWLEDGE_SMOKE_TRUST_POLICY_INVALID",
  "KNOWLEDGE_SMOKE_RUN_DID_NOT_COMPLETE",
  "KNOWLEDGE_SMOKE_RUN_NOT_FOUND",
  "KNOWLEDGE_SMOKE_SCAN_DEPTH_EXCEEDED",
  "KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED",
  "KNOWLEDGE_SMOKE_SCOPE_MISMATCH",
  "KNOWLEDGE_SMOKE_SCOPE_NOT_ACTIVE",
  "KNOWLEDGE_SMOKE_SENSITIVE_SCAN_INPUT_MISSING",
  "KNOWLEDGE_SMOKE_SENSITIVE_VALUE_LEAK",
  "KNOWLEDGE_SMOKE_STATE_HISTORY_TRUNCATED",
  "KNOWLEDGE_SMOKE_SUCCEEDED_INVOCATION_MISSING",
  "KNOWLEDGE_SMOKE_TOOL_CONFIGURATION_MISSING",
  "KNOWLEDGE_SMOKE_TRUSTED_TOOL_CALL_NOT_OBSERVED",
  "KNOWLEDGE_SMOKE_TRUSTED_TOOL_NOT_REQUIRED_BY_PROMPT",
  "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE",
  "KNOWLEDGE_SMOKE_WORKER_BUILD_REQUIRED",
]);

const REQUIRED_ENVIRONMENT = Object.freeze([
  "DEERFLOW_GATEWAY_URL",
  "DEERFLOW_LANGGRAPH_URL",
  "DEERFLOW_INTERNAL_AUTH_TOKEN",
  "WORKBENCH_DATABASE_URL",
  "WORKBENCH_KNOWLEDGE_TOOL_URL",
  "WORKBENCH_KNOWLEDGE_TOOL_SECRET",
  "WORKBENCH_S3_BUCKET",
  "WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID",
  "WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY",
  "WORKBENCH_SOURCE_COMMIT",
  "WORKBENCH_ENVIRONMENT_ID",
  "WORKBENCH_RUNTIME_WORKER_IMAGE_REF",
  "WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID",
  "WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID",
  "WORKBENCH_DEERFLOW_IMAGE_REF",
  "WORKBENCH_DEERFLOW_IMAGE_DIGEST",
  "WORKBENCH_PRODUCTION_TRUST_POLICY_PATH",
  "WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256",
  "WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_QUERY",
  "WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE",
  "WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_PRINCIPAL_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_PROJECT_ID",
  "WORKBENCH_KNOWLEDGE_SMOKE_NULL_QUERY",
]);

export function readKnowledgeSmokeEnvironment(environment) {
  const nodeEnv = typeof environment.NODE_ENV === "string" ? environment.NODE_ENV.trim() : "";
  const rawMode = (
    environment.WORKBENCH_KNOWLEDGE_SMOKE_MODE
      || environment.WORKBENCH_KNOWLEDGE_SMOKE_EXECUTION_MODE
      || "deployed-queue"
  );
  const mode = typeof rawMode === "string" ? rawMode.trim() : "";
  if (mode !== "deployed-queue" && mode !== "direct") {
    throw new Error("KNOWLEDGE_SMOKE_MODE_INVALID");
  }
  if (nodeEnv !== "production") {
    throw new Error("KNOWLEDGE_SMOKE_NODE_ENV_MUST_BE_PRODUCTION");
  }
  if (mode !== "deployed-queue") {
    throw new Error("KNOWLEDGE_SMOKE_PRODUCTION_REQUIRES_DEPLOYED_QUEUE");
  }
  const values = Object.fromEntries(REQUIRED_ENVIRONMENT.map((name) => {
    const value = typeof environment[name] === "string" ? environment[name].trim() : "";
    if (!value) throw new Error(`KNOWLEDGE_SMOKE_MISSING_ENV:${name}`);
    return [name, value];
  }));
  const assistantId = typeof environment.DEERFLOW_ASSISTANT_ID === "string"
    ? environment.DEERFLOW_ASSISTANT_ID.trim() || "lead_agent"
    : "lead_agent";
  if (assistantId !== "lead_agent") {
    throw new Error("KNOWLEDGE_SMOKE_REQUIRES_LEAD_AGENT");
  }
  assertSafeHttpUrl(values.DEERFLOW_GATEWAY_URL, "DEERFLOW_GATEWAY_URL");
  assertSafeHttpUrl(values.DEERFLOW_LANGGRAPH_URL, "DEERFLOW_LANGGRAPH_URL");
  assertSafeHttpUrl(values.WORKBENCH_KNOWLEDGE_TOOL_URL, "WORKBENCH_KNOWLEDGE_TOOL_URL", true);

  const candidateCommit = exactPattern(
    values.WORKBENCH_SOURCE_COMMIT,
    COMMIT_SHA,
    "SOURCE_COMMIT",
  );
  const environmentId = exactPattern(
    values.WORKBENCH_ENVIRONMENT_ID,
    SAFE_IDENTIFIER,
    "ENVIRONMENT_ID",
  );
  const runtimeWorkerExecutionKeyId = exactPattern(
    values.WORKBENCH_RUNTIME_WORKER_EXECUTION_KEY_ID,
    KEY_ID,
    "RUNTIME_WORKER_EXECUTION_KEY_ID",
  );
  const runtimeWorkerExecutionSignerId = exactPattern(
    values.WORKBENCH_RUNTIME_WORKER_EXECUTION_SIGNER_ID,
    SAFE_IDENTIFIER,
    "RUNTIME_WORKER_EXECUTION_SIGNER_ID",
  );
  const trustPolicyPath = values.WORKBENCH_PRODUCTION_TRUST_POLICY_PATH;
  if (
    !path.isAbsolute(trustPolicyPath)
    || trustPolicyPath.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(trustPolicyPath)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_TRUST_POLICY_INVALID");
  }
  const trustPolicySha256 = exactPattern(
    values.WORKBENCH_PRODUCTION_TRUST_POLICY_SHA256,
    SHA256,
    "TRUST_POLICY_SHA256",
  );
  const runtimeWorkerImageDigest = imageDigestFromRef(
    values.WORKBENCH_RUNTIME_WORKER_IMAGE_REF,
    "RUNTIME_WORKER_IMAGE_REF",
  );
  const deerFlowImageDigest = imageDigestFromRef(
    values.WORKBENCH_DEERFLOW_IMAGE_REF,
    "DEERFLOW_IMAGE_REF",
  );
  if (deerFlowImageDigest !== values.WORKBENCH_DEERFLOW_IMAGE_DIGEST) {
    throw new Error("KNOWLEDGE_SMOKE_DEERFLOW_IMAGE_DIGEST_MISMATCH");
  }

  const query = boundedText(values.WORKBENCH_KNOWLEDGE_SMOKE_QUERY, 1, 4_000, "QUERY");
  const expectedProbe = boundedText(
    values.WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_PROBE,
    12,
    2_000,
    "EXPECTED_PROBE",
  );
  const expectedCitation = boundedText(
    values.WORKBENCH_KNOWLEDGE_SMOKE_EXPECTED_CITATION,
    1,
    1_024,
    "EXPECTED_CITATION",
  );
  if (query.includes(expectedProbe) || query.includes(expectedCitation)) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_QUERY");
  }
  const nullQuery = boundedText(values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_QUERY, 1, 4_000, "NULL_QUERY");
  if (nullQuery.includes(expectedProbe) || nullQuery.includes(expectedCitation)) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_MUST_NOT_APPEAR_IN_NULL_QUERY");
  }
  if (values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID === values.WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_RUNS_MUST_DIFFER");
  }

  if (
    environment.WORKBENCH_KNOWLEDGE_SMOKE_DEPLOYMENT_RECEIPT_PATH
    || environment.WORKBENCH_DEPLOYMENT_RECEIPT_PATH
    || environment.WORKBENCH_PRODUCTION_DEPLOYMENT_RECEIPT_PATH
  ) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_RECEIPT_OVERRIDE_FORBIDDEN");
  }
  const runtimeWorkerContainer = safeContainerName(
    environment.WORKBENCH_KNOWLEDGE_SMOKE_RUNTIME_WORKER_CONTAINER
      || environment.WORKBENCH_RUNTIME_WORKER_CONTAINER
      || environment.WORKBENCH_RUNTIME_WORKER_CONTAINER_NAME
      || "workbench-worker",
    "RUNTIME_WORKER_CONTAINER",
  );
  const deerFlowContainer = safeContainerName(
    environment.WORKBENCH_KNOWLEDGE_SMOKE_DEERFLOW_CONTAINER
      || environment.WORKBENCH_DEERFLOW_CONTAINER
      || environment.WORKBENCH_DEERFLOW_CONTAINER_NAME
      || "deerflow",
    "DEERFLOW_CONTAINER",
  );
  const timeoutMs = boundedInteger(
    environment.WORKBENCH_KNOWLEDGE_SMOKE_TIMEOUT_MS,
    DEFAULT_SMOKE_TIMEOUT_MS,
    5_000,
    MAX_SMOKE_TIMEOUT_MS,
    "TIMEOUT_MS",
  );
  const pollIntervalMs = boundedInteger(
    environment.WORKBENCH_KNOWLEDGE_SMOKE_POLL_INTERVAL_MS,
    DEFAULT_SMOKE_POLL_INTERVAL_MS,
    100,
    MAX_SMOKE_POLL_INTERVAL_MS,
    "POLL_INTERVAL_MS",
  );

  return Object.freeze({
    binding: Object.freeze({
      candidateCommit,
      environmentId,
      runtimeWorkerImageRef: values.WORKBENCH_RUNTIME_WORKER_IMAGE_REF,
      runtimeWorkerImageDigest,
      runtimeWorkerExecutionKeyId,
      runtimeWorkerExecutionSignerId,
      deerFlowImageRef: values.WORKBENCH_DEERFLOW_IMAGE_REF,
      deerFlowImageDigest,
      runtimeWorkerContainer,
      deerFlowContainer,
    }),
    valid: Object.freeze({
      runId: values.WORKBENCH_KNOWLEDGE_SMOKE_RUN_ID,
      principalId: values.WORKBENCH_KNOWLEDGE_SMOKE_PRINCIPAL_ID,
      projectId: values.WORKBENCH_KNOWLEDGE_SMOKE_PROJECT_ID,
      releaseId: values.WORKBENCH_KNOWLEDGE_SMOKE_RELEASE_ID,
      query,
    }),
    nullRelease: Object.freeze({
      runId: values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_RUN_ID,
      principalId: values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_PRINCIPAL_ID,
      projectId: values.WORKBENCH_KNOWLEDGE_SMOKE_NULL_PROJECT_ID,
      releaseId: null,
      query: nullQuery,
    }),
    expectedProbe,
    expectedCitation,
    assistantId,
    mode: "deployed-queue",
    trustPolicy: Object.freeze({
      path: trustPolicyPath,
      sha256: trustPolicySha256,
    }),
    timeoutMs,
    pollIntervalMs,
  });
}

export function redactKnowledgeCapability(value) {
  let redacted = String(value);
  for (const capabilityName of CAPABILITY_NAMES) {
    redacted = redacted.replaceAll(capabilityName, "[REDACTED_CAPABILITY_NAME]");
  }
  return redacted.replace(CAPABILITY_TOKEN, "[REDACTED_CAPABILITY]");
}

/**
 * Collect values that must be searched in persisted runtime surfaces. URLs and
 * identifiers are scanned as ordinary values; credential fields are validated
 * separately so an undersized configured secret cannot silently disappear from
 * the scan set.
 */
export function collectKnownSmokeSecrets(config, environment = {}) {
  const ordinaryValues = [
    config?.databaseUrl,
    config?.queueConnectionString,
    config?.deerFlowLangGraphUrl,
    config?.deerFlowGatewayUrl,
    config?.knowledgeTool?.endpoint,
    config?.canvasTool?.endpoint,
    config?.canvasTool?.visualEndpoint,
    config?.s3InternalEndpoint,
    environment.WORKBENCH_DATABASE_URL,
    environment.DEERFLOW_LANGGRAPH_URL,
    environment.DEERFLOW_GATEWAY_URL,
    environment.WORKBENCH_KNOWLEDGE_TOOL_URL,
    environment.WORKBENCH_CANVAS_TOOL_URL,
    environment.WORKBENCH_CANVAS_VISUAL_URL,
    environment.WORKBENCH_S3_INTERNAL_ENDPOINT,
  ];
  const credentialValues = [
    config?.deerFlowInternalToken,
    config?.knowledgeTool?.secret,
    config?.canvasTool?.secret,
    config?.runtimeReadyBlobS3AccessKeyId,
    config?.runtimeReadyBlobS3SecretAccessKey,
    environment.DEERFLOW_INTERNAL_AUTH_TOKEN,
    environment.WORKBENCH_KNOWLEDGE_TOOL_SECRET,
    environment.WORKBENCH_CANVAS_TOOL_SECRET,
    environment.WORKBENCH_KNOWLEDGE_CAPABILITY,
    environment.WORKBENCH_CANVAS_CAPABILITY,
    environment.WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID,
    environment.WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY,
  ];
  const databaseUrls = [
    config?.databaseUrl,
    config?.queueConnectionString,
    environment.WORKBENCH_DATABASE_URL,
  ];
  for (const databaseUrl of databaseUrls) {
    for (const credential of urlPasswordValues(databaseUrl)) credentialValues.push(credential);
  }

  const values = [];
  const seen = new Set();
  const add = (value, { credential = false } = {}) => {
    if (typeof value === "string") {
      if (!value) return;
      if (credential && value.length < 4) {
        throw new Error("KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT");
      }
      if (value.length < 4) return;
      const key = `string:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
      return;
    }
    if (!isByteLike(value)) return;
    if (credential && value.length < 4) {
      throw new Error("KNOWLEDGE_SMOKE_CONFIGURED_CREDENTIAL_TOO_SHORT");
    }
    if (value.length < 4) return;
    const bytes = Uint8Array.from(value);
    const key = `bytes:${Buffer.from(bytes).toString("hex")}`;
    if (!seen.has(key)) {
      seen.add(key);
      values.push(bytes);
    }
  };
  for (const value of ordinaryValues) add(value);
  for (const value of credentialValues) add(value, { credential: true });
  return Object.freeze(values);
}

export function extractDeploymentBinding(observation) {
  if (!isRecord(observation) || observation.source !== "docker-inspect") {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_OBSERVATION_INVALID");
  }
  const runtimeWorkers = dockerRoleReplicas(
    observation.runtimeWorkers ?? observation.runtimeWorker,
    "RUNTIME_WORKER",
  );
  const deerFlows = dockerRoleReplicas(
    observation.deerFlows ?? observation.deerFlow ?? observation.deerflow,
    "DEERFLOW",
  );
  const runtimeWorker = collapseDockerRole(runtimeWorkers, "RUNTIME_WORKER");
  const deerFlow = collapseDockerRole(deerFlows, "DEERFLOW");
  const candidateCommit = uniqueRequired(
    [runtimeWorker.sourceCommit, deerFlow.sourceCommit],
    "CANDIDATE_COMMIT",
  );
  return Object.freeze({
    source: "docker-inspect",
    candidateCommit,
    environmentId: uniqueRequired(
      runtimeWorkers.map((replica) => replica.environmentId),
      "RUNTIME_WORKER_ENVIRONMENT_ID",
    ),
    runtimeWorkerImageRef: runtimeWorker.imageRef,
    runtimeWorkerImageDigest: runtimeWorker.imageDigest,
    runtimeWorkerImageId: runtimeWorker.imageId,
    runtimeWorkerSourceCommit: runtimeWorker.sourceCommit,
    runtimeWorkerExecutionKeyId: uniqueRequired(
      runtimeWorkers.map((replica) => replica.executionKeyId),
      "RUNTIME_WORKER_EXECUTION_KEY_ID",
    ),
    runtimeWorkerExecutionSignerId: uniqueRequired(
      runtimeWorkers.map((replica) => replica.executionSignerId),
      "RUNTIME_WORKER_EXECUTION_SIGNER_ID",
    ),
    runtimeWorkerContainerHostnames: Object.freeze(runtimeWorkers.map((replica) => replica.hostname)),
    runtimeWorkerReplicaCount: runtimeWorkers.length,
    deerFlowImageRef: deerFlow.imageRef,
    deerFlowImageDigest: deerFlow.imageDigest,
    deerFlowImageId: deerFlow.imageId,
    deerFlowSourceCommit: deerFlow.sourceCommit,
    deerFlowReplicaCount: deerFlows.length,
  });
}

export function assertDeploymentBinding(expected, observation) {
  const normalized = extractDeploymentBinding(observation);
  const fields = [
    "candidateCommit",
    "environmentId",
    "runtimeWorkerImageRef",
    "runtimeWorkerImageDigest",
    "runtimeWorkerExecutionKeyId",
    "runtimeWorkerExecutionSignerId",
    "deerFlowImageRef",
    "deerFlowImageDigest",
  ];
  if (fields.some((field) => typeof expected?.[field] !== "string" || !expected[field])) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_BINDING_MISSING");
  }
  if (
    fields.some((field) => normalized[field] !== expected[field])
    || normalized.runtimeWorkerSourceCommit !== expected.candidateCommit
    || normalized.deerFlowSourceCommit !== expected.candidateCommit
  ) {
    throw new Error("KNOWLEDGE_SMOKE_DEPLOYMENT_BINDING_MISMATCH");
  }
  return normalized;
}

export function assertRuntimeWorkerExecutionTrustPolicy(trustPolicy, binding) {
  const authorities = Array.isArray(trustPolicy?.receiptAuthorities)
    ? trustPolicy.receiptAuthorities.filter(({ scopeId }) => scopeId === WORKER_EXECUTION_SCOPE_ID)
    : [];
  const authority = authorities[0];
  if (
    trustPolicy?.environmentId !== binding?.environmentId
    || authorities.length !== 1
    || authority?.keyId !== binding?.runtimeWorkerExecutionKeyId
    || authority?.signerId !== binding?.runtimeWorkerExecutionSignerId
    || !trustPolicy?.keys?.has(authority?.keyId)
    || !Array.isArray(trustPolicy?.approvalAuthorities)
    || trustPolicy.approvalAuthorities.some(({ keyId }) => keyId === authority?.keyId)
    || trustPolicy.receiptAuthorities.some(({ scopeId, keyId }) => (
      scopeId !== WORKER_EXECUTION_SCOPE_ID && keyId === authority?.keyId
    ))
  ) {
    throw new Error("KNOWLEDGE_SMOKE_TRUST_POLICY_INVALID");
  }
  return Object.freeze({
    environmentId: trustPolicy.environmentId,
    keyId: authority.keyId,
    scopeId: WORKER_EXECUTION_SCOPE_ID,
    signerId: authority.signerId,
  });
}

export function assertRuntimeWorkerExecutionBinding(
  jobRecords,
  expectedExecutions,
  deployment,
  trustPolicy,
  executionWindow,
) {
  const allowedHostnames = deployment?.runtimeWorkerContainerHostnames;
  const startedAt = dateMillis(executionWindow?.startedAt);
  const finishedAt = dateMillis(executionWindow?.finishedAt);
  if (
    !Array.isArray(jobRecords)
    || !Array.isArray(expectedExecutions)
    || !Array.isArray(allowedHostnames)
    || jobRecords.length !== expectedExecutions.length
    || expectedExecutions.some((execution) => (
      !isRecord(execution)
      || Object.keys(execution).sort().join("\u0000") !== "runId\u0000runtimeAttemptId"
      || typeof execution.runId !== "string"
      || execution.runId.length === 0
      || typeof execution.runtimeAttemptId !== "string"
      || execution.runtimeAttemptId.length === 0
    ))
    || new Set(expectedExecutions.map((execution) => execution.runId)).size !== expectedExecutions.length
    || new Set(allowedHostnames).size !== allowedHostnames.length
    || allowedHostnames.length === 0
    || allowedHostnames.some((hostname) => !safeHostname(hostname))
    || !COMMIT_SHA.test(deployment?.candidateCommit ?? "")
    || !IMAGE_DIGEST.test(deployment?.runtimeWorkerImageDigest ?? "")
    || !SAFE_IDENTIFIER.test(deployment?.environmentId ?? "")
    || !KEY_ID.test(deployment?.runtimeWorkerExecutionKeyId ?? "")
    || !SAFE_IDENTIFIER.test(deployment?.runtimeWorkerExecutionSignerId ?? "")
    || !trustPolicy
    || trustPolicy.environmentId !== deployment.environmentId
    || !Array.isArray(trustPolicy.approvalAuthorities)
    || !Array.isArray(trustPolicy.receiptAuthorities)
    || finishedAt < startedAt
  ) {
    throw new Error("KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_INVALID");
  }
  const expected = new Map(expectedExecutions.map((execution) => [execution.runId, execution.runtimeAttemptId]));
  const allowed = new Set(allowedHostnames);
  const observedRuns = new Set();
  const consumers = new Set();
  for (const job of jobRecords) {
    const data = isRecord(job?.data) ? job.data : null;
    const output = isRecord(job?.output) ? job.output : null;
    const execution = isRecord(output?.workerExecution) ? output.workerExecution : null;
    const statement = isRecord(execution?.statement) ? execution.statement : null;
    const signature = isRecord(execution?.signature) ? execution.signature : null;
    const runId = data?.runId;
    const result = {
      artifactCount: output?.artifactCount,
      runId: output?.runId,
    };
    const signedAt = Date.parse(String(statement?.signedAtUtc ?? ""));
    if (
      job?.state !== "completed"
      || Object.keys(data ?? {}).sort().join("\u0000") !== "approvalIds\u0000runId"
      || !Array.isArray(data?.approvalIds)
      || data.approvalIds.length !== 0
      || typeof runId !== "string"
      || !expected.has(runId)
      || observedRuns.has(runId)
      || Object.keys(output ?? {}).sort().join("\u0000") !== "artifactCount\u0000runId\u0000workerExecution"
      || output?.runId !== runId
      || !Number.isSafeInteger(output.artifactCount)
      || output.artifactCount < 0
      || Object.keys(execution ?? {}).sort().join("\u0000")
        !== "protocol\u0000signature\u0000statement"
      || execution?.protocol !== WORKER_EXECUTION_PROTOCOL
      || Object.keys(statement ?? {}).sort().join("\u0000") !== WORKER_EXECUTION_STATEMENT_KEYS
      || statement?.scopeId !== WORKER_EXECUTION_SCOPE_ID
      || statement?.jobId !== job.id
      || statement?.runtimeAttemptId !== expected.get(runId)
      || statement?.candidateCommit !== deployment.candidateCommit
      || statement?.runtimeWorkerImageDigest !== deployment.runtimeWorkerImageDigest
      || statement?.environmentId !== deployment.environmentId
      || statement?.signerId !== deployment.runtimeWorkerExecutionSignerId
      || !safeHostname(statement?.containerHostname)
      || !allowed.has(statement.containerHostname)
      || !SHA256.test(statement?.resultSha256 ?? "")
      || statement.resultSha256 !== createHash("sha256").update(canonicalJson(result)).digest("hex")
      || !Number.isFinite(signedAt)
      || signedAt < startedAt - MAX_CLOCK_SKEW_MS
      || signedAt > finishedAt + MAX_CLOCK_SKEW_MS
      || Object.keys(signature ?? {}).sort().join("\u0000") !== "algorithm\u0000keyId\u0000value"
      || signature?.algorithm !== "Ed25519"
      || signature?.keyId !== deployment.runtimeWorkerExecutionKeyId
      || !SIGNATURE.test(signature?.value ?? "")
    ) {
      throw new Error("KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_MISMATCH");
    }
    try {
      const authority = resolveReceiptAuthority(trustPolicy, {
        scopeId: WORKER_EXECUTION_SCOPE_ID,
        keyId: signature.keyId,
        signedAt: new Date(signedAt),
      });
      if (
        authority.signerId !== statement.signerId
        || trustPolicy.approvalAuthorities.some(({ keyId }) => keyId === signature.keyId)
        || trustPolicy.receiptAuthorities.some(({ scopeId, keyId }) => (
          scopeId !== WORKER_EXECUTION_SCOPE_ID && keyId === signature.keyId
        ))
        || !verifyTrustedEd25519Signature({
          key: authority.key,
          payload: canonicalJson({ protocol: execution.protocol, statement }),
          signature: signature.value,
        })
      ) {
        throw new Error("invalid worker receipt");
      }
    } catch {
      throw new Error("KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_MISMATCH");
    }
    observedRuns.add(runId);
    consumers.add(statement.containerHostname);
  }
  if (observedRuns.size !== expected.size) {
    throw new Error("KNOWLEDGE_SMOKE_QUEUE_EXECUTION_BINDING_MISMATCH");
  }
  return Object.freeze({
    queueConsumerBound: true,
    queueJobCount: jobRecords.length,
    runtimeWorkerConsumerCount: consumers.size,
  });
}

export function runtimeExecuteSmokeJob(runId) {
  if (typeof runId !== "string" || runId.length === 0 || runId.includes("\u0000")) {
    throw new Error("KNOWLEDGE_SMOKE_QUEUE_PAYLOAD_INVALID");
  }
  return Object.freeze({ runId, approvalIds: [] });
}

export function assertNoKnowledgeCapabilityLeak(surfaces, forbiddenValues = []) {
  const { stringNeedles, byteNeedles } = sensitiveRepresentations(forbiddenValues);
  let scannedNodes = 0;
  for (const surface of surfaces) {
    const label = safeLabel(surface.label);
    walkValue(surface.value, ({ value, key, path }) => {
      scannedNodes += 1;
      if (scannedNodes > MAX_SCAN_NODES) {
        throw new Error("KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED");
      }
      if (typeof key === "string" && containsCapabilityMaterial(key)) {
        throw new Error(`KNOWLEDGE_SMOKE_CAPABILITY_LEAK:${label}:${redactedPath(path)}`);
      }
      if (typeof value === "string" && containsCapabilityMaterial(value)) {
        throw new Error(`KNOWLEDGE_SMOKE_CAPABILITY_LEAK:${label}:${redactedPath(path)}`);
      }
      const stringLeak = typeof value === "string"
        && stringNeedles.some((needle) => value.includes(needle));
      const keyLeak = typeof key === "string"
        && stringNeedles.some((needle) => key.includes(needle));
      const byteCapabilityLeak = isByteLike(value)
        && containsCapabilityMaterial(Buffer.from(value).toString("utf8"));
      const byteLeak = isByteSequence(value)
        && byteNeedles.some((needle) => containsByteSequence(value, needle));
      const encodedKeyLeak = typeof key === "string" && containsEncodedSensitiveValue(key, stringNeedles);
      const encodedStringLeak = typeof value === "string" && containsEncodedSensitiveValue(value, stringNeedles);
      if (byteCapabilityLeak) {
        throw new Error(`KNOWLEDGE_SMOKE_CAPABILITY_LEAK:${label}:${redactedPath(path)}`);
      }
      if (keyLeak || stringLeak || byteLeak || encodedKeyLeak || encodedStringLeak) {
        throw new Error("KNOWLEDGE_SMOKE_SENSITIVE_VALUE_LEAK");
      }
    });
  }
  return scannedNodes;
}

export function assertRuntimeAttemptIdentityBinding({
  receipt,
  runId,
  attempt,
  projectId,
  principalId,
  threadId,
}) {
  const bindingMetadata = isRecord(receipt?.runtimeBinding?.metadata)
    ? receipt.runtimeBinding.metadata
    : null;
  const expectedBindingMetadata = {
    workbenchProjectId: projectId,
    workbenchThreadId: threadId,
    workbenchPrincipalId: principalId,
  };
  if (
    !isRecord(receipt)
    || typeof receipt.id !== "string"
    || receipt.id.length === 0
    || typeof runId !== "string"
    || runId.length === 0
    || !Number.isSafeInteger(attempt)
    || attempt < 1
    || typeof projectId !== "string"
    || projectId.length === 0
    || typeof principalId !== "string"
    || principalId.length === 0
    || typeof threadId !== "string"
    || threadId.length === 0
    || typeof receipt.runtimeBindingId !== "string"
    || receipt.runtimeBindingId.length === 0
    || !isRecord(receipt.runtimeBinding)
    || typeof receipt.runtimeBinding.id !== "string"
    || receipt.runtimeBinding.id.length === 0
    || typeof receipt.adapter !== "string"
    || receipt.adapter.length === 0
    || typeof receipt.runtimeBinding.adapter !== "string"
    || receipt.runtimeBinding.adapter.length === 0
    || receipt.runId !== runId
    || receipt.attempt !== attempt
    || typeof receipt.providerIdempotencyKey !== "string"
    || receipt.providerIdempotencyKey !== providerIdempotencyKeyForAttempt(receipt.id)
    || typeof receipt.externalThreadId !== "string"
    || receipt.externalThreadId.length === 0
    || receipt.runtimeBinding?.threadId !== threadId
    || receipt.runtimeBinding?.id !== receipt.runtimeBindingId
    || receipt.runtimeBinding?.externalThreadId !== receipt.externalThreadId
    || receipt.runtimeBinding?.adapter !== receipt.adapter
    || !bindingMetadata
    || Object.keys(bindingMetadata).sort().join("\u0000")
      !== Object.keys(expectedBindingMetadata).sort().join("\u0000")
    || bindingMetadata.workbenchProjectId !== expectedBindingMetadata.workbenchProjectId
    || bindingMetadata.workbenchThreadId !== expectedBindingMetadata.workbenchThreadId
    || bindingMetadata.workbenchPrincipalId !== expectedBindingMetadata.workbenchPrincipalId
  ) {
    throw new Error("KNOWLEDGE_SMOKE_RUNTIME_ATTEMPT_IDENTITY_MISMATCH");
  }
  return receipt;
}

export function assertKnowledgeGrantScope({ grants, budgets, invocationCount }, expected) {
  if (
    !Array.isArray(grants)
    || !Array.isArray(budgets)
    || !Number.isSafeInteger(invocationCount)
    || invocationCount < 0
    || typeof expected?.runtimeAttemptId !== "string"
    || expected.runtimeAttemptId.length === 0
    || typeof expected?.runId !== "string"
    || expected.runId.length === 0
    || typeof expected?.principalId !== "string"
    || expected.principalId.length === 0
    || typeof expected?.projectId !== "string"
    || expected.projectId.length === 0
    || (expected.releaseId !== null
      && (typeof expected.releaseId !== "string" || expected.releaseId.length === 0))
    || grants.some((grant) => (
      !isRecord(grant)
      || grant.runtimeAttemptId !== expected?.runtimeAttemptId
      || grant.runId !== expected?.runId
      || grant.principalId !== expected?.principalId
      || grant.projectId !== expected?.projectId
      || grant.releaseId !== expected?.releaseId
      || !isRecord(grant.budget)
      || grant.budget.runtimeAttemptId !== expected?.runtimeAttemptId
      || (grant.invocations ?? []).some((invocation) => (
        !isRecord(invocation)
        || invocation.runtimeAttemptId !== expected?.runtimeAttemptId
        || invocation.lastGrantId !== grant.id
      ))
    ))
    || budgets.some((budget) => (
      !isRecord(budget)
      || budget.runtimeAttemptId !== expected?.runtimeAttemptId
      || !isRecord(budget.runtimeAttempt)
      || budget.runtimeAttempt.id !== expected?.runtimeAttemptId
      || budget.runtimeAttempt.runId !== expected?.runId
    ))
  ) {
    throw new Error("KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH");
  }
  const invocations = grants.flatMap((grant) => Array.isArray(grant.invocations) ? grant.invocations : []);
  if (
    invocationCount !== invocations.length
    || new Set(invocations.map((invocation) => invocation.id)).size !== invocations.length
  ) {
    throw new Error("KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH");
  }
  return Object.freeze({ grants, budgets, invocations });
}

export function assertKnowledgeRetrievalProof({
  deerFlowSurfaces,
  ledgerResponses,
  releaseId,
  expectedProbe,
  expectedCitation,
}) {
  const catalog = assertKnowledgeCatalogObservation(deerFlowSurfaces, true);
  const transcript = collectToolTranscript(deerFlowSurfaces);
  if (transcript.declaredCallIds.size === 0 && transcript.namedToolMessages === 0) {
    throw new Error("KNOWLEDGE_SMOKE_TRUSTED_TOOL_CALL_NOT_OBSERVED");
  }
  const deerFlowMatches = matchingRetrievalResults(
    transcript.results,
    releaseId,
    expectedProbe,
    expectedCitation,
  );
  if (deerFlowMatches.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_DEERFLOW_PROBE_NOT_FOUND");
  }
  const ledgerMatches = matchingRetrievalResults(
    ledgerResponses.flatMap(extractRetrievalResults),
    releaseId,
    expectedProbe,
    expectedCitation,
  );
  if (ledgerMatches.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_LEDGER_PROBE_NOT_FOUND");
  }
  const ledgerFingerprints = new Set(ledgerMatches.flatMap((match) => match.fingerprints));
  const sharedFingerprint = deerFlowMatches
    .flatMap((match) => match.fingerprints)
    .find((fingerprint) => ledgerFingerprints.has(fingerprint));
  if (!sharedFingerprint) {
    throw new Error("KNOWLEDGE_SMOKE_DEERFLOW_LEDGER_MISMATCH");
  }
  return Object.freeze({
    catalogObservationObserved: true,
    catalogSha256: catalog.catalogFingerprint,
    declaredToolCalls: transcript.declaredCallIds.size,
    namedToolMessages: transcript.namedToolMessages,
    deerFlowResults: deerFlowMatches.length,
    ledgerResults: ledgerMatches.length,
    citationFingerprint: sharedFingerprint,
  });
}

export function assertKnowledgeCatalogObservation(deerFlowSurfaces, expectedKnowledgeVisible) {
  const observations = collectCatalogObservations(deerFlowSurfaces);
  if (observations.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING");
  }
  if (
    typeof expectedKnowledgeVisible !== "boolean"
    || observations.some((observation) => observation.knowledgeVisible !== expectedKnowledgeVisible)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_VISIBILITY_MISMATCH");
  }
  if (observations.some(
    (observation) => observation.toolNames.includes(TOOL_NAME) !== expectedKnowledgeVisible,
  )) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_MEMBERSHIP_MISMATCH");
  }
  const catalogHashes = [...new Set(observations.map((observation) => observation.sha256))].sort();
  const aggregatePayload = {
    catalogHashes,
    protocol: TOOL_CATALOG_PROTOCOL,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson(aggregatePayload))
    .digest("hex");
  return Object.freeze({
    protocol: TOOL_CATALOG_PROTOCOL,
    knowledgeVisible: expectedKnowledgeVisible,
    observationCount: observations.length,
    catalogCount: catalogHashes.length,
    catalogHashes: Object.freeze(catalogHashes),
    catalogFingerprint: fingerprint,
    fingerprint,
    sha256: fingerprint,
  });
}

export function createKnowledgeCatalogObservation(toolNames, knowledgeVisible) {
  const normalizedToolNames = assertCanonicalToolNames(toolNames);
  if (
    typeof knowledgeVisible !== "boolean"
    || normalizedToolNames.includes(TOOL_NAME) !== knowledgeVisible
  ) throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_MEMBERSHIP_MISMATCH");
  const payload = {
    knowledgeVisible,
    protocol: TOOL_CATALOG_PROTOCOL,
    toolNames: normalizedToolNames,
  };
  const canonical = canonicalJson(payload);
  const observation = {
    ...payload,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
  return Object.freeze(observation);
}

export function assertKnowledgeCatalogHidden(deerFlowSurfaces) {
  const catalog = assertKnowledgeCatalogObservation(deerFlowSurfaces, false);
  const transcript = collectToolTranscript(deerFlowSurfaces);
  if (
    transcript.declaredCallIds.size > 0
    || transcript.namedToolMessages > 0
    || transcript.results.length > 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_CATALOG_NOT_HIDDEN");
  }
  let capabilityMissingObserved = false;
  for (const surface of deerFlowSurfaces) {
    walkValue(surface, ({ value }) => {
      capabilityMissingObserved ||= typeof value === "string"
        && value.includes("WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING");
    });
  }
  if (capabilityMissingObserved) {
    throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_REACHED_CAPABILITY_DEFENSE");
  }
  return Object.freeze({
    observationObserved: true,
    catalogSha256: catalog.sha256,
    declaredToolCalls: 0,
    namedToolMessages: 0,
    retrievalResults: 0,
    capabilityMissingObserved: false,
  });
}

export function assertKnowledgeEvidenceAbsent(surfaces, expectedProbe, expectedCitation) {
  let leaked = false;
  for (const surface of surfaces) {
    walkValue(surface, ({ value }) => {
      leaked ||= typeof value === "string"
        && (value.includes(expectedProbe) || value.includes(expectedCitation));
    });
  }
  if (leaked) throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_RETRIEVAL_EVIDENCE_LEAK");
  return true;
}

export function assertConcurrentOppositeScope({ valid, nullRelease }) {
  if (
    !valid
    || !nullRelease
    || valid.runId === nullRelease.runId
    || valid.runtimeAttemptId === nullRelease.runtimeAttemptId
    || valid.externalThreadId === nullRelease.externalThreadId
    || valid.externalRunId === nullRelease.externalRunId
    || valid.releaseId === null
    || nullRelease.releaseId !== null
    || valid.grantCount !== 1
    || valid.successfulInvocationCount < 1
    || valid.invocationCount < valid.successfulInvocationCount
    || nullRelease.grantCount !== 0
    || nullRelease.invocationCount !== 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_ISOLATION_FAILED");
  }
  const validStartedAt = dateMillis(valid.startedAt);
  const validFinishedAt = dateMillis(valid.finishedAt);
  const nullStartedAt = dateMillis(nullRelease.startedAt);
  const nullFinishedAt = dateMillis(nullRelease.finishedAt);
  if (Math.max(validStartedAt, nullStartedAt) > Math.min(validFinishedAt, nullFinishedAt)) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_DID_NOT_OVERLAP");
  }
  return Object.freeze({
    concurrentExecutionObserved: true,
    distinctRuntimeScopes: true,
    validScopeEndpointCalls: valid.invocationCount,
    nullScopeEndpointCalls: 0,
  });
}

export function buildKnowledgeSmokeEvidence({
  binding,
  valid,
  nullRelease,
  isolation,
  forbiddenValues,
}) {
  const deployedQueue = binding?.source === "docker-inspect";
  const validPersisted = persistedSurfaceCoverage(valid?.persisted, true);
  const nullPersisted = persistedSurfaceCoverage(nullRelease?.persisted, false);
  if (
    !deployedQueue
    || (
      binding.queueConsumerBound !== true
      || !Number.isSafeInteger(binding.queueJobCount)
      || binding.queueJobCount < 1
      || !Number.isSafeInteger(binding.runtimeWorkerConsumerCount)
      || binding.runtimeWorkerConsumerCount < 1
      || !Number.isSafeInteger(binding.runtimeWorkerReplicaCount)
      || binding.runtimeWorkerReplicaCount < 1
      || !Number.isSafeInteger(binding.deerFlowReplicaCount)
      || binding.deerFlowReplicaCount < 1
      || !KEY_ID.test(binding.runtimeWorkerExecutionKeyId ?? "")
    )
    || valid.successfulInvocationCount < 1
    || !Number.isSafeInteger(valid.checkpointStatesScanned)
    || valid.checkpointStatesScanned < 1
    || !Number.isSafeInteger(valid.structuredValuesScanned)
    || valid.structuredValuesScanned < validPersisted.sensitiveValuesScanned
    || valid.proof?.declaredToolCalls < 1
    || valid.proof?.catalogObservationObserved !== true
    || valid.proof?.deerFlowResults < 1
    || valid.proof?.ledgerResults < 1
    || nullRelease.grantCount !== 0
    || nullRelease.endpointCalls !== 0
    || !Number.isSafeInteger(nullRelease.checkpointStatesScanned)
    || nullRelease.checkpointStatesScanned < 1
    || !Number.isSafeInteger(nullRelease.structuredValuesScanned)
    || nullRelease.structuredValuesScanned < nullPersisted.sensitiveValuesScanned
    || nullRelease.catalog?.declaredToolCalls !== 0
    || nullRelease.catalog?.namedToolMessages !== 0
    || nullRelease.catalog?.retrievalResults !== 0
    || nullRelease.catalog?.capabilityMissingObserved !== false
    || nullRelease.catalog?.observationObserved !== true
    || isolation?.concurrentExecutionObserved !== true
    || isolation?.distinctRuntimeScopes !== true
    || isolation?.nullScopeEndpointCalls !== 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_INCOMPLETE");
  }
  const evidence = {
    schema: "workbench.deerflow-knowledge-deployed-evidence.v5",
    result: "PASS",
    binding: {
      candidateCommit: binding.candidateCommit,
      runtimeWorkerImageDigest: binding.runtimeWorkerImageDigest,
      deerFlowImageDigest: binding.deerFlowImageDigest,
      deploymentObservationSource: binding.source,
      executionMode: "deployed-queue",
      queueConsumerBound: true,
      queueJobCount: binding.queueJobCount,
      runtimeWorkerConsumerCount: binding.runtimeWorkerConsumerCount,
      runtimeWorkerReplicaCount: binding.runtimeWorkerReplicaCount,
      deerFlowReplicaCount: binding.deerFlowReplicaCount,
      runtimeWorkerExecutionKeyFingerprint:
        binding.runtimeWorkerExecutionKeyId.slice("sha256:".length),
    },
    validPinnedRelease: {
      scopeFingerprint: evidenceFingerprint("valid-scope", valid.scopeIds),
      releaseFingerprint: evidenceFingerprint("knowledge-release", [valid.releaseId]),
      catalogVisible: valid.proof.declaredToolCalls > 0,
      invocationPassed: true,
      successfulEndpointCalls: valid.successfulInvocationCount,
      checkpointStatesScanned: valid.checkpointStatesScanned,
      structuredValuesScanned: valid.structuredValuesScanned,
      persistedSurfaceCoverage: validPersisted,
      proof: valid.proof,
    },
    nullRelease: {
      scopeFingerprint: evidenceFingerprint("null-scope", nullRelease.scopeIds),
      releasePinned: false,
      grantCount: nullRelease.grantCount,
      endpointCalls: nullRelease.endpointCalls,
      catalogHidden: true,
      catalogObservationObserved: true,
      catalogSha256: nullRelease.catalog.catalogSha256,
      capabilityMissingObserved: nullRelease.catalog.capabilityMissingObserved,
      checkpointStatesScanned: nullRelease.checkpointStatesScanned,
      structuredValuesScanned: nullRelease.structuredValuesScanned,
      persistedSurfaceCoverage: nullPersisted,
    },
    concurrentOppositeScope: isolation,
    secretsNotPersisted: validPersisted.sensitiveScanCompleted
      && nullPersisted.sensitiveScanCompleted,
  };
  assertRedactedKnowledgeEvidence(evidence, forbiddenValues);
  return Object.freeze(evidence);
}

function persistedSurfaceCoverage(value, knowledgeEnabled) {
  const countNames = [
    "sensitiveValuesChecked",
    "sensitiveValuesScanned",
    "runtimeAttempts",
    "runtimeBindings",
    "runtimeExternalEvents",
    "runtimeProviderStates",
    "runEvents",
    "threadEntries",
    "knowledgeBudgets",
    "knowledgeGrants",
    "knowledgeInvocations",
    "sourceSnapshots",
    "artifactVersions",
  ];
  if (
    !isRecord(value)
    || value.sensitiveScanCompleted !== true
    || countNames.some((name) => !Number.isSafeInteger(value[name]) || value[name] < 0)
    || value.sensitiveValuesChecked < 1
    || value.sensitiveValuesScanned < 1
    || value.runtimeAttempts !== 1
    || value.runtimeBindings !== 1
    || value.runtimeExternalEvents < 1
    || value.runtimeProviderStates !== 1
    || value.runEvents < 1
    || value.threadEntries < 1
    || (knowledgeEnabled
      ? value.knowledgeBudgets !== 1
        || value.knowledgeGrants !== 1
        || value.knowledgeInvocations < 1
      : value.knowledgeBudgets !== 0
        || value.knowledgeGrants !== 0
        || value.knowledgeInvocations !== 0)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_INCOMPLETE");
  }
  return Object.freeze({
    sensitiveScanCompleted: true,
    ...Object.fromEntries(countNames.map((name) => [name, value[name]])),
  });
}

export function assertRedactedKnowledgeEvidence(evidence, forbiddenValues = []) {
  const serialized = JSON.stringify(evidence);
  if (containsCapabilityMaterial(serialized)) {
    throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_CAPABILITY_LEAK");
  }
  const { stringNeedles } = sensitiveRepresentations(forbiddenValues);
  for (const forbidden of stringNeedles) {
    if (serialized.includes(forbidden)) {
      throw new Error("KNOWLEDGE_SMOKE_EVIDENCE_RAW_VALUE_LEAK");
    }
  }
  return evidence;
}

export function safeKnowledgeSmokeError(error) {
  const message = redactKnowledgeCapability(error instanceof Error ? error.message : String(error));
  const code = /^([A-Z][A-Z0-9_]{2,})(?::.*)?$/u.exec(message)?.[1];
  return code && SAFE_KNOWLEDGE_SMOKE_ERROR_CODES.has(code)
    ? code
    : "KNOWLEDGE_SMOKE_UNCLASSIFIED_FAILURE";
}

export function assertFinalOutputContainsEvidence(value, expectedProbe, expectedCitation) {
  let probeFound = false;
  let citationFound = false;
  walkValue(value, ({ value: candidate }) => {
    if (typeof candidate !== "string") return;
    probeFound ||= candidate.includes(expectedProbe);
    citationFound ||= candidate.includes(expectedCitation);
  });
  if (!probeFound) throw new Error("KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_PROBE");
  if (!citationFound) throw new Error("KNOWLEDGE_SMOKE_FINAL_OUTPUT_MISSING_CITATION");
}

export function assertCompleteHistory(history, requestedLimit) {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error("KNOWLEDGE_SMOKE_HISTORY_LIMIT_INVALID");
  }
  if (!Array.isArray(history)) throw new Error("KNOWLEDGE_SMOKE_HISTORY_INVALID");
  if (history.length >= requestedLimit) {
    throw new Error("KNOWLEDGE_SMOKE_STATE_HISTORY_TRUNCATED");
  }
  return history;
}

export function assertExternalRunBinding(externalRun, expected) {
  const metadata = isRecord(externalRun?.metadata) ? externalRun.metadata : null;
  if (
    typeof expected?.externalRunId !== "string"
    || expected.externalRunId.length === 0
    || typeof expected?.externalThreadId !== "string"
    || expected.externalThreadId.length === 0
    || typeof expected?.workbenchRunId !== "string"
    || expected.workbenchRunId.length === 0
    || typeof expected?.runtimeAttemptId !== "string"
    || expected.runtimeAttemptId.length === 0
    || typeof expected?.providerIdempotencyKey !== "string"
    || !/^wbrt:[0-9a-f]{64}$/u.test(expected.providerIdempotencyKey)
    || !Number.isSafeInteger(expected?.attempt)
    || expected.attempt < 1
    || externalRun?.run_id !== expected?.externalRunId
    || externalRun?.thread_id !== expected?.externalThreadId
    || metadata?.workbench_run_id !== expected?.workbenchRunId
    || metadata?.workbench_runtime_attempt_id !== expected?.runtimeAttemptId
    || metadata?.workbench_provider_idempotency_key !== expected?.providerIdempotencyKey
    || metadata?.workbench_attempt !== expected?.attempt
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_BINDING_MISMATCH");
  }
  return externalRun;
}

export function assertHistoryBoundToExternalRun(history, expected) {
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_HISTORY_MISSING");
  }
  if (
    typeof expected?.externalRunId !== "string"
    || expected.externalRunId.length === 0
    || typeof expected?.workbenchRunId !== "string"
    || expected.workbenchRunId.length === 0
    || typeof expected?.runtimeAttemptId !== "string"
    || expected.runtimeAttemptId.length === 0
    || typeof expected?.providerIdempotencyKey !== "string"
    || !/^wbrt:[0-9a-f]{64}$/u.test(expected.providerIdempotencyKey)
    || !Number.isSafeInteger(expected?.attempt)
    || expected.attempt < 1
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_HISTORY_MISMATCH");
  }
  for (const state of history) {
    const metadata = isRecord(state?.metadata) ? state.metadata : null;
    if (
      metadata?.run_id !== expected?.externalRunId
      || metadata?.workbench_run_id !== expected?.workbenchRunId
      || metadata?.workbench_runtime_attempt_id !== expected?.runtimeAttemptId
      || metadata?.workbench_provider_idempotency_key !== expected?.providerIdempotencyKey
      || metadata?.workbench_attempt !== expected?.attempt
    ) {
      throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_HISTORY_MISMATCH");
    }
  }
  return history;
}

function collectToolTranscript(surfaces) {
  const declaredCallIds = new Set();
  const toolMessages = [];
  let namedToolMessages = 0;
  for (const surface of surfaces) {
    walkValue(surface, ({ value }) => {
      if (!isRecord(value)) return;
      collectDeclaredCalls(value, declaredCallIds);
      if (!isToolMessage(value)) return;
      const name = messageField(value, "name");
      const callId = messageField(value, "tool_call_id") ?? messageField(value, "toolCallId");
      if (name === TOOL_NAME) namedToolMessages += 1;
      toolMessages.push({
        name,
        callId,
        contents: messageContents(value),
      });
    });
  }
  const results = [];
  for (const message of toolMessages) {
    if (message.name !== TOOL_NAME && (!message.callId || !declaredCallIds.has(message.callId))) continue;
    results.push(...message.contents.flatMap(extractRetrievalResults));
  }
  return { declaredCallIds, namedToolMessages, results };
}

function collectCatalogObservations(surfaces) {
  const observations = [];
  let scannedNodes = 0;
  for (const surface of surfaces) {
    const seen = new WeakSet();
    const stack = [{ value: surface, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop();
      scannedNodes += 1;
      if (scannedNodes > MAX_SCAN_NODES) {
        throw new Error("KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED");
      }
      if (current.depth >= MAX_SCAN_DEPTH) {
        if (current.value !== null && typeof current.value === "object") {
          throw new Error("KNOWLEDGE_SMOKE_SCAN_DEPTH_EXCEEDED");
        }
        continue;
      }
      if (current.value === null || typeof current.value !== "object") continue;
      if (seen.has(current.value)) continue;
      seen.add(current.value);
      if (Array.isArray(current.value)) {
        for (const item of current.value) {
          stack.push({ value: item, depth: current.depth + 1 });
        }
        continue;
      }
      for (const [key, value] of Object.entries(current.value)) {
        if (key === "messages" && Array.isArray(value)) {
          if (value.length > MAX_SCAN_NODES) {
            throw new Error("KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED");
          }
          collectCatalogObservationsFromMessages(value, observations);
          continue;
        }
        stack.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return observations;
}

function collectCatalogObservationsFromMessages(messages, observations) {
  for (const message of messages) {
    if (!isRecord(message) || !isAiMessage(message)) continue;
    const metadataContainers = [
      message.response_metadata,
      nestedRecord(message, "kwargs")?.response_metadata,
      nestedRecord(message, "lc_kwargs")?.response_metadata,
    ].filter((candidate) => (
      isRecord(candidate)
      && Object.prototype.hasOwnProperty.call(candidate, TOOL_CATALOG_METADATA_KEY)
    ));
    if (metadataContainers.length === 0) {
      throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_MISSING");
    }
    if (metadataContainers.length > 1) {
      throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_INVALID");
    }
    observations.push(parseCatalogObservation(
      metadataContainers[0][TOOL_CATALOG_METADATA_KEY],
    ));
  }
}

function parseCatalogObservation(parsed) {
  const exactKeys = ["knowledgeVisible", "protocol", "sha256", "toolNames"];
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join("\u0000") !== exactKeys.join("\u0000")
    || parsed.protocol !== TOOL_CATALOG_PROTOCOL
    || typeof parsed.knowledgeVisible !== "boolean"
    || !Array.isArray(parsed.toolNames)
    || typeof parsed.sha256 !== "string") {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_INVALID");
  }
  const toolNames = assertCanonicalToolNames(parsed.toolNames);
  if (toolNames.includes(TOOL_NAME) !== parsed.knowledgeVisible) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_MEMBERSHIP_MISMATCH");
  }
  const payload = {
    knowledgeVisible: parsed.knowledgeVisible,
    protocol: parsed.protocol,
    toolNames,
  };
  const { sha256 } = parsed;
  const expected = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(sha256) || sha256 !== expected) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_OBSERVATION_INVALID");
  }
  return Object.freeze({
    protocol: parsed.protocol,
    sha256,
    knowledgeVisible: parsed.knowledgeVisible,
    toolNames,
    toolCount: toolNames.length,
  });
}

function isAiMessage(record) {
  const role = messageField(record, "role")?.toLowerCase();
  const type = messageField(record, "type")?.toLowerCase();
  const constructorId = Array.isArray(record.id)
    ? record.id.filter((item) => typeof item === "string").at(-1)?.toLowerCase()
    : undefined;
  return role === "assistant" || type === "ai" || type === "aimessage" || constructorId === "aimessage";
}

function collectDeclaredCalls(record, callIds) {
  for (const container of [record, nestedRecord(record, "additional_kwargs"), nestedRecord(record, "kwargs"), nestedRecord(record, "lc_kwargs")]) {
    if (!container) continue;
    for (const key of ["tool_calls", "toolCalls"]) {
      const calls = container[key];
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : null;
        const name = stringValue(call.name) ?? stringValue(fn?.name);
        const id = stringValue(call.id) ?? stringValue(call.tool_call_id) ?? stringValue(call.toolCallId);
        if (name === TOOL_NAME && id) callIds.add(id);
      }
    }
  }
}

function isToolMessage(record) {
  const role = messageField(record, "role")?.toLowerCase();
  const type = messageField(record, "type")?.toLowerCase();
  const constructorId = Array.isArray(record.id)
    ? record.id.filter((item) => typeof item === "string").at(-1)?.toLowerCase()
    : undefined;
  return role === "tool" || type === "tool" || type === "toolmessage" || constructorId === "toolmessage";
}

function messageField(record, field) {
  return stringValue(record[field])
    ?? stringValue(nestedRecord(record, "kwargs")?.[field])
    ?? stringValue(nestedRecord(record, "lc_kwargs")?.[field]);
}

function messageContents(record) {
  const values = [
    record.content,
    nestedRecord(record, "kwargs")?.content,
    nestedRecord(record, "lc_kwargs")?.content,
  ].filter((value) => value !== undefined);
  return values.flatMap((value) => {
    if (!Array.isArray(value)) return [value];
    return value.flatMap((part) => {
      if (!isRecord(part)) return [part];
      return [part, part.text, part.content].filter((candidate) => candidate !== undefined);
    });
  });
}

function extractRetrievalResults(value) {
  const candidate = embeddedJson(value);
  if (isRecord(candidate) && candidate.protocol === "workbench.knowledge-retrieval-result.v1") {
    return [candidate];
  }
  return [];
}

function embeddedJson(value) {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value) > MAX_EMBEDDED_JSON_BYTES) return null;
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function matchingRetrievalResults(results, releaseId, expectedProbe, expectedCitation) {
  return results.flatMap((result) => {
    const evidence = isRecord(result.evidence) ? result.evidence : null;
    const release = isRecord(evidence?.release) ? evidence.release : null;
    if (release?.id !== releaseId || !Array.isArray(result.items)) return [];
    const fingerprints = result.items.flatMap((item) => {
      if (!isRecord(item) || !isRecord(item.citation)) return [];
      const citation = item.citation;
      const quote = stringValue(citation.quote);
      const citationValues = [citation.id, citation.sourcePath]
        .filter((value) => typeof value === "string");
      if (!quote?.includes(expectedProbe)) return [];
      if (!citationValues.some((value) => value.includes(expectedCitation))) return [];
      return [citationFingerprint(releaseId, citation)];
    });
    return fingerprints.length > 0 ? [{ result, fingerprints }] : [];
  });
}

function citationFingerprint(releaseId, citation) {
  const canonical = [releaseId, citation.id, citation.documentId, citation.chunkId, citation.sourcePath, citation.quote]
    .map((value) => String(value ?? ""))
    .join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

function dockerRoleReplicas(value, role) {
  const replicas = Array.isArray(value) ? value : [value];
  if (replicas.length === 0 || replicas.some((replica) => !isRecord(replica))) {
    throw new Error(`KNOWLEDGE_SMOKE_${role}_REPLICAS_MISSING`);
  }
  return replicas.map((replica) => dockerReplica(replica, role));
}

function dockerReplica(replica, role) {
  const labels = replica.imageLabels;
  const repoDigests = replica.repoDigests;
  if (
    !CONTAINER_ID.test(replica.containerId ?? "")
    || !safeHostname(replica.hostname)
    || typeof replica.configuredImageRef !== "string"
    || !IMAGE_DIGEST.test(replica.containerImageId ?? "")
    || !IMAGE_DIGEST.test(replica.imageId ?? "")
    || replica.containerImageId !== replica.imageId
    || replica.running !== true
    || replica.status !== "running"
    || replica.healthStatus !== "healthy"
    || !Array.isArray(repoDigests)
    || repoDigests.length === 0
    || repoDigests.some((digest) => imageDigestValue(digest) === null)
    || !isRecord(labels)
    || !COMMIT_SHA.test(labels[OCI_REVISION_LABEL] ?? "")
    || (role === "RUNTIME_WORKER" && (
      !SAFE_IDENTIFIER.test(replica.environmentId ?? "")
      || !KEY_ID.test(replica.executionKeyId ?? "")
      || !SAFE_IDENTIFIER.test(replica.executionSignerId ?? "")
    ))
  ) {
    throw new Error(`KNOWLEDGE_SMOKE_${role}_CONTAINER_INVALID`);
  }
  const configuredDigest = imageDigestFromRef(replica.configuredImageRef, `${role}_CONFIGURED_IMAGE_REF`);
  const repoDigest = uniqueRequired(repoDigests.map(imageDigestValue), `${role}_REPO_DIGEST`);
  if (configuredDigest !== repoDigest) {
    throw new Error(`KNOWLEDGE_SMOKE_${role}_IMAGE_REFERENCE_MISMATCH`);
  }
  return Object.freeze({
    containerId: replica.containerId,
    hostname: replica.hostname,
    imageRef: replica.configuredImageRef,
    imageDigest: repoDigest,
    imageId: replica.imageId,
    sourceCommit: labels[OCI_REVISION_LABEL],
    ...(role === "RUNTIME_WORKER" ? {
      environmentId: replica.environmentId,
      executionKeyId: replica.executionKeyId,
      executionSignerId: replica.executionSignerId,
    } : {}),
  });
}

function collapseDockerRole(replicas, role) {
  return Object.freeze({
    imageRef: uniqueRequired(replicas.map((replica) => replica.imageRef), `${role}_IMAGE_REF`),
    imageDigest: uniqueRequired(replicas.map((replica) => replica.imageDigest), `${role}_IMAGE_DIGEST`),
    imageId: uniqueRequired(replicas.map((replica) => replica.imageId), `${role}_IMAGE_ID`),
    sourceCommit: uniqueRequired(replicas.map((replica) => replica.sourceCommit), `${role}_SOURCE_COMMIT`),
  });
}

function uniqueRequired(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`KNOWLEDGE_SMOKE_${label}_MISSING`);
  }
  const unique = new Set(values);
  if (unique.size !== 1) throw new Error(`KNOWLEDGE_SMOKE_${label}_CONFLICT`);
  return values[0];
}

function imageDigestValue(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(?:@)?(sha256:[a-f0-9]{64})$/u);
  return match?.[1] ?? null;
}

function safeHostname(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertCanonicalToolNames(value) {
  if (
    !Array.isArray(value)
    || value.some((name) => (
      typeof name !== "string"
      || name.normalize("NFC") !== name
      || !TOOL_NAME_PATTERN.test(name)
      || (name.startsWith("workbench_") && !WORKBENCH_TOOL_NAMES.has(name))
    ))
  ) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_TOOL_NAMES_INVALID");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("KNOWLEDGE_SMOKE_MODEL_CATALOG_TOOL_NAMES_DUPLICATED");
  }
  return Object.freeze([...value]);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function evidenceFingerprint(domain, values) {
  const canonical = [domain, ...values].map((value) => String(value ?? "")).join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

function dateMillis(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(milliseconds)) throw new Error("KNOWLEDGE_SMOKE_INVALID_EXECUTION_WINDOW");
  return milliseconds;
}

function walkValue(root, visitor) {
  const seen = new WeakSet();
  const stack = [{ value: root, key: null, path: "$", depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    visitor(current);
    if (current.depth >= MAX_SCAN_DEPTH) {
      if (current.value !== null && typeof current.value === "object") {
        throw new Error("KNOWLEDGE_SMOKE_SCAN_DEPTH_EXCEEDED");
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (ArrayBuffer.isView(current.value)) continue;
    const entries = Array.isArray(current.value)
      ? current.value.map((value, index) => [String(index), value])
      : Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index];
      stack.push({
        value,
        key,
        path: `${current.path}.${safePathSegment(key)}`,
        depth: current.depth + 1,
      });
    }
  }
}

function isCapabilityLeak(value) {
  return CAPABILITY_NAMES.some((name) => value.includes(name))
    || CAPABILITY_PREFIXES.some((prefix) => value.includes(prefix));
}

function containsCapabilityMaterial(value) {
  if (typeof value !== "string") return false;
  const queue = [{ text: value, depth: 0 }];
  const seen = new Set();
  let candidatesScanned = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.text)) continue;
    seen.add(current.text);
    if (isCapabilityLeak(current.text)) return true;
    if (current.depth >= 2) continue;
    const addDecoded = (decoded) => {
      if (typeof decoded !== "string" || decoded === current.text || decoded.length === 0) return;
      queue.push({ text: decoded, depth: current.depth + 1 });
    };
    try {
      addDecoded(decodeURIComponent(current.text));
    } catch {
      // Continue with base64/hex representations when URI decoding is invalid.
    }
    for (const match of current.text.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/gu)) {
      candidatesScanned += 1;
      if (candidatesScanned > 10_000) throw new Error("KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED");
      addDecoded(decodeBase64Candidate(match[0]));
    }
    for (const match of current.text.matchAll(/(?:[a-fA-F0-9]{2}){8,}/gu)) {
      candidatesScanned += 1;
      if (candidatesScanned > 10_000) throw new Error("KNOWLEDGE_SMOKE_SCAN_LIMIT_EXCEEDED");
      try {
        addDecoded(Buffer.from(match[0], "hex").toString("utf8"));
      } catch {
        // Ignore malformed candidates; the raw value has already been checked.
      }
    }
  }
  return false;
}

function containsEncodedSensitiveValue(value, needles) {
  if (typeof value !== "string") return false;
  const candidates = [value];
  try {
    candidates.push(decodeURIComponent(value));
  } catch {
    // Keep scanning the raw representation.
  }
  for (const candidate of candidates) {
    if (needles.some((needle) => candidate.includes(needle))) return true;
    for (const match of candidate.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/gu)) {
      const decoded = decodeBase64Candidate(match[0]);
      if (decoded && needles.some((needle) => decoded.includes(needle))) return true;
    }
    for (const match of candidate.matchAll(/(?:[a-fA-F0-9]{2}){8,}/gu)) {
      const decoded = Buffer.from(match[0], "hex").toString("utf8");
      if (needles.some((needle) => decoded.includes(needle))) return true;
    }
  }
  return false;
}

function decodeBase64Candidate(candidate) {
  if (typeof candidate !== "string" || candidate.length < 16 || candidate.length % 4 === 1) {
    return null;
  }
  try {
    if (/^[A-Za-z0-9_-]+$/u.test(candidate)) {
      const decoded = Buffer.from(candidate, "base64url");
      return decoded.toString("base64url") === candidate ? decoded.toString("utf8") : null;
    }
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate) && candidate.length % 4 === 0) {
      const decoded = Buffer.from(candidate, "base64");
      return decoded.toString("base64") === candidate ? decoded.toString("utf8") : null;
    }
  } catch {
    return null;
  }
  return null;
}

function providerIdempotencyKeyForAttempt(attemptId) {
  return `wbrt:${createHash("sha256").update(attemptId).digest("hex")}`;
}

function urlPasswordValues(value) {
  if (typeof value !== "string" || !value) return [];
  try {
    const url = new URL(value);
    if (!url.password) return [];
    const decoded = decodeURIComponent(url.password);
    return decoded === url.password ? [url.password] : [url.password, decoded];
  } catch {
    return [];
  }
}

function isByteLike(value) {
  return value instanceof Uint8Array
    || (Array.isArray(value)
      && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
}

function sensitiveRepresentations(values) {
  const strings = new Set();
  const bytesByHex = new Map();
  const addBytes = (candidate) => {
    if (!isByteSequence(candidate)) return;
    const bytes = Buffer.from(candidate);
    const hex = bytes.toString("hex");
    if (!bytesByHex.has(hex)) bytesByHex.set(hex, Object.freeze([...bytes]));
    const base64 = bytes.toString("base64");
    for (const encoded of [
      hex,
      hex.toUpperCase(),
      base64,
      base64.replace(/=+$/u, ""),
      bytes.toString("base64url"),
    ]) {
      if (encoded.length >= 4) strings.add(encoded);
    }
    const utf8 = bytes.toString("utf8");
    if (utf8.length >= 4 && Buffer.from(utf8, "utf8").equals(bytes)) strings.add(utf8);
  };

  for (const value of values) {
    if (typeof value === "string" && value.length >= 4) {
      strings.add(value);
      try {
        const encoded = encodeURIComponent(value);
        if (encoded.length >= 4) strings.add(encoded);
      } catch {
        // The raw UTF-8 bytes are still scanned for malformed Unicode input.
      }
      addBytes(Buffer.from(value, "utf8"));

      if (/^[A-Za-z0-9_-]+$/u.test(value)) {
        const decoded = Buffer.from(value, "base64url");
        if (decoded.length >= 4 && decoded.toString("base64url") === value) addBytes(decoded);
      }
      if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        const decoded = Buffer.from(value, "base64");
        if (decoded.length >= 4 && decoded.toString("base64") === value) addBytes(decoded);
      }
      if (/^(?:[a-fA-F0-9]{2}){4,}$/u.test(value)) addBytes(Buffer.from(value, "hex"));
    } else if (isByteSequence(value)) {
      addBytes(value);
    }
  }
  return {
    stringNeedles: Object.freeze([...strings]),
    byteNeedles: Object.freeze([...bytesByHex.values()]),
  };
}

function isByteSequence(value) {
  if (value instanceof Uint8Array) return value.length >= 4;
  return Array.isArray(value)
    && value.length >= 4
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function containsByteSequence(value, needle) {
  if (value.length < needle.length) return false;
  for (let offset = 0; offset <= value.length - needle.length; offset += 1) {
    if (needle.every((byte, index) => value[offset + index] === byte)) return true;
  }
  return false;
}

function nestedRecord(record, key) {
  return isRecord(record[key]) ? record[key] : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

function assertSafeHttpUrl(value, name, requireHttps = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_URL:${name}`);
  }
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (requireHttps && url.protocol !== "https:")
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_URL:${name}`);
  }
}

function boundedText(value, minimum, maximum, label) {
  if (value.length < minimum || value.length > maximum || value.includes("\u0000")) {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  }
  return value.normalize("NFC");
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : Number(String(value).trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  }
  return parsed;
}

function safeContainerName(value, label) {
  const normalized = String(value).trim();
  if (!SAFE_CONTAINER_NAME.test(normalized)) {
    throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  }
  return normalized;
}

function exactPattern(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  return value;
}

function imageDigestFromRef(value, label) {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) throw new Error(`KNOWLEDGE_SMOKE_INVALID_${label}`);
  return exactPattern(value.slice(separator + 1), IMAGE_DIGEST, label);
}

function safeLabel(value) {
  const label = String(value);
  return /^[A-Za-z0-9_.-]{1,80}$/u.test(label) ? label : "surface";
}

function safePathSegment(value) {
  if (isCapabilityLeak(value)) return "[redacted-key]";
  return /^[A-Za-z0-9_-]{1,80}$/u.test(value) ? value : "[field]";
}

function redactedPath(value) {
  return redactKnowledgeCapability(value).slice(0, 512);
}

export const knowledgeSmokeConstants = Object.freeze({
  capabilityName: CAPABILITY_NAME,
  capabilityNames: CAPABILITY_NAMES,
  toolName: TOOL_NAME,
});
