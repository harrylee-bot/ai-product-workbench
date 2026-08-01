#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCompleteHistory,
  assertConcurrentOppositeScope,
  assertFinalOutputContainsEvidence,
  assertKnowledgeCatalogHidden,
  assertKnowledgeEvidenceAbsent,
  assertKnowledgeRetrievalProof,
  assertNoKnowledgeCapabilityLeak,
  buildKnowledgeSmokeEvidence,
  readKnowledgeSmokeEnvironment,
  safeKnowledgeSmokeError,
} from "./workbench-deerflow-knowledge-smoke-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The pinned DeerFlow history endpoint rejects limits above 100. Reaching the
// maximum remains fail-closed because the response may be truncated.
const HISTORY_LIMIT = 100;
const RUN_PAGE_SIZE = 100;
const MAX_RUN_PAGES = 100;
const execFileAsync = promisify(execFile);
let database = null;

try {
  await main();
} catch (error) {
  process.stderr.write(`[knowledge-smoke] ${safeKnowledgeSmokeError(error)}\n`);
  process.exitCode = 1;
} finally {
  await database?.$disconnect().catch(() => undefined);
}

async function main() {
  const smoke = readKnowledgeSmokeEnvironment(process.env);
  await assertCheckoutBinding(smoke.binding.candidateCommit);
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

  const [validPreflight, nullPreflight] = await Promise.all([
    loadAndAssertScope(database, smoke.valid, contracts.startRunRequestSchema, smoke),
    loadAndAssertScope(database, smoke.nullRelease, contracts.startRunRequestSchema, smoke),
  ]);
  if (validPreflight.request.modelId !== nullPreflight.request.modelId) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_MODEL_MISMATCH");
  }
  if (validPreflight.threadId === nullPreflight.threadId) {
    throw new Error("KNOWLEDGE_SMOKE_OPPOSITE_SCOPE_THREADS_MUST_DIFFER");
  }
  const validHeaders = identityHeaders(config, smoke.valid.principalId);
  const nullHeaders = identityHeaders(config, smoke.nullRelease.principalId);
  await Promise.all([
    assertPublicRuntimeSkill(config.deerFlowGatewayUrl, validHeaders),
    assertRuntimeModel(config.deerFlowLangGraphUrl, validHeaders, validPreflight.request.modelId),
    assertRuntimeModel(config.deerFlowLangGraphUrl, nullHeaders, nullPreflight.request.modelId),
  ]);

  const runtime = new adapterModule.DeerFlowRuntimeAdapter(
    config,
    new storageModule.S3RuntimeReadyBlobReader(config),
  );
  const issuer = new grantModule.PrismaKnowledgeToolGrantIssuer(database, config.knowledgeTool);
  const processor = new processorModule.RunProcessor(database, runtime, issuer);
  const [validExecution, nullExecution] = await Promise.all([
    executeRun(processor, smoke.valid.runId),
    executeRun(processor, smoke.nullRelease.runId),
  ]);
  void validExecution;
  void nullExecution;

  const [validPersisted, nullPersisted] = await Promise.all([
    loadPersistedSurfaces(database, smoke.valid),
    loadPersistedSurfaces(database, smoke.nullRelease),
  ]);
  const [validExternal, nullExternal] = await Promise.all([
    loadExternalSurfaces(config, sdk, validHeaders, validPersisted.attempt),
    loadExternalSurfaces(config, sdk, nullHeaders, nullPersisted.attempt),
  ]);
  const validScanCount = assertNoKnowledgeCapabilityLeak([
    ...validExternal.scanSurfaces,
    { label: "valid-workbench-run", value: validPersisted.run },
    { label: "valid-workbench-grants", value: validPersisted.grants },
  ]);
  const nullScanCount = assertNoKnowledgeCapabilityLeak([
    ...nullExternal.scanSurfaces.map((surface) => ({
      label: `null-${surface.label}`,
      value: surface.value,
    })),
    { label: "null-workbench-run", value: nullPersisted.run },
    { label: "null-workbench-grants", value: nullPersisted.grants },
  ]);
  const successfulInvocations = validPersisted.grants.flatMap((grant) => grant.invocations)
    .filter((invocation) => invocation.status === "succeeded" && invocation.response !== null);
  if (successfulInvocations.length === 0) {
    throw new Error("KNOWLEDGE_SMOKE_SUCCEEDED_INVOCATION_MISSING");
  }
  const proof = assertKnowledgeRetrievalProof({
    deerFlowSurfaces: validExternal.deerFlowSurfaces,
    ledgerResponses: successfulInvocations.map((invocation) => invocation.response),
    releaseId: smoke.valid.releaseId,
    expectedProbe: smoke.expectedProbe,
    expectedCitation: smoke.expectedCitation,
  });
  assertFinalOutputContainsEvidence(
    validPersisted.run.outputEntry?.content,
    smoke.expectedProbe,
    smoke.expectedCitation,
  );
  if (nullPersisted.grants.length !== 0 || nullPersisted.invocationCount !== 0) {
    throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO");
  }
  const nullCatalog = assertKnowledgeCatalogHidden(nullExternal.deerFlowSurfaces);
  assertKnowledgeEvidenceAbsent(
    [...nullExternal.deerFlowSurfaces, nullPersisted.run, nullPersisted.grants],
    smoke.expectedProbe,
    smoke.expectedCitation,
  );
  const isolation = assertConcurrentOppositeScope({
    valid: isolationSurface(smoke.valid, validPersisted, successfulInvocations.length),
    nullRelease: isolationSurface(smoke.nullRelease, nullPersisted, 0),
  });

  const forbiddenValues = [
    ...scopeRawValues(smoke.valid, validPersisted),
    ...scopeRawValues(smoke.nullRelease, nullPersisted),
    smoke.expectedProbe,
    smoke.expectedCitation,
    smoke.valid.query,
    smoke.nullRelease.query,
  ];
  const evidence = buildKnowledgeSmokeEvidence({
    binding: smoke.binding,
    valid: {
      scopeIds: scopeRawValues(smoke.valid, validPersisted),
      releaseId: smoke.valid.releaseId,
      successfulInvocationCount: successfulInvocations.length,
      checkpointStatesScanned: validExternal.history.length,
      structuredValuesScanned: validScanCount,
      proof,
    },
    nullRelease: {
      scopeIds: scopeRawValues(smoke.nullRelease, nullPersisted),
      grantCount: nullPersisted.grants.length,
      endpointCalls: nullPersisted.invocationCount,
      catalog: nullCatalog,
      checkpointStatesScanned: nullExternal.history.length,
      structuredValuesScanned: nullScanCount,
    },
    isolation,
    forbiddenValues,
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

async function loadAndAssertScope(db, smoke, startRunRequestSchema, expectations) {
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
          runtimeBinding: { select: { id: true } },
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
    || (smoke.releaseId === null ? release !== null : release?.id !== smoke.releaseId)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_SCOPE_MISMATCH");
  }
  if (run.createdBy.status !== "active" || run.thread.status !== "active" || run.thread.project.status !== "active") {
    throw new Error("KNOWLEDGE_SMOKE_SCOPE_NOT_ACTIVE");
  }
  if (run.thread.runtimeBinding !== null) {
    throw new Error("KNOWLEDGE_SMOKE_REQUIRES_FRESH_RUNTIME_THREAD");
  }
  const membership = await db.projectMember.findUnique({
    where: { projectId_principalId: { projectId: smoke.projectId, principalId: smoke.principalId } },
    select: { projectId: true },
  });
  if (!membership) throw new Error("KNOWLEDGE_SMOKE_PROJECT_MEMBERSHIP_MISSING");
  if (smoke.releaseId !== null) {
    if (
      release?.status !== "ready"
      || !release.readyAt
      || !release.chunksReadyAt
      || (release.workspaceId !== null && release.workspaceId !== run.thread.project.workspaceId)
    ) {
      throw new Error("KNOWLEDGE_SMOKE_RELEASE_NOT_READY_OR_SCOPED");
    }
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
  if (
    request.prompt.includes(expectations.expectedProbe)
    || request.prompt.includes(expectations.expectedCitation)
  ) {
    throw new Error("KNOWLEDGE_SMOKE_EXPECTATION_LEAKED_INTO_RUN_PROMPT");
  }
  return { request, threadId: run.threadId };
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
        knowledgeReleaseId: true,
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
        startedAt: true,
        finishedAt: true,
      },
    }),
  ]);
  if (!run || attempts.length !== 1) throw new Error("KNOWLEDGE_SMOKE_POST_RUN_STATE_MISSING");
  const attempt = attempts[0];
  const [grants, invocationCount] = await Promise.all([
    db.knowledgeToolGrant.findMany({
      where: { runtimeAttemptId: attempt.id, runId: smoke.runId },
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
    }),
    db.knowledgeRetrievalInvocation.count({ where: { runtimeAttemptId: attempt.id } }),
  ]);
  if (
    run.status !== "succeeded"
    || attempt.status !== "succeeded"
    || !attempt.startedAt
    || !attempt.finishedAt
  ) {
    throw new Error("KNOWLEDGE_SMOKE_POST_RUN_NOT_SUCCEEDED");
  }
  if (run.knowledgeReleaseId !== smoke.releaseId) throw new Error("KNOWLEDGE_SMOKE_POST_RUN_SCOPE_MISMATCH");
  if (smoke.releaseId === null) {
    if (grants.length !== 0 || invocationCount !== 0) {
      throw new Error("KNOWLEDGE_SMOKE_NULL_RELEASE_ENDPOINT_NOT_ZERO");
    }
  } else if (
    grants.length !== 1
    || grants[0]?.principalId !== smoke.principalId
    || grants[0]?.projectId !== smoke.projectId
    || grants[0]?.releaseId !== smoke.releaseId
  ) {
    throw new Error("KNOWLEDGE_SMOKE_GRANT_LEDGER_MISMATCH");
  }
  return { run, attempt, grants, invocationCount };
}

