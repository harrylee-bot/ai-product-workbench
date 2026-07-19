#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCompleteHistory,
  assertFinalOutputContainsEvidence,
  assertKnowledgeRetrievalProof,
  assertNoKnowledgeCapabilityLeak,
  readKnowledgeSmokeEnvironment,
  redactKnowledgeCapability,
} from "./workbench-deerflow-knowledge-smoke-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_LIMIT = 1_000;
const RUN_PAGE_SIZE = 100;
const MAX_RUN_PAGES = 100;
let database = null;

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown Knowledge smoke failure";
  process.stderr.write(`[knowledge-smoke] ${redactKnowledgeCapability(message)}\n`);
  process.exitCode = 1;
} finally {
  await database?.$disconnect().catch(() => undefined);
}

async function main() {
  const smoke = readKnowledgeSmokeEnvironment(process.env);
  const workerDist = path.join(repoRoot, "apps/workbench-worker/dist");
  const [configModule, dbModule, adapterModule, grantModule, processorModule, storageModule, contracts, sdk] =
    await Promise.all([
      importBuilt(workerDist, "config.js"),
      importBuilt(workerDist, "db.js"),
      importBuilt(workerDist, "runtime/deerflow-runtime.adapter.js"),
      importBuilt(workerDist, "runtime/knowledge-tool-grant.service.js"),
      importBuilt(workerDist, "runs/run-processor.js"),
      importBuilt(workerDist, "storage/s3-runtime-ready-blob-reader.js"),
      import("@workbench/workbench-contracts"),
      import("@langchain/langgraph-sdk"),
    ]);
  const config = configModule.loadWorkerConfig();
  if (!config.knowledgeTool) throw new Error("KNOWLEDGE_SMOKE_TOOL_CONFIGURATION_MISSING");
  if (config.deerFlowAssistantId !== smoke.assistantId) {
    throw new Error("KNOWLEDGE_SMOKE_ASSISTANT_CONFIGURATION_MISMATCH");
  }
  database = dbModule.db;
  await database.$connect();

  const preflight = await loadAndAssertScope(database, smoke, contracts.startRunRequestSchema);
  const identityHeaders = {
    accept: "application/json",
    "X-DeerFlow-Internal-Token": config.deerFlowInternalToken,
    "X-DeerFlow-Owner-User-Id": smoke.principalId,
  };
  await assertPublicRuntimeSkill(config.deerFlowGatewayUrl, identityHeaders);
  await assertRuntimeModel(config.deerFlowLangGraphUrl, identityHeaders, preflight.request.modelId);

  const runtime = new adapterModule.DeerFlowRuntimeAdapter(
    config,
    new storageModule.S3RuntimeReadyBlobReader(config),
  );
  const issuer = new grantModule.PrismaKnowledgeToolGrantIssuer(database, config.knowledgeTool);
  const processor = new processorModule.RunProcessor(database, runtime, issuer);
  const execution = await processor.execute(smoke.runId, [], undefined, {
    retryCount: 0,
    retryLimit: 0,
  });
  if (execution?.skipped || execution?.waitingInput || execution?.cancellationPending) {
    throw new Error("KNOWLEDGE_SMOKE_RUN_DID_NOT_COMPLETE");
  }

  const persisted = await loadPersistedSurfaces(database, smoke);
  const externalRunId = persisted.attempt.externalRunId;
  if (!externalRunId) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_MISSING");
  const client = new sdk.Client({
    apiUrl: config.deerFlowLangGraphUrl,
    apiKey: null,
    timeoutMs: config.deerFlowTimeoutMs,
    defaultHeaders: identityHeaders,
  });
  const [externalRun, externalRuns, thread, state, history] = await Promise.all([
    client.runs.get(persisted.attempt.externalThreadId, externalRunId),
    listAllRuns(client, persisted.attempt.externalThreadId),
    client.threads.get(persisted.attempt.externalThreadId, {
      include: ["values", "config", "context"],
    }),
    client.threads.getState(persisted.attempt.externalThreadId, undefined, { subgraphs: true }),
    client.threads.getHistory(persisted.attempt.externalThreadId, { limit: HISTORY_LIMIT }),
  ]);
  assertCompleteHistory(history, HISTORY_LIMIT);
  const selectedRuns = externalRuns.filter((run) => run?.run_id === externalRunId);
  if (selectedRuns.length !== 1) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_MISMATCH");

  const deerFlowSurfaces = [externalRun, ...selectedRuns, thread, state, ...history];
  const scanCount = assertNoKnowledgeCapabilityLeak([
    { label: "deerflow-run", value: externalRun },
    { label: "deerflow-run-list", value: selectedRuns },
    { label: "deerflow-thread", value: thread },
    { label: "deerflow-state", value: state },
    { label: "deerflow-history", value: history },
    { label: "workbench-run", value: persisted.run },
    { label: "workbench-grants", value: persisted.grants },
  ]);
  const successfulInvocations = persisted.grants.flatMap((grant) => grant.invocations)
    .filter((invocation) => invocation.status === "succeeded" && invocation.response !== null);
  if (successfulInvocations.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_SUCCEEDED_INVOCATION_MISSING");
  }
  const proof = assertKnowledgeRetrievalProof({
    deerFlowSurfaces,
    ledgerResponses: successfulInvocations.map((invocation) => invocation.response),
    releaseId: smoke.releaseId,
    expectedProbe: smoke.expectedProbe,
    expectedCitation: smoke.expectedCitation,
  });
  assertFinalOutputContainsEvidence(
    persisted.run.outputEntry?.content,
    smoke.expectedProbe,
    smoke.expectedCitation,
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: smoke.runId,
    runtimeAttemptId: persisted.attempt.id,
    externalThreadId: persisted.attempt.externalThreadId,
    externalRunId,
    releaseId: smoke.releaseId,
    assistantId: smoke.assistantId,
    modelId: preflight.request.modelId,
    successfulKnowledgeInvocations: successfulInvocations.length,
    checkpointStatesScanned: history.length,
    structuredValuesScanned: scanCount,
    proof,
    traceAudit: {
      status: "external_gate_required",
      reason: "DeerFlow/LangGraph Run API does not expose the deployment trace backend",
    },
  }, null, 2)}\n`);
}

async function loadAndAssertScope(db, smoke, startRunRequestSchema) {
  const run = await db.run.findUnique({
    where: { id: smoke.runId },
    select: {
      id: true,
      projectId: true,
      threadId: true,
      createdById: true,
      knowledgeReleaseId: true,
      modelId: true,
      request: true,
      status: true,
      attempt: true,
      outputEntryId: true,
      runtimeAttempts: { select: { id: true } },
      createdBy: { select: { id: true, status: true } },
      thread: {
        select: {
          id: true,
          status: true,
          project: { select: { id: true, workspaceId: true, status: true } },
        },
      },
      knowledgeRelease: {
        select: {
          id: true,
          workspaceId: true,
          status: true,
          chunksReadyAt: true,
          readyAt: true,
        },
      },
    },
  });
  if (!run) throw new Error("KNOWLEDGE_SMOKE_RUN_NOT_FOUND");
  const release = run.knowledgeRelease;
  if (
    run.id !== smoke.runId
    || run.createdById !== smoke.principalId
    || run.projectId !== smoke.projectId
    || run.thread.project.id !== smoke.projectId
    || run.knowledgeReleaseId !== smoke.releaseId
    || release?.id !== smoke.releaseId
  ) {
    throw new Error("KNOWLEDGE_SMOKE_SCOPE_MISMATCH");
  }
  if (run.createdBy.status !== "active" || run.thread.status !== "active" || run.thread.project.status !== "active") {
    throw new Error("KNOWLEDGE_SMOKE_SCOPE_NOT_ACTIVE");
  }
  const membership = await db.projectMember.findUnique({
    where: { projectId_principalId: { projectId: smoke.projectId, principalId: smoke.principalId } },
    select: { projectId: true },
  });
  if (!membership) throw new Error("KNOWLEDGE_SMOKE_PROJECT_MEMBERSHIP_MISSING");
  if (
    release.status !== "ready"
    || !release.readyAt
    || !release.chunksReadyAt
    || (release.workspaceId !== null && release.workspaceId !== run.thread.project.workspaceId)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_RELEASE_NOT_READY_OR_SCOPED");
  }
  if (
    run.status !== "queued"
    || run.outputEntryId !== null
    || run.runtimeAttempts.length !== 0
  ) {
    throw new Error("KNOWLEDGE_SMOKE_FIXTURE_NOT_FRESH");
  }
  const request = startRunRequestSchema.parse(run.request);
  if (request.modelId !== run.modelId) throw new Error("KNOWLEDGE_SMOKE_MODEL_PIN_MISMATCH");
  if (!request.prompt.includes(smoke.query)) throw new Error("KNOWLEDGE_SMOKE_QUERY_NOT_IN_RUN_PROMPT");
  if (!request.prompt.includes("workbench_knowledge_retrieve")) {
    throw new Error("KNOWLEDGE_SMOKE_TRUSTED_TOOL_NOT_REQUIRED_BY_PROMPT");
  }
  if (request.prompt.includes(smoke.expectedProbe) || request.prompt.includes(smoke.expectedCitation)) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_LEAKED_INTO_RUN_PROMPT");
  }
  return { request };
}

async function loadPersistedSurfaces(db, smoke) {
  const [run, attempts] = await Promise.all([
    db.run.findUnique({
      where: { id: smoke.runId },
      select: {
        id: true,
        status: true,
        errorCode: true,
        errorDetail: true,
        outputEntry: { select: { content: true } },
        draft: { select: { content: true } },
        events: { orderBy: { sequence: "asc" }, select: { type: true, payload: true } },
      },
    }),
    db.runtimeAttempt.findMany({
      where: { runId: smoke.runId },
      select: {
        id: true,
        status: true,
        externalThreadId: true,
        externalRunId: true,
        errorCode: true,
        errorDetail: true,
      },
    }),
  ]);
  if (!run || attempts.length !== 1) throw new Error("KNOWLEDGE_SMOKE_POST_RUN_STATE_MISSING");
  const attempt = attempts[0];
  const grants = await db.knowledgeToolGrant.findMany({
    where: {
      runtimeAttemptId: attempt.id,
      runId: smoke.runId,
      principalId: smoke.principalId,
      projectId: smoke.projectId,
      releaseId: smoke.releaseId,
    },
    select: {
      id: true,
      runtimeAttemptId: true,
      runId: true,
      principalId: true,
      projectId: true,
      releaseId: true,
      payloadSha256: true,
      issuedAt: true,
      expiresAt: true,
      revokedAt: true,
      invocations: {
        select: {
          id: true,
          invocationId: true,
          querySha256: true,
          status: true,
          attemptCount: true,
          response: true,
          responseSha256: true,
          lastErrorCode: true,
        },
      },
    },
  });
  if (run.status !== "succeeded" || attempt.status !== "succeeded") {
    throw new Error("KNOWLEDGE_SMOKE_POST_RUN_NOT_SUCCEEDED");
  }
  if (grants.length !== 1) throw new Error("KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH");
  return { run, attempt, grants };
}

async function listAllRuns(client, threadId) {
  const runs = [];
  for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
    const batch = await client.runs.list(threadId, {
      limit: RUN_PAGE_SIZE,
      offset: page * RUN_PAGE_SIZE,
      select: [
        "run_id",
        "thread_id",
        "assistant_id",
        "created_at",
        "updated_at",
        "status",
        "metadata",
        "kwargs",
        "multitask_strategy",
      ],
    });
    runs.push(...batch);
    if (batch.length < RUN_PAGE_SIZE) return runs;
  }
  throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_TRUNCATED");
}

async function assertPublicRuntimeSkill(gatewayUrl, headers) {
  const response = await fetch(`${trimTrailingSlash(gatewayUrl)}/api/skills`, { headers });
  const payload = await responseJson(response, "DEERFLOW_SKILL_CATALOG_FAILED");
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  const skill = skills.find((candidate) => candidate?.name === "workbench");
  if (!skill || skill.category !== "public" || skill.enabled !== true) {
    throw new Error("DEERFLOW_PUBLIC_WORKBENCH_SKILL_REQUIRED");
  }
}

async function assertRuntimeModel(langGraphUrl, headers, expectedModel) {
  const response = await fetch(`${trimTrailingSlash(langGraphUrl)}/models`, { headers });
  const payload = await responseJson(response, "DEERFLOW_MODEL_CATALOG_FAILED");
  const names = Array.isArray(payload?.models)
    ? payload.models.map((model) => model?.name).filter((name) => typeof name === "string")
    : [];
  if (!names.includes(expectedModel)) throw new Error("DEERFLOW_PINNED_MODEL_UNAVAILABLE");
}

async function responseJson(response, errorCode) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${errorCode}:${response.status}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${errorCode}:INVALID_JSON`);
  }
}

function importBuilt(base, relativePath) {
  return import(pathToFileURL(path.join(base, relativePath)).href).catch((error) => {
    throw new Error(`KNOWLEDGE_SMOKE_WORKER_BUILD_REQUIRED:${redactKnowledgeCapability(error.message)}`);
  });
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}
