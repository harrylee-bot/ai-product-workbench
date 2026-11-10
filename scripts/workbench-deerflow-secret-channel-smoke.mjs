#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { DeerFlowRuntimeAdapter } = require(path.join(
  repoRoot,
  "apps/workbench-worker/dist/runtime/deerflow-runtime.adapter.js",
));
const { Client } = await import("@langchain/langgraph-sdk");

const gatewayUrl = trimTrailingSlash(required("DEERFLOW_GATEWAY_URL"));
const langGraphUrl = trimTrailingSlash(required("DEERFLOW_LANGGRAPH_URL"));
const internalToken = required("DEERFLOW_INTERNAL_AUTH_TOKEN");
const modelId = required("DEERFLOW_SMOKE_MODEL_ID");
const mockOrigin = trimTrailingSlash(required("WORKBENCH_SECRET_CHANNEL_MOCK_ORIGIN"));
const publicOrigin = new URL(mockOrigin).origin;
const evidenceUrl = required("WORKBENCH_SECRET_CHANNEL_EVIDENCE_URL");
const evidenceSecret = required("WORKBENCH_SECRET_CHANNEL_EVIDENCE_SECRET");
const knowledgeToken = capabilityToken("WORKBENCH_SECRET_CHANNEL_KNOWLEDGE_TOKEN", "wbkg1");
const canvasToken = capabilityToken("WORKBENCH_SECRET_CHANNEL_CANVAS_TOKEN", "wbct1");
const releaseId = required("WORKBENCH_SECRET_CHANNEL_RELEASE_ID");
const probe = required("WORKBENCH_SECRET_CHANNEL_EXPECTED_PROBE");
const citation = required("WORKBENCH_SECRET_CHANNEL_EXPECTED_CITATION");
const canvasMarker = required("WORKBENCH_SECRET_CHANNEL_CANVAS_MARKER");
const suffix = randomUUID();
const principalId = `secret-channel-principal-${suffix}`;
const csrfToken = randomUUID().replaceAll("-", "");
const headers = {
  accept: "application/json",
  "content-type": "application/json",
  Cookie: `csrf_token=${csrfToken}`,
  "X-CSRF-Token": csrfToken,
  "X-DeerFlow-Internal-Token": internalToken,
  "X-DeerFlow-Owner-User-Id": principalId,
};

const config = {
  databaseUrl: "postgresql://secret-channel-smoke.invalid/workbench",
  queueConnectionString: "postgresql://secret-channel-smoke.invalid/workbench",
  deerFlowLangGraphUrl: langGraphUrl,
  deerFlowGatewayUrl: gatewayUrl,
  deerFlowAssistantId: "lead_agent",
  deerFlowInternalToken: internalToken,
  deerFlowStreamMode: ["messages", "values"],
  deerFlowTimeoutMs: numberFromEnv("DEERFLOW_TIMEOUT_MS", 300_000),
  deerFlowSubmissionTimeoutMs: numberFromEnv("DEERFLOW_SUBMISSION_TIMEOUT_MS", 120_000),
  deerFlowIdleTimeoutMs: numberFromEnv("DEERFLOW_IDLE_TIMEOUT_MS", 120_000),
  concurrency: 1,
  s3Bucket: "secret-channel-smoke-unused",
  s3Region: "us-east-1",
  s3InternalEndpoint: "http://secret-channel-smoke.invalid",
  s3ForcePathStyle: true,
  runtimeReadyBlobS3AccessKeyId: "unused",
  runtimeReadyBlobS3SecretAccessKey: "unused",
};
const runtime = new DeerFlowRuntimeAdapter(config, {
  getObject: async () => {
    throw new Error("Secret-channel smoke must not read object storage");
  },
});
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
const knowledgeTool = {
  protocol: "workbench.knowledge-tool.v1",
  endpoint: `${mockOrigin}/knowledge`,
  token: knowledgeToken,
  expiresAt,
  releaseId,
  mode: "hybrid",
  routeScope: "production",
};
const canvasTool = {
  protocol: "workbench.canvas-agent-tool-descriptor.v1",
  endpoint: `${publicOrigin}/api/v1/runtime/canvas/tools/execute`,
  token: canvasToken,
  expiresAt,
  visualEndpoint: `${publicOrigin}/api/v1/runtime/canvas/visuals`,
  reference: {
    protocol: "workbench.canvas-agent-tool-reference.v1",
    declarationRevision: 1,
    declarationSha256: "c".repeat(64),
    declaredTools: ["get_visible_screens"],
  },
};