async function executeRun(processor, runId) {
  const execution = await processor.execute(runId, [], undefined, {
    retryCount: 0,
    retryLimit: 0,
  });
  if (execution?.skipped || execution?.waitingInput || execution?.cancellationPending) {
    throw new Error("KNOWLEDGE_SMOKE_RUN_DID_NOT_COMPLETE");
  }
  return execution;
}

async function loadExternalSurfaces(config, sdk, headers, attempt) {
  const externalRunId = attempt.externalRunId;
  if (!externalRunId) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_MISSING");
  const client = new sdk.Client({
    apiUrl: config.deerFlowLangGraphUrl,
    apiKey: null,
    timeoutMs: config.deerFlowTimeoutMs,
    defaultHeaders: headers,
  });
  const [externalRun, externalRuns, thread, state, history] = await Promise.all([
    client.runs.get(attempt.externalThreadId, externalRunId),
    listAllRuns(client, attempt.externalThreadId),
    client.threads.get(attempt.externalThreadId, { include: ["values", "config", "context"] }),
    client.threads.getState(attempt.externalThreadId, undefined, { subgraphs: true }),
    client.threads.getHistory(attempt.externalThreadId, { limit: HISTORY_LIMIT }),
  ]);
  assertCompleteHistory(history, HISTORY_LIMIT);
  const selectedRuns = externalRuns.filter((run) => run?.run_id === externalRunId);
  if (selectedRuns.length !== 1) throw new Error("KNOWLEDGE_SMOKE_EXTERNAL_RUN_LIST_MISMATCH");
  return {
    history,
    deerFlowSurfaces: [externalRun, ...selectedRuns, thread, state, ...history],
    scanSurfaces: [
      { label: "deerflow-run", value: externalRun },
      { label: "deerflow-run-list", value: selectedRuns },
      { label: "deerflow-thread", value: thread },
      { label: "deerflow-state", value: state },
      { label: "deerflow-history", value: history },
    ],
  };
}

