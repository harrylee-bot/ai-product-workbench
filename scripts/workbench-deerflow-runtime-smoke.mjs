#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { DeerFlowRuntimeAdapter } = require(path.join(
  repoRoot,
  "apps/workbench-worker/dist/runtime/deerflow-runtime.adapter.js",
));

const gatewayUrl = trimTrailingSlash(process.env.DEERFLOW_GATEWAY_URL || "http://localhost:8001");
const langGraphUrl = trimTrailingSlash(process.env.DEERFLOW_LANGGRAPH_URL || `${gatewayUrl}/api`);
const internalToken = process.env.DEERFLOW_INTERNAL_AUTH_TOKEN?.trim();
if (!internalToken) throw new Error("DEERFLOW_INTERNAL_AUTH_TOKEN is required");
const suffix = randomUUID();
const principalId = `workbench-runtime-smoke-${suffix}`;
const assistantId = process.env.DEERFLOW_ASSISTANT_ID?.trim() || "lead_agent";
const identityHeaders = {
  accept: "application/json",
  "X-DeerFlow-Internal-Token": internalToken,
  "X-DeerFlow-Owner-User-Id": principalId,
};
await assertPublicRuntimeSkill(identityHeaders);
const modelId = required("DEERFLOW_SMOKE_MODEL_ID");

const config = {
  databaseUrl: "postgresql://runtime-smoke.invalid/workbench",
  queueConnectionString: "postgresql://runtime-smoke.invalid/workbench",
  deerFlowLangGraphUrl: langGraphUrl,
  deerFlowGatewayUrl: gatewayUrl,
  deerFlowAssistantId: assistantId,
  deerFlowInternalToken: internalToken,
  deerFlowStreamMode: ["messages", "values"],
  deerFlowTimeoutMs: numberFromEnv("DEERFLOW_TIMEOUT_MS", 180_000),
  deerFlowSubmissionTimeoutMs: numberFromEnv("DEERFLOW_SUBMISSION_TIMEOUT_MS", 120_000),
  deerFlowIdleTimeoutMs: numberFromEnv("DEERFLOW_IDLE_TIMEOUT_MS", 60_000),
  concurrency: 1,
  s3Bucket: "runtime-smoke-unused",
  s3Region: "us-east-1",
  s3InternalEndpoint: "http://runtime-smoke.invalid",
  s3ForcePathStyle: true,
  runtimeReadyBlobS3AccessKeyId: "unused",
  runtimeReadyBlobS3SecretAccessKey: "unused",
};
const runtime = new DeerFlowRuntimeAdapter(config, {
  getObject: async () => {
    throw new Error("Runtime smoke must not read object storage");
  },
});
const projectId = `project-runtime-smoke-${suffix}`;
const threadId = `thread-runtime-smoke-${suffix}`;
const runId = `run-runtime-smoke-${suffix}`;
const binding = await runtime.createThread({
  workbenchProjectId: projectId,
  workbenchThreadId: threadId,
  workbenchPrincipalId: principalId,
});
const events = [];
let externalRunId = null;
const result = await runtime.execute({
  runId,
  runtimeAttemptId: `attempt-${suffix}`,
  attempt: 1,
  projectId,
  threadId,
  principalId,
  externalThreadId: binding.externalThreadId,
  request: {
    prompt: "生成一份简短的产品调研记录，返回 document Artifact。内容只需要说明本次 DeerFlow 运行链路验证成功。",
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
  knowledgeTool: null,
  designStyleSnapshot: null,
  resume: null,
  providerTextState: {
    protocol: "workbench.runtime-provider-text-state.v2",
    rawAssistantText: "",
    visibleAssistantText: "",
    durableVisibleAssistantText: "",
    redactionBuffer: "",
    committedFinalization: null,
  },
  submission: {
    mode: "submit",
    providerIdempotencyKey: `wbrt:runtime-smoke:${suffix}`,
  },
}, {
  onSubmissionStarted: async () => undefined,
  onExternalRunCreated: async (id) => {
    externalRunId = id;
  },
  isExternalEventProcessed: async () => false,
  onExternalEvent: async (_part, effects) => {
    events.push(...effects);
  },
  onExternalFinalization: async (_part, effects) => {
    events.push(...effects);
  },
});

if (result.protocol !== "workbench.runtime.result.v1") {
  throw new Error(`Unexpected Runtime result protocol: ${result.protocol}`);
}
if (result.artifacts.length !== 1 || result.artifacts[0]?.kind !== "document") {
  throw new Error("Runtime smoke did not return exactly one document Artifact");
}
if (result.artifacts[0].operation.kind !== "create") {
  throw new Error("Runtime smoke document did not use a create operation");
}
if (events.some((event) => event.type === "text.delta" && (
  event.delta.includes("workbench_runtime_result_submit")
  || event.delta.includes("workbench.runtime.validated-result.v1")
))) {
  throw new Error("Runtime result submit transport leaked into visible text events");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  externalThreadId: binding.externalThreadId,
  externalRunId,
  artifactKind: result.artifacts[0].kind,
  operation: result.artifacts[0].operation.kind,
  assistantId,
  modelId,
  visibleTextBytes: events
    .filter((event) => event.type === "text.delta")
    .reduce((total, event) => total + Buffer.byteLength(event.delta), 0),
}, null, 2)}\n`);

async function assertPublicRuntimeSkill(headers) {
  const response = await fetch(`${gatewayUrl}/api/skills`, { headers });
  const payload = await responseJson(response, "DeerFlow skill catalog");
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  const skill = skills.find((candidate) => candidate?.name === "workbench");
  if (!skill || skill.category !== "public" || skill.enabled !== true) {
    throw new Error(
      "DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED: mount the repository workbench skill "
      + "read-only under DEER_FLOW_SKILLS_PATH/public/workbench for every runtime tenant",
    );
  }
}

async function responseJson(response, label) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : response.statusText;
    throw new Error(`${label} failed (${response.status}): ${detail}`);
  }
  return payload;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