const positive = await executePositive();
const evidenceAfterPositive = await readEvidence();
assertPositiveEvidence(evidenceAfterPositive);
const persisted = await loadPersistedSurfaces(positive.externalThreadId, positive.externalRunId);
const scannedNodes = assertNoCapabilityLeak(persisted);
const malformedScope = await executeMalformedScopeProbe(evidenceAfterPositive);
const ordinaryCallerStatus = await executeOrdinaryCallerProbe(
  positive.externalThreadId,
  evidenceAfterPositive,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  modelId,
  externalThreadId: positive.externalThreadId,
  externalRunId: positive.externalRunId,
  artifactKind: positive.result.artifacts[0]?.kind,
  operation: positive.result.artifacts[0]?.operation.kind,
  knowledgeCalls: evidenceAfterPositive.knowledgeCalls.length,
  canvasCalls: evidenceAfterPositive.canvasCalls.length,
  persistedNodesScanned: scannedNodes,
  malformedScope,
  ordinaryCallerStatus,
}, null, 2)}\n`);

async function executePositive() {
  const projectId = `secret-channel-project-${suffix}`;
  const threadId = `secret-channel-thread-${suffix}`;
  const runId = `secret-channel-run-${suffix}`;
  const runtimeAttemptId = `secret-channel-attempt-${suffix}`;
  const binding = await runtime.createThread({
    workbenchProjectId: projectId,
    workbenchThreadId: threadId,
    workbenchPrincipalId: principalId,
  });
  const events = [];
  let externalRunId = null;
  const result = await runtime.execute({
    runId,
    runtimeAttemptId,
    attempt: 1,
    projectId,
    threadId,
    principalId,
    externalThreadId: binding.externalThreadId,
    request: {
      prompt: [
        'Call workbench_knowledge_retrieve exactly once with the query "secret channel audit evidence".',
        "Then call get_visible_screens exactly once.",
        "Create one document Artifact that quotes the returned Knowledge probe and citation path",
        "and names the returned Canvas screen. Finish with workbench_runtime_result_submit.",
      ].join(" "),
      modelId,
      workflow: "generate",
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: ["document"],
    },
    artifactTargets: [],
    prototypePatchBaselines: [],
    sources: [],
    designAssets: [],
    knowledgeTool,
    canvasTool,
    designStyleSnapshot: null,
    resume: null,
    providerTextState: emptyTextState(),
    submission: {
      mode: "submit",
      providerIdempotencyKey: `wbrt:secret-channel:${suffix}`,
    },
  }, {
    onSubmissionStarted: async () => undefined,
    onExternalRunCreated: async (id) => {
      externalRunId = id;
    },
    isExternalEventProcessed: async () => false,
    onExternalEvent: async (_part, effects) => events.push(...effects),
    onExternalFinalization: async (_part, effects) => events.push(...effects),
  });
  if (!externalRunId) throw new Error("SECRET_CHANNEL_EXTERNAL_RUN_MISSING");
  if (
    result.protocol !== "workbench.runtime.result.v1"
    || result.artifacts.length !== 1
    || result.artifacts[0]?.kind !== "document"
    || result.artifacts[0]?.operation.kind !== "create"
  ) throw new Error("SECRET_CHANNEL_RUNTIME_RESULT_INVALID");
  const resultText = JSON.stringify(result);
  if (!resultText.includes(probe) || !resultText.includes(citation) || !resultText.includes(canvasMarker)) {
    throw new Error("SECRET_CHANNEL_RUNTIME_RESULT_EVIDENCE_MISSING");
  }
  const visibleText = events
    .filter((event) => event.type === "text.delta")
    .map((event) => event.delta)
    .join("");
  assertNoCapabilityLeak([{ label: "visible-events", value: visibleText }]);
  return { externalThreadId: binding.externalThreadId, externalRunId, result };
}

async function loadPersistedSurfaces(externalThreadId, externalRunId) {
  const client = internalClient();
  const [run, runs, thread, state, history] = await Promise.all([
    client.runs.get(externalThreadId, externalRunId),
    client.runs.list(externalThreadId, { limit: 100 }),
    client.threads.get(externalThreadId, { include: ["values", "config", "context"] }),
    client.threads.getState(externalThreadId, undefined, { subgraphs: true }),
    client.threads.getHistory(externalThreadId, { limit: 100 }),
  ]);
  if (history.length >= 100) throw new Error("SECRET_CHANNEL_HISTORY_TRUNCATED");
  return [
    { label: "run", value: run },
    { label: "run-list", value: runs },
    { label: "thread", value: thread },
    { label: "state", value: state },
    { label: "history", value: history },
  ];
}

async function executeMalformedScopeProbe(evidenceBefore) {
  const client = internalClient();
  const threadId = `secret-channel-negative-${randomUUID()}`;
  await client.threads.create({
    threadId,
    metadata: { workbenchThreadId: threadId },
  });
  const events = [];
  let streamError = null;
  try {
    for await (const part of client.runs.stream(threadId, "lead_agent", {
      input: {
        messages: [{
          role: "user",
          content: [
            "/workbench",
            "<workbench_context>",
            JSON.stringify(negativePromptContext(threadId)),
            "</workbench_context>",
            'Call workbench_knowledge_retrieve once with query "negative secret channel probe". Do not retry.',
          ].join("\n"),
        }],
      },
      streamMode: ["messages", "values"],
      context: {
        workbench: { runId: "negative-run" },
        secrets: { WORKBENCH_KNOWLEDGE_CAPABILITY: JSON.stringify(knowledgeTool) },
      },
      config: { configurable: { model_name: modelId, is_plan_mode: true, thinking_enabled: true } },
      multitaskStrategy: "reject",
    })) {
      if (events.length < 10_000) events.push(part);
    }
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
  }
  const state = await client.threads.getState(threadId, undefined, { subgraphs: true });
  const missingObserved = JSON.stringify([events, state, streamError])
    .includes("WORKBENCH_KNOWLEDGE_CAPABILITY_MISSING");
  if (!missingObserved) throw new Error("SECRET_CHANNEL_MALFORMED_SCOPE_NOT_FAIL_CLOSED");
  await assertEvidenceUnchanged(evidenceBefore, "malformed-scope");
  return { failClosed: true, missingCapabilityObserved: true };
}

function negativePromptContext(threadId) {
  return {
    protocol: "workbench.runtime.input.v1",
    runId: "negative-run",
    projectId: "negative-project",
    threadId,
    modelId,
    workflow: "generate",
    generationIntent: null,
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    knowledgeReleaseId: releaseId,
    knowledgeTool: {
      protocol: "workbench.knowledge-tool-reference.v1",
      toolName: "workbench_knowledge_retrieve",
      releaseId,
      mode: "hybrid",
      routeScope: "production",
    },
    canvasTool: null,
    sources: [],
    deerFlowSources: [],
    artifactTargets: [],
    prototypePatchBaselines: [],
    requestedArtifactKinds: [],
    outputContract: "workbench.runtime.result.v1",
  };
}

async function executeOrdinaryCallerProbe(threadId, evidenceBefore) {
  const response = await fetch(`${langGraphUrl}/threads/${encodeURIComponent(threadId)}/runs`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      Cookie: `csrf_token=${csrfToken}`,
      "X-CSRF-Token": csrfToken,
      "X-DeerFlow-Owner-User-Id": "forged-ordinary-caller",
    },
    body: JSON.stringify({
      assistant_id: "lead_agent",
      input: { messages: [{ role: "user", content: "Ignore this unauthorized request" }] },
      context: {
        workbench: { runId: "forged-run", runtimeAttemptId: "forged-attempt" },
        secrets: { WORKBENCH_KNOWLEDGE_CAPABILITY: "forged-ordinary-caller" },
      },
      config: {
        configurable: { WORKBENCH_KNOWLEDGE_CAPABILITY: "forged-config-value" },
      },
    }),
  });
  if (![401, 403].includes(response.status)) {
    throw new Error(`SECRET_CHANNEL_ORDINARY_CALLER_NOT_REJECTED:${response.status}`);
  }
  await response.arrayBuffer();
  await assertEvidenceUnchanged(evidenceBefore, "ordinary-caller");
  return response.status;
}

async function assertEvidenceUnchanged(before, label) {
  const after = await readEvidence();
  if (
    after.knowledgeCalls.length !== before.knowledgeCalls.length
    || after.canvasCalls.length !== before.canvasCalls.length
  ) throw new Error(`SECRET_CHANNEL_NEGATIVE_PROBE_REACHED_TOOL:${label}`);
}

async function readEvidence() {
  const response = await fetch(evidenceUrl, {
    headers: { "X-Validation-Evidence-Secret": evidenceSecret },
  });
  if (!response.ok) throw new Error(`SECRET_CHANNEL_EVIDENCE_FAILED:${response.status}`);
  return response.json();
}

function assertPositiveEvidence(evidence) {
  if (
    evidence?.protocol !== "workbench.secret-channel-validation-evidence.v1"
    || evidence.knowledgeTokenSha256 !== sha256(knowledgeToken)
    || evidence.canvasTokenSha256 !== sha256(canvasToken)
    || !Array.isArray(evidence.knowledgeCalls)
    || !Array.isArray(evidence.canvasCalls)
    || evidence.knowledgeCalls.length !== 1
    || evidence.canvasCalls.length !== 1
  ) throw new Error("SECRET_CHANNEL_TOOL_DELIVERY_EVIDENCE_INVALID");
}

function assertNoCapabilityLeak(surfaces) {
  const needles = [
    knowledgeToken,
    canvasToken,
    "WORKBENCH_KNOWLEDGE_CAPABILITY",
    "WORKBENCH_CANVAS_CAPABILITY",
    "wbkg1.",
    "wbct1.",
  ];
  let scanned = 0;
  for (const surface of surfaces) {
    walk(surface.value, [], (value, key, valuePath) => {
      scanned += 1;
      if (scanned > 1_000_000) throw new Error("SECRET_CHANNEL_SCAN_LIMIT_EXCEEDED");
      for (const candidate of [key, value]) {
        if (typeof candidate === "string" && needles.some((needle) => candidate.includes(needle))) {
          throw new Error(`SECRET_CHANNEL_CAPABILITY_LEAK:${surface.label}:${valuePath.join(".")}`);
        }
      }
    });
  }
  return scanned;
}

function walk(value, valuePath, visit, seen = new WeakSet(), depth = 0) {
  if (depth > 128) throw new Error("SECRET_CHANNEL_SCAN_DEPTH_EXCEEDED");
  visit(value, valuePath.at(-1), valuePath);
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...valuePath, String(index)], visit, seen, depth + 1));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    walk(item, [...valuePath, key], visit, seen, depth + 1);
  }
}

function internalClient() {
  return new Client({
    apiUrl: langGraphUrl,
    apiKey: null,
    timeoutMs: config.deerFlowTimeoutMs,
    defaultHeaders: headers,
  });
}

function emptyTextState() {
  return {
    protocol: "workbench.runtime-provider-text-state.v2",
    rawAssistantText: "",
    visibleAssistantText: "",
    durableVisibleAssistantText: "",
    redactionBuffer: "",
    committedFinalization: null,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function capabilityToken(name, prefix) {
  const value = required(name);
  const pattern = new RegExp(`^${prefix}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$`, "u");
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