function isolationSurface(scope, persisted, successfulInvocationCount) {
  return {
    runId: scope.runId,
    runtimeAttemptId: persisted.attempt.id,
    externalThreadId: persisted.attempt.externalThreadId,
    externalRunId: persisted.attempt.externalRunId,
    releaseId: scope.releaseId,
    grantCount: persisted.grants.length,
    invocationCount: persisted.invocationCount,
    successfulInvocationCount,
    startedAt: persisted.attempt.startedAt,
    finishedAt: persisted.attempt.finishedAt,
  };
}

function scopeRawValues(scope, persisted) {
  return [
    scope.runId,
    scope.principalId,
    scope.projectId,
    scope.releaseId,
    persisted.attempt.id,
    persisted.attempt.externalThreadId,
    persisted.attempt.externalRunId,
  ].filter((value) => typeof value === "string" && value.length > 0);
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

function identityHeaders(config, principalId) {
  return {
    accept: "application/json",
    "X-DeerFlow-Internal-Token": config.deerFlowInternalToken,
    "X-DeerFlow-Owner-User-Id": principalId,
  };
}

async function assertCheckoutBinding(expectedCommit) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }));
  } catch {
    throw new Error("KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_UNAVAILABLE");
  }
  if (stdout.trim() !== expectedCommit) {
    throw new Error("KNOWLEDGE_SMOKE_CANDIDATE_CHECKOUT_MISMATCH");
  }
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
  return import(pathToFileURL(path.join(base, relativePath)).href).catch(() => {
    throw new Error("KNOWLEDGE_SMOKE_WORKER_BUILD_REQUIRED");
  });
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}
