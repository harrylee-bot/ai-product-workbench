#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { chromium } from "playwright";
import {
  assertRealStackBrowserMode,
  browserExternalRequestClass,
  browserNetworkFailureClass,
  browserOriginClass,
  browserSseEventEvidence,
  connectionErrorClass,
  createScriptedNavigationAbortTracker,
  hasRequiredBrowserSseEvidence,
  httpOriginClass,
  httpPathClass as browserPathClass,
  persistedTerminalSseAbortAttribution,
  shouldFailRealStackEvidenceForSourceDrift,
} from "./workbench-browser-network-evidence.mjs";
import {
  captureStableMotionFrameEvidence,
  diagnosticErrorClass,
  diagnosticFakeRuntimeState,
  evaluateMotionFrameEvidence,
  httpDiagnosticSuccessEvidence,
} from "./workbench-postgres-http-e2e-diagnostics.mjs";
import { executeCanvasToolRequest } from "./workbench-postgres-http-e2e-canvas-client.mjs";
import {
  runBoundedCleanup,
  stopProcessTree,
} from "./e2e/workbench-process-lifecycle.mjs";
import {
  waitForWorkbenchWeb,
  warmWorkbenchAuthRoutes,
  warmWorkbenchProtectedRoutes,
} from "./e2e/workbench-web-startup.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const databaseUrl = testDatabaseUrl(process.env.WORKBENCH_TEST_DATABASE_URL);
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
assertSchemaResetConfirmation(databaseName);
const commandTimeoutMs = positiveInteger("WORKBENCH_E2E_COMMAND_TIMEOUT_MS", 180_000);
const scenarioTimeoutMs = positiveInteger("WORKBENCH_E2E_SCENARIO_TIMEOUT_MS", 60_000);
const fakeRuntimeToken = `workbench-e2e-${randomUUID()}`;
const fakeStorageBucket = "workbench-e2e-sources";
const fakeStorageAccessKeyId = "workbench-e2e-access-key";
const fakeStorageSecretAccessKey = "workbench-e2e-secret-key";
const previewTokenSecret = Buffer.alloc(32, 17).toString("base64url");
const invitationTokenSecret = Buffer.alloc(32, 29).toString("base64url");
const canvasToolSecret = Buffer.alloc(32, 41).toString("base64url");
const canvasVisualFixtureBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const runtimeCatalogModelId = "quality";
const runtimeProviderModel = "fake-quality-model";
const prdV2DocumentId = "e2e-prd";
const prdV2WorkOrderName = "Workbench PostgreSQL E2E";
const prdV2Title = `${prdV2WorkOrderName}需求说明书`;
const prdGenerationStageSequence = [
  "collecting-prd-context",
  "structuring-prd",
  "drafting-prd",
  "validating-prd",
];
const successPrdCheckpointToolCallId = "e2e-prd-checkpoint";
const prdReferenceFixtures = [
  {
    path: "/mnt/skills/public/requirement-doc-template/SKILL.md",
    source: new URL(
      "../integrations/deerflow/skills/requirement-doc-template/SKILL.md",
      import.meta.url,
    ),
  },
  {
    path: "/mnt/skills/public/requirement-doc-template/references/structure.md",
    source: new URL(
      "../integrations/deerflow/skills/requirement-doc-template/references/structure.md",
      import.meta.url,
    ),
  },
  {
    path: "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
    source: new URL(
      "../integrations/deerflow/skills/requirement-doc-template/references/quality-standards.md",
      import.meta.url,
    ),
  },
  {
    path: "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
    source: new URL(
      "../integrations/deerflow/skills/workbench/references/prd-runtime-result.schema.json",
      import.meta.url,
    ),
  },
].map((fixture, index) => ({
  ...fixture,
  content: readFileSync(fixture.source, "utf8"),
  toolCallId: `e2e-prd-reference-${index}`,
}));
const verbose = process.env.WORKBENCH_E2E_VERBOSE === "1";
const runRealStackBrowser = process.env.WORKBENCH_E2E_REAL_STACK_BROWSER === "1";
const realStackBrowserOnly = process.env.WORKBENCH_E2E_REAL_STACK_BROWSER_ONLY === "1";
const runRuntimeProcessConvergence = process.env.WORKBENCH_E2E_RUNTIME_PROCESS_CONVERGENCE === "1";
assertRealStackBrowserMode({ browserOnly: realStackBrowserOnly, enabled: runRealStackBrowser });
assert.equal(
  runRuntimeProcessConvergence && runRealStackBrowser,
  false,
  "runtime process convergence and real-stack browser modes are mutually exclusive",
);
const controlledProvider = process.env.WORKBENCH_E2E_CONTROLLED_PROVIDER ?? "controlled-local-deerflow";
assert.equal(controlledProvider, "controlled-local-deerflow", "real-stack browser must use the approved controlled provider marker");
const candidateSourceCommit = resolveCandidateSourceCommit();
const candidateSourceSnapshot = resolveCandidateSourceSnapshot();
// The controlled provider deliberately exhausts the real pg-boss retry policy.
// Keep the longer budget scoped to that recovery assertion; ordinary scenarios
// retain the shorter timeout so a hung service still fails promptly.
const recoveryScenarioTimeoutMs = positiveInteger(
  "WORKBENCH_E2E_RECOVERY_TIMEOUT_MS",
  runRealStackBrowser ? 360_000 : scenarioTimeoutMs,
);
const controlledProviderDelayMs = runRealStackBrowser ? 3_000 : 250;
const controlledProviderHeartbeatMs = 2_000;
const runtimeProcessConvergenceTimeoutMs = positiveInteger(
  "WORKBENCH_E2E_RUNTIME_PROCESS_CONVERGENCE_TIMEOUT_MS",
  120_000,
);
const runtimeExecuteQueueName = "runtime.execute";
const runtimeCancelQueueName = "runtime.cancel";
const runtimeTerminalJobStates = new Set(["cancelled", "completed", "failed"]);
const generationVisualViewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const pendingDocumentEvidenceLatencyMs = 10_000;
const browserCleanupTimeoutMs = 5_000;
const motionFrameSampleCount = 6;
const motionFrameSampleIntervalMs = 100;
const maximumMotionCaptureAttempts = 3;
const motionElementRemountTimeoutMs = 5_000;

const services = [];
let fakeRuntime;
let cleanupPromise;
let prdV2DocumentFixture;

class LogBuffer {
  constructor(name) {
    this.name = name;
    this.buffer = "";
  }

  append(stream, chunk) {
    const text = `[${stream}] ${chunk}`;
    this.buffer = boundedAppend(this.buffer, text);
    if (verbose) process[stream === "stderr" ? "stderr" : "stdout"].write(`[${this.name}] ${chunk}`);
  }

  value() {
    return this.buffer;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  console.log("[e2e] target database class: isolated-postgresql");
  await buildWorkspaces();
  const { prdDocumentV2Schema } = await import("@workbench/workbench-contracts");
  const { prdDocumentV2Example } = await import("@workbench/workbench-contracts/test-fixtures");
  prdV2DocumentFixture = prdDocumentV2Schema.parse(buildPrdV2DocumentFixture(prdDocumentV2Example));
  await rebuildSchemas();
  await migrateDatabase();

  fakeRuntime = await startFakeDeerFlow(fakeRuntimeToken);
  const apiPort = await reservePort();
  const webPort = runRealStackBrowser ? await reservePort() : null;
  const webOrigin = webPort === null ? "http://127.0.0.1:3000" : `http://127.0.0.1:${webPort}`;
  const previewPort = runRealStackBrowser ? await reservePort() : 4300;
  const previewHost = "127.0.0.1";
  const previewOrigin = `http://${previewHost}:${previewPort}`;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}/api/v1`;
  const commonEnvironment = {
    ...process.env,
    NODE_ENV: "test",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    WORKBENCH_DATABASE_URL: databaseUrl,
    WORKBENCH_S3_BUCKET: fakeStorageBucket,
    WORKBENCH_S3_REGION: "us-east-1",
    WORKBENCH_S3_INTERNAL_ENDPOINT: fakeRuntime.url,
    WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: "true",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: `${fakeRuntime.url}/${fakeStorageBucket}`,
    WORKBENCH_API_STAGING_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-api-staging`,
    WORKBENCH_API_STAGING_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-api-staging`,
    WORKBENCH_API_READY_BLOB_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-api-ready`,
    WORKBENCH_API_READY_BLOB_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-api-ready`,
    WORKBENCH_API_CANVAS_VISUAL_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-api-canvas-visual`,
    WORKBENCH_API_CANVAS_VISUAL_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-api-canvas-visual`,
    WORKBENCH_RUNTIME_READY_BLOB_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-runtime-ready`,
    WORKBENCH_RUNTIME_READY_BLOB_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-runtime-ready`,
    WORKBENCH_EXPORT_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-export`,
    WORKBENCH_EXPORT_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-export`,
    WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-preview`,
    WORKBENCH_PREVIEW_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-preview`,
  };

  const api = spawnService("workbench-api", process.execPath, ["apps/workbench-api/dist/main.js"], {
    ...commonEnvironment,
    WORKBENCH_API_HOST: "127.0.0.1",
    WORKBENCH_API_PORT: String(apiPort),
    WORKBENCH_WEB_ORIGIN: "http://127.0.0.1:3000",
    WORKBENCH_AUTH_MODE: "development",
    WORKBENCH_INVITATION_TOKEN_SECRET: invitationTokenSecret,
    WORKBENCH_INVITATION_TTL_HOURS: "168",
    WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
    WORKBENCH_PREVIEW_TOKEN_SECRET: previewTokenSecret,
    WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS: "60",
    WORKBENCH_CANVAS_TOOL_SECRET: canvasToolSecret,
    WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS: "300",
    WORKBENCH_CANVAS_COMMAND_TTL_SECONDS: "60",
    WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS: "30",
    DEERFLOW_LANGGRAPH_URL: fakeRuntime.url,
    DEERFLOW_GATEWAY_URL: fakeRuntime.url,
    DEERFLOW_INTERNAL_AUTH_TOKEN: fakeRuntimeToken,
  });
  await waitForHttp(`${apiBaseUrl}/system/ready`, api, scenarioTimeoutMs);

  const workerEnvironment = {
    ...commonEnvironment,
    WORKBENCH_RUNTIME_CONCURRENCY: runRuntimeProcessConvergence ? "1" : "2",
    WORKBENCH_CANVAS_TOOL_URL: `${apiBaseUrl}/runtime/canvas/tools/execute`,
    WORKBENCH_CANVAS_VISUAL_URL: `${apiBaseUrl}/runtime/canvas/visuals`,
    WORKBENCH_CANVAS_TOOL_SECRET: canvasToolSecret,
    WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS: "300",
    DEERFLOW_LANGGRAPH_URL: fakeRuntime.url,
    DEERFLOW_GATEWAY_URL: fakeRuntime.url,
    DEERFLOW_ASSISTANT_ID: "workbench-e2e-agent",
    DEERFLOW_INTERNAL_AUTH_TOKEN: fakeRuntimeToken,
    DEERFLOW_STREAM_MODE: "messages,values",
    DEERFLOW_TIMEOUT_MS: "30000",
    DEERFLOW_IDLE_TIMEOUT_MS: runRealStackBrowser ? "15000" : "5000",
    ...(runRuntimeProcessConvergence ? {
      WORKBENCH_RUNTIME_EXECUTION_LEASE_MS: "10000",
      WORKBENCH_RUNTIME_EXECUTION_HEARTBEAT_MS: "1000",
      WORKBENCH_RUNTIME_EXECUTION_RECONCILE_INTERVAL_MS: "1000",
      WORKBENCH_RUNTIME_CANCEL_RECONCILE_INTERVAL_MS: "1000",
      WORKBENCH_RUNTIME_CANCEL_RECONCILE_STALE_MS: "1000",
      WORKBENCH_RUNTIME_CANCELLATION_POLL_INTERVAL_MS: "250",
      DEERFLOW_SUBMISSION_TIMEOUT_MS: "15000",
    } : {}),
  };
  const spawnRuntimeWorker = (name) => spawnService(
    name,
    process.execPath,
    ["apps/workbench-worker/dist/main.js"],
    workerEnvironment,
  );
  const worker = spawnRuntimeWorker("workbench-worker");
  await waitForProcessStart(worker, 750);

  if (runRealStackBrowser) {
    const exportWorker = spawnService("workbench-export-worker", process.execPath, ["apps/workbench-export-worker/dist/main.js"], {
      ...commonEnvironment,
      WORKBENCH_EXPORT_CHROMIUM_PATH: chromium.executablePath(),
      WORKBENCH_EXPORT_CONCURRENCY: "1",
      WORKBENCH_EXPORT_BROWSER_TIMEOUT_MS: "30000",
      WORKBENCH_EXPORT_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-export`,
      WORKBENCH_EXPORT_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-export`,
    });
    await waitForProcessStart(exportWorker, 1_000);

    const preview = spawnService("workbench-preview-real-stack", process.execPath, ["apps/workbench-preview/dist/main.js"], {
      ...commonEnvironment,
      WORKBENCH_PREVIEW_HOST: "127.0.0.1",
      WORKBENCH_PREVIEW_PORT: String(previewPort),
      WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
      WORKBENCH_WEB_ORIGIN: webOrigin,
      WORKBENCH_PREVIEW_TOKEN_SECRET: previewTokenSecret,
      WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS: "60",
      WORKBENCH_PREVIEW_S3_ACCESS_KEY_ID: `${fakeStorageAccessKeyId}-preview`,
      WORKBENCH_PREVIEW_S3_SECRET_ACCESS_KEY: `${fakeStorageSecretAccessKey}-preview`,
    });
    await waitForHttp(`${previewOrigin}/healthz`, preview, scenarioTimeoutMs);
  }

  if (runRuntimeProcessConvergence) {
    const client = createApiClient(apiBaseUrl);
    await runRuntimeProcessConvergenceScenario({
      client,
      initialWorker: worker,
      spawnRuntimeWorker,
    });
  } else if (runRealStackBrowser) {
    await runRealStackBrowserScenario({
      commonEnvironment,
      fakeRuntimeUrl: fakeRuntime.url,
      previewOrigin,
      recoveryScenarioTimeoutMs,
      webOrigin,
      webPort,
    });
  }

  if (runRuntimeProcessConvergence) {
    console.log(JSON.stringify({
      ok: true,
      evidenceLevel: "process-level-real-stack",
      databaseClass: "isolated-postgresql",
      provider: controlledProvider,
      candidateSha: candidateSourceCommit,
    }));
  } else if (realStackBrowserOnly) {
    console.log(JSON.stringify({
      ok: true,
      evidenceLevel: "real-stack",
      databaseClass: "isolated-postgresql",
      provider: controlledProvider,
      candidate: {
        sourceCommit: candidateSourceCommit,
        sourceTreeAtStart: candidateSourceSnapshot.clean ? "clean" : "dirty",
        candidateBound: candidateSourceSnapshot.clean,
      },
      legacyHttpScenarios: "not-run",
    }));
  } else {
  const client = createApiClient(apiBaseUrl);
  const outsiderClient = createApiClient(apiBaseUrl, {
    subject: "workbench-e2e-outsider",
    email: "workbench-e2e-outsider@test.local",
    name: "Workbench E2E Outsider",
  });
  const inviteeClient = createApiClient(apiBaseUrl, {
    subject: "workbench-e2e-invitee",
    email: "workbench-e2e-invitee@test.local",
    name: "Workbench E2E Invitee",
  });
  await runProjectLifecycleScenario(
    client,
    outsiderClient,
    inviteeClient,
  );
  await runSseRevocationScenario(client, outsiderClient);
  const success = await runSuccessScenario(client, outsiderClient);
  await runPrototypePatchScenario(client);
  await runCanvasGatewayScenario(client);
  await runSourceTargetGeneratePrototypeScenario(client);
  const approvals = await runApprovalScenario(client);
  const cancellation = await runCancellationScenario(client);
  await runRetryScenario(client);

  assert.ok(fakeRuntime.state.threadCreates >= 4, "fake DeerFlow did not receive thread creation calls");
  assert.ok(fakeRuntime.state.successRuns >= 1, "fake DeerFlow did not receive the success Run");
  assert.equal(
    fakeRuntime.state.prototypePatchRuns,
    1,
    "fake DeerFlow did not receive the Prototype patch Run",
  );
  assert.equal(
    fakeRuntime.state.sourcePrototypeRuns,
    1,
    "fake DeerFlow did not receive the source Prototype seed Run",
  );
  assert.equal(
    fakeRuntime.state.generatePrototypeRuns,
    1,
    "fake DeerFlow did not receive the targeted Generate Prototype Run",
  );
  assert.ok(fakeRuntime.state.approvalRuns >= 1, "fake DeerFlow did not emit approval interrupts");
  assert.ok(fakeRuntime.state.approvalResumes >= 1, "fake DeerFlow did not receive approval resume decisions");
  assert.ok(fakeRuntime.state.cancelRuns >= 1, "fake DeerFlow did not receive the cancellation Run");
  assert.equal(fakeRuntime.state.canvasSeedRuns, 1, "fake DeerFlow did not receive the Canvas seed Run");
  assert.equal(fakeRuntime.state.canvasQuickEditRuns, 1, "fake DeerFlow did not receive the Canvas quick-edit Run");
  assert.equal(fakeRuntime.state.canvasDirectEditRuns, 1, "fake DeerFlow did not receive the Canvas direct-edit Run");
  assert.deepEqual(
    [...new Set(fakeRuntime.state.canvasToolCalls.map((call) => call.toolName))],
    [
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "navigate_canvas",
      "quick_edit",
      "rename_screen",
      "duplicate_screen",
    ],
    "fake DeerFlow did not execute the complete Canvas tool surface",
  );
  assert.ok(
    fakeRuntime.state.runRequests.every(
      (request) => request.body?.config?.configurable?.model_name === runtimeCatalogModelId,
    ),
    "Worker did not send the stable runtime catalog model id to DeerFlow",
  );
  const expectedContentTransfers = success.runtimeContentCount
    + approvals.runtimeContentCount
    + cancellation.runtimeContentCount;
  assert.equal(
    fakeRuntime.state.objectReads.length,
    expectedContentTransfers,
    "Worker did not read every immutable source object exactly once",
  );
  assert.equal(
    fakeRuntime.state.gatewayUploads.length,
    expectedContentTransfers,
    "Worker did not upload every immutable source object exactly once",
  );
  assert.ok(
    fakeRuntime.state.gatewayUploads.every((upload) => upload.matchedStorageKeys.length === 1),
    "a fake Gateway multipart body did not contain exactly one registered immutable object",
  );
  assert.equal(fakeRuntime.state.storageWrites.length, 1, "Canvas visual was not written exactly once");
  assert.equal(fakeRuntime.state.visualReads.length, 1, "Canvas visual was not read exactly once");
  const [visualWrite] = fakeRuntime.state.storageWrites;
  const [visualRead] = fakeRuntime.state.visualReads;
  assert.match(visualWrite.storageKey, /^canvas-visuals\/[A-Za-z0-9][A-Za-z0-9._:-]*\/.+\.webp$/);
  assert.equal(visualWrite.mediaType, "image/webp");
  assert.equal(visualRead.storageKey, visualWrite.storageKey);
  assert.equal(visualRead.sha256, visualWrite.sha256);
  const serializedRuntimeRequests = JSON.stringify(fakeRuntime.state.runRequests);
  assert.ok(
    !serializedRuntimeRequests.includes(runtimeProviderModel),
    "provider model name leaked into the Workbench runtime request contract",
  );
  for (const receipt of fakeRuntime.state.gatewayReceipts) {
    assert.ok(!serializedRuntimeRequests.includes(receipt), "private Gateway receipt reached DeerFlow runtime context");
  }

  console.log(JSON.stringify(httpDiagnosticSuccessEvidence({
    candidateSha: candidateSourceCommit,
    controlledProvider,
    fakeRuntimeState: fakeRuntime.state,
    sourceClean: candidateSourceSnapshot.clean,
  }), null, 2));
  }
} catch (error) {
  console.error("[e2e] FAILED", error instanceof Error ? error.stack ?? error.message : error);
  dumpLogs();
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function buildWorkspaces() {
  console.log("[e2e] validating and building Workbench packages");
  await runCommand(
    "workbench:prepare",
    npm,
    ["run", "workbench:prepare"],
    { WORKBENCH_DATABASE_URL: databaseUrl },
  );
  await runCommand("api:build", npm, [
    "--workspace", "@workbench/workbench-api", "run", "build",
  ]);
  await runCommand("worker:build", npm, [
    "--workspace", "@workbench/workbench-worker", "run", "build",
  ]);
  await runCommand("export-worker:build", npm, [
    "--workspace", "@workbench/workbench-export-worker", "run", "build",
  ]);
  await runCommand("preview:build", npm, [
    "--workspace", "@workbench/workbench-preview", "run", "build",
  ]);
}

async function rebuildSchemas() {
  const client = new Client({
    connectionString: pgConnectionUrl(databaseUrl),
    application_name: "workbench-e2e-reset",
  });
  await client.connect();
  try {
    const result = await client.query("SELECT current_database() AS name");
    const actualName = result.rows[0]?.name;
    if (typeof actualName !== "string" || !isTestDatabaseName(actualName)) {
      throw new Error(`Refusing to reset non-test database reported by PostgreSQL: ${String(actualName)}`);
    }
    if (actualName !== databaseName) {
      throw new Error(`Database URL resolved to ${actualName}, expected ${databaseName}`);
    }

    console.log("[e2e] rebuilding workbench and workbench_jobs schemas");
    await client.query('DROP SCHEMA IF EXISTS "workbench_jobs" CASCADE');
    await client.query('DROP SCHEMA IF EXISTS "workbench" CASCADE');
    await client.query('CREATE SCHEMA "workbench"');
  } finally {
    await client.end();
  }
}

async function queryDatabase(text, values = []) {
  const client = new Client({
    connectionString: pgConnectionUrl(databaseUrl),
    application_name: "workbench-e2e-assertions",
  });
  await client.connect();
  try {
    await client.query('SET search_path TO "workbench", public');
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

async function migrateDatabase() {
  console.log("[e2e] applying Workbench migrations and reconciling Runtime queues");
  await runCommand("database:migrate", "sh", ["deploy/workbench-migrate.sh"], {
    WORKBENCH_DATABASE_URL: databaseUrl,
    WORKBENCH_MIGRATOR_DATABASE_URL: databaseUrl,
  });
}

function existingSubmissionAttachments(fileAssetIds) {
  return fileAssetIds.map((fileAssetId) => ({ kind: "existing", fileAssetId }));
}

function createSubmissionIntent(
  client,
  { threadId, request, attachments = [], idempotencyKey, expectedStatus = 201 },
) {
  return client.json("POST", `/threads/${threadId}/submission-intents`, {
    body: { request, attachments },
    headers: { "Idempotency-Key": idempotencyKey },
    expectedStatus,
  });
}

function submitSubmissionIntent(client, intentId, expectedStatus = 202) {
  return client.json("POST", `/submission-intents/${intentId}/submit`, { expectedStatus });
}

async function cancelPendingSubmissionIntent(client, intentId) {
  const current = await client.json("GET", `/submission-intents/${intentId}`);
  assert.equal(current.body.status, "pending");
  const etag = current.headers.get("etag");
  assert.match(etag ?? "", /^"\d+"$/);
  await client.json("DELETE", `/submission-intents/${intentId}`, {
    headers: { "If-Match": etag },
    expectedStatus: 204,
  });
}

async function startRunThroughSubmissionIntent(
  client,
  { threadId, request, attachments = [], idempotencyKey },
) {
  const created = await createSubmissionIntent(client, {
    threadId,
    request,
    attachments,
    idempotencyKey,
  });
  assert.deepEqual(
    created.body.attachments.map((attachment) => ({
      kind: attachment.kind,
      fileAssetId: attachment.fileAssetId,
    })),
    attachments,
  );
  const submitted = await submitSubmissionIntent(client, created.body.id);
  assert.equal(submitted.body.intent.id, created.body.id);
  assert.equal(submitted.body.intent.status, "submitted");
  assert.equal(submitted.body.intent.runId, submitted.body.run.id);
  return { body: submitted.body.run, intent: submitted.body.intent };
}

async function runRuntimeProcessConvergenceScenario({
  client,
  initialWorker,
  spawnRuntimeWorker,
}) {
  console.log("[e2e] running process-level Runtime convergence scenarios");
  assert.equal(candidateSourceSnapshot.clean, true, "runtime process evidence requires a clean source tree");
  assert.equal(candidateSourceCommit, currentSourceCommit(), "runtime process evidence candidate differs from HEAD");
  const startedAt = new Date().toISOString();

  const sigkill = await runSigkillTakeoverScenario({
    client,
    worker: initialWorker,
    spawnRuntimeWorker,
  });
  const sigterm = await runSigtermCancellationScenario({
    client,
    worker: sigkill.replacementWorker,
    spawnRuntimeWorker,
  });

  const finishedSourceSnapshot = resolveCandidateSourceSnapshot();
  assert.equal(finishedSourceSnapshot.clean, true, "runtime process evidence source tree became dirty");
  assert.equal(
    finishedSourceSnapshot.digest,
    candidateSourceSnapshot.digest,
    "runtime process evidence source tree drifted during execution",
  );
  const evidence = {
    protocol: "workbench.runtime-process-convergence-evidence.v1",
    candidate: {
      sourceCommit: candidateSourceCommit,
      cleanAtStart: candidateSourceSnapshot.clean,
      cleanAtFinish: finishedSourceSnapshot.clean,
      sourceDrift: false,
    },
    environment: {
      databaseClass: "isolated-postgresql",
      provider: controlledProvider,
      workerBoundary: "node-child-process",
      queue: "pg-boss",
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    faultClock: {
      queueDeadlineCompressed: true,
      executionLeaseCompressed: true,
      applicationBudgetsUnchanged: true,
    },
    scenarios: {
      sigkillTakeover: sigkill.evidence,
      sigtermCancellation: sigterm.evidence,
    },
    stagingOnly: [
      "uncompressed pg-boss heartbeat and execution-lease wall clock",
      "orchestrator-level container SIGKILL and replacement",
      "immutable deployed image digest and deployment identity binding",
    ],
  };
  assertRuntimeProcessEvidenceRedacted(evidence, [
    ...sigkill.sensitiveValues,
    ...sigterm.sensitiveValues,
  ]);
  const evidenceDir = path.join(root, "output/runtime-process-convergence");
  const evidencePath = path.join(evidenceDir, "evidence.json");
  await mkdir(evidenceDir, { recursive: true });
  const manifestSha256 = await writeEvidenceManifest(evidencePath, evidence);
  await writeFile(
    path.join(evidenceDir, "evidence.json.sha256"),
    `${manifestSha256}  evidence.json\n`,
  );
  console.log(`[e2e] runtime process evidence: ${path.relative(root, evidencePath)} sha256=${manifestSha256}`);
}

async function runSigkillTakeoverScenario({ client, worker, spawnRuntimeWorker }) {
  const runId = await createRuntimeProcessFaultRun(
    client,
    "E2E_PROCESS_SIGKILL_RECOVERY",
    "Runtime SIGKILL takeover",
  );
  const initial = await waitForRuntimeProcessClaim(runId, "process-sigkill-recovery");
  const initialJobs = await runtimeQueueJobs(runId);
  const activeJob = initialJobs.find((job) => (
    job.name === runtimeExecuteQueueName && job.state === "active"
  ));
  assert.ok(activeJob, "SIGKILL scenario did not claim the runtime.execute job");
  assert.equal(activeJob.retryLimit, 5, "SIGKILL scenario did not start with the production retry limit");

  assert.equal(worker.child.kill("SIGKILL"), true, "failed to deliver SIGKILL to Runtime Worker");
  const killed = await waitForServiceExit(worker, runtimeProcessConvergenceTimeoutMs);
  assert.equal(killed.signal, "SIGKILL", "Runtime Worker did not terminate from SIGKILL");
  await waitFor(
    () => fakeRuntime.state.processFaults.get(runId)?.initialStreamClosed === true,
    runtimeProcessConvergenceTimeoutMs,
    "controlled provider did not observe the SIGKILL disconnect",
  );

  await expireRuntimeExecutionAfterCrash(runId, activeJob.id);
  const replacementWorker = spawnRuntimeWorker("workbench-worker-after-sigkill");
  await waitForProcessStart(replacementWorker, 750);
  await waitFor(
    () => fakeRuntime.state.processFaults.get(runId)?.rejoinActive === true,
    runtimeProcessConvergenceTimeoutMs,
    "replacement Worker did not rejoin the accepted provider Run",
  );
  const takeover = await waitForRuntimeProcessClaim(runId, "process-sigkill-recovery", initial.ownerId);
  assert.ok(takeover.epoch > initial.epoch, "replacement Worker did not advance the execution epoch");
  assert.notEqual(takeover.ownerId, initial.ownerId, "replacement Worker reused the stale execution owner");
  await assertStaleRuntimeClaimFenced({
    runId,
    attemptId: initial.attemptId,
    ownerId: initial.ownerId,
    epoch: initial.epoch,
  });

  fakeRuntime.releaseProcessRecovery(runId);
  await waitForRuntimeRunStatus(client, runId, "succeeded");
  const terminal = await assertRuntimeProcessTerminalState(runId, "succeeded", {
    requiredQueues: [runtimeExecuteQueueName],
  });
  const fault = fakeRuntime.state.processFaults.get(runId);
  assert.equal(fault?.submissionCount, 1, "SIGKILL recovery duplicated provider submission");
  assert.equal(fault?.rejoinCount, 1, "SIGKILL recovery did not use one provider rejoin");
  assert.equal(fault?.rejoinFinished, true, "SIGKILL recovery provider stream did not finish");
  assert.equal(fault?.cancelCount, 0, "SIGKILL recovery unexpectedly cancelled the provider Run");

  return {
    replacementWorker,
    evidence: {
      deliveredSignal: "SIGKILL",
      observedExitSignal: killed.signal,
      runIdSha256: sha256(runId),
      runtimeAttemptIdSha256: sha256(initial.attemptId),
      externalRunIdSha256: sha256(initial.externalRunId),
      initialEpoch: initial.epoch,
      takeoverEpoch: takeover.epoch,
      ownerChanged: true,
      staleOwnerFenced: true,
      providerSubmissions: fault.submissionCount,
      providerRejoins: fault.rejoinCount,
      providerCancels: fault.cancelCount,
      finalRunStatus: terminal.runStatus,
      finalAttemptStatus: terminal.attemptStatus,
      terminalEvents: terminal.terminalEvents,
      jobs: terminal.jobs,
    },
    sensitiveValues: [
      runId,
      initial.attemptId,
      initial.externalRunId,
      initial.ownerId,
      takeover.ownerId,
      ...terminal.rawJobIds,
    ],
  };
}

async function runSigtermCancellationScenario({ client, worker, spawnRuntimeWorker }) {
  const runId = await createRuntimeProcessFaultRun(
    client,
    "E2E_PROCESS_SIGTERM_CANCEL",
    "Runtime SIGTERM cancellation",
  );
  const initial = await waitForRuntimeProcessClaim(runId, "process-sigterm-cancel");
  assert.ok(
    (await runtimeQueueJobs(runId)).some((job) => (
      job.name === runtimeExecuteQueueName && job.state === "active"
    )),
    "SIGTERM scenario did not claim the runtime.execute job",
  );

  assert.equal(worker.child.kill("SIGTERM"), true, "failed to deliver SIGTERM to Runtime Worker");
  await waitFor(
    () => worker.log.value().includes("[worker] received SIGTERM"),
    runtimeProcessConvergenceTimeoutMs,
    "Runtime Worker did not enter its SIGTERM shutdown path",
  );
  fakeRuntime.disconnectProcessFault(runId);
  const terminated = await waitForServiceExit(worker, runtimeProcessConvergenceTimeoutMs);
  assert.equal(terminated.code, 0, "Runtime Worker did not complete graceful SIGTERM shutdown");
  assert.equal(terminated.signal, null, "Runtime Worker was force-killed during SIGTERM shutdown");

  const cancel = await client.json("POST", `/runs/${runId}/cancel`, {
    headers: { "Idempotency-Key": `e2e-process-cancel-${randomUUID()}` },
    expectedStatus: 202,
  });
  assert.ok(["cancelling", "cancelled"].includes(cancel.body.status));
  await exhaustRuntimeCancelJob(runId);
  const replacementWorker = spawnRuntimeWorker("workbench-worker-after-sigterm");
  await waitForProcessStart(replacementWorker, 750);

  await waitForRuntimeRunStatus(client, runId, "cancelled");
  const terminal = await assertRuntimeProcessTerminalState(runId, "cancelled", {
    requiredQueues: [runtimeExecuteQueueName, runtimeCancelQueueName],
  });
  const fault = fakeRuntime.state.processFaults.get(runId);
  assert.equal(fault?.submissionCount, 1, "SIGTERM cancellation duplicated provider submission");
  assert.equal(fault?.cancelCount, 1, "cancellation reconciler did not cancel the provider Run exactly once");
  assert.ok(
    terminal.jobs.filter((job) => job.name === runtimeCancelQueueName).length >= 2,
    "cancellation reconciler did not replace the exhausted cancel job",
  );

  return {
    replacementWorker,
    evidence: {
      deliveredSignal: "SIGTERM",
      gracefulExitCode: terminated.code,
      runIdSha256: sha256(runId),
      runtimeAttemptIdSha256: sha256(initial.attemptId),
      externalRunIdSha256: sha256(initial.externalRunId),
      providerSubmissions: fault.submissionCount,
      providerRejoins: fault.rejoinCount,
      providerCancels: fault.cancelCount,
      cancellationJobReconciled: true,
      finalRunStatus: terminal.runStatus,
      finalAttemptStatus: terminal.attemptStatus,
      terminalEvents: terminal.terminalEvents,
      jobs: terminal.jobs,
    },
    sensitiveValues: [
      runId,
      initial.attemptId,
      initial.externalRunId,
      initial.ownerId,
      ...terminal.rawJobIds,
    ],
  };
}

async function createRuntimeProcessFaultRun(client, marker, title) {
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json("POST", `/workspaces/${identity.body.defaultWorkspaceId}/projects`, {
    body: { title },
    expectedStatus: 201,
  });
  const bootstrap = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = bootstrap.body.threads[0]?.id;
  assert.equal(typeof threadId, "string", "Runtime process fixture did not create a thread");
  const run = await startRunThroughSubmissionIntent(client, {
    threadId,
    request: {
      prompt: `${marker}: controlled synthetic process-lifecycle fixture`,
      modelId: runtimeCatalogModelId,
      workflow: "generate",
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      requestedArtifactKinds: ["prd"],
    },
    idempotencyKey: `e2e-process-${randomUUID()}`,
  });
  return run.body.id;
}

async function waitForRuntimeProcessClaim(runId, expectedKind, previousOwnerId = null) {
  let observed = null;
  await waitFor(async () => {
    const fault = fakeRuntime.state.processFaults.get(runId);
    if (!fault || fault.kind !== expectedKind) return false;
    const current = await runtimeProcessState(runId);
    if (
      current.runStatus !== "running"
      || current.attemptStatus !== "running"
      || !current.ownerId
      || !current.attemptOwnerId
      || !current.attemptId
      || !current.externalRunId
      || current.ownerId !== current.attemptOwnerId
      || (previousOwnerId !== null && current.ownerId === previousOwnerId)
    ) return false;
    observed = current;
    return true;
  }, runtimeProcessConvergenceTimeoutMs, `Runtime process claim was not established for ${expectedKind}`);
  return observed;
}

async function runtimeProcessState(runId) {
  const result = await queryDatabase(`
    SELECT
      run.status::text AS "runStatus",
      run.execution_owner_id AS "ownerId",
      run.execution_epoch AS epoch,
      run.execution_lease_expires_at AS "leaseExpiresAt",
      attempt.id AS "attemptId",
      attempt.status::text AS "attemptStatus",
      attempt.execution_owner_id AS "attemptOwnerId",
      attempt.execution_epoch AS "attemptEpoch",
      attempt.execution_lease_expires_at AS "attemptLeaseExpiresAt",
      attempt.external_run_id AS "externalRunId"
    FROM workbench.runs AS run
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM workbench.runtime_attempts AS candidate
      WHERE candidate.run_id = run.id
      ORDER BY candidate.attempt DESC
      LIMIT 1
    ) AS attempt ON TRUE
    WHERE run.id = $1
  `, [runId]);
  const row = result.rows[0];
  assert.ok(row, "Runtime process fixture Run disappeared");
  return row;
}

async function expireRuntimeExecutionAfterCrash(runId, activeJobId) {
  const result = await queryDatabase(`
    WITH expired_run AS (
      UPDATE workbench.runs
      SET execution_heartbeat_at = clock_timestamp() - interval '2 seconds',
          execution_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1 AND status = 'running'
      RETURNING id
    ), expired_attempt AS (
      UPDATE workbench.runtime_attempts
      SET execution_heartbeat_at = clock_timestamp() - interval '2 seconds',
          execution_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE run_id = $1 AND status = 'running'
      RETURNING id
    ), exhausted_job AS (
      UPDATE workbench_jobs.job_common
      SET retry_limit = retry_count,
          heartbeat_on = clock_timestamp() - interval '5 minutes'
      WHERE id = $2::uuid
        AND name = $3
        AND singleton_key = $1
        AND state = 'active'
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM expired_run) AS runs,
      (SELECT count(*)::int FROM expired_attempt) AS attempts,
      (SELECT count(*)::int FROM exhausted_job) AS jobs
  `, [runId, activeJobId, runtimeExecuteQueueName]);
  assert.deepEqual(result.rows[0], { runs: 1, attempts: 1, jobs: 1 });
  await forceQueueSupervision(runtimeExecuteQueueName);
  await waitFor(async () => (
    (await runtimeQueueJobs(runId)).some((job) => (
      job.id === activeJobId && job.name === runtimeExecuteQueueName && job.state === "failed"
    ))
  ), runtimeProcessConvergenceTimeoutMs, "pg-boss did not terminalize the crashed execution job");
}

async function exhaustRuntimeCancelJob(runId) {
  const boss = runtimeControlBoss("runtime-process-cancel-fault");
  try {
    await boss.start();
    const fetched = await boss.fetch(runtimeCancelQueueName, {
      batchSize: 1,
      includeMetadata: true,
    });
    assert.equal(fetched.length, 1, "controlled cancel consumer did not claim one job");
    assert.equal(fetched[0]?.data?.runId, runId, "controlled cancel consumer claimed another Run");
    const result = await queryDatabase(`
      WITH exhausted_job AS (
        UPDATE workbench_jobs.job_common
        SET retry_limit = retry_count,
            started_on = clock_timestamp() - interval '5 minutes'
        WHERE id = $2::uuid
          AND name = $3
          AND singleton_key = $1
          AND state = 'active'
        RETURNING id
      ), aged_run AS (
        UPDATE workbench.runs
        SET updated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '5 seconds'
        WHERE id = $1 AND status = 'cancelling'
        RETURNING id
      )
      SELECT
        (SELECT count(*)::int FROM exhausted_job) AS jobs,
        (SELECT count(*)::int FROM aged_run) AS runs
    `, [runId, fetched[0].id, runtimeCancelQueueName]);
    assert.deepEqual(result.rows[0], { jobs: 1, runs: 1 });
    await makeQueueSupervisionDue(runtimeCancelQueueName);
    await boss.supervise(runtimeCancelQueueName);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  await waitFor(async () => (
    (await runtimeQueueJobs(runId)).some((job) => (
      job.name === runtimeCancelQueueName && job.state === "failed"
    ))
  ), runtimeProcessConvergenceTimeoutMs, "pg-boss did not terminalize the faulted cancel job");
}

async function forceQueueSupervision(queueName) {
  const boss = runtimeControlBoss("runtime-process-execution-supervisor");
  try {
    await boss.start();
    await makeQueueSupervisionDue(queueName);
    await boss.supervise(queueName);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
}

function runtimeControlBoss(applicationName) {
  const boss = new PgBoss({
    connectionString: pgConnectionUrl(databaseUrl),
    schema: "workbench_jobs",
    application_name: applicationName,
    schedule: false,
    supervise: false,
    migrate: false,
    createSchema: false,
    useListenNotify: false,
  });
  boss.on("error", (error) => console.error("[runtime-process-pg-boss]", diagnosticErrorClass(error)));
  return boss;
}

async function makeQueueSupervisionDue(queueName) {
  const result = await queryDatabase(`
    UPDATE workbench_jobs.queue
    SET monitor_on = clock_timestamp() - interval '5 minutes'
    WHERE name = $1
    RETURNING name
  `, [queueName]);
  assert.equal(result.rowCount, 1, `Runtime queue ${queueName} is missing`);
}

async function assertStaleRuntimeClaimFenced(claim) {
  const { PrismaClient } = await import("@workbench/workbench-db");
  const { RuntimeAttemptService } = await import(
    "../apps/workbench-worker/dist/runtime/runtime-attempt.service.js"
  );
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let observedError = null;
  try {
    await new RuntimeAttemptService(db, 10_000).heartbeat(claim);
  } catch (error) {
    observedError = error;
  } finally {
    await db.$disconnect();
  }
  assert.equal(observedError?.message, "RUNTIME_EXECUTION_FENCED", "stale Runtime owner was not fenced");
}

async function waitForRuntimeRunStatus(client, runId, expectedStatus) {
  await waitFor(async () => {
    const current = await client.json("GET", `/runs/${runId}`);
    return current.body.status === expectedStatus;
  }, runtimeProcessConvergenceTimeoutMs, `Runtime Run did not converge to ${expectedStatus}`);
}

async function assertRuntimeProcessTerminalState(runId, expectedStatus, { requiredQueues }) {
  await waitFor(async () => {
    const jobs = await runtimeQueueJobs(runId);
    return requiredQueues.every((name) => jobs.some((job) => job.name === name))
      && jobs.every((job) => runtimeTerminalJobStates.has(job.state));
  }, runtimeProcessConvergenceTimeoutMs, "Runtime queue jobs did not reach terminal states");
  const state = await runtimeProcessState(runId);
  assert.equal(state.runStatus, expectedStatus);
  assert.equal(state.attemptStatus, expectedStatus);
  assert.equal(state.ownerId, null, "terminal Run retained an execution owner");
  assert.equal(state.attemptOwnerId, null, "terminal Runtime attempt retained an execution owner");
  assert.equal(state.leaseExpiresAt, null, "terminal Run retained an execution lease");
  assert.equal(state.attemptLeaseExpiresAt, null, "terminal Runtime attempt retained an execution lease");
  const terminalResult = await queryDatabase(`
    SELECT
      count(*) FILTER (WHERE type = 'run.completed')::int AS completed,
      count(*) FILTER (WHERE type = 'run.failed')::int AS failed,
      count(*) FILTER (WHERE type = 'run.cancelled')::int AS cancelled
    FROM workbench.run_events
    WHERE run_id = $1
  `, [runId]);
  const terminalEvents = terminalResult.rows[0];
  assert.deepEqual(
    terminalEvents,
    expectedStatus === "succeeded"
      ? { completed: 1, failed: 0, cancelled: 0 }
      : { completed: 0, failed: 0, cancelled: 1 },
  );
  const rawJobs = await runtimeQueueJobs(runId);
  return {
    runStatus: state.runStatus,
    attemptStatus: state.attemptStatus,
    terminalEvents,
    jobs: rawJobs.map((job) => ({
      jobIdSha256: sha256(job.id),
      name: job.name,
      state: job.state,
      retryCount: job.retryCount,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    })),
    rawJobIds: rawJobs.map((job) => job.id),
  };
}

async function runtimeQueueJobs(runId) {
  const result = await queryDatabase(`
    SELECT
      id::text AS id,
      name,
      state::text AS state,
      retry_count AS "retryCount",
      retry_limit AS "retryLimit",
      created_on AS "createdAt",
      started_on AS "startedAt",
      completed_on AS "completedAt"
    FROM workbench_jobs.job_common
    WHERE singleton_key = $1
      AND name = ANY($2::text[])
    ORDER BY created_on ASC, id ASC
  `, [runId, [runtimeExecuteQueueName, runtimeCancelQueueName]]);
  return result.rows;
}

async function waitForServiceExit(service, timeoutMs) {
  return Promise.race([
    service.exited,
    delay(timeoutMs).then(() => {
      throw new Error(`${service.name} did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

function assertRuntimeProcessEvidenceRedacted(evidence, sensitiveValues) {
  const serialized = JSON.stringify(evidence);
  for (const sensitive of sensitiveValues) {
    assert.equal(
      typeof sensitive === "string" && sensitive.length > 0 && serialized.includes(sensitive),
      false,
      "runtime process evidence contains an unredacted identifier",
    );
  }
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//iu);
  assert.doesNotMatch(serialized, /(?:password|secret|capability|authorization|user prompt)/iu);
}

async function runSuccessScenario(client, outsiderClient) {
  console.log("[e2e] running success, idempotency, and SSE replay scenario");
  const identity = await client.json("GET", "/identity/me");
  assert.equal(typeof identity.body.id, "string");
  assert.equal(typeof identity.body.defaultWorkspaceId, "string");
  const runtimeModels = await client.json("GET", "/runtime/models");
  assert.deepEqual(runtimeModels.body.items.map((model) => model.id), [runtimeCatalogModelId]);
  assert.ok(
    !JSON.stringify(runtimeModels.body).includes(runtimeProviderModel),
    "provider model name leaked through the public runtime model catalog",
  );
  const designPresets = await client.json("GET", "/design-presets");
  assert.deepEqual(
    designPresets.body.items.map((item) => item.presetId),
    ["workbench.alexandria", "workbench.bauhaus", "workbench.glacier", "workbench.carbon"],
  );
  const selectedPreset = designPresets.body.items[0];
  assert.equal(selectedPreset.version, 1);
  assert.match(selectedPreset.checksum, /^[0-9a-f]{64}$/);
  assert.equal(typeof selectedPreset.directives.composition, "string");
  assert.equal(typeof selectedPreset.tokens.colors.accent, "string");

  const project = await client.json("POST", `/workspaces/${identity.body.defaultWorkspaceId}/projects`, {
    body: { title: "Workbench PostgreSQL E2E" },
    expectedStatus: 201,
  });
  const uploadIdempotencyKey = `e2e-upload-${randomUUID()}`;
  const uploadRequest = {
    fileName: "e2e-upload.pdf",
    declaredMediaType: "application/pdf",
    byteSize: 6 * 1024 * 1024,
    sha256: sha256(Buffer.from("e2e-upload-digest-proof")),
  };
  const upload = await client.json("POST", `/projects/${project.body.id}/file-upload-sessions`, {
    body: uploadRequest,
    headers: { "Idempotency-Key": uploadIdempotencyKey },
    expectedStatus: 201,
  });
  const uploadReplay = await client.json("POST", `/projects/${project.body.id}/file-upload-sessions`, {
    body: uploadRequest,
    headers: { "Idempotency-Key": uploadIdempotencyKey },
    expectedStatus: 201,
  });
  assert.equal(upload.body.upload.status, "initiated");
  assert.equal(uploadReplay.body.upload.id, upload.body.upload.id);
  assert.equal(uploadReplay.body.file.id, upload.body.file.id);
  const initial = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  assert.equal(initial.body.threads.length, 1);
  assert.equal(initial.body.artifacts.length, 0);
  assert.equal(initial.body.board.nodes.length, 0);
  const threadId = initial.body.threads[0].id;
  assert.equal(initial.body.selectedThreadId, threadId);
  assert.equal(initial.body.latestRun, null);

  const beforeMixedPersistence = await browserProjectPersistenceCounts(project.body.id);
  const beforeMixedQueueJobs = await runtimeExecuteQueueJobCount();
  const beforeMixedProviderRequests = fakeRuntime.state.runRequests.length;
  const mixedIdempotencyKey = `e2e-mixed-request-${randomUUID()}`;
  const mixedRequest = {
    prompt: "Create a PRD and a prototype",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    generationIntent: null,
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: ["prd", "prototype"],
    canvasSnapshot: null,
  };
  const mixedFirst = await createSubmissionIntent(client, {
    threadId,
    request: mixedRequest,
    idempotencyKey: mixedIdempotencyKey,
    expectedStatus: 400,
  });
  const mixedReplay = await createSubmissionIntent(client, {
    threadId,
    request: mixedRequest,
    idempotencyKey: mixedIdempotencyKey,
    expectedStatus: 400,
  });
  const { requestId: mixedFirstRequestId, ...mixedFirstProblem } = mixedFirst.body;
  const { requestId: mixedReplayRequestId, ...mixedReplayProblem } = mixedReplay.body;
  assert.match(mixedFirst.headers.get("content-type") ?? "", /^application\/problem\+json\b/u);
  assert.match(String(mixedFirstRequestId), /^[0-9a-f-]{36}$/u);
  assert.match(String(mixedReplayRequestId), /^[0-9a-f-]{36}$/u);
  assert.notEqual(mixedReplayRequestId, mixedFirstRequestId);
  assert.deepEqual(mixedReplayProblem, mixedFirstProblem);
  assert.equal(mixedFirst.body.status, 400);
  assert.equal(mixedFirst.body.code, "VALIDATION_ERROR");
  assert.deepEqual(mixedFirst.body.errors?.["request.requestedArtifactKinds"], [
    "PRD and Prototype/code must be requested in two sequential Runs: complete the PRD Run first",
  ]);
  assert.deepEqual(
    await browserProjectPersistenceCounts(project.body.id),
    beforeMixedPersistence,
    "mixed request changed Project persistence",
  );
  assert.equal(
    await runtimeExecuteQueueJobCount(),
    beforeMixedQueueJobs,
    "mixed request published a runtime.execute queue job",
  );
  assert.equal(
    fakeRuntime.state.runRequests.length,
    beforeMixedProviderRequests,
    "mixed request reached the controlled provider",
  );

  const sourceFixtures = await seedRunSourceFixtures({
    projectId: project.body.id,
    principalId: identity.body.id,
    label: "success",
  });

  const idempotencyKey = `e2e-success-${randomUUID()}`;
  const request = {
    prompt: "E2E_SUCCESS: generate one deterministic PRD artifact",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    targetSurface: "web",
    designStyle: {
      kind: "preset",
      presetId: selectedPreset.presetId,
      version: selectedPreset.version,
      checksum: selectedPreset.checksum,
    },
    requestedArtifactKinds: ["prd"],
  };
  const attachments = existingSubmissionAttachments(
    sourceFixtures.map((fixture) => fixture.fileAssetId),
  );
  const directRunPost = await client.json("POST", `/threads/${threadId}/runs`, {
    body: {
      ...request,
      sourceIds: [],
    },
    headers: { "Idempotency-Key": `e2e-direct-run-disabled-${randomUUID()}` },
    expectedStatus: 404,
  });
  assert.equal(directRunPost.body.status, 404);
  assert.equal(directRunPost.body.code, "HTTP_404");
  assert.match(directRunPost.body.detail, /Cannot POST .*\/threads\/.*\/runs/);

  for (const [label, designStyle, expectedCode] of [
    ["unknown", { ...request.designStyle, presetId: "workbench.unknown" }, "RUN_DESIGN_PRESET_UNKNOWN"],
    ["version", { ...request.designStyle, version: request.designStyle.version + 1 }, "RUN_DESIGN_PRESET_VERSION_MISMATCH"],
    ["checksum", { ...request.designStyle, checksum: "0".repeat(64) }, "RUN_DESIGN_PRESET_CHECKSUM_MISMATCH"],
  ]) {
    const rejectedIntent = await createSubmissionIntent(client, {
      threadId,
      request: { ...request, designStyle },
      attachments,
      idempotencyKey: `e2e-preset-${label}-${randomUUID()}`,
    });
    const rejected = await submitSubmissionIntent(client, rejectedIntent.body.id, 400);
    assert.equal(rejected.body.code, expectedCode);
    await cancelPendingSubmissionIntent(client, rejectedIntent.body.id);
  }
  const first = await startRunThroughSubmissionIntent(client, {
    threadId,
    request,
    attachments,
    idempotencyKey,
  });
  assert.deepEqual(first.body.requestedArtifactKinds, ["prd"]);
  const typedOptions = assertRunTypedOptions(first.body, request);
  const sourceSnapshots = assertRunSourceSnapshots(first.body, sourceFixtures);
  const duplicate = await startRunThroughSubmissionIntent(client, {
    threadId,
    request,
    attachments,
    idempotencyKey,
  });
  assert.equal(duplicate.body.id, first.body.id, "same idempotency key did not return the original Run");
  assert.deepEqual(duplicate.body.requestedArtifactKinds, ["prd"]);
  assertRunTypedOptions(duplicate.body, request, typedOptions);
  assertRunSourceSnapshots(duplicate.body, sourceFixtures, sourceSnapshots);

  const typedOptionConflicts = [
    ["workflow", { ...request, workflow: "ideate" }],
    ["targetSurface", { ...request, targetSurface: "app" }],
    ["designStyle", { ...request, designStyle: { kind: "automatic" } }],
  ];
  for (const [field, conflictingRequest] of typedOptionConflicts) {
    const typedConflict = await createSubmissionIntent(client, {
      threadId,
      request: conflictingRequest,
      attachments,
      idempotencyKey,
      expectedStatus: 409,
    });
    assert.equal(
      typedConflict.body.code,
      "IDEMPOTENCY_KEY_REUSED",
      `changing ${field} did not invalidate the idempotency request hash`,
    );
  }

  const conflict = await createSubmissionIntent(client, {
    threadId,
    request,
    attachments: [...attachments].reverse(),
    idempotencyKey,
    expectedStatus: 409,
  });
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");

  const events = await client.sse(`/runs/${first.body.id}/events?afterSequence=0`);
  assertOrderedEvents(events, { runId: first.body.id, firstSequence: 1 });
  assert.equal(events.at(-1)?.data.type, "run.completed");
  assert.ok(events.some((event) => event.data.type === "artifact.version.created"));
  assert.ok(events.some((event) => event.data.type === "message.delta"));
  assert.deepEqual(
    events
      .filter((event) => event.data.type === "run.generation.stage.changed")
      .map((event) => event.data.payload.stage),
    ["thinking", ...prdGenerationStageSequence],
  );
  const prdCheckpointIndex = events.findIndex(
    (event) => event.data.type === "artifact.draft.created",
  );
  const prdReadyIndex = events.findIndex(
    (event) => event.data.type === "artifact.version.created",
  );
  assert.ok(
    prdCheckpointIndex > events.findLastIndex(
      (event) => event.data.type === "run.generation.stage.changed",
    ) && prdCheckpointIndex < prdReadyIndex,
    "the PRD checkpoint was not persisted after validation and before ready publication",
  );

  const cursorIndex = Math.max(0, Math.floor(events.length / 2) - 1);
  const cursor = events[cursorIndex].data.sequence;
  const conflictingCursor = await client.json(
    "GET",
    `/runs/${first.body.id}/events?afterSequence=0`,
    {
      headers: { "Last-Event-ID": String(cursor) },
      expectedStatus: 400,
    },
  );
  assert.equal(conflictingCursor.body.code, "VALIDATION_ERROR");
  assert.match(conflictingCursor.body.detail, /must match/u);

  const replay = await client.sse(`/runs/${first.body.id}/events`, {
    "Last-Event-ID": String(cursor),
  });
  const expectedReplay = events.filter((event) => event.data.sequence > cursor);
  assert.deepEqual(
    replay.map(eventIdentity),
    expectedReplay.map(eventIdentity),
    "Last-Event-ID replay did not return the exact ordered suffix",
  );

  const terminal = await client.json("GET", `/runs/${first.body.id}`);
  assert.equal(terminal.body.status, "succeeded");
  assert.deepEqual(terminal.body.requestedArtifactKinds, ["prd"]);
  assertRunTypedOptions(terminal.body, request, typedOptions);
  assertRunSourceSnapshots(terminal.body, sourceFixtures, sourceSnapshots);
  assert.equal(terminal.body.progress, 1);
  assert.equal(terminal.body.lastEventSequence, events.length);
  assert.equal(terminal.body.failure, null);

  const completed = await client.json("GET", `/projects/${project.body.id}/bootstrap?threadId=${threadId}`);
  assert.equal(completed.body.selectedThreadId, threadId);
  assert.equal(completed.body.latestRun.id, first.body.id);
  assert.equal(completed.body.latestRun.status, "succeeded");
  assert.equal(completed.body.latestRun.lastEventSequence, events.length);
  assertRunTypedOptions(completed.body.latestRun, request, typedOptions);
  assertRunSourceSnapshots(completed.body.latestRun, sourceFixtures, sourceSnapshots);
  assert.equal(completed.body.artifacts.length, 1);
  const artifact = completed.body.artifacts[0];
  assert.equal(artifact.kind, "prd");
  assert.equal(artifact.currentVersion.status, "ready");
  assert.equal(artifact.currentVersion.kind, "prd");
  assert.equal(artifact.currentVersion.schemaVersion, 2);
  assert.equal(artifact.currentVersion.createdByRunId, first.body.id);
  assert.equal(artifact.revision, 1);

  const artifactPage = await client.json(
    "GET",
    `/projects/${project.body.id}/artifacts?kind=prd&limit=1`,
  );
  assert.equal(artifactPage.body.items.length, 1);
  assert.equal(artifactPage.body.items[0].id, artifact.id);
  assert.equal(artifactPage.body.nextCursor, null);

  const artifactDetail = await client.json("GET", `/artifacts/${artifact.id}`);
  assert.deepEqual(artifactDetail.body, artifact);
  assert.equal(artifactDetail.headers.get("etag"), '"1"');
  const artifactNotModified = await client.json("GET", `/artifacts/${artifact.id}`, {
    headers: { "If-None-Match": artifactDetail.headers.get("etag") },
    expectedStatus: 304,
  });
  assert.equal(artifactNotModified.body, null);

  const versionPage = await client.json(
    "GET",
    `/artifacts/${artifact.id}/versions?limit=1`,
  );
  assert.equal(versionPage.body.items.length, 1);
  assert.equal(versionPage.body.items[0].artifactVersionId, artifact.currentVersion.artifactVersionId);
  assert.equal(versionPage.body.items[0].kind, "prd");
  assert.equal(versionPage.body.items[0].schemaVersion, 2);
  assert.equal(versionPage.body.items[0].contentMode, "inline");

  const versionDetail = await client.json(
    "GET",
    `/artifacts/${artifact.id}/versions/${artifact.currentVersion.artifactVersionId}`,
  );
  const versionEtag = versionDetail.headers.get("etag");
  assert.match(versionEtag ?? "", /^"[a-f0-9]{64}"$/);
  assert.equal(versionDetail.body.contentMode, "inline");
  assert.equal(versionDetail.body.kind, "prd");
  assert.equal(versionDetail.body.schemaVersion, 2);
  assert.equal(versionDetail.body.content.protocol, "workbench.prd.v2");
  assert.equal(versionDetail.body.content.documentId, prdV2DocumentId);
  assert.equal(versionDetail.body.content.title, prdV2Title);
  assert.equal(versionDetail.body.content.cover.workOrderName, prdV2WorkOrderName);
  assert.equal(versionDetail.body.content.cover.title, prdV2Title);
  assert.equal(versionDetail.body.knowledgeReleaseId, null);
  const versionNotModified = await client.json(
    "GET",
    `/artifacts/${artifact.id}/versions/${artifact.currentVersion.artifactVersionId}`,
    { headers: { "If-None-Match": versionEtag }, expectedStatus: 304 },
  );
  assert.equal(versionNotModified.body, null);

  const wrongPair = await client.json(
    "GET",
    `/artifacts/not-the-owner/versions/${artifact.currentVersion.artifactVersionId}`,
    { expectedStatus: 404 },
  );
  assert.equal(wrongPair.body.code, "RESOURCE_NOT_FOUND");
  const outsiderArtifact = await outsiderClient.json("GET", `/artifacts/${artifact.id}`, {
    expectedStatus: 404,
  });
  const outsiderVersion = await outsiderClient.json(
    "GET",
    `/artifacts/${artifact.id}/versions/${artifact.currentVersion.artifactVersionId}`,
    { expectedStatus: 404 },
  );
  assert.equal(outsiderArtifact.body.code, "RESOURCE_NOT_FOUND");
  assert.equal(outsiderVersion.body.code, "RESOURCE_NOT_FOUND");
  const artifactNode = completed.body.board.nodes.find(
    (node) => node.artifactVersionId === artifact.currentVersion.artifactVersionId,
  );
  assert.ok(artifactNode, "Worker did not add the ArtifactVersion to the Board");
  assert.equal(artifactNode.artifactId, artifact.id);
  assert.equal(artifactNode.data.artifactKind, "prd");
  assert.deepEqual(artifactNode.size, { width: 500, height: 500 });
  const userEntry = completed.body.entries.find(
    (entry) => entry.role === "user" && entry.content?.type === "user.prompt",
  );
  assert.equal(userEntry?.content.protocol, "workbench.entry.v1");
  assert.deepEqual(
    userEntry?.content.sourceIds,
    sourceSnapshots.map((source) => source.sourceId),
  );
  const assistantEntry = completed.body.entries.find(
    (entry) => entry.producedByRunId === first.body.id && entry.role === "assistant",
  );
  assert.equal(assistantEntry?.kind, "message");
  assert.equal(assistantEntry?.content.protocol, "workbench.entry.v1");
  assert.equal(assistantEntry?.content.type, "assistant.message");
  assert.equal(assistantEntry?.content.text, "E2E generated response");

  const secondThread = await client.json("POST", `/projects/${project.body.id}/threads`, {
    body: { title: "Second thread" },
    headers: { "Idempotency-Key": `e2e-thread-${randomUUID()}` },
    expectedStatus: 201,
  });
  const secondBootstrap = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${secondThread.body.id}`,
  );
  assert.equal(secondBootstrap.body.selectedThreadId, secondThread.body.id);
  assert.equal(secondBootstrap.body.entries.length, 0);
  assert.equal(secondBootstrap.body.latestRun, null);
  const restoredOriginal = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  assert.equal(restoredOriginal.body.latestRun.id, first.body.id);
  assertRunTypedOptions(restoredOriginal.body.latestRun, request, typedOptions);
  assertRunSourceSnapshots(restoredOriginal.body.latestRun, sourceFixtures, sourceSnapshots);
  assert.ok(restoredOriginal.body.entries.every((entry) => entry.threadId === threadId));

  const runPage = await client.json("GET", `/threads/${threadId}/runs?limit=1`);
  assert.equal(runPage.body.items.length, 1);
  assert.equal(runPage.body.items[0].id, first.body.id);
  assert.equal(runPage.body.items[0].status, "succeeded");
  assertRunTypedOptions(runPage.body.items[0], request, typedOptions);
  assertRunSourceSnapshots(runPage.body.items[0], sourceFixtures, sourceSnapshots);
  assert.equal(runPage.body.nextCursor, null);

  const persisted = await queryDatabase(`
    SELECT
      r.status,
      r.phase,
      r.progress,
      r.event_sequence,
      r.error_retryable,
      r.cancellation_reason,
      r.request->'requestedArtifactKinds' AS requested_artifact_kinds,
      r.design_style_snapshot->>'protocol' AS design_style_snapshot_protocol,
      r.design_style_snapshot#>>'{source,presetId}' AS design_style_preset_id,
      r.design_style_snapshot#>>'{source,checksum}' AS design_style_preset_checksum,
      r.design_style_snapshot_sha256,
      count(DISTINCT av.id)::int AS artifact_version_count,
      max(av.schema_version)::int AS artifact_schema_version,
      max(av.content->>'protocol') AS artifact_protocol,
      count(DISTINCT bn.id)::int AS board_node_count,
      to_regnamespace('workbench_jobs') IS NOT NULL AS queue_schema_exists
    FROM workbench.runs r
    LEFT JOIN workbench.artifact_versions av ON av.created_by_run_id = r.id
    LEFT JOIN workbench.board_nodes bn ON bn.artifact_version_id = av.id
    WHERE r.id = $1
    GROUP BY r.status, r.phase, r.progress, r.event_sequence,
      r.error_retryable, r.cancellation_reason, r.request,
      r.design_style_snapshot, r.design_style_snapshot_sha256
  `, [first.body.id]);
  assert.equal(persisted.rows[0]?.status, "succeeded");
  assert.equal(persisted.rows[0]?.progress, 1);
  assert.equal(persisted.rows[0]?.event_sequence, events.length);
  assert.equal(persisted.rows[0]?.error_retryable, null);
  assert.equal(persisted.rows[0]?.cancellation_reason, null);
  assert.deepEqual(persisted.rows[0]?.requested_artifact_kinds, ["prd"]);
  assert.equal(persisted.rows[0]?.design_style_snapshot_protocol, "workbench.runtime.design-preset.v1");
  assert.equal(persisted.rows[0]?.design_style_preset_id, selectedPreset.presetId);
  assert.equal(persisted.rows[0]?.design_style_preset_checksum, selectedPreset.checksum);
  assert.match(persisted.rows[0]?.design_style_snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.equal(persisted.rows[0]?.artifact_version_count, 1);
  assert.equal(persisted.rows[0]?.artifact_schema_version, 2);
  assert.equal(persisted.rows[0]?.artifact_protocol, "workbench.prd.v2");
  assert.equal(persisted.rows[0]?.board_node_count, 1);
  assert.equal(persisted.rows[0]?.queue_schema_exists, true);
  await assertPersistedRunSources(first.body.id, sourceFixtures, sourceSnapshots);
  assertRuntimeSourceIsolation(first.body.id, sourceFixtures, sourceSnapshots, request);

  return {
    runId: first.body.id,
    eventCount: events.length,
    replayCursor: cursor,
    replayCount: replay.length,
    artifactVersionId: artifact.currentVersion.artifactVersionId,
    artifactEtag: artifactDetail.headers.get("etag"),
    artifactVersionEtag: versionEtag,
    boardNodeId: artifactNode.id,
    sourceCount: sourceSnapshots.length,
    runtimeContentCount: runtimeContentCount(sourceFixtures),
  };
}

async function runPrototypePatchScenario(client) {
  console.log("[e2e] running Prototype checkpoint, patch, and ready-publication scenario");
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json(
    "POST",
    `/workspaces/${identity.body.defaultWorkspaceId}/projects`,
    {
      body: { title: "Prototype Patch PostgreSQL E2E" },
      expectedStatus: 201,
    },
  );
  const bootstrap = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = bootstrap.body.selectedThreadId;
  assert.equal(typeof threadId, "string");

  const request = {
    prompt: "E2E_PROTOTYPE_PATCH: stream one deterministic Prototype patch",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    generationIntent: null,
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    requestedArtifactKinds: ["prototype"],
  };
  const run = await startRunThroughSubmissionIntent(client, {
    threadId,
    request,
    idempotencyKey: `e2e-prototype-patch-${randomUUID()}`,
  });
  const events = await client.sse(`/runs/${run.body.id}/events?afterSequence=0`);
  assertOrderedEvents(events, { runId: run.body.id, firstSequence: 1 });
  assert.equal(events.at(-1)?.data.type, "run.completed");
  const patchEvents = events.filter(
    (event) => event.data.type === "artifact.prototype.patch.created",
  );
  const draftEvents = events.filter((event) => event.data.type === "artifact.draft.created");
  assert.equal(patchEvents.length, 2);
  assert.equal(draftEvents.length, 3);
  assert.equal(
    events.filter((event) => event.data.type === "artifact.prototype.patch.degraded").length,
    0,
  );
  const firstDraftIndex = events.findIndex((event) => event.data.type === "artifact.draft.created");
  const firstPatchIndex = events.findIndex(
    (event) => event.data.type === "artifact.prototype.patch.created",
  );
  const secondPatchIndex = events.findLastIndex(
    (event) => event.data.type === "artifact.prototype.patch.created",
  );
  const readyVersionIndex = events.findIndex((event) => event.data.type === "artifact.version.created");
  assert.ok(
    firstDraftIndex >= 0 && firstDraftIndex < firstPatchIndex,
    "Patch preceded its complete checkpoint",
  );
  assert.ok(
    firstPatchIndex < secondPatchIndex && secondPatchIndex < readyVersionIndex,
    "consecutive Prototype patches were not published before ready",
  );

  const completed = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  assert.equal(completed.body.latestRun.id, run.body.id);
  assert.equal(completed.body.latestRun.status, "succeeded");
  const artifact = completed.body.artifacts.find((candidate) => candidate.kind === "prototype");
  assert.ok(artifact?.currentVersion, "Prototype patch Run did not publish a ready ArtifactVersion");
  assert.equal(artifact.currentVersion.status, "ready");
  const versionId = artifact.currentVersion.artifactVersionId;
  const version = await client.json(
    "GET",
    `/artifacts/${artifact.id}/versions/${versionId}`,
  );
  assert.equal(version.body.contentMode, "inline");
  assert.equal(version.body.content.screens[0]?.name, "Streamed Home");
  assert.equal(version.body.content.revision, 1, "transport patches changed document revision");
  assert.ok(
    completed.body.board.nodes.some((node) => (
      node.artifactId === artifact.id && node.artifactVersionId === versionId
    )),
    "Prototype patch Run did not publish the ready version to the Board",
  );

  const checkpoint = await client.json(
    "GET",
    `/runs/${run.body.id}/artifact-drafts/${versionId}/checkpoint`,
  );
  assert.equal(checkpoint.body.status, "ready");
  assert.equal(checkpoint.body.artifactVersionId, versionId);
  assert.equal(checkpoint.body.document.screens[0]?.name, "Streamed Home");
  assert.equal(checkpoint.body.screens.length, 1);
  assert.deepEqual(checkpoint.body.screens[0], {
    screenId: "screen-home",
    revision: 2,
    checksum: prototypeScreenProjectionChecksum(
      checkpoint.body.document,
      "screen-home",
      2,
    ),
  });
  assert.equal(checkpoint.body.documentChecksum, sha256(canonicalJson(checkpoint.body.document)));
  assert.equal(checkpoint.body.lastSequence, events.length);

  const persisted = await queryDatabase(`
    SELECT
      projection.status::text AS projection_status,
      projection.revision AS projection_revision,
      projection.checksum AS projection_checksum,
      application.outcome::text AS application_outcome,
      application.base_revision,
      application.next_revision,
      application.operations,
      application.source_event_id,
      event.type AS event_type
    FROM prototype_patch_projections projection
    JOIN prototype_patch_applications application
      ON application.artifact_version_id = projection.artifact_version_id
     AND application.screen_id = projection.screen_id
    JOIN run_events event
      ON event.id = application.run_event_id
     AND event.run_id = application.run_id
    WHERE projection.run_id = $1
    ORDER BY application.next_revision ASC
  `, [run.body.id]);
  assert.equal(persisted.rows.length, 2);
  assert.ok(persisted.rows.every((row) => row.projection_status === "finalized"));
  assert.ok(persisted.rows.every((row) => row.projection_revision === 2));
  assert.ok(persisted.rows.every((row) => (
    row.projection_checksum === checkpoint.body.screens[0].checksum
  )));
  assert.ok(persisted.rows.every((row) => row.application_outcome === "applied"));
  assert.deepEqual(
    persisted.rows.map((row) => [row.base_revision, row.next_revision]),
    [[0, 1], [1, 2]],
  );
  assert.ok(persisted.rows.every((row) => row.event_type === "artifact.prototype.patch.created"));
  assert.ok(persisted.rows.every((row) => /^deerflow:[0-9a-f]{64}$/.test(row.source_event_id)));
  assert.deepEqual(
    persisted.rows.map((row) => row.operations.map((operation) => operation.kind)),
    [["update_screen"], ["update_screen"]],
  );

  const persistedEvents = await queryDatabase(`
    SELECT sequence, type, source_id
    FROM run_events
    WHERE run_id = $1
    ORDER BY sequence ASC
  `, [run.body.id]);
  const explicitFinalCheckpointSourceId = runtimeToolEventSourceId(
    checkpoint.body.runtimeAttemptId,
    "workbench_artifact_draft_publish",
    "prototype-patch-checkpoint-final",
  );
  const explicitFinalCheckpoint = persistedEvents.rows.find(
    (event) => event.source_id === explicitFinalCheckpointSourceId,
  );
  assert.equal(explicitFinalCheckpoint?.type, "artifact.draft.created");
  assert.ok(
    explicitFinalCheckpoint.sequence > patchEvents[1].data.sequence
      && explicitFinalCheckpoint.sequence < events[readyVersionIndex].data.sequence,
    "the explicit final checkpoint was not persisted between the last patch and ready publication",
  );

  return {
    runId: run.body.id,
    eventCount: events.length,
    artifactVersionId: versionId,
    screenRevision: checkpoint.body.screens[0].revision,
    patchEventSequences: patchEvents.map((event) => event.data.sequence),
  };
}

async function runCanvasGatewayScenario(client) {
  console.log("[e2e] running Canvas Gateway capability, command, and staged-mutation scenario");
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json("POST", `/workspaces/${identity.body.defaultWorkspaceId}/projects`, {
    body: { title: "Workbench Canvas Gateway E2E" },
    expectedStatus: 201,
  });
  const initial = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = initial.body.selectedThreadId;
  assert.equal(typeof threadId, "string");

  const seed = await startRunThroughSubmissionIntent(client, {
    threadId,
    request: {
      prompt: "E2E_CANVAS_SEED: generate one deterministic Prototype screen",
      modelId: runtimeCatalogModelId,
      workflow: "generate",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: ["prototype"],
      canvasSnapshot: null,
    },
    idempotencyKey: `e2e-canvas-seed-${randomUUID()}`,
  });
  await waitForSucceededRun(client, seed.body.id, "Canvas seed Run");

  const seededBootstrap = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  const seeded = await loadCanvasScreenFixture(client, seededBootstrap.body, "screen-home");
  const seedBoardRevision = seededBootstrap.body.board.revision;
  assert.equal(seeded.artifact.currentVersion.createdByRunId, seed.body.id);
  assert.equal(seeded.artifact.currentVersion.status, "ready");

  const quickSnapshot = createCanvasSnapshot({
    projectId: project.body.id,
    threadId,
    board: seededBootstrap.body.board,
    screen: seeded,
    projectSessionGeneration: 1,
  });
  const quickEdit = await startRunThroughSubmissionIntent(client, {
    threadId,
    request: {
      prompt: "E2E_CANVAS_QUICK_EDIT: inspect, interact with, and edit the selected screen",
      modelId: runtimeCatalogModelId,
      workflow: "edit",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      artifactTargets: [{
        artifactId: seeded.reference.artifactId,
        artifactVersionId: seeded.reference.artifactVersionId,
        screenIds: [seeded.reference.screenId],
      }],
      requestedArtifactKinds: ["prototype"],
      canvasSnapshot: quickSnapshot,
    },
    idempotencyKey: `e2e-canvas-quick-edit-${randomUUID()}`,
  });
  const [quickTerminal, quickCommands] = await Promise.all([
    waitForSucceededRun(client, quickEdit.body.id, "Canvas quick-edit Run"),
    driveCanvasClientCommands(client, quickEdit.body.id, quickSnapshot, seeded.summary, 3),
  ]);
  assert.equal(quickTerminal.status, "succeeded");

  const quickBootstrap = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  const quickResult = await loadCanvasScreenFixture(client, quickBootstrap.body, "screen-home");
  const quickBoardRevision = quickBootstrap.body.board.revision;
  assert.notEqual(quickResult.reference.artifactVersionId, seeded.reference.artifactVersionId);
  assert.equal(quickResult.artifact.currentVersion.createdByRunId, quickEdit.body.id);
  assert.equal(quickBoardRevision, seedBoardRevision + 1);
  assert.equal(quickResult.node.artifactVersionId, quickResult.reference.artifactVersionId);

  const directSnapshot = createCanvasSnapshot({
    projectId: project.body.id,
    threadId,
    board: quickBootstrap.body.board,
    screen: quickResult,
    projectSessionGeneration: 2,
  });
  const directEdit = await startRunThroughSubmissionIntent(client, {
    threadId,
    request: {
      prompt: "E2E_CANVAS_DIRECT_EDIT: rename and duplicate the selected screen",
      modelId: runtimeCatalogModelId,
      workflow: "edit",
      targetSurface: "app",
      designStyle: { kind: "automatic" },
      artifactTargets: [{
        artifactId: quickResult.reference.artifactId,
        artifactVersionId: quickResult.reference.artifactVersionId,
        screenIds: [quickResult.reference.screenId],
      }],
      requestedArtifactKinds: ["prototype"],
      canvasSnapshot: directSnapshot,
    },
    idempotencyKey: `e2e-canvas-direct-edit-${randomUUID()}`,
  });
  await waitForSucceededRun(client, directEdit.body.id, "Canvas direct-intent Run");

  const completed = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  const finalScreen = await loadCanvasScreenFixture(client, completed.body, "screen-home");
  assert.notEqual(finalScreen.reference.artifactVersionId, quickResult.reference.artifactVersionId);
  assert.equal(finalScreen.artifact.currentVersion.createdByRunId, directEdit.body.id);
  assert.equal(completed.body.board.revision, quickBoardRevision + 1);
  assert.equal(finalScreen.node.artifactVersionId, finalScreen.reference.artifactVersionId);
  assert.equal(finalScreen.screen.name, "Agent Home");
  assert.equal(finalScreen.document.screens.length, 2);
  assert.equal(
    completed.body.board.nodes.filter((node) => node.artifactId === finalScreen.reference.artifactId).length,
    2,
  );

  const audit = await assertCanvasGatewayAudit({
    seedRunId: seed.body.id,
    quickRunId: quickEdit.body.id,
    directRunId: directEdit.body.id,
    projectId: project.body.id,
    seededVersionId: seeded.reference.artifactVersionId,
    quickVersionId: quickResult.reference.artifactVersionId,
    finalVersionId: finalScreen.reference.artifactVersionId,
    seedBoardRevision,
    quickBoardRevision,
    finalBoardRevision: completed.body.board.revision,
    finalScreenName: finalScreen.screen.name,
  });

  return {
    projectId: project.body.id,
    threadId,
    seedRunId: seed.body.id,
    quickEditRunId: quickEdit.body.id,
    directEditRunId: directEdit.body.id,
    finalArtifactVersionId: finalScreen.reference.artifactVersionId,
    finalBoardRevision: completed.body.board.revision,
    toolsCovered: [...new Set([
      ...audit.quickInvocationTools,
      ...audit.directInvocationTools,
    ])],
    acknowledgedCommandCount: quickCommands.length,
  };
}

async function runSourceTargetGeneratePrototypeScenario(client) {
  console.log("[e2e] running targeted Generate Prototype source-projection scenario");
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json(
    "POST",
    `/workspaces/${identity.body.defaultWorkspaceId}/projects`,
    {
      body: { title: "Workbench Generate Prototype Source E2E" },
      expectedStatus: 201,
    },
  );
  const initial = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = initial.body.selectedThreadId;
  assert.equal(typeof threadId, "string");

  const sourceRequest = {
    prompt: "E2E_GENERATE_SOURCE_SEED: publish a deterministic three-screen source Prototype",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    generationIntent: null,
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    artifactTargets: [],
    requestedArtifactKinds: ["prototype"],
    canvasSnapshot: null,
  };
  const sourceRun = await startRunThroughSubmissionIntent(client, {
    threadId,
    request: sourceRequest,
    idempotencyKey: `e2e-generate-source-seed-${randomUUID()}`,
  });
  assert.equal(sourceRun.body.generationIntent, null);
  await waitForSucceededRun(client, sourceRun.body.id, "Generate Prototype source seed Run");

  const sourceBootstrap = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  const sourceArtifact = sourceBootstrap.body.artifacts.find(
    (candidate) => candidate.kind === "prototype"
      && candidate.currentVersion?.createdByRunId === sourceRun.body.id,
  );
  assert.ok(sourceArtifact?.currentVersion, "source seed Run did not publish a ready Prototype");
  const sourceVersionId = sourceArtifact.currentVersion.artifactVersionId;
  const sourceVersion = await client.json(
    "GET",
    `/artifacts/${sourceArtifact.id}/versions/${sourceVersionId}`,
  );
  assert.equal(sourceVersion.body.contentMode, "inline");
  assert.equal(sourceVersion.body.kind, "prototype");
  const sourceContent = structuredClone(sourceVersion.body.content);
  assert.deepEqual(
    sourceContent.screens.map((screen) => screen.id),
    ["screen-home", "screen-settings", "screen-admin"],
  );
  assert.equal(sourceBootstrap.body.board.nodes.filter(
    (node) => node.artifactVersionId === sourceVersionId,
  ).length, 3);

  // Keep the caller's order intentionally different from document order. The
  // runtime projection must preserve this frozen selection order while sorting
  // only independently addressable collections.
  const sourceTarget = {
    artifactId: sourceArtifact.id,
    artifactVersionId: sourceVersionId,
    screenIds: ["screen-admin", "screen-home"],
  };
  const targetRequest = {
    prompt: "E2E_GENERATE_PROTOTYPE_SOURCE: generate a new Prototype from two selected source screens",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    generationIntent: "interactive-prototype",
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    artifactTargets: [sourceTarget],
    requestedArtifactKinds: ["prototype"],
    canvasSnapshot: null,
  };
  const targetRun = await startRunThroughSubmissionIntent(client, {
    threadId,
    request: targetRequest,
    idempotencyKey: `e2e-generate-prototype-source-${randomUUID()}`,
  });
  assert.equal(targetRun.body.generationIntent, "interactive-prototype");
  assert.deepEqual(targetRun.body.artifactTargets, [sourceTarget]);
  await waitForSucceededRun(client, targetRun.body.id, "targeted Generate Prototype Run");

  const runtimeRequest = fakeRuntime.state.runRequests.find(
    (request) => request.body?.config?.configurable?.workbench_run_id === targetRun.body.id
      && request.body?.input !== null,
  );
  assert.ok(runtimeRequest, "fake DeerFlow did not receive the targeted Generate request");
  const runtimeContext = parseWorkbenchRuntimeContext(runtimeRequest.body);
  assert.equal(runtimeContext.generationIntent, "interactive-prototype");
  assert.deepEqual(
    runtimeContext.artifactTargets.map((target) => ({
      artifactId: target.artifactId,
      artifactVersionId: target.artifactVersionId,
      screenIds: target.screenIds,
    })),
    [sourceTarget],
  );
  const projection = runtimeContext.artifactTargets[0]?.content?.value;
  assert.equal(projection?.protocol, "workbench.prototype-source-projection.v1");
  assert.deepEqual(projection?.selectedScreenIds, sourceTarget.screenIds);
  assert.deepEqual(
    projection?.screens?.map((screen) => screen.id),
    sourceTarget.screenIds,
  );
  assert.deepEqual(
    [...new Set(projection?.nodes?.map((node) => node.screenId))],
    sourceTarget.screenIds,
  );
  assert.ok(
    !projection.nodes.some((node) => node.id === "frame-settings" || node.id === "icon-settings"),
    "Generate source projection leaked an unselected screen node",
  );
  assert.deepEqual(
    projection.assets.map((asset) => asset.id),
    ["asset-admin", "asset-home"],
    "Generate source projection did not retain only selected-screen assets",
  );
  assert.deepEqual(projection.navigationTargets, [{
    id: "screen-settings",
    name: "Settings",
    route: "/settings",
    viewport: { width: 390, height: 844 },
  }]);
  assert.equal(projection.source.checksum, sourceVersion.body.checksum);

  const completed = await client.json(
    "GET",
    `/projects/${project.body.id}/bootstrap?threadId=${threadId}`,
  );
  const generatedArtifact = completed.body.artifacts.find(
    (candidate) => candidate.kind === "prototype"
      && candidate.currentVersion?.createdByRunId === targetRun.body.id,
  );
  assert.ok(generatedArtifact?.currentVersion, "targeted Generate did not publish a ready Prototype");
  assert.notEqual(generatedArtifact.id, sourceArtifact.id);
  const generatedVersion = await client.json(
    "GET",
    `/artifacts/${generatedArtifact.id}/versions/${generatedArtifact.currentVersion.artifactVersionId}`,
  );
  assert.deepEqual(
    generatedVersion.body.content.screens.map((screen) => screen.id),
    sourceTarget.screenIds,
  );
  assert.equal(
    completed.body.board.nodes.filter(
      (node) => node.artifactVersionId === generatedArtifact.currentVersion.artifactVersionId,
    ).length,
    2,
  );

  const sourceAfter = await client.json(
    "GET",
    `/artifacts/${sourceArtifact.id}/versions/${sourceVersionId}`,
  );
  assert.deepEqual(sourceAfter.body.content, sourceContent, "targeted Generate mutated the source content");
  assert.equal(sourceAfter.body.checksum, sourceVersion.body.checksum);

  const persisted = await queryDatabase(`
    SELECT
      request->>'generationIntent' AS generation_intent,
      request->'artifactTargets' AS artifact_targets,
      status,
      (SELECT count(*)::int FROM workbench.artifact_versions av
       WHERE av.created_by_run_id = runs.id) AS created_versions
    FROM workbench.runs
    WHERE id = $1
  `, [targetRun.body.id]);
  assert.equal(persisted.rows[0]?.generation_intent, "interactive-prototype");
  assert.deepEqual(persisted.rows[0]?.artifact_targets, [sourceTarget]);
  assert.equal(persisted.rows[0]?.status, "succeeded");
  assert.equal(persisted.rows[0]?.created_versions, 1);

  return {
    projectId: project.body.id,
    threadId,
    sourceRunId: sourceRun.body.id,
    sourceArtifactId: sourceArtifact.id,
    sourceVersionId,
    targetRunId: targetRun.body.id,
    generatedArtifactId: generatedArtifact.id,
    generatedVersionId: generatedArtifact.currentVersion.artifactVersionId,
    selectedScreenIds: sourceTarget.screenIds,
    projectedNodeCount: projection.nodes.length,
    projectedAssetIds: projection.assets.map((asset) => asset.id),
  };
}

async function waitForSucceededRun(client, runId, label) {
  let current;
  await waitFor(async () => {
    current = (await client.json("GET", `/runs/${runId}`)).body;
    return ["succeeded", "failed", "cancelled"].includes(current.status);
  }, scenarioTimeoutMs, `${label} never reached a terminal status`);
  assert.equal(
    current.status,
    "succeeded",
    `${label} failed: ${JSON.stringify(current.failure ?? current.cancellationReason)}`,
  );
  return current;
}

async function loadCanvasScreenFixture(client, bootstrap, screenId) {
  const artifact = bootstrap.artifacts.find((candidate) => candidate.kind === "prototype");
  assert.ok(artifact?.currentVersion, "Canvas bootstrap omitted the Prototype current version");
  const node = bootstrap.board.nodes.find((candidate) => (
    candidate.artifactId === artifact.id
    && candidate.artifactVersionId === artifact.currentVersion.artifactVersionId
    && candidate.data?.screenId === screenId
  ));
  assert.ok(node, `Canvas bootstrap omitted the ${screenId} Board node`);
  const detail = await client.json(
    "GET",
    `/artifacts/${artifact.id}/versions/${artifact.currentVersion.artifactVersionId}`,
  );
  assert.equal(detail.body.kind, "prototype");
  assert.equal(detail.body.contentMode, "inline");
  const screen = detail.body.content.screens.find((candidate) => candidate.id === screenId);
  assert.ok(screen, `Prototype ArtifactVersion omitted ${screenId}`);
  const reference = {
    boardNodeId: node.id,
    artifactId: artifact.id,
    artifactVersionId: artifact.currentVersion.artifactVersionId,
    screenId,
  };
  return {
    artifact,
    node,
    document: detail.body.content,
    screen,
    reference,
    summary: {
      reference,
      name: screen.name,
      route: screen.route,
      phase: "complete",
      viewport: screen.viewport,
    },
  };
}

function createCanvasSnapshot({ projectId, threadId, board, screen, projectSessionGeneration }) {
  const capturedAt = new Date();
  return {
    protocol: "workbench.canvas-snapshot.v1",
    projectId,
    threadId,
    runId: null,
    boardId: board.id,
    clientSessionId: `canvas-e2e-${randomUUID()}`,
    projectSessionGeneration,
    boardRevision: board.revision,
    canvasStateRevision: 1,
    capturedAt: capturedAt.toISOString(),
    expiresAt: new Date(capturedAt.getTime() + 90_000).toISOString(),
    viewport: board.viewport,
    screens: [screen.summary],
    visibleScreens: [screen.reference],
    selectedScreens: [screen.reference],
  };
}

async function driveCanvasClientCommands(client, runId, snapshot, screenSummary, expectedCount) {
  const state = {
    protocol: "workbench.canvas-client-state.v1",
    clientSessionId: snapshot.clientSessionId,
    projectSessionGeneration: snapshot.projectSessionGeneration,
    boardId: snapshot.boardId,
    boardRevision: snapshot.boardRevision,
    canvasStateRevision: snapshot.canvasStateRevision,
    viewport: structuredClone(snapshot.viewport),
    visibleScreens: structuredClone(snapshot.visibleScreens),
    selectedScreens: structuredClone(snapshot.selectedScreens),
  };
  const acknowledged = [];
  const deadline = Date.now() + scenarioTimeoutMs;
  const commandRoute = `/projects/${snapshot.projectId}/canvas-agent/commands`
    + `?clientSessionId=${encodeURIComponent(snapshot.clientSessionId)}`
    + `&projectSessionGeneration=${snapshot.projectSessionGeneration}`;

  while (acknowledged.length < expectedCount && Date.now() < deadline) {
    const listed = await client.json("GET", commandRoute);
    for (const command of listed.body.items) {
      if (acknowledged.some((candidate) => candidate.commandId === command.commandId)) continue;
      await synchronizeCanvasClientState(client, snapshot.projectId, state);
      const applied = applyCanvasClientCommand(command, state, screenSummary);
      if (applied.stateChanged) state.canvasStateRevision += 1;
      await synchronizeCanvasClientState(client, snapshot.projectId, state, command.commandId);
      const durableAck = {
        protocol: "workbench.canvas-client-command-ack.v1",
        commandId: command.commandId,
        agentSessionId: command.agentSessionId,
        toolCallId: command.toolCallId,
        requestId: command.requestId,
        toolName: command.toolName,
        projectId: command.projectId,
        threadId: command.threadId,
        runId: command.runId,
        boardId: command.boardId,
        clientSessionId: command.clientSessionId,
        projectSessionGeneration: command.projectSessionGeneration,
        boardRevision: command.boardRevision,
        canvasStateRevision: state.canvasStateRevision,
        acknowledgedAt: new Date().toISOString(),
        status: "applied",
        result: applied.result,
        failure: null,
      };
      const visualCapture = command.kind === "preview.open"
        ? createCanvasVisualCapture(command.view.visualCapabilityId)
        : undefined;
      const wireAck = visualCapture
        ? { ...durableAck, visualCapture }
        : durableAck;
      const settled = await client.json(
        "POST",
        `/projects/${snapshot.projectId}/canvas-agent/commands/${command.commandId}/ack`,
        { body: wireAck },
      );
      // Visual bytes are wire-only. The API persists and returns the durable
      // ACK without the potentially large capture payload.
      assert.deepEqual(settled.body, durableAck);
      if (visualCapture) {
        const descriptor = canvasCapabilityDescriptorForRun(runId);
        const visualUrl = `${descriptor.visualEndpoint}/${encodeURIComponent(visualCapture.visualCapabilityId)}`;
        const visual = await fetchBytes(visualUrl, {
          Accept: "image/webp, image/jpeg, image/png",
          Authorization: `Bearer ${descriptor.token}`,
          "Cache-Control": "no-store",
        });
        assert.equal(visual.headers.get("content-type"), "image/webp");
        assert.equal(Number(visual.headers.get("content-length")), visual.bytes.byteLength);
        assert.equal(visual.headers.get("x-content-sha256"), sha256(visual.bytes));
        assert.equal(visual.headers.get("etag"), `"${sha256(visual.bytes)}"`);
        assert.ok(Date.parse(visual.headers.get("x-canvas-visual-expires-at") ?? "") > Date.now());
        assert.ok(visual.bytes.byteLength > 0);
        const replay = await fetchBytes(
          visualUrl,
          {
            Accept: "image/webp, image/jpeg, image/png",
            Authorization: `Bearer ${descriptor.token}`,
            "Cache-Control": "no-store",
            "If-None-Match": visual.headers.get("etag") ?? "",
          },
          304,
        );
        assert.equal(replay.bytes.byteLength, 0);
      }
      await synchronizeCanvasClientState(client, snapshot.projectId, state);
      acknowledged.push({
        commandId: command.commandId,
        toolName: command.toolName,
        result: applied.result,
      });
    }
    if (acknowledged.length >= expectedCount) break;
    const run = await client.json("GET", `/runs/${runId}`);
    if (["succeeded", "failed", "cancelled"].includes(run.body.status)) {
      throw new Error(`Canvas Run ${runId} ended before ${expectedCount} commands were acknowledged`);
    }
    await delay(50);
  }

  assert.equal(acknowledged.length, expectedCount, "Canvas client command poll timed out");
  assert.deepEqual(
    acknowledged.map((command) => command.toolName),
    ["view_screen", "select_screen", "navigate_canvas"],
  );
  return acknowledged;
}

async function synchronizeCanvasClientState(client, projectId, state, causedByCommandId) {
  const synchronized = await client.json("PUT", `/projects/${projectId}/canvas-agent/state`, {
    body: causedByCommandId ? { ...state, causedByCommandId } : state,
  });
  assert.equal(synchronized.body.protocol, state.protocol);
  assert.equal(synchronized.body.activeSession, true);
  assert.equal(synchronized.body.canvasStateRevision, state.canvasStateRevision);
}

function applyCanvasClientCommand(command, state, screenSummary) {
  assert.equal(command.boardRevision, state.boardRevision);
  assert.ok(command.expectedCanvasStateRevision <= state.canvasStateRevision);
  if (command.kind === "preview.open") {
    assert.equal(command.toolName, "view_screen");
    return { result: { view: command.view }, stateChanged: false };
  }
  if (command.kind === "selection.change") {
    assert.equal(command.toolName, "select_screen");
    assert.deepEqual(command.targets, [screenSummary.reference]);
    assert.equal(command.mode, "replace");
    const selectedScreens = structuredClone(command.targets);
    const stateChanged = canonicalJson(state.selectedScreens) !== canonicalJson(selectedScreens);
    state.selectedScreens = selectedScreens;
    return {
      result: {
        selection: {
          kind: "single",
          items: [screenSummary],
          truncated: false,
        },
      },
      stateChanged,
    };
  }
  assert.equal(command.kind, "viewport.navigate");
  assert.equal(command.toolName, "navigate_canvas");
  assert.deepEqual(command.target, { kind: "screen", screen: screenSummary.reference });
  const viewport = { x: 48, y: 96, zoom: 1.25 };
  const stateChanged = canonicalJson(state.viewport) !== canonicalJson(viewport);
  state.viewport = viewport;
  return { result: { viewport: state.viewport }, stateChanged };
}

function createCanvasVisualCapture(visualCapabilityId) {
  assert.equal(typeof visualCapabilityId, "string");
  const bytes = Buffer.from(canvasVisualFixtureBase64, "base64");
  return {
    protocol: "workbench.canvas-visual-capture.v1",
    visualCapabilityId,
    mediaType: "image/png",
    byteSize: bytes.byteLength,
    width: 1,
    height: 1,
    sha256: sha256(bytes),
    dataBase64: canvasVisualFixtureBase64,
  };
}

function canvasCapabilityDescriptorForRun(runId) {
  const request = [...fakeRuntime.state.runRequests].reverse().find(
    (candidate) => candidate.body?.metadata?.workbench_run_id === runId
      && candidate.body?.context?.secrets?.WORKBENCH_CANVAS_CAPABILITY,
  );
  assert.ok(request, `Canvas runtime request for ${runId} did not expose a capability descriptor`);
  const descriptor = parseJson(
    request.body.context.secrets.WORKBENCH_CANVAS_CAPABILITY,
    "Canvas capability descriptor",
  );
  assert.match(descriptor.token, /^wbct1\./);
  const endpoint = new URL(descriptor.endpoint);
  const visualEndpoint = new URL(descriptor.visualEndpoint);
  assert.equal(endpoint.pathname, "/api/v1/runtime/canvas/tools/execute");
  assert.equal(visualEndpoint.pathname, "/api/v1/runtime/canvas/visuals");
  assert.equal(visualEndpoint.origin, endpoint.origin);
  assert.equal(visualEndpoint.search, "");
  assert.equal(visualEndpoint.hash, "");
  return descriptor;
}

async function assertCanvasGatewayAudit({
  seedRunId,
  quickRunId,
  directRunId,
  projectId,
  seededVersionId,
  quickVersionId,
  finalVersionId,
  seedBoardRevision,
  quickBoardRevision,
  finalBoardRevision,
  finalScreenName,
}) {
  const runs = await queryDatabase(`
    SELECT id, status
    FROM workbench.runs
    WHERE id = ANY($1::text[])
    ORDER BY id
  `, [[seedRunId, quickRunId, directRunId]]);
  assert.equal(runs.rows.length, 3);
  assert.ok(runs.rows.every((run) => run.status === "succeeded"));

  const artifact = await queryDatabase(`
    SELECT artifact.id, artifact.current_version_id, board.revision AS board_revision,
           version.status, version.created_by_run_id, version.content
    FROM workbench.artifacts AS artifact
    JOIN workbench.artifact_versions AS version ON version.id = artifact.current_version_id
    JOIN workbench.boards AS board ON board.project_id = artifact.project_id
    WHERE artifact.project_id = $1 AND artifact.kind = 'prototype'
  `, [projectId]);
  assert.equal(artifact.rows.length, 1);
  assert.equal(artifact.rows[0]?.current_version_id, finalVersionId);
  assert.equal(artifact.rows[0]?.status, "ready");
  assert.equal(artifact.rows[0]?.created_by_run_id, directRunId);
  assert.equal(artifact.rows[0]?.board_revision, finalBoardRevision);
  assert.equal(
    artifact.rows[0]?.content?.screens?.find((screen) => screen.id === "screen-home")?.name,
    finalScreenName,
  );

  const versions = await queryDatabase(`
    SELECT id, status, created_by_run_id
    FROM workbench.artifact_versions
    WHERE project_id = $1 AND id = ANY($2::text[])
    ORDER BY version
  `, [projectId, [seededVersionId, quickVersionId, finalVersionId]]);
  assert.deepEqual(
    versions.rows.map((version) => ({ status: version.status, runId: version.created_by_run_id })),
    [
      { status: "ready", runId: seedRunId },
      { status: "ready", runId: quickRunId },
      { status: "ready", runId: directRunId },
    ],
  );

  const sessions = await queryDatabase(`
    SELECT session.id, session.run_id, session.status, session.board_revision,
           session.canvas_state_revision, session.invocation_sequence,
           session.active_mutation_tool_call_id, tool_grant.revoked_at
    FROM workbench.canvas_agent_sessions AS session
    JOIN workbench.canvas_tool_grants AS tool_grant ON tool_grant.agent_session_id = session.id
    WHERE session.run_id = ANY($1::text[])
    ORDER BY session.created_at
  `, [[quickRunId, directRunId]]);
  assert.equal(sessions.rows.length, 2);
  const quickSession = sessions.rows.find((session) => session.run_id === quickRunId);
  const directSession = sessions.rows.find((session) => session.run_id === directRunId);
  assert.equal(quickSession?.status, "completed");
  assert.equal(quickSession?.board_revision, quickBoardRevision);
  assert.equal(quickSession?.canvas_state_revision, 2);
  assert.equal(quickSession?.invocation_sequence, 6);
  assert.equal(quickSession?.active_mutation_tool_call_id, null);
  assert.ok(quickSession?.revoked_at instanceof Date);
  assert.equal(directSession?.status, "completed");
  assert.equal(directSession?.board_revision, finalBoardRevision);
  assert.equal(directSession?.invocation_sequence, 3);
  assert.equal(directSession?.active_mutation_tool_call_id, null);
  assert.ok(directSession?.revoked_at instanceof Date);

  const invocations = await queryDatabase(`
    SELECT invocation.id, invocation.run_id, invocation.sequence,
           invocation.tool_call_id, invocation.tool_name, invocation.status,
           invocation.response, invocation.satisfies_run_target,
           invocation.result_artifact_version_id,
           invocation.board_revision_before, invocation.board_revision_after,
           invocation.canvas_state_revision_before, invocation.canvas_state_revision_after
    FROM workbench.canvas_tool_invocations AS invocation
    WHERE invocation.run_id = ANY($1::text[])
    ORDER BY invocation.run_id, invocation.sequence
  `, [[quickRunId, directRunId]]);
  const quickInvocations = invocations.rows.filter((invocation) => invocation.run_id === quickRunId);
  const directInvocations = invocations.rows.filter((invocation) => invocation.run_id === directRunId);
  const quickInvocationTools = quickInvocations.map((invocation) => invocation.tool_name);
  const directInvocationTools = directInvocations.map((invocation) => invocation.tool_name);
  assert.deepEqual(quickInvocationTools, [
    "get_visible_screens",
    "get_selected_screens",
    "view_screen",
    "select_screen",
    "navigate_canvas",
    "quick_edit",
  ]);
  assert.deepEqual(directInvocationTools, [
    "get_selected_screens",
    "rename_screen",
    "duplicate_screen",
  ]);
  assert.ok(invocations.rows.every((invocation) => invocation.status === "succeeded"));
  assert.ok(quickInvocations.slice(0, 5).every((invocation) => (
    invocation.satisfies_run_target === false
    && invocation.result_artifact_version_id === null
  )));
  assert.equal(quickInvocations[5]?.satisfies_run_target, true);
  assert.equal(quickInvocations[5]?.result_artifact_version_id, quickVersionId);
  assert.equal(directInvocations[0]?.satisfies_run_target, false);
  assert.equal(directInvocations[0]?.result_artifact_version_id, null);
  assert.ok(directInvocations.slice(1).every((invocation) => (
    invocation.satisfies_run_target === true
    && invocation.result_artifact_version_id === finalVersionId
  )));
  assert.ok(quickInvocations.every((invocation) => invocation.board_revision_before === seedBoardRevision));
  assert.ok(directInvocations.every((invocation) => invocation.board_revision_before === quickBoardRevision));

  const commands = await queryDatabase(`
    SELECT command.id, command.status, command.command, command.acknowledgement,
           command.acknowledged_at, invocation.response
    FROM workbench.canvas_client_commands AS command
    JOIN workbench.canvas_tool_invocations AS invocation ON invocation.id = command.invocation_id
    WHERE command.run_id = $1
    ORDER BY command.created_at, command.id
  `, [quickRunId]);
  assert.equal(commands.rows.length, 3);
  assert.ok(commands.rows.every((command) => command.status === "acknowledged"));
  assert.ok(commands.rows.every((command) => command.acknowledged_at instanceof Date));
  for (const command of commands.rows) {
    assert.equal(command.acknowledgement?.status, "applied");
    assert.equal(command.acknowledgement?.commandId, command.id);
    assert.deepEqual(command.acknowledgement?.result, command.response?.data);
  }

  const boardNodes = await queryDatabase(`
    SELECT node_key, artifact_version_id, data->>'screenId' AS screen_id
    FROM workbench.board_nodes
    WHERE project_id = $1 AND artifact_version_id = $2
    ORDER BY sort_order, node_key
  `, [projectId, finalVersionId]);
  assert.equal(boardNodes.rows.length, 2);
  assert.ok(boardNodes.rows.every((node) => node.artifact_version_id === finalVersionId));
  assert.ok(boardNodes.rows.some((node) => node.screen_id === "screen-home"));
  assert.equal(new Set(boardNodes.rows.map((node) => node.node_key)).size, 2);

  return { quickInvocationTools, directInvocationTools };
}

async function runProjectLifecycleScenario(ownerClient, sharedClient, inviteeClient) {
  console.log("[e2e] running Project membership, invitation, duplicate, search, and archive scenario");
  const ownerIdentity = await ownerClient.json("GET", "/identity/me");
  const sharedIdentity = await sharedClient.json("GET", "/identity/me");
  const workspaceId = ownerIdentity.body.defaultWorkspaceId;
  await queryDatabase(`
    INSERT INTO "workspace_members" (
      "workspace_id", "principal_id", "role", "updated_at"
    ) VALUES ($1, $2, 'member', clock_timestamp())
    ON CONFLICT ("workspace_id", "principal_id") DO NOTHING
  `, [workspaceId, sharedIdentity.body.id]);

  const source = await ownerClient.json("POST", `/workspaces/${workspaceId}/projects`, {
    body: { title: "Lifecycle Search Needle", summary: "private project lifecycle" },
    expectedStatus: 201,
  });
  assert.equal(source.headers.get("etag"), '"0"');

  const owned = await ownerClient.json(
    "GET",
    "/projects?q=search%20needle&relationship=owned&limit=1",
  );
  assert.equal(owned.body.items.length, 1);
  assert.equal(owned.body.items[0].id, source.body.id);
  assert.equal(owned.body.items[0].role, "owner");
  assert.equal(owned.body.items[0].relationship, "owned");

  const beforeShare = await sharedClient.json(
    "GET",
    "/projects?relationship=shared",
  );
  assert.equal(beforeShare.body.items.length, 0);
  await sharedClient.json("GET", `/projects/${source.body.id}/bootstrap`, {
    expectedStatus: 404,
  });

  const added = await ownerClient.json(
    "PUT",
    `/projects/${source.body.id}/members/${sharedIdentity.body.id}`,
    {
      headers: { "If-Match": '"0"' },
      body: { role: "viewer" },
    },
  );
  assert.equal(added.body.role, "viewer");
  assert.equal(added.headers.get("etag"), '"1"');

  const noOp = await ownerClient.json(
    "PUT",
    `/projects/${source.body.id}/members/${sharedIdentity.body.id}`,
    {
      headers: { "If-Match": '"1"' },
      body: { role: "viewer" },
    },
  );
  assert.equal(noOp.headers.get("etag"), '"1"');

  const invitationKey = `e2e-project-invitation-${randomUUID()}`;
  const invitationRequest = {
    email: "WORKBENCH-E2E-INVITEE@test.local",
    role: "editor",
  };
  const invitation = await ownerClient.json(
    "POST",
    `/projects/${source.body.id}/invitations`,
    {
      headers: {
        "If-Match": '"1"',
        "Idempotency-Key": invitationKey,
      },
      body: invitationRequest,
      expectedStatus: 201,
    },
  );
  assert.equal(invitation.headers.get("etag"), '"2"');
  assert.equal(invitation.body.invitation.email, "workbench-e2e-invitee@test.local");
  assert.equal(invitation.body.invitation.status, "pending");
  assert.equal(invitation.body.deliveryStatus, "not_configured");
  assert.match(invitation.body.token, /^wbi_/);

  const invitationReplay = await ownerClient.json(
    "POST",
    `/projects/${source.body.id}/invitations`,
    {
      headers: {
        "If-Match": '"1"',
        "Idempotency-Key": invitationKey,
      },
      body: invitationRequest,
      expectedStatus: 201,
    },
  );
  assert.equal(invitationReplay.headers.get("etag"), '"2"');
  assert.equal(invitationReplay.body.invitation.id, invitation.body.invitation.id);
  assert.equal(invitationReplay.body.token, invitation.body.token);

  const pendingInvitations = await ownerClient.json(
    "GET",
    `/projects/${source.body.id}/invitations?status=pending`,
  );
  assert.equal(pendingInvitations.body.items.length, 1);
  assert.equal(pendingInvitations.body.items[0].token, invitation.body.token);
  await sharedClient.json("POST", "/project-invitations/preview", {
    body: { token: invitation.body.token },
    expectedStatus: 409,
  });
  const preview = await inviteeClient.json("POST", "/project-invitations/preview", {
    body: { token: invitation.body.token },
  });
  assert.equal(preview.body.projectId, source.body.id);
  assert.equal(preview.body.role, "editor");

  const accepted = await inviteeClient.json("POST", "/project-invitations/accept", {
    body: { token: invitation.body.token },
  });
  assert.equal(accepted.headers.get("etag"), '"3"');
  assert.equal(accepted.body.invitation.status, "accepted");
  assert.equal(accepted.body.member.role, "editor");
  const acceptedReplay = await inviteeClient.json("POST", "/project-invitations/accept", {
    body: { token: invitation.body.token },
  });
  assert.equal(acceptedReplay.headers.get("etag"), '"3"');
  assert.equal(acceptedReplay.body.invitation.id, invitation.body.invitation.id);
  await inviteeClient.json("GET", `/projects/${source.body.id}/bootstrap`);
  const inviteeWorkspaceMembership = await queryDatabase(`
    SELECT count(*)::int AS count
    FROM "workspace_members"
    WHERE "workspace_id" = $1 AND "principal_id" = $2
  `, [workspaceId, accepted.body.member.principalId]);
  assert.equal(
    inviteeWorkspaceMembership.rows[0]?.count,
    0,
    "accepting a Project invitation granted Workspace membership",
  );

  const revokeCandidate = await ownerClient.json(
    "POST",
    `/projects/${source.body.id}/invitations`,
    {
      headers: {
        "If-Match": '"3"',
        "Idempotency-Key": `e2e-project-invitation-revoke-${randomUUID()}`,
      },
      body: { email: "workbench-e2e-revoked@test.local", role: "viewer" },
      expectedStatus: 201,
    },
  );
  assert.equal(revokeCandidate.headers.get("etag"), '"4"');
  const revoked = await ownerClient.json(
    "DELETE",
    `/projects/${source.body.id}/invitations/${revokeCandidate.body.invitation.id}`,
    { headers: { "If-Match": '"4"' } },
  );
  assert.equal(revoked.headers.get("etag"), '"5"');
  assert.equal(revoked.body.status, "revoked");

  const shared = await sharedClient.json(
    "GET",
    "/projects?q=lifecycle&relationship=shared",
  );
  assert.equal(shared.body.items.length, 1);
  assert.equal(shared.body.items[0].relationship, "shared");
  await sharedClient.json("GET", `/projects/${source.body.id}/bootstrap`);
  await sharedClient.json("PATCH", `/projects/${source.body.id}`, {
    headers: { "If-Match": '"5"' },
    body: { title: "Viewer cannot edit" },
    expectedStatus: 404,
  });

  const duplicateKey = `e2e-project-duplicate-${randomUUID()}`;
  const duplicate = await sharedClient.json("POST", `/projects/${source.body.id}/duplicate`, {
    headers: { "Idempotency-Key": duplicateKey },
    body: { title: "Viewer-owned duplicate" },
    expectedStatus: 201,
  });
  const duplicateReplay = await sharedClient.json("POST", `/projects/${source.body.id}/duplicate`, {
    headers: { "Idempotency-Key": duplicateKey },
    body: { title: "Viewer-owned duplicate" },
    expectedStatus: 201,
  });
  assert.equal(duplicateReplay.body.project.id, duplicate.body.project.id);
  assert.notEqual(duplicate.body.project.id, source.body.id);
  const duplicateBootstrap = await sharedClient.json(
    "GET",
    `/projects/${duplicate.body.project.id}/bootstrap`,
  );
  assert.equal(duplicateBootstrap.body.threads.length, 1);
  assert.equal(duplicateBootstrap.body.entries.length, 0);
  assert.equal(duplicateBootstrap.body.latestRun, null);

  const archived = await ownerClient.json("DELETE", `/projects/${source.body.id}`, {
    headers: { "If-Match": '"5"' },
  });
  assert.equal(archived.body.status, "archived");
  assert.equal(archived.headers.get("etag"), '"6"');
  await ownerClient.json("GET", `/projects/${source.body.id}/bootstrap`, {
    expectedStatus: 404,
  });

  return {
    sourceProjectId: source.body.id,
    duplicateProjectId: duplicate.body.project.id,
    sharedPrincipalId: sharedIdentity.body.id,
    invitationId: invitation.body.invitation.id,
    invitedPrincipalId: accepted.body.member.principalId,
    revokedInvitationId: revoked.body.id,
  };
}

async function runSseRevocationScenario(ownerClient, viewerClient) {
  console.log("[e2e] running live SSE membership revocation scenario");
  const owner = await ownerClient.json("GET", "/identity/me");
  const viewer = await viewerClient.json("GET", "/identity/me");
  const workspaceId = owner.body.defaultWorkspaceId;
  await queryDatabase(`
    INSERT INTO "workspace_members" (
      "workspace_id", "principal_id", "role", "updated_at"
    ) VALUES ($1, $2, 'member', clock_timestamp())
    ON CONFLICT ("workspace_id", "principal_id") DO NOTHING
  `, [workspaceId, viewer.body.id]);
  const project = await ownerClient.json("POST", `/workspaces/${workspaceId}/projects`, {
    body: { title: "Workbench SSE Revocation E2E" },
    expectedStatus: 201,
  });
  const bootstrap = await ownerClient.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = bootstrap.body.selectedThreadId;
  const added = await ownerClient.json(
    "PUT",
    `/projects/${project.body.id}/members/${viewer.body.id}`,
    {
      headers: { "If-Match": '"0"' },
      body: { role: "viewer" },
    },
  );
  assert.equal(added.body.role, "viewer");

  const runId = `sse-revocation-${randomUUID()}`;
  const requestId = `sse-revocation-request-${randomUUID()}`;
  const traceId = `sse-revocation-trace-${randomUUID()}`;
  const executionOwnerId = `sse-revocation-fixture:${randomUUID()}`;
  const runRequest = {
    prompt: "SSE authorization boundary",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: [],
  };
  await queryDatabase(`
    WITH inserted_run AS (
      INSERT INTO "runs" (
        "id", "project_id", "thread_id", "created_by_id", "idempotency_key",
        "request_hash", "request_id", "request", "status", "model_id", "trace_id",
        "event_sequence", "attempt", "execution_owner_id", "execution_epoch",
        "execution_heartbeat_at", "execution_lease_expires_at",
        "started_at", "created_at", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, repeat('a', 64), $6, $7::jsonb, 'running',
        $8, $9, 1, 1, $10, 1, clock_timestamp(),
        clock_timestamp() + interval '5 minutes',
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
      RETURNING "id"
    )
    INSERT INTO "run_events" (
      "id", "run_id", "sequence", "type", "payload", "trace_id", "occurred_at"
    )
    SELECT $11, "id", 1, 'run.started', '{"attempt":1}'::jsonb, $9, clock_timestamp()
    FROM inserted_run
  `, [
    runId,
    project.body.id,
    threadId,
    owner.body.id,
    `sse-revocation-${randomUUID()}`,
    requestId,
    JSON.stringify(runRequest),
    runtimeCatalogModelId,
    traceId,
    executionOwnerId,
    `sse-revocation-event-${randomUUID()}`,
  ]);

  const stream = await viewerClient.openSse(`/runs/${runId}/events?afterSequence=0`);
  await waitFor(
    () => stream.observed.some((event) => event.data.sequence === 1),
    scenarioTimeoutMs,
    "SSE client did not receive its authorized baseline event",
  );

  await ownerClient.json("DELETE", `/projects/${project.body.id}/members/${viewer.body.id}`, {
    headers: { "If-Match": '"1"' },
    expectedStatus: 204,
  });
  await queryDatabase(`
    WITH advanced AS (
      UPDATE "runs"
      SET "event_sequence" = "event_sequence" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $1
      RETURNING "id", "event_sequence", "trace_id"
    )
    INSERT INTO "run_events" (
      "id", "run_id", "sequence", "type", "payload", "trace_id", "occurred_at"
    )
    SELECT
      $2,
      "id",
      "event_sequence",
      'activity.changed',
      '{"activityId":"revoked-sentinel","status":"running","label":"Must remain private","detail":null}'::jsonb,
      "trace_id",
      clock_timestamp()
    FROM advanced
  `, [runId, `sse-revocation-event-${randomUUID()}`]);

  const events = await stream.events;
  assert.deepEqual(events.map((event) => event.data.sequence), [1]);
  assert.ok(!events.some((event) => event.data.payload?.activityId === "revoked-sentinel"));
  await viewerClient.json("GET", `/runs/${runId}`, { expectedStatus: 404 });
  await queryDatabase('DELETE FROM "runs" WHERE "id" = $1', [runId]);

  return {
    projectId: project.body.id,
    runId,
    deliveredSequences: events.map((event) => event.data.sequence),
  };
}

async function runApprovalScenario(client) {
  console.log("[e2e] running multiple durable approvals and checkpoint resume scenario");
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json("POST", `/workspaces/${identity.body.defaultWorkspaceId}/projects`, {
    body: { title: "Workbench Approval E2E" },
    expectedStatus: 201,
  });
  const initial = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = initial.body.selectedThreadId;
  assert.equal(typeof threadId, "string");
  const sourceFixtures = await seedRunSourceFixtures({
    projectId: project.body.id,
    principalId: identity.body.id,
    label: "approval",
  });
  const request = {
    prompt: "E2E_APPROVAL: require two independent decisions before publishing",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    requestedArtifactKinds: ["prd"],
  };
  const attachments = existingSubmissionAttachments(
    sourceFixtures.map((fixture) => fixture.fileAssetId),
  );
  const run = await startRunThroughSubmissionIntent(client, {
    threadId,
    request,
    attachments,
    idempotencyKey: `e2e-approval-${randomUUID()}`,
  });
  const typedOptions = assertRunTypedOptions(run.body, request);
  const sourceSnapshots = assertRunSourceSnapshots(run.body, sourceFixtures);
  const stream = client.sse(`/runs/${run.body.id}/events?afterSequence=0`);

  await waitFor(async () => {
    const current = await client.json("GET", `/runs/${run.body.id}`);
    return current.body.status === "waiting_input";
  }, scenarioTimeoutMs, "Run never reached waiting_input");

  const pending = await client.json("GET", `/runs/${run.body.id}/approvals`);
  assert.equal(pending.body.items.length, 2);
  assert.ok(pending.body.items.every((approval) => approval.status === "pending"));
  const gatewayUploadCountBeforeResume = fakeRuntime.state.gatewayUploads.length;

  const first = pending.body.items[0];
  const second = pending.body.items[1];
  const firstDecision = await client.json(
    "POST",
    `/runs/${run.body.id}/approvals/${first.id}`,
    {
      body: { decision: "approve" },
      headers: { "Idempotency-Key": `e2e-approval-first-${randomUUID()}` },
      expectedStatus: 202,
    },
  );
  assert.equal(firstDecision.body.approval.status, "approved");
  assert.equal(firstDecision.body.run.status, "waiting_input");
  assertRunTypedOptions(firstDecision.body.run, request, typedOptions);
  assertRunSourceSnapshots(firstDecision.body.run, sourceFixtures, sourceSnapshots);
  const stillWaiting = await client.json("GET", `/runs/${run.body.id}`);
  assert.equal(stillWaiting.body.status, "waiting_input");
  assertRunTypedOptions(stillWaiting.body, request, typedOptions);
  assertRunSourceSnapshots(stillWaiting.body, sourceFixtures, sourceSnapshots);

  const secondDecision = await client.json(
    "POST",
    `/runs/${run.body.id}/approvals/${second.id}`,
    {
      body: { decision: "submit", value: { direction: "quality" } },
      headers: { "Idempotency-Key": `e2e-approval-second-${randomUUID()}` },
      expectedStatus: 202,
    },
  );
  assert.equal(secondDecision.body.approval.status, "submitted");
  assert.equal(secondDecision.body.run.status, "queued");
  assertRunTypedOptions(secondDecision.body.run, request, typedOptions);
  assertRunSourceSnapshots(secondDecision.body.run, sourceFixtures, sourceSnapshots);

  const events = await stream;
  assertOrderedEvents(events, { runId: run.body.id, firstSequence: 1 });
  assert.equal(events.filter((event) => event.data.type === "run.input.required").length, 2);
  assert.equal(events.filter((event) => event.data.type === "run.input.submitted").length, 2);
  assert.ok(events.some((event) => event.data.type === "run.queued" && event.data.sequence > 1));
  assert.equal(events.at(-1)?.data.type, "run.completed");

  const terminal = await client.json("GET", `/runs/${run.body.id}`);
  assert.equal(terminal.body.status, "succeeded");
  assert.equal(terminal.body.attempt, 2);
  assert.equal(terminal.body.lastEventSequence, events.length);
  assertRunTypedOptions(terminal.body, request, typedOptions);
  assertRunSourceSnapshots(terminal.body, sourceFixtures, sourceSnapshots);
  assert.equal(
    fakeRuntime.state.gatewayUploads.length,
    gatewayUploadCountBeforeResume,
    "approval resume re-uploaded immutable Run sources",
  );
  await assertPersistedRunSources(run.body.id, sourceFixtures, sourceSnapshots);
  assertRuntimeSourceIsolation(run.body.id, sourceFixtures, sourceSnapshots, request);
  const decided = await client.json("GET", `/runs/${run.body.id}/approvals`);
  assert.deepEqual(decided.body.items.map((approval) => approval.status), ["approved", "submitted"]);

  return {
    runId: run.body.id,
    approvalCount: decided.body.items.length,
    eventCount: events.length,
    attempt: terminal.body.attempt,
    sourceCount: sourceSnapshots.length,
    runtimeContentCount: runtimeContentCount(sourceFixtures),
  };
}

async function runCancellationScenario(client) {
  console.log("[e2e] running in-flight cancellation scenario");
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json("POST", `/workspaces/${identity.body.defaultWorkspaceId}/projects`, {
    body: { title: "Workbench Cancellation E2E" },
    expectedStatus: 201,
  });
  const initial = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = initial.body.threads[0].id;
  const sourceFixtures = await seedRunSourceFixtures({
    projectId: project.body.id,
    principalId: identity.body.id,
    label: "cancel",
  });
  const request = {
    prompt: "E2E_CANCEL: hold the fake runtime stream until cancellation",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    requestedArtifactKinds: ["prd"],
  };
  const attachments = existingSubmissionAttachments(
    sourceFixtures.map((fixture) => fixture.fileAssetId),
  );
  const run = await startRunThroughSubmissionIntent(client, {
    threadId,
    request,
    attachments,
    idempotencyKey: `e2e-cancel-${randomUUID()}`,
  });
  assert.deepEqual(run.body.requestedArtifactKinds, ["prd"]);
  const typedOptions = assertRunTypedOptions(run.body, request);
  const sourceSnapshots = assertRunSourceSnapshots(run.body, sourceFixtures);

  await waitFor(async () => {
    const current = await client.json("GET", `/runs/${run.body.id}`);
    return current.body.status === "running";
  }, scenarioTimeoutMs, "Run never reached running before cancellation");
  await waitFor(
    () => fakeRuntime.state.activeCancelStreams > 0,
    scenarioTimeoutMs,
    "fake DeerFlow never opened the cancellation stream",
  );

  const stream = client.sse(`/runs/${run.body.id}/events?afterSequence=0`);
  const cancel = await client.json("POST", `/runs/${run.body.id}/cancel`, {
    headers: { "Idempotency-Key": `e2e-cancel-command-${randomUUID()}` },
    expectedStatus: 202,
  });
  assert.ok(["cancelling", "cancelled"].includes(cancel.body.status));
  assertRunTypedOptions(cancel.body, request, typedOptions);
  assertRunSourceSnapshots(cancel.body, sourceFixtures, sourceSnapshots);

  const events = await stream;
  assertOrderedEvents(events, { runId: run.body.id, firstSequence: 1 });
  assert.equal(events.at(-1)?.data.type, "run.cancelled");
  assert.ok(events.some((event) => event.data.type === "run.cancel.requested"));
  assert.ok(!events.some((event) => event.data.type === "artifact.version.created"));
  assert.ok(!events.some((event) => event.data.type === "run.completed"));

  const terminal = await client.json("GET", `/runs/${run.body.id}`);
  assert.equal(terminal.body.status, "cancelled");
  assert.equal(terminal.body.cancellationReason, "Cancelled by user");
  assert.equal(terminal.body.lastEventSequence, events.length);
  assertRunTypedOptions(terminal.body, request, typedOptions);
  assertRunSourceSnapshots(terminal.body, sourceFixtures, sourceSnapshots);
  const completed = await client.json("GET", `/projects/${project.body.id}/bootstrap?threadId=${threadId}`);
  assert.equal(completed.body.selectedThreadId, threadId);
  assert.equal(completed.body.latestRun.id, run.body.id);
  assert.equal(completed.body.latestRun.status, "cancelled");
  assertRunTypedOptions(completed.body.latestRun, request, typedOptions);
  assertRunSourceSnapshots(completed.body.latestRun, sourceFixtures, sourceSnapshots);
  assert.equal(completed.body.artifacts.length, 0);
  assert.equal(completed.body.board.nodes.length, 0);

  const persisted = await queryDatabase(`
    SELECT
      r.status,
      r.event_sequence,
      r.cancellation_reason,
      count(av.id)::int AS artifact_version_count
    FROM workbench.runs r
    LEFT JOIN workbench.artifact_versions av ON av.created_by_run_id = r.id
    WHERE r.id = $1
    GROUP BY r.status, r.event_sequence, r.cancellation_reason
  `, [run.body.id]);
  assert.equal(persisted.rows[0]?.status, "cancelled");
  assert.equal(persisted.rows[0]?.event_sequence, events.length);
  assert.equal(persisted.rows[0]?.cancellation_reason, "Cancelled by user");
  assert.equal(persisted.rows[0]?.artifact_version_count, 0);
  await assertPersistedRunSources(run.body.id, sourceFixtures, sourceSnapshots);
  assertRuntimeSourceIsolation(run.body.id, sourceFixtures, sourceSnapshots, request);

  return {
    runId: run.body.id,
    eventCount: events.length,
    status: terminal.body.status,
    sourceCount: sourceSnapshots.length,
    runtimeContentCount: runtimeContentCount(sourceFixtures),
  };
}

async function runRetryScenario(client) {
  console.log("[e2e] running persisted-request Run retry scenario");
  const identity = await client.json("GET", "/identity/me");
  const project = await client.json("POST", `/workspaces/${identity.body.defaultWorkspaceId}/projects`, {
    body: { title: "Workbench Retry E2E" },
    expectedStatus: 201,
  });
  const initial = await client.json("GET", `/projects/${project.body.id}/bootstrap`);
  const threadId = initial.body.selectedThreadId;
  assert.equal(typeof threadId, "string");

  const request = {
    prompt: "E2E_RETRY: recreate this Run from its persisted request",
    modelId: runtimeCatalogModelId,
    workflow: "generate",
    generationIntent: null,
    targetSurface: "app",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: ["prd"],
    canvasSnapshot: null,
  };
  const sourceRunId = `retry-source-${randomUUID()}`;
  const terminalSourceRunId = `retry-terminal-${randomUUID()}`;
  await queryDatabase(`
    INSERT INTO workbench.runs (
      id, project_id, thread_id, created_by_id, idempotency_key, request_hash,
      request_id, request, status, model_id, trace_id, error_code, error_detail,
      error_retryable, finished_at, created_at, updated_at
    ) VALUES
      ($1, $2, $3, $4, $5, repeat('e', 64), $6, $7::jsonb, 'failed', $8, $9,
       'TEMPORARY_RUNTIME_FAILURE', 'Retryable E2E source', TRUE,
       clock_timestamp(), clock_timestamp(), clock_timestamp()),
      ($10, $2, $3, $4, $11, repeat('f', 64), $12, $7::jsonb, 'failed', $8, $13,
       'INVALID_REQUEST', 'Terminal E2E source', FALSE,
       clock_timestamp(), clock_timestamp(), clock_timestamp())
  `, [
    sourceRunId,
    project.body.id,
    threadId,
    identity.body.id,
    `source-${randomUUID()}`,
    `source-request-${randomUUID()}`,
    JSON.stringify(request),
    request.modelId,
    `source-trace-${randomUUID()}`,
    terminalSourceRunId,
    `terminal-${randomUUID()}`,
    `terminal-request-${randomUUID()}`,
    `terminal-trace-${randomUUID()}`,
  ]);

  const terminalRetry = await client.json("POST", `/runs/${terminalSourceRunId}/retry`, {
    headers: { "Idempotency-Key": `e2e-retry-terminal-${randomUUID()}` },
    expectedStatus: 409,
  });
  assert.equal(terminalRetry.body.code, "RUN_RETRY_NOT_ALLOWED");

  const idempotencyKey = `e2e-retry-${randomUUID()}`;
  const first = await client.json("POST", `/runs/${sourceRunId}/retry`, {
    headers: { "Idempotency-Key": idempotencyKey },
    expectedStatus: 202,
  });
  assert.equal(first.body.retryOfRunId, sourceRunId);
  assertRunTypedOptions(first.body, request);

  const duplicate = await client.json("POST", `/runs/${sourceRunId}/retry`, {
    headers: { "Idempotency-Key": idempotencyKey },
    expectedStatus: 202,
  });
  assert.equal(duplicate.body.id, first.body.id);
  assert.equal(duplicate.body.retryOfRunId, sourceRunId);

  await waitFor(async () => {
    const current = await client.json("GET", `/runs/${first.body.id}`);
    return current.body.status === "succeeded";
  }, scenarioTimeoutMs, "Retried Run never succeeded");

  const persisted = await queryDatabase(`
    SELECT retry.id AS retry_id, retry.retry_of_run_id, retry.request,
           source.status AS source_status, source.error_retryable AS source_retryable
    FROM workbench.runs AS retry
    JOIN workbench.runs AS source ON source.id = retry.retry_of_run_id
    WHERE retry.id = $1
  `, [first.body.id]);
  assert.equal(persisted.rows[0]?.retry_of_run_id, sourceRunId);
  assert.deepEqual(persisted.rows[0]?.request, request);
  assert.equal(persisted.rows[0]?.source_status, "failed");
  assert.equal(persisted.rows[0]?.source_retryable, true);

  return {
    sourceRunId,
    retriedRunId: first.body.id,
    idempotentReplayRunId: duplicate.body.id,
  };
}

async function seedRunSourceFixtures({ projectId, principalId, label }) {
  const token = randomUUID();
  const definitions = [
    {
      suffix: "brief",
      originalName: `${label}-brief.txt`,
      mediaType: "text/plain",
      bytes: Buffer.from(`Private ${label} source brief ${token}\n`, "utf8"),
      extraction: Buffer.from(`# Normalized ${label} brief\n\n${token}\n`, "utf8"),
    },
    {
      suffix: "requirements",
      originalName: `${label}-requirements.json`,
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify({ label, token, requirement: "ordered snapshots" }), "utf8"),
      extraction: null,
    },
  ];
  const fixtures = definitions.map((definition) => {
    const idSuffix = `${label}-${definition.suffix}-${token}`;
    const storageKey = `private/e2e/${token}/${definition.suffix}/original`;
    const stagingKey = `private/e2e/${token}/${definition.suffix}/staging`;
    const providerUploadId = `private-provider-upload-${idSuffix}`;
    const extractionBytes = definition.extraction;
    return {
      ...definition,
      fileAssetId: `file-${idSuffix}`,
      blobId: `blob-${idSuffix}`,
      scanId: `scan-${idSuffix}`,
      uploadSessionId: `upload-${idSuffix}`,
      storageKey,
      stagingKey,
      providerUploadId,
      sha256: sha256(definition.bytes),
      byteSize: definition.bytes.byteLength,
      extractionId: extractionBytes ? `extraction-${idSuffix}` : null,
      extractionBlobId: extractionBytes ? `blob-extraction-${idSuffix}` : null,
      extractionStorageKey: extractionBytes
        ? `private/e2e/${token}/${definition.suffix}/normalized`
        : null,
      extractionSha256: extractionBytes ? sha256(extractionBytes) : null,
    };
  });

  const client = new Client({
    connectionString: pgConnectionUrl(databaseUrl),
    application_name: "workbench-e2e-source-fixtures",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query('SET LOCAL search_path TO "workbench"');
    for (const fixture of fixtures) {
      await client.query(`
        INSERT INTO workbench.blobs (
          id, sha256, generation, storage_key, media_type, byte_size, status,
          verified_at, gc_eligible_at, deleted_at, created_at, updated_at
        ) VALUES ($1, $2, 1, $3, $4, $5, 'pending', NULL, NULL, NULL, clock_timestamp(), clock_timestamp())
      `, [fixture.blobId, fixture.sha256, fixture.storageKey, fixture.mediaType, fixture.byteSize]);
      await client.query(`
        INSERT INTO workbench.blob_scans (
          id, blob_id, attempt, status, scanner, scanner_version, signature_version,
          evidence, failure_code, failure_detail, started_at, finished_at, created_at, updated_at
        ) VALUES (
          $1, $2, 1, 'clean', 'workbench-e2e-scanner', '1', 'e2e-signatures-1',
          $3::jsonb, NULL, NULL, clock_timestamp(), clock_timestamp(), clock_timestamp(), clock_timestamp()
        )
      `, [fixture.scanId, fixture.blobId, JSON.stringify({ verdict: "clean", fixture: label })]);
      await client.query(`
        UPDATE workbench.blobs
        SET status = 'ready', verified_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1
      `, [fixture.blobId]);
      await client.query(`
        INSERT INTO workbench.file_assets (
          id, project_id, blob_id, current_extraction_id, uploaded_by_id,
          original_name, declared_media_type, detected_media_type, byte_size,
          status, revision, failure_code, failure_detail, metadata, verified_at,
          deleted_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, NULL, $4, $5, $6, $6, $7,
          'ready', 0, NULL, NULL, $8::jsonb, clock_timestamp(),
          NULL, clock_timestamp(), clock_timestamp()
        )
      `, [
        fixture.fileAssetId,
        projectId,
        fixture.blobId,
        principalId,
        fixture.originalName,
        fixture.mediaType,
        fixture.byteSize,
        JSON.stringify({ fixture: label, privateStorageKey: fixture.storageKey }),
      ]);
      await client.query(`
        INSERT INTO workbench.file_upload_sessions (
          id, project_id, file_asset_id, provider, provider_upload_id, staging_key,
          status, expected_byte_size, expected_sha256, part_size, revision,
          idempotency_key, request_hash, completion_idempotency_key,
          completion_request_hash, failure_code, failure_detail, expires_at,
          completed_at, aborted_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'private-e2e-provider', $4, $5,
          'completed', $6, $7, 5242880, 0,
          $8, $9, $10, $11, NULL, NULL,
          clock_timestamp() + interval '1 day', clock_timestamp(), NULL,
          clock_timestamp(), clock_timestamp()
        )
      `, [
        fixture.uploadSessionId,
        projectId,
        fixture.fileAssetId,
        fixture.providerUploadId,
        fixture.stagingKey,
        fixture.byteSize,
        fixture.sha256,
        `e2e-create-${fixture.fileAssetId}`,
        sha256(Buffer.from(`create:${fixture.fileAssetId}`)),
        `e2e-complete-${fixture.fileAssetId}`,
        sha256(Buffer.from(`complete:${fixture.fileAssetId}`)),
      ]);

      if (fixture.extraction && fixture.extractionId && fixture.extractionBlobId
        && fixture.extractionStorageKey && fixture.extractionSha256) {
        await client.query(`
          INSERT INTO workbench.blobs (
            id, sha256, generation, storage_key, media_type, byte_size, status,
            verified_at, gc_eligible_at, deleted_at, created_at, updated_at
          ) VALUES (
            $1, $2, 1, $3, 'text/markdown', $4, 'ready',
            clock_timestamp(), NULL, NULL, clock_timestamp(), clock_timestamp()
          )
        `, [
          fixture.extractionBlobId,
          fixture.extractionSha256,
          fixture.extractionStorageKey,
          fixture.extraction.byteLength,
        ]);
        await client.query(`
          INSERT INTO workbench.file_extractions (
            id, file_asset_id, source_blob_id, attempt, status, parser,
            parser_version, output_schema_version, idempotency_key, request_hash,
            content_sha256, failure_code, failure_detail, metadata,
            started_at, finished_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, 1, 'queued', 'workbench-e2e-parser',
            '1', 1, $4, $5, NULL, NULL, NULL, $6::jsonb,
            NULL, NULL, clock_timestamp(), clock_timestamp()
          )
        `, [
          fixture.extractionId,
          fixture.fileAssetId,
          fixture.blobId,
          `e2e-extract-${fixture.fileAssetId}`,
          sha256(Buffer.from(`extract:${fixture.fileAssetId}`)),
          JSON.stringify({ fixture: label }),
        ]);
        await client.query(`
          UPDATE workbench.file_extractions
          SET status = 'running', processing_attempts = 1, submission_generation = 1,
              submission_started_at = clock_timestamp(), started_at = clock_timestamp(),
              updated_at = clock_timestamp()
          WHERE id = $1
        `, [fixture.extractionId]);
        await client.query(`
          INSERT INTO workbench.file_extraction_outputs (
            extraction_id, kind, position, blob_id, metadata, created_at
          ) VALUES ($1, 'text', 0, $2, $3::jsonb, clock_timestamp())
        `, [
          fixture.extractionId,
          fixture.extractionBlobId,
          JSON.stringify({ normalized: true }),
        ]);
        await client.query(`
          UPDATE workbench.file_extractions
          SET status = 'ready', content_sha256 = $2,
              finished_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = $1
        `, [fixture.extractionId, fixture.extractionSha256]);
        await client.query(`
          UPDATE workbench.file_assets
          SET current_extraction_id = $2, revision = revision + 1, updated_at = clock_timestamp()
          WHERE id = $1
        `, [fixture.fileAssetId, fixture.extractionId]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  for (const fixture of fixtures) {
    fakeRuntime.registerObject(fixture.storageKey, fixture.bytes, fixture.mediaType);
    if (fixture.extraction && fixture.extractionStorageKey) {
      fakeRuntime.registerObject(fixture.extractionStorageKey, fixture.extraction, "text/markdown");
    }
  }
  return fixtures;
}

function assertRunTypedOptions(run, request, expectedOptions) {
  const actual = {
    workflow: run.workflow,
    targetSurface: run.targetSurface,
    designStyle: run.designStyle,
  };
  const requested = {
    workflow: request.workflow,
    targetSurface: request.targetSurface,
    designStyle: request.designStyle,
  };
  assert.deepEqual(actual, requested, "Run response changed the submitted typed options");
  if (expectedOptions) {
    assert.deepEqual(actual, expectedOptions, "typed Run options changed across APIs");
  }
  return structuredClone(actual);
}

function assertRunSourceSnapshots(run, fixtures, expectedSnapshots) {
  assert.equal(run.sources.length, fixtures.length, "Run source snapshot count changed");
  assert.deepEqual(
    run.sources.map((source) => source.position),
    fixtures.map((_, position) => position),
    "Run source snapshot request order changed",
  );
  const publicKeys = [
    "checksum",
    "createdAt",
    "descriptor",
    "id",
    "kind",
    "label",
    "position",
    "projectId",
    "runId",
    "snapshot",
    "sourceId",
  ].sort();
  for (const [position, fixture] of fixtures.entries()) {
    const source = run.sources[position];
    assert.ok(source, `Run source ${position} is missing`);
    assert.deepEqual(Object.keys(source).sort(), publicKeys, "Run source exposed a non-contract field");
    assert.equal(source.runId, run.id);
    assert.equal(source.projectId, run.projectId);
    assert.equal(source.position, position);
    assert.equal(source.kind, "file");
    assert.equal(source.label, fixture.originalName);
    assert.equal(source.checksum, fixture.sha256);
    assert.deepEqual(source.descriptor, {
      kind: "file",
      fileAssetId: fixture.fileAssetId,
      originalName: fixture.originalName,
      mediaType: fixture.mediaType,
    });
    assert.deepEqual(source.snapshot, {
      protocol: "workbench.import-source-snapshot.v1",
      sourceRevision: 1,
      checksum: fixture.sha256,
      blobs: [{
        position: 0,
        blobId: fixture.blobId,
        role: "primary",
        path: fixture.originalName,
        mediaType: fixture.mediaType,
        byteSize: fixture.byteSize,
        sha256: fixture.sha256,
      }],
    });
    assert.equal(typeof source.sourceId, "string");
    assert.ok(source.sourceId.length > 0, "Run source id is missing");
    assert.ok(Number.isFinite(Date.parse(source.createdAt)), "Run source createdAt is not ISO datetime");
  }
  assertPrivateSourceDataAbsent(run.sources, fixtures, "Run source HTTP snapshot");
  if (expectedSnapshots) {
    assert.deepEqual(run.sources, expectedSnapshots, "immutable Run source snapshots changed across APIs");
  }
  return structuredClone(run.sources);
}

async function assertPersistedRunSources(runId, fixtures, expectedSnapshots) {
  const persisted = await queryDatabase(`
    SELECT
      snapshot.position,
      snapshot.source_id,
      snapshot.kind::text AS kind,
      snapshot.label,
      snapshot.checksum,
      snapshot.descriptor,
      snapshot.snapshot,
      source.status::text AS source_status,
      source.revision AS source_revision,
      source_blob.position AS blob_position,
      source_blob.file_asset_id,
      source_blob.blob_id,
      source_blob.role,
      source_blob.path,
      source_blob.media_type,
      source_blob.byte_size,
      source_blob.sha256,
      blob.storage_key,
      upload.provider,
      upload.provider_upload_id,
      upload.staging_key
    FROM workbench.run_source_snapshots AS snapshot
    JOIN workbench.import_sources AS source ON source.id = snapshot.source_id
    JOIN workbench.import_source_blobs AS source_blob ON source_blob.import_source_id = source.id
    JOIN workbench.blobs AS blob ON blob.id = source_blob.blob_id
    JOIN workbench.file_upload_sessions AS upload ON upload.file_asset_id = source_blob.file_asset_id
    WHERE snapshot.run_id = $1
    ORDER BY snapshot.position, source_blob.position
  `, [runId]);
  assert.equal(persisted.rows.length, fixtures.length);
  for (const [position, fixture] of fixtures.entries()) {
    const row = persisted.rows[position];
    const expected = expectedSnapshots[position];
    assert.equal(row?.position, position);
    assert.equal(row?.source_id, expected.sourceId);
    assert.equal(row?.kind, "file");
    assert.equal(row?.label, fixture.originalName);
    assert.equal(row?.checksum, fixture.sha256);
    assert.deepEqual(row?.descriptor, expected.descriptor);
    assert.deepEqual(row?.snapshot, expected.snapshot);
    assert.equal(row?.source_status, "ready");
    assert.equal(row?.source_revision, 1);
    assert.equal(row?.blob_position, 0);
    assert.equal(row?.file_asset_id, fixture.fileAssetId);
    assert.equal(row?.blob_id, fixture.blobId);
    assert.equal(row?.role, "primary");
    assert.equal(row?.path, fixture.originalName);
    assert.equal(row?.media_type, fixture.mediaType);
    assert.equal(Number(row?.byte_size), fixture.byteSize);
    assert.equal(row?.sha256, fixture.sha256);
    assert.equal(row?.storage_key, fixture.storageKey);
    assert.equal(row?.provider, "private-e2e-provider");
    assert.equal(row?.provider_upload_id, fixture.providerUploadId);
    assert.equal(row?.staging_key, fixture.stagingKey);
  }
  assertPrivateSourceDataAbsent(expectedSnapshots, fixtures, "persisted/public snapshot comparison");
}

function assertRuntimeSourceIsolation(runId, fixtures, sourceSnapshots, request) {
  const requests = fakeRuntime.state.runRequests.filter(
    (request) => request.body?.config?.configurable?.workbench_run_id === runId,
  );
  const initialRequests = requests.filter((request) => request.body?.input !== null);
  assert.equal(initialRequests.length, 1, "DeerFlow did not receive exactly one initial source context");
  const context = parseWorkbenchRuntimeContext(initialRequests[0].body);
  assert.deepEqual(
    { workflow: context.workflow, targetSurface: context.targetSurface },
    { workflow: request.workflow, targetSurface: request.targetSurface },
    "DeerFlow context changed the durable typed Run options",
  );
  if (request.designStyle.kind === "preset") {
    assert.equal(context.designStyle.kind, "materialized");
    assert.deepEqual(context.designStyle.snapshot.source, {
      presetId: request.designStyle.presetId,
      version: request.designStyle.version,
      checksum: request.designStyle.checksum,
    });
    assert.equal(context.designStyle.snapshot.protocol, "workbench.runtime.design-preset.v1");
    assert.deepEqual(context.designStyle.assetHandles, {});
  } else {
    assert.deepEqual(context.designStyle, request.designStyle);
  }
  assert.deepEqual(
    context.sources.map((source) => ({
      position: source.position,
      sourceId: source.sourceId,
      kind: source.kind,
      blobId: source.blobId,
      fileName: source.fileName,
      mediaType: source.mediaType,
      byteSize: source.byteSize,
      sha256: source.sha256,
    })),
    fixtures.map((fixture, position) => ({
      position,
      sourceId: sourceSnapshots[position].sourceId,
      kind: "file",
      blobId: fixture.blobId,
      fileName: fixture.originalName,
      mediaType: fixture.mediaType,
      byteSize: fixture.byteSize,
      sha256: fixture.sha256,
    })),
    "DeerFlow source metadata did not preserve request order",
  );
  assert.deepEqual(
    context.deerFlowSources.map((source) => ({
      position: source.position,
      fileName: source.fileName,
      mediaType: source.fileType,
      byteSize: source.size,
    })),
    fixtures.map((fixture, position) => ({
      position,
      fileName: fixture.originalName,
      mediaType: fixture.mediaType,
      byteSize: fixture.byteSize,
    })),
    "DeerFlow uploaded source handles did not preserve request order",
  );
  const serialized = JSON.stringify(requests.map((request) => request.body));
  for (const fixture of fixtures) {
    for (const privateValue of [
      fixture.fileAssetId,
      fixture.extractionId,
      fixture.extractionBlobId,
      fixture.storageKey,
      fixture.extractionStorageKey,
      fixture.stagingKey,
      fixture.providerUploadId,
    ]) {
      if (privateValue) {
        assert.ok(!serialized.includes(privateValue), `private source identifier reached DeerFlow: ${privateValue}`);
      }
    }
  }
}

function parseWorkbenchRuntimeContext(body) {
  const content = body?.input?.messages?.[0]?.content;
  assert.equal(typeof content, "string", "DeerFlow initial request did not contain a Workbench message");
  const startMarker = "<workbench_context>\n";
  const endMarker = "\n</workbench_context>";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, "DeerFlow initial request omitted the Workbench context envelope");
  return parseJson(content.slice(start + startMarker.length, end), "DeerFlow Workbench context");
}

function assertPrivateSourceDataAbsent(value, fixtures, label) {
  const serialized = JSON.stringify(value);
  for (const fixture of fixtures) {
    for (const privateValue of [
      fixture.storageKey,
      fixture.extractionStorageKey,
      fixture.stagingKey,
      fixture.providerUploadId,
    ]) {
      if (privateValue) assert.ok(!serialized.includes(privateValue), `${label} leaked ${privateValue}`);
    }
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeToolEventSourceId(runtimeAttemptId, toolName, toolCallId) {
  return `deerflow:${createHash("sha256")
    .update("workbench-runtime-tool-event-v1\0")
    .update(runtimeAttemptId)
    .update("\0")
    .update(toolName)
    .update("\0")
    .update(toolCallId)
    .digest("hex")}`;
}

function canonicalJson(value) {
  const result = canonicalize(value);
  if (typeof result !== "string") throw new Error("E2E fixture is not canonical JSON");
  return result;
}

function prototypeScreenProjectionChecksum(document, screenId, revision) {
  const screen = document.screens.find((candidate) => candidate.id === screenId);
  assert.ok(screen, `Prototype projection omitted ${screenId}`);
  const screenNodeIds = new Set(
    document.nodes.filter((node) => node.screenId === screenId).map((node) => node.id),
  );
  const sorted = (values, key) => [...values].sort((left, right) => {
    const leftKey = String(key(left));
    const rightKey = String(key(right));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const projection = {
    protocol: "workbench.prototype-screen-projection.v1",
    documentId: document.documentId,
    revision,
    screen,
    nodes: sorted(document.nodes.filter((node) => node.screenId === screenId), (node) => node.id),
    tokens: sorted(document.tokens, (token) => token.id),
    assets: sorted(document.assets, (asset) => asset.id),
    variables: sorted(document.variables, (variable) => variable.path),
    states: sorted(document.states.filter((state) => state.screenId === screenId), (state) => state.id),
    actions: sorted(document.actions.filter((action) => screenNodeIds.has(action.nodeId)), (action) => action.id),
    bindings: sorted(document.bindings.filter((binding) => screenNodeIds.has(binding.nodeId)), (binding) => binding.id),
    motions: sorted(document.motions.filter((motion) => screenNodeIds.has(motion.nodeId)), (motion) => motion.id),
  };
  return sha256(canonicalJson(projection));
}

function runtimeContentCount(fixtures) {
  return fixtures.reduce((count, fixture) => count + 1 + (fixture.extraction ? 1 : 0), 0);
}

function createApiClient(baseUrl, identity = {}) {
  const authenticationHeaders = {
    "X-Workbench-Dev-Subject": identity.subject ?? "workbench-e2e-principal",
    "X-Workbench-Dev-Email": identity.email ?? "workbench-e2e@test.local",
    "X-Workbench-Dev-Name": identity.name ?? "Workbench E2E",
  };

  async function openSse(route, headers = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`SSE timeout: ${route}`)), scenarioTimeoutMs);
    const response = await fetch(`${baseUrl}${route}`, {
      headers: {
        Accept: "text/event-stream",
        ...authenticationHeaders,
        ...headers,
      },
      signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) {
      clearTimeout(timeout);
      throw new Error(`SSE ${route}: HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
    }
    const observed = [];
    const events = readSse(response.body, (event) => observed.push(event))
      .finally(() => clearTimeout(timeout));
    return {
      observed,
      events,
      abort: () => controller.abort(),
    };
  }

  return {
    openSse,
    async json(method, route, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`HTTP timeout: ${method} ${route}`)), scenarioTimeoutMs);
      try {
        const response = await fetch(`${baseUrl}${route}`, {
          method,
          headers: {
            Accept: "application/json, application/problem+json",
            ...authenticationHeaders,
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(options.headers ?? {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
        const text = await response.text();
        const body = text ? parseJson(text, `${method} ${route}`) : null;
        const expected = options.expectedStatus ?? 200;
        if (response.status !== expected) {
          throw new Error(`${method} ${route}: expected HTTP ${expected}, received ${response.status}: ${text.slice(0, 2000)}`);
        }
        return { status: response.status, headers: response.headers, body };
      } finally {
        clearTimeout(timeout);
      }
    },

    async sse(route, headers = {}) {
      const stream = await openSse(route, headers);
      return stream.events;
    },
  };
}

async function fetchBytes(url, headers, expectedStatus = 200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`HTTP timeout: GET ${url}`)), scenarioTimeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== expectedStatus) {
      throw new Error(`GET ${url}: expected HTTP ${expectedStatus}, received ${response.status}`);
    }
    return { status: response.status, headers: response.headers, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

async function readSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSseFrame(frame);
        if (event) {
          events.push(event);
          onEvent?.(event);
        }
      }
    }
    buffer += decoder.decode();
    const final = parseSseFrame(buffer);
    if (final) {
      events.push(final);
      onEvent?.(final);
    }
    return events;
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame) {
  if (!frame.trim() || frame.trimStart().startsWith(":")) return null;
  let event = "message";
  let id = null;
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("id:")) id = line.slice(3).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, id, data: parseJson(data.join("\n"), `SSE ${event}`) };
}

function assertOrderedEvents(events, { runId, firstSequence }) {
  assert.ok(events.length > 0, "SSE stream contained no events");
  const seen = new Set();
  for (const [index, event] of events.entries()) {
    const sequence = event.data.sequence;
    assert.equal(sequence, firstSequence + index, `SSE sequence gap at event ${index}`);
    assert.equal(event.id, String(sequence), `SSE id does not match sequence ${sequence}`);
    assert.equal(event.event, event.data.type, `SSE event name does not match payload type at ${sequence}`);
    assert.equal(event.data.runId, runId, `SSE event ${sequence} belongs to another Run`);
    assert.ok(!seen.has(event.data.id), `duplicate RunEvent id ${event.data.id}`);
    seen.add(event.data.id);
  }
}

function eventIdentity(event) {
  return {
    id: event.data.id,
    sequence: event.data.sequence,
    type: event.data.type,
  };
}

async function startFakeDeerFlow(expectedToken) {
  const storageObjects = new Map();
  const browserPrdDraftGate = controlledGate();
  const browserPrdFinalizationGate = controlledGate();
  const state = {
    threadCreates: 0,
    successRuns: 0,
    prototypePatchRuns: 0,
    sourcePrototypeRuns: 0,
    generatePrototypeRuns: 0,
    approvalRuns: 0,
    approvalResumes: 0,
    cancelRuns: 0,
    canvasSeedRuns: 0,
    canvasQuickEditRuns: 0,
    canvasDirectEditRuns: 0,
    browserPrototypeRuns: 0,
    browserFailureSourceRunId: null,
    browserFailureAttempts: 0,
    browserFailureRejoinAttempts: 0,
    browserFailureRecoveryRuns: 0,
    browserFailureAcceptedRunId: null,
    browserFailureAcceptedRunVisible: false,
    processFaults: new Map(),
    canvasToolCalls: [],
    activeCancelStreams: 0,
    objectReads: [],
    visualReads: [],
    exportReads: [],
    gatewayUploads: [],
    gatewayReceipts: [],
    runRequests: [],
    requests: [],
    runtimeRuns: new Map(),
    multipartCreates: [],
    storageWrites: [],
  };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    void handleFakeDeerFlow(
      request,
      response,
      expectedToken,
      state,
      storageObjects,
      browserPrdDraftGate,
      browserPrdFinalizationGate,
    ).catch((error) => {
      state.requests.push({ errorClass: diagnosticErrorClass(error) });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      if (!response.writableEnded) response.end(JSON.stringify({ error: "fake runtime failure" }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  console.log(`[e2e] fake DeerFlow listening on 127.0.0.1:${address.port}`);
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    registerObject(storageKey, bytes, mediaType) {
      assert.ok(!storageObjects.has(storageKey), `duplicate fake S3 object key: ${storageKey}`);
      storageObjects.set(storageKey, { bytes: Buffer.from(bytes), mediaType });
    },
    releaseBrowserPrdDraft() {
      browserPrdDraftGate.release();
    },
    releaseBrowserPrdFinalization() {
      browserPrdFinalizationGate.release();
    },
    disconnectProcessFault(workbenchRunId) {
      const fault = state.processFaults.get(workbenchRunId);
      assert.ok(fault, "controlled provider process fault was not registered");
      fault.closeInitialStream?.();
    },
    releaseProcessRecovery(workbenchRunId) {
      const fault = state.processFaults.get(workbenchRunId);
      assert.ok(fault, "controlled provider process recovery was not registered");
      fault.recoveryGate.release();
    },
    async close() {
      browserPrdDraftGate.release();
      browserPrdFinalizationGate.release();
      for (const fault of state.processFaults.values()) {
        fault.recoveryGate.release();
        fault.closeInitialStream?.();
      }
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function handleFakeDeerFlow(
  request,
  response,
  expectedToken,
  state,
  storageObjects,
  browserPrdDraftGate,
  browserPrdFinalizationGate,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const storagePrefix = `/${fakeStorageBucket}/`;
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith(storagePrefix)) {
    const storageKey = url.pathname
      .slice(storagePrefix.length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const object = storageObjects.get(storageKey);
    if (!object) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    const read = { storageKey, byteSize: object.bytes.byteLength, sha256: sha256(object.bytes) };
    const exportObject = storageKey.startsWith("pending/exports/") || storageKey.startsWith("blobs/");
    if (exportObject) {
      const role = storageAccessRole(request);
      assert.ok(
        storageKey.startsWith("pending/exports/") ? role === "export" : role === "export" || role === "preview",
        `fake S3 read used an unexpected dedicated identity for ${storageKey}`,
      );
      state.exportReads.push({ ...read, role });
    } else if (storageKey.startsWith("canvas-visuals/")) state.visualReads.push(read);
    else state.objectReads.push(read);
    response.writeHead(200, {
      "content-type": object.mediaType,
      "content-length": String(object.bytes.byteLength),
      etag: `\"${sha256(object.bytes)}\"`,
      "x-amz-meta-sha256": sha256(object.bytes),
      "x-amz-meta-byte-size": String(object.bytes.byteLength),
      "last-modified": new Date().toUTCString(),
      "x-amz-request-id": `e2e-${randomUUID()}`,
    });
    response.end(request.method === "HEAD" ? undefined : object.bytes);
    return;
  }
  if (request.method === "PUT" && url.pathname.startsWith(storagePrefix)) {
    const storageKey = url.pathname
      .slice(storagePrefix.length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const canvasVisual = storageKey.startsWith("canvas-visuals/");
    const exportObject = storageKey.startsWith("pending/exports/") || storageKey.startsWith("blobs/");
    assert.ok(canvasVisual || exportObject, `fake S3 rejected an unexpected object key class: ${storageKey.split("/")[0]}`);
    assert.equal(
      storageAccessRole(request),
      canvasVisual ? "api-canvas-visual" : "export",
      "S3 PUT did not use the dedicated object-storage identity",
    );
    const bytes = await readRequestBuffer(request, 2 * 1024 * 1024);
    const declaredLength = Number(request.headers["content-length"]);
    assert.equal(declaredLength, bytes.byteLength, "fake S3 received a truncated Canvas visual PUT");
    const digest = sha256(bytes);
    const metadataDigest = request.headers["x-amz-meta-sha256"];
    assert.equal(metadataDigest, digest, "Canvas visual PUT omitted its immutable metadata digest");
    if (canvasVisual) {
      const checksum = request.headers["x-amz-checksum-sha256"];
      assert.equal(typeof checksum, "string", "Canvas visual PUT omitted its S3 checksum");
      assert.equal(Buffer.from(checksum, "base64").toString("hex"), digest);
    }
    const mediaType = String(request.headers["content-type"] ?? "application/octet-stream");
    storageObjects.set(storageKey, { bytes, mediaType });
    if (canvasVisual) state.storageWrites.push({ storageKey, byteSize: bytes.byteLength, mediaType, sha256: digest });
    response.writeHead(200, {
      etag: `"${digest}"`,
      "x-amz-version-id": `e2e-${state.storageWrites.length + 1}`,
    });
    response.end();
    return;
  }
  if (request.method === "DELETE" && url.pathname.startsWith(storagePrefix)) {
    const storageKey = url.pathname.slice(storagePrefix.length).split("/").map(decodeURIComponent).join("/");
    storageObjects.delete(storageKey);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && url.pathname.startsWith(storagePrefix) && url.searchParams.has("uploads")) {
    const storageKey = url.pathname
      .slice(storagePrefix.length)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const uploadId = `fake-multipart-${state.multipartCreates.length + 1}-${randomUUID()}`;
    state.multipartCreates.push({ storageKey, uploadId });
    response.writeHead(200, {
      "content-type": "application/xml",
      "x-amz-request-id": `e2e-${randomUUID()}`,
    });
    response.end([
      '<CreateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
      `<Bucket>${fakeStorageBucket}</Bucket>`,
      `<Key>${escapeXml(storageKey)}</Key>`,
      `<UploadId>${uploadId}</UploadId>`,
      "</CreateMultipartUploadResult>",
    ].join(""));
    return;
  }
  if (request.headers["x-deerflow-internal-token"] !== expectedToken) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid internal token" }));
    return;
  }
  if (request.method === "GET" && url.pathname === "/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      models: [{
        name: runtimeCatalogModelId,
        model: runtimeProviderModel,
        display_name: "E2E Quality",
        description: "Fake model for the Workbench HTTP E2E",
        supports_thinking: true,
        supports_reasoning_effort: true,
      }],
      token_usage: { enabled: true },
    }));
    return;
  }
  const principalId = request.headers["x-deerflow-owner-user-id"];
  if (typeof principalId !== "string" || !principalId) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "missing owner" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/skills") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      skills: [{
        name: "workbench",
        description: "产品工作台 E2E runtime skill",
        license: "MIT",
        category: "public",
        enabled: true,
        editable: false,
      }],
    }));
    return;
  }

  if (request.method === "POST" && /^\/api\/threads\/[^/]+\/uploads$/.test(url.pathname)) {
    const body = await readRequestBuffer(request, 4 * 1024 * 1024);
    const declaredLength = Number(request.headers["content-length"]);
    assert.equal(declaredLength, body.byteLength, "fake Gateway received a truncated multipart upload");
    const matchedStorageKeys = [];
    for (const [storageKey, object] of storageObjects) {
      if (body.includes(object.bytes)) matchedStorageKeys.push(storageKey);
    }
    const uploadIndex = state.gatewayUploads.length + 1;
    const receipt = `private-gateway-receipt-${uploadIndex}-${randomUUID()}`;
    state.gatewayUploads.push({
      path: url.pathname,
      principalId,
      byteSize: body.byteLength,
      contentType: request.headers["content-type"],
      matchedStorageKeys,
    });
    state.gatewayReceipts.push(receipt);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      files: [{
        virtual_path: `/mnt/user-data/uploads/e2e-${uploadIndex}.bin`,
        markdown_virtual_path: `/mnt/user-data/uploads/e2e-${uploadIndex}.md`,
        provider_upload_id: receipt,
        artifact_url: `https://private.invalid/${receipt}`,
      }],
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/threads") {
    const body = await readJsonRequest(request);
    state.threadCreates += 1;
    state.requests.push({ method: request.method, path: url.pathname, kind: "thread", body });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      thread_id: body.thread_id,
      metadata: body.metadata,
      status: "idle",
    }));
    return;
  }

  const runListMatch = /^\/threads\/([^/]+)\/runs$/.exec(url.pathname);
  if (request.method === "GET" && runListMatch) {
    const externalThreadId = decodeURIComponent(runListMatch[1]);
    const runs = [...state.runtimeRuns.values()]
      .filter((run) => run.thread_id === externalThreadId)
      .filter((run) => (
        run.kind !== "browser-failure-accepted"
        || (
          run.run_id === state.browserFailureAcceptedRunId
          && !state.browserFailureAcceptedRunVisible
        )
      ))
      .map(publicRuntimeRun);
    if (state.browserFailureAcceptedRunId && !state.browserFailureAcceptedRunVisible) {
      const accepted = state.runtimeRuns.get(state.browserFailureAcceptedRunId);
      if (accepted?.thread_id === externalThreadId) state.browserFailureAcceptedRunVisible = true;
    }
    state.requests.push({ method: request.method, path: url.pathname, kind: "run-list" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(runs));
    return;
  }

  const runGetMatch = /^\/threads\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname);
  const runJoinMatch = /^\/threads\/([^/]+)\/runs\/([^/]+)\/stream$/.exec(url.pathname);
  if (request.method === "GET" && runJoinMatch) {
    const run = state.runtimeRuns.get(decodeURIComponent(runJoinMatch[2]));
    if (!run || run.thread_id !== decodeURIComponent(runJoinMatch[1])) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (run.kind === "browser-failure-accepted") {
      state.browserFailureRejoinAttempts += 1;
      state.requests.push({ method: request.method, path: url.pathname, kind: "browser-failure-rejoin" });
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "CONTROLLED_BROWSER_STREAM_UNAVAILABLE" }));
      return;
    }
    if (run.kind === "process-sigkill-recovery") {
      const workbenchRunId = run.metadata?.workbench_run_id;
      const fault = state.processFaults.get(workbenchRunId);
      assert.ok(fault, "controlled SIGKILL recovery state is missing");
      fault.rejoinCount += 1;
      fault.rejoinActive = true;
      state.requests.push({ method: request.method, path: url.pathname, kind: "process-rejoin" });
      await fault.recoveryGate.wait();
      await writeSuccessfulRuntimeStream(response, fault.requestBody);
      run.status = "success";
      run.updated_at = new Date().toISOString();
      fault.rejoinActive = false;
      fault.rejoinFinished = true;
      return;
    }
    if (run.kind === "process-sigterm-cancel") {
      const workbenchRunId = run.metadata?.workbench_run_id;
      const fault = state.processFaults.get(workbenchRunId);
      assert.ok(fault, "controlled SIGTERM cancellation state is missing");
      fault.rejoinCount += 1;
      await holdProcessFaultStream(request, response, fault);
      return;
    }
  }
  if (request.method === "GET" && runGetMatch) {
    const run = state.runtimeRuns.get(decodeURIComponent(runGetMatch[2]));
    if (!run || run.thread_id !== decodeURIComponent(runGetMatch[1])) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(publicRuntimeRun(run)));
    return;
  }

  const runCancelMatch = /^\/threads\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && runCancelMatch) {
    const run = state.runtimeRuns.get(decodeURIComponent(runCancelMatch[2]));
    if (!run || run.thread_id !== decodeURIComponent(runCancelMatch[1])) {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    assert.equal(url.searchParams.get("wait"), "1");
    assert.equal(url.searchParams.get("action"), "interrupt");
    run.status = "interrupted";
    run.closeStream?.();
    const processFault = state.processFaults.get(run.metadata?.workbench_run_id);
    if (processFault) processFault.cancelCount += 1;
    state.requests.push({ method: request.method, path: url.pathname, kind: "run-cancel" });
    response.writeHead(204).end();
    return;
  }

  if (request.method === "POST" && /^\/threads\/[^/]+\/runs\/stream$/.test(url.pathname)) {
    const body = await readJsonRequest(request);
    const serialized = JSON.stringify(body);
    const processSigkillRecovery = serialized.includes("E2E_PROCESS_SIGKILL_RECOVERY");
    const processSigtermCancel = serialized.includes("E2E_PROCESS_SIGTERM_CANCEL");
    const browserFailure = serialized.includes("E2E_BROWSER_FAILURE");
    const browserVisualPrd = serialized.includes("synthetic browser test");
    const workbenchRunId = body?.metadata?.workbench_run_id;
    let browserFailureRecovery = false;
    if (browserFailure) {
      assert.equal(typeof workbenchRunId, "string", "controlled browser failure omitted the Workbench Run identity");
      state.browserFailureSourceRunId ??= workbenchRunId;
      if (workbenchRunId === state.browserFailureSourceRunId) {
        state.browserFailureAttempts += 1;
        const acceptedRunId = randomUUID();
        state.browserFailureAcceptedRunId = acceptedRunId;
        state.browserFailureAcceptedRunVisible = false;
        state.runtimeRuns.set(acceptedRunId, {
          run_id: acceptedRunId,
          thread_id: decodeURIComponent(url.pathname.split("/")[2]),
          assistant_id: body.assistant_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "error",
          metadata: body.metadata ?? {},
          multitask_strategy: body.multitask_strategy ?? null,
          kind: "browser-failure-accepted",
          closeStream: null,
        });
        state.requests.push({ method: request.method, path: url.pathname, kind: "browser-failure" });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "CONTROLLED_BROWSER_RUNTIME_UNAVAILABLE" }));
        return;
      }
      browserFailureRecovery = true;
    }
    const cancellation = serialized.includes("E2E_CANCEL");
    const approval = serialized.includes("E2E_APPROVAL");
    const prototypePatch = serialized.includes("E2E_PROTOTYPE_PATCH");
    const sourcePrototype = serialized.includes("E2E_GENERATE_SOURCE_SEED");
    const generatePrototype = serialized.includes("E2E_GENERATE_PROTOTYPE_SOURCE");
    const canvasSeed = serialized.includes("E2E_CANVAS_SEED");
    const canvasQuickEdit = serialized.includes("E2E_CANVAS_QUICK_EDIT");
    const canvasDirectEdit = serialized.includes("E2E_CANVAS_DIRECT_EDIT");
    const prototypeGeneration = serialized.includes('"requestedArtifactKinds":["prototype"]');
    const resume = body?.input === null && body?.command?.resume !== undefined;
    const kind = processSigkillRecovery
      ? "process-sigkill-recovery"
      : processSigtermCancel
        ? "process-sigterm-cancel"
      : browserFailureRecovery
      ? "browser-failure-recovery"
      : cancellation
        ? "cancel"
      : resume
          ? "approval-resume"
          : approval
            ? "approval"
            : prototypePatch
              ? "prototype-patch"
              : sourcePrototype
                ? "source-prototype"
                : generatePrototype
                  ? "generate-prototype"
              : canvasSeed
                ? "canvas-seed"
              : canvasQuickEdit
                ? "canvas-quick-edit"
                : canvasDirectEdit
                  ? "canvas-direct-edit"
                  : prototypeGeneration
                    ? "prototype-generation"
                  : "success";
    const externalThreadId = decodeURIComponent(url.pathname.split("/")[2]);
    const externalRunId = randomUUID();
    const run = {
      run_id: externalRunId,
      thread_id: externalThreadId,
      assistant_id: body.assistant_id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "running",
      metadata: body.metadata ?? {},
      multitask_strategy: body.multitask_strategy ?? null,
      kind,
      closeStream: null,
    };
    state.runtimeRuns.set(externalRunId, run);
    state.runRequests.push({ kind, body });
    state.requests.push({ method: request.method, path: url.pathname, kind, externalRunId });
    response.setHeader("content-location", `/threads/${externalThreadId}/runs/${externalRunId}`);
    if (processSigkillRecovery || processSigtermCancel) {
      assert.equal(typeof workbenchRunId, "string", "controlled process fault omitted Workbench Run identity");
      const fault = {
        cancelCount: 0,
        closeInitialStream: null,
        initialStreamActive: false,
        initialStreamClosed: false,
        kind,
        recoveryGate: controlledGate(),
        rejoinActive: false,
        rejoinCount: 0,
        rejoinFinished: false,
        requestBody: body,
        submissionCount: 1,
      };
      state.processFaults.set(workbenchRunId, fault);
      await holdProcessFaultStream(request, response, fault);
    } else if (browserFailureRecovery) {
      state.browserFailureRecoveryRuns += 1;
      await writeSuccessfulRuntimeStream(response, body);
      run.status = "success";
    } else if (cancellation) {
      state.cancelRuns += 1;
      await holdCancellationStream(request, response, state, run);
    } else if (resume) {
      state.approvalResumes += 1;
      await writeSuccessfulRuntimeStream(response, body);
      run.status = "success";
    } else if (approval) {
      state.approvalRuns += 1;
      await writeApprovalRuntimeStream(response);
      run.status = "interrupted";
    } else if (prototypePatch) {
      state.prototypePatchRuns += 1;
      await writePrototypePatchRuntimeStream(response, body);
      run.status = "success";
    } else if (sourcePrototype) {
      state.sourcePrototypeRuns += 1;
      await writeSourcePrototypeRuntimeStream(response, body);
      run.status = "success";
    } else if (generatePrototype) {
      state.generatePrototypeRuns += 1;
      await writeGeneratePrototypeRuntimeStream(response, body);
      run.status = "success";
    } else if (canvasSeed) {
      state.canvasSeedRuns += 1;
      await writeCanvasRuntimeStream(response, body, "seed", state);
      run.status = "success";
    } else if (canvasQuickEdit) {
      state.canvasQuickEditRuns += 1;
      await writeCanvasRuntimeStream(response, body, "quick-edit", state);
      run.status = "success";
    } else if (canvasDirectEdit) {
      state.canvasDirectEditRuns += 1;
      await writeCanvasRuntimeStream(response, body, "direct-edit", state);
      run.status = "success";
    } else if (prototypeGeneration) {
      state.browserPrototypeRuns += 1;
      await writePrototypeCreateRuntimeStream(response, body, {
        kind: "prototype",
        title: "Controlled browser prototype",
        schemaVersion: 1,
        operation: { kind: "create" },
        content: interactiveBrowserPrototypeDocument(),
        citations: [],
      }, "Controlled browser prototype ready");
      run.status = "success";
    } else {
      state.successRuns += 1;
      await writeSuccessfulRuntimeStream(response, body, {
        draftGate: browserVisualPrd ? browserPrdDraftGate : null,
        finalizationGate: browserVisualPrd ? browserPrdFinalizationGate : null,
        streamStages: browserVisualPrd,
      });
      run.status = "success";
    }
    run.updated_at = new Date().toISOString();
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
}

function storageAccessRole(request) {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\//u.exec(
    String(request.headers.authorization ?? ""),
  );
  const prefix = `${fakeStorageAccessKeyId}-`;
  return match?.[1]?.startsWith(prefix) ? match[1].slice(prefix.length) : null;
}

function publicRuntimeRun(run) {
  return {
    run_id: run.run_id,
    thread_id: run.thread_id,
    assistant_id: run.assistant_id,
    created_at: run.created_at,
    updated_at: run.updated_at,
    status: run.status,
    metadata: run.metadata,
    multitask_strategy: run.multitask_strategy,
  };
}

async function writeApprovalRuntimeStream(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
  sendSse(response, "values", {
    __interrupt__: [
      {
        id: "approval_publish",
        resumable: true,
        value: {
          kind: "confirmation",
          prompt: "Publish the generated result?",
          options: [{ id: "publish", label: "Publish", value: "publish" }],
        },
      },
      {
        id: "approval_direction",
        resumable: true,
        value: {
          kind: "selection",
          prompt: "Choose the delivery direction",
          options: [{ id: "quality", label: "Quality", value: { direction: "quality" } }],
        },
      },
    ],
  }, "1");
  response.end();
}

async function writeSuccessfulRuntimeStream(
  response,
  requestBody,
  { draftGate = null, finalizationGate = null, streamStages = false } = {},
) {
  const scope = runtimeScopeFromRequest(requestBody);
  const draft = {
    kind: "prd",
    title: prdV2Title,
    schemaVersion: 2,
    operation: { kind: "create" },
    content: minimalPrdDocument(),
    citations: [],
  };
  const result = {
    protocol: "workbench.runtime.result.v1",
    message: "E2E generated response",
    artifacts: [draft],
  };
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
  sendSse(response, "messages", [
    { type: "AIMessageChunk", role: "assistant", content: "E2E generated" },
    { langgraph_node: "generate_prd" },
  ], "1");
  await delay(controlledProviderDelayMs);
  sendSse(response, "messages", [
    { type: "AIMessageChunk", role: "assistant", content: "E2E generated response" },
    { langgraph_node: "generate_prd" },
  ], "2");
  await delay(controlledProviderDelayMs);
  const messages = [{ type: "human", content: "Workbench E2E request" }];
  const stageSnapshots = [];
  const [collectingStage, ...remainingStages] = prdGenerationStageSequence;
  const collectingToolCallId = `e2e-prd-stage-${collectingStage}`;
  messages.push(...declaredToolMessages(
    "workbench_generation_stage_update",
    collectingToolCallId,
    validatedGenerationStageArtifact(collectingStage, {
      ...scope,
      toolCallId: collectingToolCallId,
    }),
  ));
  stageSnapshots.push(structuredClone(messages));
  messages.push(...declaredPrdReferenceMessages());
  for (const stage of remainingStages) {
    const toolCallId = `e2e-prd-stage-${stage}`;
    messages.push(...declaredToolMessages(
      "workbench_generation_stage_update",
      toolCallId,
      validatedGenerationStageArtifact(stage, { ...scope, toolCallId }),
    ));
    stageSnapshots.push(structuredClone(messages));
  }
  messages.push(...declaredToolMessages(
    "workbench_artifact_draft_publish",
    successPrdCheckpointToolCallId,
    validatedArtifactDraftArtifact(draft, {
      ...scope,
      toolCallId: successPrdCheckpointToolCallId,
    }),
  ));
  const draftSnapshot = structuredClone(messages);
  messages.push(...declaredToolMessages(
    "workbench_runtime_result_submit",
    "e2e-result-submit",
    validatedRuntimeResultArtifact(result, {
      ...scope,
      toolCallId: "e2e-result-submit",
    }),
  ));
  if (streamStages) {
    for (const [index, snapshot] of stageSnapshots.entries()) {
      sendSse(response, "values", {
        node: "generate_prd",
        values: { messages: snapshot },
      }, String(index + 3));
      await delay(controlledProviderDelayMs);
    }
    if (draftGate) await waitForControlledProviderGate(response, draftGate);
    sendSse(response, "values", {
      node: "generate_prd",
      values: { messages: draftSnapshot },
    }, String(stageSnapshots.length + 3));
    if (finalizationGate) await waitForControlledProviderGate(response, finalizationGate);
    else await delay(controlledProviderDelayMs);
    sendSse(response, "values", {
      node: "finalize",
      values: { messages },
    }, String(stageSnapshots.length + 4));
  } else {
    sendSse(response, "values", {
      node: "finalize",
      values: { messages },
    }, "3");
  }
  response.end();
}

async function writePrototypePatchRuntimeStream(response, requestBody) {
  const scope = runtimeScopeFromRequest(requestBody);
  const initialDocument = minimalPrototypeDocument();
  initialDocument.title = "Prototype Patch E2E";
  const intermediateDocument = structuredClone(initialDocument);
  intermediateDocument.screens[0].name = "Streamed Home step 1";
  const finalDocument = structuredClone(intermediateDocument);
  finalDocument.screens[0].name = "Streamed Home";
  const initialDraft = {
    kind: "prototype",
    title: "Prototype Patch E2E",
    schemaVersion: 1,
    operation: { kind: "create" },
    content: initialDocument,
    citations: [],
  };
  const finalDraft = { ...initialDraft, content: finalDocument };
  const firstPatch = {
    protocol: "workbench.runtime.prototype-patch.v1",
    artifactIndex: 0,
    screenId: "screen-home",
    baseRevision: 0,
    nextRevision: 1,
    operations: [{
      kind: "update_screen",
      screenId: "screen-home",
      screen: intermediateDocument.screens[0],
    }],
    resultingChecksum: prototypeScreenProjectionChecksum(intermediateDocument, "screen-home", 1),
  };
  const secondPatch = {
    protocol: "workbench.runtime.prototype-patch.v1",
    artifactIndex: 0,
    screenId: "screen-home",
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      kind: "update_screen",
      screenId: "screen-home",
      screen: finalDocument.screens[0],
    }],
    resultingChecksum: prototypeScreenProjectionChecksum(finalDocument, "screen-home", 2),
  };
  const messages = [{ type: "human", content: "Workbench Prototype patch request" }];
  for (const stage of ["design-system", "mapping-components", "creating-flows", "generating-ui"]) {
    const toolCallId = `prototype-patch-stage-${stage}`;
    messages.push(...declaredToolMessages(
      "workbench_generation_stage_update",
      toolCallId,
      validatedGenerationStageArtifact(stage, { ...scope, toolCallId }),
    ));
  }
  const initialCheckpointCallId = "prototype-patch-checkpoint-initial";
  messages.push(...declaredToolMessages(
    "workbench_artifact_draft_publish",
    initialCheckpointCallId,
    validatedArtifactDraftArtifact(initialDraft, {
      ...scope,
      toolCallId: initialCheckpointCallId,
    }),
  ));
  const afterInitialCheckpoint = structuredClone(messages);

  const firstPatchCallId = "prototype-patch-apply-1";
  messages.push(...declaredToolMessages(
    "workbench_prototype_patch_publish",
    firstPatchCallId,
    validatedPrototypePatchArtifact(firstPatch, { ...scope, toolCallId: firstPatchCallId }),
    prototypePatchToolArgs(firstPatch),
  ));
  const afterFirstPatch = structuredClone(messages);

  const secondPatchCallId = "prototype-patch-apply-2";
  messages.push(...declaredToolMessages(
    "workbench_prototype_patch_publish",
    secondPatchCallId,
    validatedPrototypePatchArtifact(secondPatch, { ...scope, toolCallId: secondPatchCallId }),
    prototypePatchToolArgs(secondPatch),
  ));
  const afterSecondPatch = structuredClone(messages);

  const finalCheckpointCallId = "prototype-patch-checkpoint-final";
  messages.push(...declaredToolMessages(
    "workbench_artifact_draft_publish",
    finalCheckpointCallId,
    validatedArtifactDraftArtifact(finalDraft, {
      ...scope,
      toolCallId: finalCheckpointCallId,
    }),
  ));
  const afterFinalCheckpoint = structuredClone(messages);

  const result = {
    protocol: "workbench.runtime.result.v1",
    message: "Prototype patch completed",
    artifacts: [finalDraft],
  };
  const resultCallId = "prototype-patch-result";
  messages.push(...declaredToolMessages(
    "workbench_runtime_result_submit",
    resultCallId,
    validatedRuntimeResultArtifact(result, { ...scope, toolCallId: resultCallId }),
  ));

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
  sendSse(response, "values", {
    node: "prototype_patch",
    values: { messages: afterInitialCheckpoint },
  }, "1");
  sendSse(response, "values", {
    node: "prototype_patch",
    values: { messages: afterFirstPatch },
  }, "2");
  sendSse(response, "values", {
    node: "prototype_patch",
    values: { messages: afterSecondPatch },
  }, "3");
  sendSse(response, "values", {
    node: "prototype_patch",
    values: { messages: afterFinalCheckpoint },
  }, "4");
  sendSse(response, "values", {
    node: "finalize",
    values: { messages },
  }, "5");
  response.end();
}

async function writeSourcePrototypeRuntimeStream(response, requestBody) {
  const context = parseWorkbenchRuntimeContext(requestBody);
  assert.equal(context.workflow, "generate");
  assert.equal(context.generationIntent, null);
  assert.deepEqual(context.artifactTargets, []);
  const document = sourcePrototypeDocument();
  await writePrototypeCreateRuntimeStream(
    response,
    requestBody,
    {
      kind: "prototype",
      title: "Three-screen source Prototype",
      schemaVersion: 1,
      operation: { kind: "create" },
      content: document,
      citations: [],
    },
    "Source Prototype seeded",
  );
}

async function writeGeneratePrototypeRuntimeStream(response, requestBody) {
  const context = parseWorkbenchRuntimeContext(requestBody);
  assert.equal(context.workflow, "generate");
  assert.equal(context.generationIntent, "interactive-prototype");
  assert.equal(context.artifactTargets.length, 1);
  const target = context.artifactTargets[0];
  assert.equal(target.content.mode, "inline");
  const projection = target.content.value;
  assert.equal(projection.protocol, "workbench.prototype-source-projection.v1");
  assert.deepEqual(projection.selectedScreenIds, target.screenIds);
  const document = generatedPrototypeFromSourceProjection(projection);
  await writePrototypeCreateRuntimeStream(
    response,
    requestBody,
    {
      kind: "prototype",
      title: "Generated Prototype from selected source screens",
      schemaVersion: 1,
      operation: { kind: "create" },
      content: document,
      citations: [],
    },
    "Generate Prototype completed",
  );
}

async function writePrototypeCreateRuntimeStream(response, requestBody, draft, message) {
  const scope = runtimeScopeFromRequest(requestBody);
  const messages = [{ type: "human", content: "Workbench Prototype generation request" }];
  const stageMessages = [];
  for (const stage of ["design-system", "mapping-components", "creating-flows", "generating-ui"]) {
    const stageToolCallId = `prototype-create-stage-${stage}`;
    messages.push(...declaredToolMessages(
      "workbench_generation_stage_update",
      stageToolCallId,
      validatedGenerationStageArtifact(stage, { ...scope, toolCallId: stageToolCallId }),
    ));
    stageMessages.push(structuredClone(messages));
  }
  const draftToolCallId = "prototype-create-draft";
  messages.push(...declaredToolMessages(
    "workbench_artifact_draft_publish",
    draftToolCallId,
    validatedArtifactDraftArtifact(draft, { ...scope, toolCallId: draftToolCallId }),
  ));
  const result = {
    protocol: "workbench.runtime.result.v1",
    message,
    artifacts: [draft],
  };
  const resultToolCallId = "prototype-create-result";
  messages.push(...declaredToolMessages(
    "workbench_runtime_result_submit",
    resultToolCallId,
    validatedRuntimeResultArtifact(result, { ...scope, toolCallId: resultToolCallId }),
  ));

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
  sendSse(response, "messages", [
    { type: "AIMessageChunk", role: "assistant", content: message },
    { langgraph_node: "generate_prototype" },
  ], "1");
  for (const [index, stageSnapshot] of stageMessages.entries()) {
    await delay(controlledProviderDelayMs);
    sendSse(response, "values", {
      node: "generate_prototype",
      values: { messages: stageSnapshot },
    }, String(index + 2));
  }
  await delay(controlledProviderDelayMs);
  sendSse(response, "values", {
    node: "finalize",
    values: { messages },
  }, String(stageMessages.length + 2));
  response.end();
}

function sourcePrototypeDocument() {
  const base = minimalPrototypeDocument();
  const sourceScreens = [
    { id: "screen-home", name: "Home", route: "/", frameId: "frame-home", iconId: "icon-home", assetId: "asset-home", iconName: "House" },
    { id: "screen-settings", name: "Settings", route: "/settings", frameId: "frame-settings", iconId: "icon-settings", assetId: "asset-settings", iconName: "Settings" },
    { id: "screen-admin", name: "Admin", route: "/admin", frameId: "frame-admin", iconId: "icon-admin", assetId: "asset-admin", iconName: "Shield" },
  ];
  const screens = sourceScreens.map(({ id, name, route, frameId }) => ({
    id,
    name,
    route,
    rootNodeId: frameId,
    initialStateId: null,
    viewport: { width: 390, height: 844 },
  }));
  const nodes = [];
  const assets = sourceScreens.map(({ id: screenId, name, assetId, iconName }) => ({
    id: assetId,
    kind: "icon",
    name: `${name} icon`,
    library: "lucide",
    iconName,
    screenId,
  })).map(({ screenId: _screenId, ...asset }) => asset);
  for (const source of sourceScreens) {
    const frame = structuredClone(base.nodes[0]);
    frame.id = source.frameId;
    frame.screenId = source.id;
    frame.name = `${source.name} frame`;
    frame.childIds = [source.iconId];
    frame.actionIds = [];
    const { childIds: _childIds, clipContent: _clipContent, ...iconBase } = structuredClone(base.nodes[0]);
    const icon = {
      ...iconBase,
      id: source.iconId,
      screenId: source.id,
      parentId: source.frameId,
      name: `${source.name} icon node`,
      kind: "icon",
      assetId: source.assetId,
      accessibilityLabel: `${source.name} navigation`,
      actionIds: source.id === "screen-home" ? ["action-home-settings"] : source.id === "screen-admin" ? ["action-admin-home"] : [],
      bindingIds: [],
      motionIds: [],
    };
    nodes.push(frame, icon);
  }
  return {
    protocol: "workbench.prototype.v1",
    documentId: "source-prototype-document",
    title: "Three-screen source Prototype",
    revision: 1,
    screens,
    nodes,
    tokens: [],
    assets,
    variables: [],
    states: [],
    actions: [
      {
        id: "action-home-settings",
        nodeId: "icon-home",
        event: "click",
        kind: "navigate",
        targetScreenId: "screen-settings",
      },
      {
        id: "action-admin-home",
        nodeId: "icon-admin",
        event: "click",
        kind: "navigate",
        targetScreenId: "screen-home",
      },
    ],
    bindings: [],
    motions: [],
  };
}

function generatedPrototypeFromSourceProjection(projection) {
  const selected = new Set(projection.selectedScreenIds);
  const actions = projection.actions.filter((action) => (
    action.kind !== "navigate" || selected.has(action.targetScreenId)
  ));
  const actionIds = new Set(actions.map((action) => action.id));
  return {
    protocol: "workbench.prototype.v1",
    documentId: "generated-source-prototype-document",
    title: "Generated Prototype from selected source screens",
    revision: 1,
    screens: structuredClone(projection.screens),
    nodes: projection.nodes.map((node) => ({
      ...structuredClone(node),
      actionIds: node.actionIds.filter((actionId) => actionIds.has(actionId)),
    })),
    tokens: structuredClone(projection.tokens),
    assets: structuredClone(projection.assets),
    variables: structuredClone(projection.variables),
    states: structuredClone(projection.states),
    actions: structuredClone(actions),
    bindings: structuredClone(projection.bindings),
    motions: structuredClone(projection.motions),
  };
}

function runtimeScopeFromRequest(body) {
  const runId = body?.metadata?.workbench_run_id;
  const runtimeAttemptId = body?.metadata?.workbench_runtime_attempt_id;
  assert.equal(typeof runId, "string", "fake runtime request omitted workbench_run_id");
  assert.equal(typeof runtimeAttemptId, "string", "fake runtime request omitted workbench_runtime_attempt_id");
  return { runId, runtimeAttemptId };
}

function declaredToolMessages(toolName, toolCallId, artifact, args = {}) {
  return [
    {
      type: "ai",
      content: "",
      tool_calls: [{ id: toolCallId, name: toolName, args }],
    },
    {
      type: "tool",
      name: toolName,
      tool_call_id: toolCallId,
      artifact,
    },
  ];
}

function declaredPrdReferenceMessages() {
  return [
    {
      type: "ai",
      content: "",
      tool_calls: prdReferenceFixtures.map((fixture) => ({
        id: fixture.toolCallId,
        name: "read_file",
        args: { path: fixture.path },
      })),
    },
    ...prdReferenceFixtures.map((fixture) => ({
      type: "tool",
      name: "read_file",
      tool_call_id: fixture.toolCallId,
      content: fixture.content,
      status: "success",
    })),
  ];
}

function validatedRuntimeResultArtifact(result, { runId, runtimeAttemptId, toolCallId }) {
  const envelope = {
    protocol: "workbench.runtime.validated-result.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    ok: true,
    resultChecksum: sha256(canonicalJson(result)),
  };
  return {
    ...envelope,
    result,
    checksum: sha256(canonicalJson(envelope)),
  };
}

function validatedArtifactDraftArtifact(draft, {
  runId,
  runtimeAttemptId,
  toolCallId,
  artifactIndex = 0,
}) {
  const envelope = {
    protocol: "workbench.runtime.artifact-draft.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    artifactIndex,
    ok: true,
    draftChecksum: sha256(canonicalJson(draft)),
  };
  return {
    ...envelope,
    draft,
    checksum: sha256(canonicalJson(envelope)),
  };
}

function validatedPrototypePatchArtifact(patch, { runId, runtimeAttemptId, toolCallId }) {
  const envelope = {
    protocol: "workbench.runtime.prototype-patch-publication.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    ok: true,
    patchChecksum: sha256(canonicalJson(patch)),
  };
  return {
    ...envelope,
    patch,
    checksum: sha256(canonicalJson(envelope)),
  };
}

function prototypePatchToolArgs(patch) {
  return {
    artifact_index: patch.artifactIndex,
    screen_id: patch.screenId,
    base_revision: patch.baseRevision,
    next_revision: patch.nextRevision,
    operations: patch.operations,
    resulting_checksum: patch.resultingChecksum,
  };
}

function validatedGenerationStageArtifact(stage, { runId, runtimeAttemptId, toolCallId }) {
  const payload = {
    protocol: "workbench.runtime.generation-stage.v1",
    runId,
    runtimeAttemptId,
    toolCallId,
    stage,
  };
  return { ...payload, checksum: sha256(canonicalJson(payload)) };
}

async function writeCanvasRuntimeStream(response, requestBody, mode, state) {
  const scope = runtimeScopeFromRequest(requestBody);
  const context = parseWorkbenchRuntimeContext(requestBody);
  const messages = [{ type: "human", content: `Workbench Canvas ${mode} request` }];
  let draft;

  if (mode === "seed") {
    draft = {
      kind: "prototype",
      schemaVersion: 1,
      title: "Canvas E2E Prototype",
      citations: [],
      operation: { kind: "create" },
      content: minimalPrototypeDocument(),
    };
  } else {
    const descriptor = canvasDescriptorFromRequest(requestBody);
    assert.deepEqual(descriptor.reference.declaredTools, [
      "get_visible_screens",
      "get_selected_screens",
      "view_screen",
      "select_screen",
      "quick_edit",
      "duplicate_screen",
      "rename_screen",
      "navigate_canvas",
    ]);
    const target = canvasRuntimeTarget(context);
    if (mode === "quick-edit") {
      const visibleInput = { limit: 10 };
      const visible = await executeCanvasToolUntilTerminal(
        descriptor,
        "get_visible_screens",
        "canvas-visible",
        visibleInput,
        state,
        scope.runId,
      );
      messages.push(...declaredToolMessages(
        "get_visible_screens",
        "canvas-visible",
        visible,
        visibleInput,
      ));
    }
    const selectedToolCallId = mode === "quick-edit" ? "canvas-selected" : "canvas-direct-selected";
    const selected = await executeCanvasToolUntilTerminal(
      descriptor,
      "get_selected_screens",
      selectedToolCallId,
      {},
      state,
      scope.runId,
    );
    messages.push(...declaredToolMessages(
      "get_selected_screens",
      selectedToolCallId,
      selected,
      {},
    ));
    const reference = selectedCanvasReference(selected, target);
    const remainingToolPlan = mode === "quick-edit"
      ? [
          ["view_screen", "canvas-view", { target: reference }],
          ["select_screen", "canvas-select", { targets: [reference], mode: "replace" }],
          ["navigate_canvas", "canvas-navigate", {
            target: { kind: "screen", screen: reference },
            behavior: "smooth",
          }],
          ["quick_edit", "canvas-quick-edit", {
            target: reference,
            instruction: "Make the home screen clearer",
          }],
        ]
      : [
          ["rename_screen", "canvas-rename", { target: reference, title: "Agent Home" }],
          ["duplicate_screen", "canvas-duplicate", { target: reference }],
        ];
    for (const [toolName, toolCallId, input] of remainingToolPlan) {
      const toolResult = await executeCanvasToolUntilTerminal(
        descriptor,
        toolName,
        toolCallId,
        input,
        state,
        scope.runId,
      );
      messages.push(...declaredToolMessages(toolName, toolCallId, toolResult, input));
    }

    const document = structuredClone(target.document);
    document.revision += 1;
    const frame = document.nodes.find((node) => node.id === "frame-home");
    assert.ok(frame, "Canvas runtime target omitted frame-home");
    frame.name = mode === "quick-edit" ? "quick-edited-home" : "direct-edited-home";
    draft = {
      kind: "prototype",
      schemaVersion: 1,
      title: mode === "quick-edit" ? "Quick-edited prototype" : "Direct-edited prototype",
      citations: [],
      operation: {
        kind: "revise",
        target: {
          artifactId: target.artifactId,
          artifactVersionId: target.artifactVersionId,
          screenIds: [target.screenId],
        },
      },
      content: document,
    };
  }

  for (const stage of ["design-system", "mapping-components", "creating-flows", "generating-ui"]) {
    const stageToolCallId = `canvas-${mode}-stage-${stage}`;
    messages.push(...declaredToolMessages(
      "workbench_generation_stage_update",
      stageToolCallId,
      validatedGenerationStageArtifact(stage, {
        ...scope,
        toolCallId: stageToolCallId,
      }),
    ));
  }

  const draftToolCallId = `canvas-${mode}-draft`;
  messages.push(...declaredToolMessages(
    "workbench_artifact_draft_publish",
    draftToolCallId,
    validatedArtifactDraftArtifact(draft, {
      ...scope,
      toolCallId: draftToolCallId,
    }),
  ));
  const result = {
    protocol: "workbench.runtime.result.v1",
    message: `Canvas ${mode} completed`,
    artifacts: [draft],
  };
  const resultToolCallId = `canvas-${mode}-result`;
  messages.push(...declaredToolMessages(
    "workbench_runtime_result_submit",
    resultToolCallId,
    validatedRuntimeResultArtifact(result, {
      ...scope,
      toolCallId: resultToolCallId,
    }),
  ));

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
  sendSse(response, "messages", [
    { type: "AIMessageChunk", role: "assistant", content: `Canvas ${mode} completed` },
    { langgraph_node: "workbench_canvas" },
  ], "1");
  sendSse(response, "values", {
    node: "finalize",
    values: { messages },
  }, "2");
  response.end();
}

function canvasDescriptorFromRequest(body) {
  const serialized = body?.context?.secrets?.WORKBENCH_CANVAS_CAPABILITY;
  assert.equal(typeof serialized, "string", "Worker omitted the private Canvas capability descriptor");
  const descriptor = parseJson(serialized, "Canvas capability descriptor");
  assert.equal(descriptor.protocol, "workbench.canvas-agent-tool-descriptor.v1");
  assert.equal(typeof descriptor.endpoint, "string");
  assert.match(descriptor.token, /^wbct1\./);
  assert.ok(Date.parse(descriptor.expiresAt) > Date.now());
  assert.equal(descriptor.reference.protocol, "workbench.canvas-agent-tool-reference.v1");
  return descriptor;
}

function canvasRuntimeTarget(context) {
  assert.equal(context.workflow, "edit");
  assert.equal(context.artifactTargets.length, 1);
  const target = context.artifactTargets[0];
  assert.equal(target.kind, "prototype");
  assert.deepEqual(target.screenIds, ["screen-home"]);
  assert.equal(target.content.mode, "inline");
  return {
    artifactId: target.artifactId,
    artifactVersionId: target.artifactVersionId,
    screenId: target.screenIds[0],
    document: target.content.value,
  };
}

function selectedCanvasReference(result, target) {
  assert.equal(result.data?.kind, "single");
  assert.equal(result.data?.items?.length, 1);
  const reference = result.data.items[0].reference;
  assert.equal(reference.artifactId, target.artifactId);
  assert.equal(reference.artifactVersionId, target.artifactVersionId);
  assert.equal(reference.screenId, target.screenId);
  return reference;
}

async function executeCanvasToolUntilTerminal(
  descriptor,
  toolName,
  toolCallId,
  input,
  state,
  runId,
) {
  const statuses = [];
  const deadline = Date.now() + scenarioTimeoutMs;
  while (Date.now() < deadline) {
    const result = await executeCanvasToolRequest({
      descriptor,
      toolName,
      toolCallId,
      input,
      deadline,
    });
    statuses.push(result.status);
    if (!["waiting_client", "waiting_approval"].includes(result.status)) {
      assert.equal(result.status, "succeeded", `${toolName} failed: ${JSON.stringify(result.failure)}`);
      state.canvasToolCalls.push({ runId, toolName, toolCallId, statuses });
      return result;
    }
    assert.equal(result.status, "waiting_client", `${toolName} unexpectedly requires approval`);
    await delay(50);
  }
  throw new Error(`Canvas tool ${toolName} did not reach a terminal status`);
}

function minimalPrototypeDocument() {
  const literal = (value) => ({ kind: "literal", value });
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-doc",
    title: "Canvas E2E",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "frame-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: "frame-home",
      screenId: "screen-home",
      parentId: null,
      name: "base-home",
      visible: true,
      layout: {
        mode: "absolute",
        x: literal(0),
        y: literal(0),
        width: literal(390),
        height: literal(844),
        display: "block",
        direction: "column",
        gap: literal(0),
        padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
        align: "stretch",
        justify: "start",
        gridColumns: null,
        overflow: "hidden",
      },
      style: {
        opacity: 1,
        rotation: 0,
        transformOrigin: { x: 0.5, y: 0.5 },
        fill: { kind: "literal", value: "#ffffff" },
        stroke: null,
        radii: {
          topLeft: literal(0),
          topRight: literal(0),
          bottomRight: literal(0),
          bottomLeft: literal(0),
        },
        shadowTokenIds: [],
        typography: null,
      },
      actionIds: [],
      bindingIds: [],
      motionIds: [],
      kind: "frame",
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function interactiveBrowserPrototypeDocument() {
  const document = minimalPrototypeDocument();
  document.nodes[0].actionIds = ["action-open-preview-reference"];
  document.actions = [{
    id: "action-open-preview-reference",
    nodeId: "frame-home",
    event: "click",
    kind: "openUrl",
    target: "newWindow",
    url: "https://example.com/preview-reference",
  }];
  return document;
}

function minimalPrdDocument() {
  assert.ok(prdV2DocumentFixture, "PRD v2 fixture was not initialized");
  return structuredClone(prdV2DocumentFixture);
}

function buildPrdV2DocumentFixture(example) {
  const document = structuredClone(example);
  document.documentId = prdV2DocumentId;
  document.title = prdV2Title;
  document.cover.workOrderName = prdV2WorkOrderName;
  document.cover.title = prdV2Title;
  document.revision.summary = "Initial deterministic E2E version";
  document.sections.introduction.background.blocks[0].content[0].text =
    "本 E2E 工作台覆盖确定性的需求说明书生成、状态反馈与结果确认，确保用户能够从项目入口提交请求、跟踪运行状态并读取最终产物。";
  document.sections.businessRequirements.summary[0].text =
    "总体目标：E2E 用户通过端内入口提交生成请求，连续跟踪处理状态，并完成异常恢复与结果确认。";
  document.sections.businessRequirements.flowAndPages.blocks[1].content[0].text =
    "两张图分别描述从请求提交到结果确认的正常与异常路径，以及页面、运行能力、状态记录和验收反馈之间的产品关系。";
  document.sections.degradation.content[0].text =
    "运行依赖发生故障时，页面保留用户已经填写的内容并阻止重复提交，清楚展示失败原因、影响范围和可执行的重试入口；状态同步延迟时继续显示最后一次可信状态及其更新时间，不提前标记成功；权限校验不可用时按无权限处理且不创建运行；产物读取失败时保留运行编号并允许稍后刷新。服务恢复后，用户可以从原运行继续查询或安全重试，幂等请求必须复用已有结果，同时记录异常时间、恢复时间和最终状态，供业务、研发与测试共同核验。";
  return document;
}

async function holdCancellationStream(request, response, state, run) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.flushHeaders?.();
  state.activeCancelStreams += 1;
  sendSse(response, "messages", [
    { type: "AIMessageChunk", role: "assistant", content: "E2E cancellation pending" },
    { langgraph_node: "generate_prd" },
  ], "1");
  await new Promise((resolve) => {
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(`: fake-heartbeat ${Date.now()}\n\n`);
    }, 250);
    heartbeat.unref();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      state.activeCancelStreams -= 1;
      resolve();
    };
    run.closeStream = () => {
      if (!response.destroyed && !response.writableEnded) response.end();
      finish();
    };
    request.once("aborted", finish);
    response.once("close", finish);
  });
  run.closeStream = null;
}

async function holdProcessFaultStream(request, response, fault) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-workbench-controlled-provider": "process-fault",
  });
  response.flushHeaders?.();
  fault.initialStreamActive = true;
  await new Promise((resolve) => {
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.write(": controlled-process-heartbeat\n\n");
      }
    }, 250);
    heartbeat.unref();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      fault.initialStreamActive = false;
      fault.initialStreamClosed = true;
      fault.closeInitialStream = null;
      resolve();
    };
    fault.closeInitialStream = () => {
      if (!response.destroyed && !response.writableEnded) response.end();
      finish();
    };
    request.once("aborted", finish);
    response.once("close", finish);
  });
}

function sendSse(response, event, value, id) {
  if (!response.destroyed && !response.writableEnded) {
    response.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
}

async function readJsonRequest(request) {
  const body = await readRequestBuffer(request, 2 * 1024 * 1024);
  const text = body.toString("utf8");
  return text ? parseJson(text, "fake runtime request") : null;
}

async function readRequestBuffer(request, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error("fake HTTP request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function runRealStackBrowserScenario({
  commonEnvironment,
  fakeRuntimeUrl,
  previewOrigin,
  recoveryScenarioTimeoutMs,
  webOrigin,
  webPort,
}) {
  assert.ok(Number.isSafeInteger(webPort), "real-stack browser Web port was not reserved");
  const evidenceStartedAt = new Date().toISOString();
  const evidenceRunDirectory = evidenceStartedAt.replaceAll(":", "-");
  const outputDir = path.join(
    root,
    "output",
    "playwright",
    "real-stack",
    candidateSourceCommit,
    evidenceRunDirectory,
  );
  const evidenceManifestPath = path.join(outputDir, "manifest.json");
  const evidenceManifest = {
    schemaVersion: 1,
    evidenceLevel: "real-stack",
    candidate: {
      sourceCommit: candidateSourceCommit,
      cleanAtStart: candidateSourceSnapshot.clean,
      sourceEntryCountAtStart: candidateSourceSnapshot.entryCount,
      sourceStatusDigestAtStart: candidateSourceSnapshot.digest,
      candidateBound: false,
    },
    provider: controlledProvider,
    startedAt: evidenceStartedAt,
    finishedAt: null,
    status: "running",
    browser: null,
    bffRequests: [],
    colorScheme: "dark",
    consoleErrors: [],
    failedRequests: [],
    terminalSseAborts: [],
    navigation: [],
    visualEvidence: [],
    webStartup: null,
    browserCleanup: [],
    checks: {},
    failure: null,
  };
  await mkdir(outputDir, { recursive: true });
  await writeEvidenceManifest(evidenceManifestPath, evidenceManifest);
  const oidcApiPort = await reservePort();
  const oidcApiBaseUrl = `http://127.0.0.1:${oidcApiPort}/api/v1`;
  const nextEnvPath = path.join(root, "apps", "web", "next-env.d.ts");
  const originalNextEnv = await readFile(nextEnvPath);
  const temporaryWebTsconfigPath = path.join(root, "apps", "web", ".tsconfig.real-stack.json");
  let browser;
  let context;
  let web;
  try {
  await copyFile(
    path.join(root, "apps", "web", "tsconfig.json"),
    temporaryWebTsconfigPath,
  );
  web = spawnService("workbench-web-real-stack", npm, [
    "--workspace", "@workbench/web", "exec", "--", "next", "dev", "--turbo",
    "--hostname", "127.0.0.1", "--port", String(webPort),
  ], {
    ...commonEnvironment,
    NODE_ENV: "test",
    BETTER_AUTH_URL: webOrigin,
    BETTER_AUTH_SECRET: "workbench-real-stack-browser-test-secret",
    WORKBENCH_DATABASE_SCHEMA: "workbench",
    WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "true",
    WORKBENCH_API_INTERNAL_URL: oidcApiBaseUrl,
    WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
    WORKBENCH_NEXT_TSCONFIG_PATH: path.basename(temporaryWebTsconfigPath),
  });
  await waitForWorkbenchWeb(webOrigin, web.exited);
  const authPaths = await warmWorkbenchAuthRoutes(webOrigin, web.exited);
  const protectedPaths = await warmWorkbenchProtectedRoutes(webOrigin, web.exited);
  const warmedPaths = [...authPaths, ...protectedPaths];
  evidenceManifest.webStartup = {
    mode: "development-prewarmed",
    warmedPathClasses: warmedPaths.map((warmupPath) => browserPathClass(warmupPath)),
  };
  console.log(`[e2e] Workbench Web routes ready: ${warmedPaths.join(", ")}`);

  const oidcApi = spawnService("workbench-api-real-stack", process.execPath, ["apps/workbench-api/dist/main.js"], {
    ...commonEnvironment,
    NODE_ENV: "test",
    WORKBENCH_API_HOST: "127.0.0.1",
    WORKBENCH_API_PORT: String(oidcApiPort),
    WORKBENCH_WEB_ORIGIN: webOrigin,
    WORKBENCH_AUTH_MODE: "oidc",
    WORKBENCH_E2E_EXTERNAL_DELIVERY_AVAILABLE: "netlify",
    OIDC_ISSUER: webOrigin,
    OIDC_AUDIENCE: "workbench",
    OIDC_JWKS_URL: `${webOrigin}/api/auth/jwks`,
    WORKBENCH_INVITATION_TOKEN_SECRET: invitationTokenSecret,
    WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
    WORKBENCH_PREVIEW_TOKEN_SECRET: previewTokenSecret,
    WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS: "60",
    WORKBENCH_CANVAS_TOOL_SECRET: canvasToolSecret,
    WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS: "300",
    WORKBENCH_CANVAS_COMMAND_TTL_SECONDS: "60",
    WORKBENCH_CANVAS_INVOCATION_LEASE_SECONDS: "30",
    DEERFLOW_LANGGRAPH_URL: fakeRuntimeUrl,
    DEERFLOW_GATEWAY_URL: fakeRuntimeUrl,
    DEERFLOW_INTERNAL_AUTH_TOKEN: fakeRuntimeToken,
  });
  await waitForHttp(`${oidcApiBaseUrl}/system/ready`, oidcApi, scenarioTimeoutMs);

  browser = await chromium.launch({ headless: true });
  evidenceManifest.browser = `chromium ${browser.version()}`;
  context = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 900 } });
  const browserSseEvents = [];
  const browserSseObservationFailures = [];
  await context.exposeBinding("__workbenchRecordSseEvidence", (_source, value) => {
    const evidence = browserSseEventEvidence(value);
    if (evidence) browserSseEvents.push(evidence);
    else browserSseObservationFailures.push({ class: "invalid-sse-event-evidence" });
  });
  await context.addInitScript(installBrowserSseEvidenceObserver, { webOrigin });
  const page = await context.newPage();
  const navigationEvidence = evidenceManifest.navigation;
  const bffRequests = evidenceManifest.bffRequests;
  const httpResponses = [];
  const externalRequests = [];
  const unknownRequests = [];
  const externalRequestClassifications = [];
  const sseSequences = [];
  evidenceManifest.httpResponses = httpResponses;
  evidenceManifest.externalRequests = externalRequests;
  evidenceManifest.unknownRequests = unknownRequests;
  evidenceManifest.sseEvents = browserSseEvents;
  evidenceManifest.sseObservationFailures = browserSseObservationFailures;
  evidenceManifest.sseReplayCursors = sseSequences;
  const consoleErrors = evidenceManifest.consoleErrors;
  const failedRequests = evidenceManifest.failedRequests;
  const navigationAbortTracker = createScriptedNavigationAbortTracker();
  const sseResponseEvidence = new WeakMap();
  const terminalSseAbortCandidates = [];
  const captureBrowserRequest = (request) => {
    const originClass = browserOriginClass(request.url(), { previewOrigin, webOrigin });
    if (originClass === "web") {
      navigationAbortTracker.requestStarted(request, {
        navigationRequest: request.isNavigationRequest(),
      });
    } else if (originClass !== "preview" && originClass !== "other-scheme") {
      const method = request.method();
      const resourceType = request.resourceType();
      let initiatorOrigin = null;
      let initiatorPathClass = null;
      let isMainFrame = false;
      try {
        const frame = request.frame();
        const initiatorUrl = new URL(frame.url());
        initiatorOrigin = initiatorUrl.origin;
        initiatorPathClass = browserPathClass(initiatorUrl.pathname);
        isMainFrame = frame === page.mainFrame();
      } catch {
        // Requests without an attributable frame remain unknown and fail closed.
      }
      const evidence = { originClass, method, resourceType };
      const classification = (async () => {
        try {
          const headers = await request.allHeaders();
          const hasCredentials = Object.keys(headers).some((name) => (
            name.toLowerCase() === "authorization" || name.toLowerCase() === "cookie"
          ));
          const requestClass = browserExternalRequestClass(request.url(), {
            hasCredentials,
            initiatorOrigin,
            initiatorPathClass,
            isMainFrame,
            isNavigationRequest: request.isNavigationRequest(),
            method,
            redirected: request.redirectedFrom() !== null,
            resourceType,
            webOrigin,
          });
          return { ...evidence, requestClass };
        } catch {
          return { ...evidence, inspection: "failed", requestClass: null };
        }
      })();
      externalRequestClassifications.push(classification);
    }
  };
  page.on("request", captureBrowserRequest);
  page.on("requestfinished", (request) => navigationAbortTracker.requestFinished(request));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).origin === webOrigin) {
      navigationAbortTracker.mainFrameNavigated();
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const originClass = browserOriginClass(url.href, { previewOrigin, webOrigin });
    const pathClass = browserPathClass(url.pathname);
    const responseEvidence = {
      originClass,
      method: response.request().method(),
      pathClass,
      status: response.status(),
    };
    if (originClass === "preview" || (originClass === "web" && url.pathname.startsWith("/api/"))) {
      httpResponses.push(responseEvidence);
    }
    if (originClass !== "web" || !url.pathname.startsWith("/api/v1/")) return;
    bffRequests.push({ method: responseEvidence.method, pathClass, status: responseEvidence.status });
    if (/\/runs\/[^/]+\/events$/u.test(url.pathname)) {
      const after = url.searchParams.get("afterSequence");
      const afterSequence = after === null ? null : Number(after);
      if (afterSequence !== null) sseSequences.push(afterSequence);
      sseResponseEvidence.set(response.request(), {
        afterSequence,
        status: response.status(),
      });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push({
        sourceClass: browserUrlClass(message.location().url, { previewOrigin, webOrigin }),
        type: "error",
      });
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const rawErrorText = request.failure()?.errorText ?? "unknown";
    const abortAttribution = navigationAbortTracker.classifyFailure(request, rawErrorText);
    const originClass = browserOriginClass(url.href, { previewOrigin, webOrigin });
    const failure = {
      originClass,
      method: request.method(),
      pathClass: originClass === "web" || originClass === "preview"
        ? browserPathClass(url.pathname)
        : "unknown-origin",
      errorText: browserNetworkFailureClass(rawErrorText),
      resourceType: request.resourceType(),
      abortAttribution,
    };
    failedRequests.push(failure);
    if (originClass === "web") {
      const sseRoute = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/u);
      if (abortAttribution === null && sseRoute) {
        const responseEvidence = sseResponseEvidence.get(request);
        terminalSseAbortCandidates.push({
          afterSequence: responseEvidence?.afterSequence ?? null,
          failure,
          responseStatus: responseEvidence?.status ?? null,
          runId: decodeURIComponent(sseRoute[1]),
        });
      }
    }
  });

    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
    await runScriptedHardNavigation({
      action: () => page.goto(`${webOrigin}/register`, { waitUntil: "networkidle" }),
      kind: "goto",
      navigationAbortTracker,
      navigationEvidence,
      page,
      targetPathClass: "/register",
    });
    if (new URL(page.url()).pathname !== "/register") {
      throw new Error(`registration route redirected to ${new URL(page.url()).pathname}`);
    }
    await page.getByRole("button", { name: "创建账号" }).click();
    const registrationFields = await page.locator("#username, #email, #password").count();
    if (registrationFields !== 3) {
      const pageText = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 240);
      throw new Error(`registration route did not render its form (fields=${registrationFields}, body=${JSON.stringify(pageText)})`);
    }
    await page.locator("#username").fill(`browser_${suffix}`.slice(0, 30));
    await page.locator("#email").fill(`browser_${suffix}@example.test`);
    await page.locator("#password").fill("BrowserRealStack!2026");
    await runScriptedHardNavigation({
      action: async () => {
        const navigationResponse = page.waitForResponse((response) => (
          response.request().isNavigationRequest()
          && response.frame() === page.mainFrame()
          && new URL(response.url()).origin === webOrigin
          && new URL(response.url()).pathname === "/"
        ), { timeout: scenarioTimeoutMs });
        await page.getByRole("button", { name: "创建工作台" }).click();
        const response = await navigationResponse;
        await page.waitForURL(`${webOrigin}/`, { timeout: scenarioTimeoutMs });
        return response;
      },
      kind: "form-submit",
      navigationAbortTracker,
      navigationEvidence,
      page,
      targetPathClass: "/",
    });
    await page.locator('textarea[aria-label="提示词"]').waitFor({ state: "visible", timeout: scenarioTimeoutMs });

    await page.locator('textarea[aria-label="提示词"]').fill("Generate a product requirements document for the synthetic browser test");
    await page.getByRole("button", { name: "提交提示" }).click();
    await page.waitForURL(/\/projects\//u, { timeout: scenarioTimeoutMs });
    const projectUrl = page.url();
    await page.locator('[data-panel-motion="agent-card"]').waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await page.locator('[data-canvas-generation-motion="prd"]').waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await page.locator('[data-generation-stage="collecting-prd-context"]')
      .first()
      .waitFor({ state: "attached", timeout: scenarioTimeoutMs });
    await waitFor(
      () => sseSequences.length > 0,
      scenarioTimeoutMs,
      "initial browser SSE request did not expose a replay cursor",
    );
    const sseRequestCountBeforeReload = sseSequences.length;
    const maximumCursorBeforeReload = Math.max(...sseSequences);
    await runScriptedHardNavigation({
      action: () => page.reload({ waitUntil: "domcontentloaded" }),
      kind: "reload",
      navigationAbortTracker,
      navigationEvidence,
      page,
      targetPathClass: "/projects/:id",
    });
    await page.locator('[data-panel-motion="agent-card"]').waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await page.locator('[data-canvas-generation-motion="prd"]').waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await waitFor(
      () => sseSequences
        .slice(sseRequestCountBeforeReload)
        .some((cursor) => cursor > maximumCursorBeforeReload),
      scenarioTimeoutMs,
      "active browser reload did not reconnect after the last consumed SSE sequence",
    );
    const reconnectCursor = sseSequences
      .slice(sseRequestCountBeforeReload)
      .find((cursor) => cursor > maximumCursorBeforeReload);
    const reconnectMotion = await page.locator('[data-canvas-generation-motion="prd"]').evaluate((element) => ({
      kind: element.getAttribute("data-canvas-generation-motion"),
      stage: element.getAttribute("data-generation-stage"),
    }));
    assert.equal(reconnectMotion.kind, "prd", "active reload restored the wrong motion kind");

    const visualEvidence = evidenceManifest.visualEvidence;
    await captureActiveGenerationVisualEvidence({
      evidence: visualEvidence,
      kind: "prd",
      outputDir,
      page,
    });
    assertActiveGenerationVisualEvidence(visualEvidence, "prd");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const cdpSession = await context.newCDPSession(page);
    await cdpSession.send("Network.enable");
    const pendingDocument = page
      .locator('[data-workbench-artifact-state="pending"][data-workbench-artifact-variant="document"]')
      .filter({ hasText: "正在细化：需求文档" });
    let pendingDocumentEvidence = [];
    try {
      await cdpSession.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: pendingDocumentEvidenceLatencyMs,
        downloadThroughput: 5 * 1024 * 1024,
        uploadThroughput: 5 * 1024 * 1024,
      });
      fakeRuntime.releaseBrowserPrdDraft();
      await pendingDocument.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
      pendingDocumentEvidence = await capturePendingDocumentVisualEvidence({
        outputDir,
        page,
        pendingDocument,
      });
      evidenceManifest.pendingDocumentEvidence = pendingDocumentEvidence;
      assertPendingDocumentVisualEvidence(pendingDocumentEvidence);
    } finally {
      fakeRuntime.releaseBrowserPrdDraft();
      fakeRuntime.releaseBrowserPrdFinalization();
      await cdpSession.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await cdpSession.detach();
    }
    await pendingDocument.waitFor({ state: "detached", timeout: scenarioTimeoutMs });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator('[data-phase="complete"]').first().waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await runScriptedHardNavigation({
      action: () => page.reload({ waitUntil: "networkidle" }),
      kind: "reload",
      navigationAbortTracker,
      navigationEvidence,
      page,
      targetPathClass: "/projects/:id",
    });
    await page.locator('[data-phase="complete"]').first().waitFor({ state: "visible", timeout: scenarioTimeoutMs });

    await runScriptedHardNavigation({
      action: () => page.goto(projectUrl, { waitUntil: "networkidle" }),
      kind: "goto",
      navigationAbortTracker,
      navigationEvidence,
      page,
      targetPathClass: "/projects/:id",
    });
    const projectId = new URL(projectUrl).pathname.split("/").at(-1);

    await page.getByRole("button", { name: "导出", exact: true }).click();
    const exportPanel = page.locator("[data-workbench-export-panel]");
    await exportPanel.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    if (await exportPanel.getAttribute("data-export-state") === "empty") {
      await exportPanel.getByRole("button", { name: "全选", exact: true }).click();
    }
    await waitFor(
      async () => await exportPanel.getAttribute("data-export-state") === "selected",
      scenarioTimeoutMs,
      "product Export panel did not select the persisted Board",
    );
    const netlifyTarget = exportPanel.getByRole("button", { name: /Netlify/u });
    await netlifyTarget.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    assert.equal(await netlifyTarget.isEnabled(), true, "controlled Netlify capability was unavailable in the product Export panel");
    await netlifyTarget.click();

    const exportCreationResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && /^\/api\/v1\/projects\/[^/]+\/exports$/u.test(new URL(response.url()).pathname)
    ), { timeout: scenarioTimeoutMs });
    await exportPanel.getByRole("button", { name: "生成并准备 Netlify", exact: true }).click();
    assert.equal((await exportCreationResponse).status(), 202, "product Export creation did not return 202");
    const prepareDeliveryButton = exportPanel.getByRole("button", { name: "准备发布至 Netlify", exact: true });
    await prepareDeliveryButton.waitFor({ state: "visible", timeout: scenarioTimeoutMs });

    const deliveryCreationResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && /^\/api\/v1\/exports\/[^/]+\/deliveries$/u.test(new URL(response.url()).pathname)
    ), { timeout: scenarioTimeoutMs });
    await prepareDeliveryButton.click();
    assert.equal((await deliveryCreationResponse).status(), 201, "product External Delivery preparation did not return 201");
    await exportPanel.locator("[data-external-delivery-confirmation]")
      .waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const deliveryBeforeConfirmation = await latestBrowserExternalDelivery(projectId);
    assert.equal(deliveryBeforeConfirmation.status, "pending_confirmation", "External Delivery was not pending confirmation");
    assert.equal(deliveryBeforeConfirmation.attempt, 0, "pending External Delivery already had an execution attempt");
    assert.equal(deliveryBeforeConfirmation.confirmedAt, null, "pending External Delivery was already confirmed");
    assert.equal(deliveryBeforeConfirmation.transferAuthorizedAt, null, "pending External Delivery was already authorized");
    assert.equal(deliveryBeforeConfirmation.queueJobs, 0, "pending External Delivery was queued before confirmation");

    const deliveryConfirmationResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && /^\/api\/v1\/export-deliveries\/[^/]+\/confirm$/u.test(new URL(response.url()).pathname)
    ), { timeout: scenarioTimeoutMs });
    await exportPanel.getByRole("button", { name: "确认发布至 Netlify", exact: true }).click();
    assert.equal((await deliveryConfirmationResponse).status(), 202, "product External Delivery confirmation did not return 202");
    await exportPanel.getByRole("button", { name: "重试发布 Netlify", exact: true })
      .waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const deliveryAfterConfirmation = await latestBrowserExternalDelivery(projectId);
    assert.equal(deliveryAfterConfirmation.id, deliveryBeforeConfirmation.id, "External Delivery identity changed after confirmation");
    assert.equal(deliveryAfterConfirmation.status, "failed", "controlled unavailable external adapter did not fail closed");
    assert.equal(deliveryAfterConfirmation.failureCode, "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED", "External Delivery lost its stable failure code");
    assert.ok(deliveryAfterConfirmation.confirmedAt, "confirmed External Delivery omitted its confirmation timestamp");
    assert.ok(deliveryAfterConfirmation.transferAuthorizedAt, "confirmed External Delivery omitted transfer authorization");
    assert.ok(deliveryAfterConfirmation.queueJobs >= 1, "confirmed External Delivery did not enqueue durable work");
    assert.ok(fakeRuntime.state.exportReads.some((read) => read.role === "export"), "Export Worker did not read the canonical object with its dedicated identity");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await exportPanel.waitFor({ state: "detached", timeout: scenarioTimeoutMs });

    assert.ok(projectId, "real-stack browser project URL has no project id");
    const mixedPersistenceBefore = await browserProjectPersistenceCounts(projectId);
    const mixedProviderRequestsBefore = fakeRuntime.state.runRequests.length;
    const mixedSubmissionPostsBefore = bffRequests.filter((request) => (
      request.method === "POST" && /\/threads\/:id\/submission-intents$/u.test(request.pathClass)
    )).length;
    const mixedComposer = page.locator('input[placeholder="您想更改或创建什么内容?"]');
    await mixedComposer.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const mixedArtifactPrompt = "生成需求文档。然后生成原型";
    await mixedComposer.fill(mixedArtifactPrompt);
    await page.getByRole("button", { name: "提交项目请求" }).click();
    await page.locator('[data-panel-motion="agent-card"]').getByText("提交失败", { exact: true })
      .waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const mixedErrorMessage = "一次运行只能生成需求文档或原型。请先完成需求文档，再发起原型生成。";
    const mixedErrorToast = page.locator('[data-sonner-toast][data-type="error"]')
      .filter({ hasText: mixedErrorMessage });
    await mixedErrorToast.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const mixedErrorToastText = (await mixedErrorToast.textContent())?.replace(/\s+/gu, " ").trim() ?? "";
    assert.ok(mixedErrorToastText.includes(mixedErrorMessage), "mixed Composer rejection omitted its localized product message");
    assert.doesNotMatch(
      mixedErrorToastText,
      /requestedArtifactKinds|two sequential Runs|\[\s*\{/u,
      "mixed Composer rejection exposed its schema validation payload",
    );
    const mixedPersistenceAfter = await browserProjectPersistenceCounts(projectId);
    const mixedSubmissionPostsAfter = bffRequests.filter((request) => (
      request.method === "POST" && /\/threads\/:id\/submission-intents$/u.test(request.pathClass)
    )).length;
    const mixedProviderRequestsAdded = fakeRuntime.state.runRequests.length - mixedProviderRequestsBefore;
    const mixedSubmissionPostsAdded = mixedSubmissionPostsAfter - mixedSubmissionPostsBefore;
    assert.deepEqual(
      mixedPersistenceAfter,
      mixedPersistenceBefore,
      "mixed Composer request created persistent side effects",
    );
    assert.equal(
      mixedProviderRequestsAdded,
      0,
      "mixed Composer request reached the controlled provider",
    );
    assert.equal(
      mixedSubmissionPostsAdded,
      0,
      "mixed Composer request crossed the client contract boundary",
    );
    assert.equal(await mixedComposer.inputValue(), mixedArtifactPrompt, "rejected mixed prompt was cleared from the Composer");
    assert.equal(await page.locator('[data-phase="generating"]').count(), 0, "mixed Composer request left an active Run UI");
    await mixedComposer.fill("");

    await page.getByRole("button", { name: /基于此 PRD 生成 UI/u }).waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await page.evaluate(() => {
      const observations = [];
      const observer = new MutationObserver(() => {
        observations.push(...[...document.querySelectorAll("[data-canvas-generation-motion]")]
          .map((element) => element.getAttribute("data-canvas-generation-motion")));
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-canvas-generation-motion"] });
      globalThis.__workbenchPrototypeMotionObservations = observations;
      globalThis.__workbenchPrototypeMotionObserver = observer;
    });
    await page.getByRole("button", { name: /基于此 PRD 生成 UI/u }).click();
    await mixedErrorToast.waitFor({ state: "detached", timeout: scenarioTimeoutMs });
    await page.locator('[data-canvas-generation-motion="prototype"]').waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const prototypeObservations = await page.evaluate(() => {
      globalThis.__workbenchPrototypeMotionObserver?.disconnect();
      return globalThis.__workbenchPrototypeMotionObservations ?? [];
    });
    assert.ok(!prototypeObservations.includes("prd"), "prototype Run mounted a PRD generation wash after the stale PRD artifact");
    const prototypeVisualEvidence = [];
    await captureActiveGenerationVisualEvidence({
      evidence: prototypeVisualEvidence,
      kind: "prototype",
      outputDir,
      page,
    });
    evidenceManifest.prototypeVisualEvidence = prototypeVisualEvidence;
    assertActiveGenerationVisualEvidence(prototypeVisualEvidence, "prototype");

    await page.locator('[data-phase="complete"]').first().waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const artifactPersistence = await assertBrowserArtifactPersistence(projectId);
    evidenceManifest.artifactPersistence = artifactPersistence;
    await runScriptedHardNavigation({
      action: () => page.goto(projectUrl, { waitUntil: "networkidle" }),
      kind: "goto",
      navigationAbortTracker,
      navigationEvidence,
      page,
      targetPathClass: "/projects/:id",
    });

    await context.addCookies([{
      name: "workbench_preview_ambient_canary",
      value: "must-not-reach-preview",
      domain: "127.0.0.1",
      path: "/preview",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    }]);
    const previewCanaryCookiePresent = (await context.cookies(`${previewOrigin}/preview/canary`))
      .some((cookie) => cookie.name === "workbench_preview_ambient_canary");
    assert.equal(previewCanaryCookiePresent, true, "Preview credential canary cookie was not installed");

    const previewHttpResponseStart = httpResponses.length;
    let previewEvidence = null;
    const productPreviewRequestHeaders = [];
    const captureProductPreviewRequest = (request) => {
      if (new URL(request.url()).origin !== previewOrigin) return;
      productPreviewRequestHeaders.push(request.allHeaders().then((headers) => ({
        method: request.method(),
        pathClass: browserPathClass(new URL(request.url()).pathname),
        hasCookie: headers.cookie !== undefined,
        hasAuthorization: headers.authorization !== undefined,
      })));
    };
    page.on("request", captureProductPreviewRequest);
    try {
      const previewAction = page.locator('[data-project-action="preview"]');
      await previewAction.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
      assert.equal(
        await previewAction.getAttribute("aria-label"),
        "预览项目",
        "product Preview action lost its accessible name",
      );
      assert.equal(await previewAction.isEnabled(), true, "product Preview action was disabled");
      await previewAction.click({ timeout: scenarioTimeoutMs });
      const productPreview = page.locator("[data-project-preview]");
      await productPreview.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
      const productPreviewFrame = productPreview.locator("iframe[data-preview-capability]");
      await productPreviewFrame.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
      await productPreview.locator('[data-isolated-preview] [role="status"]')
        .waitFor({ state: "detached", timeout: scenarioTimeoutMs });
      const embeddedPreview = await productPreviewFrame.evaluate((frame) => ({
        credentialless: frame.getAttribute("credentialless"),
        referrerPolicy: frame.getAttribute("referrerpolicy"),
        sandbox: frame.getAttribute("sandbox"),
        src: frame.getAttribute("src"),
      }));
      assert.equal(new URL(embeddedPreview.src).origin, previewOrigin, "product Preview iframe did not use the independent origin");
      assert.equal(embeddedPreview.credentialless, "", "product Preview iframe was not credentialless");
      assert.equal(embeddedPreview.referrerPolicy, "no-referrer", "product Preview iframe did not suppress referrers");
      assert.equal(
        embeddedPreview.sandbox,
        "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox",
        "product Preview iframe sandbox permissions drifted",
      );
      const productPreviewRequests = await Promise.all(productPreviewRequestHeaders);
      assert.ok(productPreviewRequests.length > 0, "product Preview iframe did not request the independent origin");
      assert.ok(
        productPreviewRequests.every((request) => !request.hasCookie && !request.hasAuthorization),
        "product Preview iframe carried ambient credentials",
      );
      assert.ok(
        fakeRuntime.state.exportReads.some((read) => read.role === "preview"),
        "product Preview did not read the canonical Export object with its dedicated identity",
      );
      const previewResponses = httpResponses
        .slice(previewHttpResponseStart)
        .filter((response) => response.originClass === "preview");
      assert.ok(previewResponses.length > 0, "product Preview iframe did not receive an independent-origin response");
      assert.ok(
        previewResponses.every((response) => response.status >= 200 && response.status < 400),
        "product Preview iframe received an unexpected HTTP status",
      );
      previewEvidence = {
        domAssertions: {
          credentialless: embeddedPreview.credentialless === "",
          frameVisible: true,
          independentOrigin: true,
          loadingStatusDetached: true,
          referrerPolicy: embeddedPreview.referrerPolicy,
          sandbox: embeddedPreview.sandbox,
        },
        requestSecurity: {
          authorizationBlocked: productPreviewRequests.every((request) => !request.hasAuthorization),
          cookieBlocked: productPreviewRequests.every((request) => !request.hasCookie),
          requestCount: productPreviewRequests.length,
        },
        requests: productPreviewRequests.map(({ method, pathClass }) => ({ method, pathClass })),
        responses: previewResponses,
      };
      evidenceManifest.previewEvidence = previewEvidence;
      await page.getByRole("button", { name: "退出预览" }).click();
      await productPreview.waitFor({ state: "detached", timeout: scenarioTimeoutMs });
    } catch (error) {
      evidenceManifest.previewFailureDiagnostics = await captureBrowserPreviewFailure({
        bffRequests,
        outputDir,
        page,
        projectId,
      });
      throw error;
    } finally {
      page.off("request", captureProductPreviewRequest);
    }

    const composer = page.locator('input[placeholder="您想更改或创建什么内容?"]');
    await composer.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await composer.fill("E2E_BROWSER_FAILURE: Generate a product requirements document for controlled recovery");
    await page.getByRole("button", { name: "提交项目请求" }).click();
    await page.locator('[data-phase="generating"]').first().waitFor({ state: "visible", timeout: recoveryScenarioTimeoutMs });
    const retryButton = page.getByRole("button", { name: "重试当前运行" }).first();
    await retryButton.waitFor({ state: "visible", timeout: recoveryScenarioTimeoutMs });
    await page.locator('[data-panel-motion="agent-card"]').getByText("运行失败", { exact: true })
      .waitFor({ state: "visible", timeout: recoveryScenarioTimeoutMs });
    assert.equal(fakeRuntime.state.browserFailureAttempts, 1, "controlled browser failure issued a duplicate provider submission");
    assert.ok(fakeRuntime.state.browserFailureRejoinAttempts > 0, "controlled browser failure did not rejoin the accepted provider Run");
    const browserFailureQueueJob = (await queryDatabase(`
      SELECT "state", "retry_count", "retry_limit"
      FROM "workbench_jobs"."job"
      WHERE "name" = 'runtime.execute'
      ORDER BY "created_on" DESC
      LIMIT 1
    `)).rows[0];
    assert.equal(browserFailureQueueJob?.state, "failed", "controlled browser failure queue job was not terminal");
    assert.equal(
      browserFailureQueueJob?.retry_count,
      browserFailureQueueJob?.retry_limit,
      "controlled browser failure did not exhaust the real pg-boss retry policy",
    );
    const browserFailureQueueRetries = Number(browserFailureQueueJob.retry_count);

    const retryResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && /^\/api\/v1\/runs\/[^/]+\/retry$/u.test(new URL(response.url()).pathname)
    ), { timeout: recoveryScenarioTimeoutMs });
    await retryButton.click();
    const retryResponse = await retryResponsePromise;
    assert.equal(retryResponse.status(), 202, "browser Run retry did not return 202");
    await page.locator('[data-phase="generating"]').first().waitFor({ state: "visible", timeout: recoveryScenarioTimeoutMs });
    await page.locator('[data-phase="complete"]').first().waitFor({ state: "visible", timeout: recoveryScenarioTimeoutMs });
    assert.equal(fakeRuntime.state.browserFailureRecoveryRuns, 1, "browser Run retry did not execute through the controlled provider");

    await composer.fill("E2E_CANCEL: Generate a product requirements document for controlled cancellation");
    await page.getByRole("button", { name: "提交项目请求" }).click();
    await page.locator('[data-phase="generating"]').first().waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await waitFor(
      () => fakeRuntime.state.activeCancelStreams === 1,
      scenarioTimeoutMs,
      "controlled browser cancellation stream did not open",
    );
    const cancelButton = page.getByRole("button", { name: "取消当前任务" });
    await cancelButton.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    const cancelResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && /^\/api\/v1\/runs\/[^/]+\/cancel$/u.test(new URL(response.url()).pathname)
    ), { timeout: scenarioTimeoutMs });
    await cancelButton.click();
    const cancelResponse = await cancelResponsePromise;
    assert.equal(cancelResponse.status(), 202, "browser Run cancellation did not return 202");
    await page.locator('[data-panel-motion="agent-card"]').getByText("运行已取消", { exact: true })
      .waitFor({ state: "visible", timeout: scenarioTimeoutMs });
    await waitFor(
      () => fakeRuntime.state.activeCancelStreams === 0,
      scenarioTimeoutMs,
      "controlled browser cancellation stream did not close",
    );

    await page.waitForTimeout(50);
    const requiredBrowserTerminalSseEvents = ["run.completed", "run.failed"];
    await waitFor(
      () => hasRequiredBrowserSseEvidence(browserSseEvents, reconnectCursor),
      scenarioTimeoutMs,
      "browser SSE observer did not record reconnect, completed, and failed event evidence",
    );
    const terminalSseAborts = await attributePersistedTerminalSseAborts(terminalSseAbortCandidates);
    evidenceManifest.terminalSseAborts = terminalSseAborts;
    page.off("request", captureBrowserRequest);
    const requestClassifications = await Promise.all(externalRequestClassifications);
    for (const { requestClass, ...evidence } of requestClassifications) {
      if (requestClass) externalRequests.push({ ...evidence, requestClass });
      else unknownRequests.push(evidence);
    }
    assert.ok(bffRequests.some((request) => /\/runs\/:id\/events$/u.test(request.pathClass)), "browser did not open the real BFF SSE endpoint");
    assert.ok(bffRequests.some((request) => request.method === "POST" && /\/runs\/:id\/retry$/u.test(request.pathClass) && request.status === 202), "browser did not retry the failed Run through the real BFF");
    assert.ok(bffRequests.some((request) => request.method === "POST" && /\/runs\/:id\/cancel$/u.test(request.pathClass) && request.status === 202), "browser did not cancel the active Run through the real BFF");
    const navigationAborts = failedRequests.filter((request) => (
      request.abortAttribution?.cause === "scripted-hard-navigation"
    ));
    const unattributedFailedRequests = failedRequests.filter((request) => request.abortAttribution === null);
    assert.equal(
      unattributedFailedRequests.length,
      0,
      `real-stack browser had unattributed failed requests: ${JSON.stringify(unattributedFailedRequests)}`,
    );
    const expectedAbortCauses = new Set([
      "scripted-hard-navigation",
      "persisted-terminal-run-sse-cleanup",
    ]);
    const unexpectedFailedRequests = failedRequests.filter((request) => (
      !expectedAbortCauses.has(request.abortAttribution?.cause)
    ));
    assert.equal(
      unexpectedFailedRequests.length,
      0,
      `real-stack browser had unexpected failed requests: ${JSON.stringify(unexpectedFailedRequests)}`,
    );
    assert.equal(
      unknownRequests.length,
      0,
      `real-stack browser issued requests to unknown origins: ${JSON.stringify(unknownRequests)}`,
    );
    assert.deepEqual(
      externalRequests.map((request) => request.requestClass).sort(),
      ["auth-spotlight-primary", "auth-spotlight-reveal"],
      `real-stack browser external request evidence was incomplete: ${JSON.stringify(externalRequests)}`,
    );
    const unexpectedHttpResponses = httpResponses.filter((response) => (
      response.status < 200 || response.status >= 400
    ));
    assert.equal(
      unexpectedHttpResponses.length,
      0,
      `real-stack browser received unexpected HTTP responses: ${JSON.stringify(unexpectedHttpResponses)}`,
    );
    assert.equal(
      browserSseObservationFailures.length,
      0,
      `real-stack browser observed invalid SSE evidence: ${JSON.stringify(browserSseObservationFailures)}`,
    );
    assert.ok(
      browserSseEvents.some((event) => (
        event.afterSequence === reconnectCursor && event.sequence > reconnectCursor
      )),
      "browser SSE observer did not prove forward replay after reconnect",
    );
    for (const terminalEventName of requiredBrowserTerminalSseEvents) {
      assert.ok(
        browserSseEvents.some((event) => event.eventName === terminalEventName),
        `browser SSE observer did not record ${terminalEventName}`,
      );
    }
    const persistedCancellationObserved = terminalSseAborts.some((request) => {
      const attribution = request.abortAttribution;
      return attribution?.cause === "persisted-terminal-run-sse-cleanup"
        && attribution.terminalStatus === "cancelled"
        && attribution.terminalEventType === "run.cancelled"
        && Number.isSafeInteger(attribution.terminalSequence)
        && attribution.terminalSequence > 0;
    });
    assert.ok(
      browserSseEvents.some((event) => event.eventName === "run.cancelled")
      || persistedCancellationObserved,
      "browser cancellation lacked observed or persisted terminal SSE evidence",
    );
    assert.ok(previewEvidence, "product Preview evidence was not retained in the manifest");
    assert.equal(
      consoleErrors.length,
      0,
      `real-stack browser console errors: ${JSON.stringify(consoleErrors)}`,
    );

    const checks = {
      betterAuthRegistration: true,
      bffOidcApi: true,
      workerArtifactPersistence: true,
      prdPendingPanelAndMotion: true,
      mixedRequestRejected: true,
      prototypeAfterPrdMotion: true,
      reconnectReload: true,
      previewIndependentOriginAndSandbox: true,
      previewCredentialCanaryBlocked: true,
      releaseAndExportBuild: true,
      externalDeliveryConfirmationGate: true,
      runFailureRetry: true,
      runCancellation: true,
      failedNetworkRequestsAttributed: true,
      externalRequestsClassified: true,
      httpResponsesAllowlisted: true,
      sseEventSequenceRecorded: true,
    };
    const controlledRuntime = {
      failureSubmissions: fakeRuntime.state.browserFailureAttempts,
      failureRejoins: fakeRuntime.state.browserFailureRejoinAttempts,
      queueRetries: browserFailureQueueRetries,
      recoveryRuns: fakeRuntime.state.browserFailureRecoveryRuns,
      cancellationRuns: fakeRuntime.state.cancelRuns,
    };
    Object.assign(evidenceManifest, {
      status: "passed",
      browser: `chromium ${browser.version()}`,
      visualEvidence,
      pendingDocumentEvidence,
      artifactPersistence,
      mixedZeroSideEffects: {
        persistenceCountsUnchanged: true,
        providerRequestsAdded: mixedProviderRequestsAdded,
        submissionPostsAdded: mixedSubmissionPostsAdded,
      },
      mixedErrorPresentation: {
        localized: true,
        schemaPayloadHidden: true,
        dismissedBeforeNextRun: true,
      },
      externalDeliveryConfirmation: {
        attemptBeforeConfirmation: deliveryBeforeConfirmation.attempt,
        queueJobsBeforeConfirmation: deliveryBeforeConfirmation.queueJobs,
        queueJobsAfterConfirmation: deliveryAfterConfirmation.queueJobs,
        terminalStatus: deliveryAfterConfirmation.status,
      },
      bffRequests: bffRequests.map(({ method, pathClass, status }) => ({ method, pathClass, status })),
      externalRequests,
      httpResponses,
      previewEvidence,
      navigationAborts,
      terminalSseAborts,
      sseEvents: browserSseEvents,
      sseReplayCursors: sseSequences,
      controlledRuntime,
      checks,
    });
    console.log(JSON.stringify({
      evidenceLevel: "real-stack",
      sourceCommit: candidateSourceCommit,
      sourceTreeAtStart: candidateSourceSnapshot.clean ? "clean" : "dirty",
      provider: controlledProvider,
      browser: `chromium ${browser.version()}`,
      evidenceManifest: path.relative(root, evidenceManifestPath),
      checks,
      controlledRuntime,
      externalDelivery: {
        attemptBeforeConfirmation: deliveryBeforeConfirmation.attempt,
        queueJobsBeforeConfirmation: deliveryBeforeConfirmation.queueJobs,
        queueJobsAfterConfirmation: deliveryAfterConfirmation.queueJobs,
      },
    }));
  } catch (error) {
    evidenceManifest.status = "failed";
    evidenceManifest.failure = {
      class: error instanceof Error ? error.name : "UnknownError",
    };
    throw error;
  } finally {
    if (context) {
      evidenceManifest.browserCleanup.push(await runBoundedCleanup(
        "browser-context",
        () => context.close(),
        browserCleanupTimeoutMs,
      ));
    }
    if (browser) {
      evidenceManifest.browserCleanup.push(await runBoundedCleanup(
        "browser",
        () => browser.close(),
        browserCleanupTimeoutMs,
      ));
    }
    if (web) await stopService(web);
    await rm(temporaryWebTsconfigPath, { force: true });
    await writeFile(nextEnvPath, originalNextEnv);
    const finishedSourceSnapshot = resolveCandidateSourceSnapshot();
    const sourceDrift = finishedSourceSnapshot.digest !== candidateSourceSnapshot.digest;
    Object.assign(evidenceManifest.candidate, {
      cleanAtFinish: finishedSourceSnapshot.clean,
      sourceEntryCountAtFinish: finishedSourceSnapshot.entryCount,
      sourceStatusDigestAtFinish: finishedSourceSnapshot.digest,
      sourceDrift,
      candidateBound: candidateSourceSnapshot.clean
        && finishedSourceSnapshot.clean
        && !sourceDrift,
    });
    const sourceDriftFailure = shouldFailRealStackEvidenceForSourceDrift(
      evidenceManifest.status,
      sourceDrift,
    );
    if (sourceDriftFailure) {
      evidenceManifest.status = "failed";
      evidenceManifest.failure = { class: "SourceDriftError" };
    }
    evidenceManifest.finishedAt = new Date().toISOString();
    const manifestSha256 = await writeEvidenceManifest(evidenceManifestPath, evidenceManifest);
    console.log(`[e2e] evidence manifest: ${path.relative(root, evidenceManifestPath)} sha256=${manifestSha256}`);
    if (sourceDriftFailure) throw new Error("REAL_STACK_SOURCE_DRIFT");
  }
}

function controlledGate() {
  let released = false;
  let releasePromise;
  const promise = new Promise((resolve) => {
    releasePromise = resolve;
  });
  return {
    wait: () => promise,
    release: () => {
      if (released) return;
      released = true;
      releasePromise();
    },
  };
}

async function waitForControlledProviderGate(response, gate) {
  while (true) {
    const released = await Promise.race([
      gate.wait().then(() => true),
      delay(controlledProviderHeartbeatMs, false),
    ]);
    if (released) return;
    if (response.destroyed || response.writableEnded) {
      throw new Error("controlled provider stream closed before the visual gate was released");
    }
    // Comment-only SSE frames reset the real adapter's idle budget without
    // advancing the durable provider cursor or changing business state.
    response.write(": workbench-e2e-provider-heartbeat\n\n");
  }
}

function spawnService(name, command, args, environment) {
  const log = new LogBuffer(name);
  const child = spawn(command, args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => log.append("stdout", chunk));
  child.stderr.on("data", (chunk) => log.append("stderr", chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const service = { name, child, log, exited, spawnError: null };
  child.once("error", (error) => {
    service.spawnError = error;
    log.append("stderr", `failed to spawn: ${error.message}\n`);
  });
  services.push(service);
  return service;
}

async function waitForHttp(url, service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastConnectionErrorClass = null;
  let lastHttpStatus = null;
  while (Date.now() < deadline) {
    assertServiceRunning(service);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastHttpStatus = response.status;
    } catch (error) {
      lastConnectionErrorClass = connectionErrorClass(error);
    }
    await delay(200);
  }
  throw new Error(
    `${service.name} did not become ready within ${timeoutMs}ms `
    + `(originClass=${httpOriginClass(url)}, `
    + `lastConnectionError=${lastConnectionErrorClass ?? "none"}, `
    + `lastHttpStatus=${lastHttpStatus ?? "none"})`,
  );
}

async function waitForProcessStart(service, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    assertServiceRunning(service);
    await delay(50);
  }
}

function assertServiceRunning(service) {
  if (service.spawnError) {
    throw new Error(`${service.name} could not start: ${service.spawnError.message}`);
  }
  if (service.child.exitCode !== null || service.child.signalCode !== null) {
    throw new Error(`${service.name} exited before becoming ready`);
  }
}

async function runCommand(name, command, args, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = boundedAppend(output, chunk);
    if (verbose) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output = boundedAppend(output, chunk);
    if (verbose) process.stderr.write(chunk);
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, commandTimeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (timedOut || result.code !== 0) {
    throw new Error(`${name} failed (${timedOut ? "timeout" : `exit ${result.code}, signal ${result.signal}`})\n${output}`);
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError instanceof Error ? lastError.message : lastError}` : ""}`);
}

async function runScriptedHardNavigation({
  action,
  kind,
  navigationAbortTracker,
  navigationEvidence,
  page,
  targetPathClass,
}) {
  const scope = navigationAbortTracker.beginNavigation({ kind, targetPathClass });
  let recorded = false;
  try {
    const response = await action();
    const actualPathClass = browserPathClass(new URL(page.url()).pathname);
    const status = response?.status() ?? null;
    navigationEvidence.push({
      actualPathClass,
      kind,
      status,
      targetPathClass,
    });
    recorded = true;
    assert.ok(response, `browser ${kind} to ${targetPathClass} returned no main-resource response`);
    assert.equal(status, 200, `browser ${kind} to ${targetPathClass} returned HTTP ${status}`);
    assert.equal(
      actualPathClass,
      targetPathClass,
      `browser ${kind} landed on ${actualPathClass} instead of ${targetPathClass}`,
    );
    return response;
  } catch (error) {
    if (!recorded) {
      navigationEvidence.push({
        actualPathClass: browserPathClass(new URL(page.url()).pathname),
        errorClass: error instanceof Error ? error.name : "UnknownError",
        kind,
        status: null,
        targetPathClass,
      });
    }
    throw error;
  } finally {
    // Let Playwright deliver aborts caused by unloading the old document before
    // closing the narrowly scoped attribution window.
    await delay(0);
    navigationAbortTracker.endNavigation(scope);
  }
}

async function captureActiveGenerationVisualEvidence({ evidence, kind, outputDir, page }) {
  const selector = `[data-canvas-generation-motion="${kind}"]`;
  for (const reducedMotion of [false, true]) {
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    if (reducedMotion) await page.waitForTimeout(20);
    for (const viewport of generationVisualViewports) {
      await page.setViewportSize(viewport);
      const motionElement = page.locator(selector);
      await motionElement.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
      const motion = await captureStableMotionFrames(motionElement, kind);
      const layout = await page.evaluate(() => {
        const metric = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { visible: false, rect: null };
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible = style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) > 0
            && rect.width > 0
            && rect.height > 0;
          return {
            visible,
            rect: visible
              ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
              : null,
          };
        };
        return {
          agentCard: metric('[data-panel-motion="agent-card"]'),
          taskStack: metric("[data-left-task-stack]"),
          mobileRunStatus: metric("[data-mobile-run-status]"),
          composer: metric("[data-project-composer]"),
          rightToolRail: metric("[data-right-tool-rail]"),
          selectedAction: metric("[data-selected-action]"),
          suggestions: metric("[data-project-suggestions]"),
          utilityPill: metric("[data-utility-pill]"),
        };
      });
      const runState = await page.locator('[data-panel-motion="agent-card"]').evaluate((element) => ({
        phase: element.getAttribute("data-phase"),
        stage: element.getAttribute("data-generation-stage"),
        status: "active",
        motionKind: document.querySelector("[data-canvas-generation-motion]")
          ?.getAttribute("data-canvas-generation-motion") ?? null,
      }));
      const screenshotPath = path.join(
        outputDir,
        `workbench-real-stack-${kind}-${viewport.width}x${viewport.height}-${reducedMotion ? "reduced" : "normal"}.png`,
      );
      const bytes = await page.screenshot({ path: screenshotPath, fullPage: false });
      evidence.push({
        viewport: `${viewport.width}x${viewport.height}`,
        reducedMotion,
        colorScheme: "dark",
        runState,
        motion,
        layout,
        screenshot: path.relative(root, screenshotPath),
        sha256: sha256(bytes),
      });
    }
  }
}

function assertActiveGenerationVisualEvidence(evidence, kind) {
  assert.equal(evidence.length, generationVisualViewports.length * 2, `${kind} visual matrix was incomplete`);
  const expectedAnimationName = kind === "prd"
    ? /workbench-stage-aurora-sweep/u
    : /workbench-stage-sweep/u;
  for (const item of evidence.filter((candidate) => !candidate.reducedMotion)) {
    const frameEvidence = evaluateMotionFrameEvidence(item.motion.frames, kind, item.reducedMotion);
    assert.equal(item.runState.motionKind, kind, `${kind} visual evidence captured the wrong motion kind`);
    assert.equal(
      frameEvidence.stableConnected,
      true,
      `normal-motion ${kind} wash was sampled from a replaced element at ${item.viewport}`,
    );
    assert.match(item.motion.beforeAnimationName, expectedAnimationName, `normal-motion ${kind} wash was not active at ${item.viewport}`);
    assert.notEqual(item.motion.beforeAnimationDuration, "0.001s", `normal-motion ${kind} wash used reduced duration at ${item.viewport}`);
    assert.ok(
      cssValueListMatches(item.motion.beforeAnimationIterationCount, "infinite"),
      `normal-motion ${kind} wash did not repeat every animation at ${item.viewport}`,
    );
    assert.equal(
      frameEvidence.advanced,
      true,
      `normal-motion ${kind} wash did not advance between frames at ${item.viewport}`,
    );
    assert.equal(frameEvidence.matchesPreference, true, `normal-motion ${kind} evidence contradicted its media preference`);
  }
  for (const item of evidence.filter((candidate) => candidate.reducedMotion)) {
    const frameEvidence = evaluateMotionFrameEvidence(item.motion.frames, kind, item.reducedMotion);
    assert.equal(item.runState.motionKind, kind, `${kind} reduced-motion evidence captured the wrong motion kind`);
    assert.equal(
      frameEvidence.stableConnected,
      true,
      `reduced-motion ${kind} wash was sampled from a replaced element at ${item.viewport}`,
    );
    assert.match(item.motion.beforeAnimationName, expectedAnimationName, `reduced-motion ${kind} wash lost its semantic animation at ${item.viewport}`);
    assert.equal(item.motion.beforeAnimationDuration, "0.001s", `reduced-motion ${kind} wash did not collapse to 1ms at ${item.viewport}`);
    assert.ok(
      cssValueListMatches(item.motion.beforeAnimationIterationCount, "1"),
      `reduced-motion ${kind} wash kept an animation repeating at ${item.viewport}`,
    );
    assert.equal(
      frameEvidence.advanced,
      false,
      `reduced-motion ${kind} wash continued moving at ${item.viewport}`,
    );
    assert.equal(frameEvidence.matchesPreference, true, `reduced-motion ${kind} evidence contradicted its media preference`);
  }
  for (const item of evidence) {
    const [width, height] = item.viewport.split("x").map(Number);
    assert.equal(item.layout.composer.visible, true, `Project Composer was not visible at ${kind} ${item.viewport}`);
    assert.equal(item.layout.agentCard.visible, width >= 768, `Agent card breakpoint was incorrect at ${kind} ${item.viewport}`);
    assert.equal(item.layout.taskStack.visible, width >= 1280, `task stack breakpoint was incorrect at ${kind} ${item.viewport}`);
    assert.equal(item.layout.mobileRunStatus.visible, width < 768, `mobile Run status breakpoint was incorrect at ${kind} ${item.viewport}`);
    assert.equal(item.layout.rightToolRail.visible, true, `right tool rail was not visible at ${kind} ${item.viewport}`);
    assert.equal(item.layout.suggestions.visible, true, `suggestions were not visible at ${kind} ${item.viewport}`);
    assert.equal(item.layout.utilityPill.visible, true, `Utility Pill was not visible at ${kind} ${item.viewport}`);
    assert.equal(item.layout.selectedAction.visible, false, `selected action remained visible during ${kind} Run at ${item.viewport}`);
    for (const [name, region] of Object.entries(item.layout)) {
      if (!region.visible || !region.rect) continue;
      assert.ok(region.rect.left >= 0 && region.rect.top >= 0, `${name} escaped the top/left viewport at ${kind} ${item.viewport}`);
      assert.ok(region.rect.right <= width && region.rect.bottom <= height, `${name} escaped the bottom/right viewport at ${kind} ${item.viewport}`);
    }
    for (const name of ["agentCard", "taskStack", "mobileRunStatus"]) {
      assert.ok(
        !rectanglesOverlap(item.layout[name].rect, item.layout.composer.rect),
        `${name} overlapped the Project Composer at ${kind} ${item.viewport}`,
      );
    }
    for (const [left, right] of [
      ["utilityPill", "composer"],
      ["suggestions", "composer"],
      ["utilityPill", "suggestions"],
    ]) {
      assert.ok(
        !rectanglesOverlap(item.layout[left].rect, item.layout[right].rect),
        `${left} overlapped ${right} at ${kind} ${item.viewport}`,
      );
    }
  }
}

async function captureStableMotionFrames(motionElement, kind) {
  return captureStableMotionFrameEvidence({
    capture: () => motionElement.evaluate(async (element, options) => {
      const sample = () => {
        const style = getComputedStyle(element);
        const before = getComputedStyle(element, "::before");
        return {
          connected: element.isConnected,
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          opacity: style.opacity,
          transform: style.transform,
          beforeAnimationName: before.animationName,
          beforeAnimationDuration: before.animationDuration,
          beforeAnimationIterationCount: before.animationIterationCount,
          beforeBackgroundPosition: before.backgroundPosition,
          beforeOpacity: before.opacity,
          beforeTransform: before.transform,
        };
      };
      const frames = [];
      for (let index = 0; index < options.sampleCount; index += 1) {
        const frame = sample();
        frames.push(frame);
        if (!frame.connected || index === options.sampleCount - 1) break;
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
      }
      return { ...frames.at(-1), frames };
    }, {
      intervalMs: motionFrameSampleIntervalMs,
      sampleCount: motionFrameSampleCount,
    }),
    kind,
    maximumAttempts: maximumMotionCaptureAttempts,
    waitForRemount: () => motionElement.waitFor({
      state: "visible",
      timeout: motionElementRemountTimeoutMs,
    }),
  });
}

function cssValueListMatches(value, expected) {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 && values.every((item) => item === expected);
}

async function capturePendingDocumentVisualEvidence({ outputDir, page, pendingDocument }) {
  const evidence = [];
  for (const reducedMotion of [false, true]) {
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    if (reducedMotion) await page.waitForTimeout(20);
    for (const viewport of generationVisualViewports) {
      await page.setViewportSize(viewport);
      await pendingDocument.waitFor({ state: "visible", timeout: scenarioTimeoutMs });
      await waitForStableViewportRect(pendingDocument, viewport, "pending PRD document");
      const observation = await pendingDocument.evaluate(async (element, options) => {
        const metric = (selector) => {
          const candidate = document.querySelector(selector);
          if (!(candidate instanceof HTMLElement)) return null;
          const style = getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) > 0
            && rect.width > 0
            && rect.height > 0
            ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
            : null;
        };
        const spinner = element.querySelector(".workbench-artifact-spinner");
        const spinnerSample = () => spinner instanceof HTMLElement
          ? {
              connected: spinner.isConnected,
              animationDuration: getComputedStyle(spinner).animationDuration,
              animationIterationCount: getComputedStyle(spinner).animationIterationCount,
              transform: getComputedStyle(spinner).transform,
            }
          : null;
        const spinnerFrames = [];
        for (let index = 0; index < options.sampleCount; index += 1) {
          const frame = spinnerSample();
          spinnerFrames.push(frame);
          if (!frame?.connected || index === options.sampleCount - 1) break;
          await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
        }
        const rect = element.getBoundingClientRect();
        return {
          ariaLive: element.getAttribute("aria-live"),
          colorScheme: "dark",
          hasSkeleton: element.querySelector("[data-workbench-artifact-skeleton]") !== null,
          hasSpinner: spinner !== null,
          labelKind: element.textContent?.includes("正在细化") ? "refining" : "other",
          reducedMotionMedia: matchMedia("(prefers-reduced-motion: reduce)").matches,
          runState: {
            phase: document.querySelector('[data-panel-motion="agent-card"]')?.getAttribute("data-phase") ?? null,
            stage: document.querySelector('[data-canvas-generation-motion="prd"]')?.getAttribute("data-generation-stage") ?? null,
            status: "active",
            motionKind: "prd",
          },
          spinnerFrames,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          occluders: {
            composer: metric("[data-project-composer]"),
            mobileRunStatus: metric("[data-mobile-run-status]"),
            rightToolRail: metric("[data-right-tool-rail]"),
            utilityPill: metric("[data-utility-pill]"),
          },
        };
      }, {
        intervalMs: motionFrameSampleIntervalMs,
        sampleCount: motionFrameSampleCount,
      });
      const screenshotPath = path.join(
        outputDir,
        `workbench-real-stack-prd-pending-${viewport.width}x${viewport.height}-${reducedMotion ? "reduced" : "normal"}.png`,
      );
      const bytes = await page.screenshot({ path: screenshotPath, fullPage: false });
      evidence.push({
        ...observation,
        viewport: `${viewport.width}x${viewport.height}`,
        reducedMotion,
        screenshot: path.relative(root, screenshotPath),
        sha256: sha256(bytes),
      });
    }
  }
  return evidence;
}

async function waitForStableViewportRect(locator, viewport, label) {
  let previousRect = null;
  let stableSamples = 0;
  await waitFor(async () => {
    const rect = await locator.boundingBox();
    if (!rect) {
      previousRect = null;
      stableSamples = 0;
      return false;
    }
    const insideViewport = rect.x >= 0
      && rect.y >= 0
      && rect.x + rect.width <= viewport.width
      && rect.y + rect.height <= viewport.height;
    const stable = insideViewport
      && previousRect !== null
      && ["x", "y", "width", "height"].every((key) => (
        Math.abs(rect[key] - previousRect[key]) <= 0.5
      ));
    stableSamples = stable ? stableSamples + 1 : 0;
    previousRect = rect;
    return stableSamples >= 2;
  }, scenarioTimeoutMs, `${label} did not settle inside ${viewport.width}x${viewport.height}`);
}

function assertPendingDocumentVisualEvidence(evidence) {
  assert.equal(evidence.length, generationVisualViewports.length * 2, "pending PRD visual matrix was incomplete");
  for (const item of evidence) {
    const [width, height] = item.viewport.split("x").map(Number);
    assert.equal(item.ariaLive, "polite", `pending PRD document did not expose a polite live region at ${item.viewport}`);
    assert.equal(item.hasSkeleton, true, `pending PRD document omitted its skeleton at ${item.viewport}`);
    assert.equal(item.hasSpinner, true, `pending PRD document omitted its progress indicator at ${item.viewport}`);
    assert.equal(item.labelKind, "refining", `runtime PRD draft did not expose refining context at ${item.viewport}`);
    assert.equal(
      item.reducedMotionMedia,
      item.reducedMotion,
      `pending PRD reduced-motion media state was incorrect at ${item.viewport}`,
    );
    assert.ok(
      item.rect.left >= 0
      && item.rect.top >= 0
      && item.rect.right <= width
      && item.rect.bottom <= height,
      `pending PRD document escaped the viewport at ${item.viewport}`,
    );
    assert.equal(
      item.spinnerFrames.length,
      motionFrameSampleCount,
      `pending PRD spinner frame matrix was incomplete at ${item.viewport}`,
    );
    assert.ok(
      item.spinnerFrames.every((frame) => frame?.connected),
      `pending PRD spinner was replaced during sampling at ${item.viewport}`,
    );
    for (const [name, rect] of Object.entries(item.occluders)) {
      assert.ok(
        !rectanglesOverlap(item.rect, rect),
        `pending PRD document was obscured by ${name} at ${item.viewport}`,
      );
    }
    const spinnerTransforms = new Set(item.spinnerFrames.map((frame) => frame.transform));
    if (item.reducedMotion) {
      assert.ok(
        item.spinnerFrames.every((frame) => frame.animationDuration === "0.001s"),
        `pending PRD spinner did not reduce motion at ${item.viewport}`,
      );
      assert.ok(
        item.spinnerFrames.every((frame) => frame.animationIterationCount === "1"),
        `pending PRD spinner kept repeating at ${item.viewport}`,
      );
      assert.equal(spinnerTransforms.size, 1, `pending PRD spinner moved with reduced motion at ${item.viewport}`);
    } else {
      assert.ok(
        item.spinnerFrames.every((frame) => frame.animationDuration !== "0.001s"),
        `pending PRD spinner used reduced duration at ${item.viewport}`,
      );
      assert.ok(
        item.spinnerFrames.every((frame) => frame.animationIterationCount === "infinite"),
        `pending PRD spinner did not keep progressing at ${item.viewport}`,
      );
      assert.ok(spinnerTransforms.size > 1, `pending PRD spinner did not advance at ${item.viewport}`);
    }
  }
}

function browserUrlClass(rawUrl, { previewOrigin, webOrigin }) {
  if (!rawUrl) return "unknown";
  try {
    const url = new URL(rawUrl);
    if (url.origin === webOrigin) return `web:${browserPathClass(url.pathname)}`;
    if (url.origin === previewOrigin) return `preview:${browserPathClass(url.pathname)}`;
    return url.protocol === "http:" || url.protocol === "https:"
      ? httpOriginClass(url.href)
      : "other-scheme";
  } catch {
    return "invalid";
  }
}

function installBrowserSseEvidenceObserver({ webOrigin }) {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  globalThis.fetch = async function workbenchEvidenceFetch(...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const url = new URL(response.url);
      if (
        url.origin === webOrigin
        && /^\/api\/v1\/runs\/[^/]+\/events$/u.test(url.pathname)
        && response.headers.get("content-type")?.startsWith("text/event-stream")
      ) {
        const afterSequence = Number(url.searchParams.get("afterSequence") ?? "0");
        const observed = response.clone();
        void observeSseResponse(observed, afterSequence).catch(() => undefined);
      }
    } catch {
      // The application owns fetch errors; evidence collection must stay observational.
    }
    return response;
  };

  async function observeSseResponse(response, afterSequence) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let eventId = null;
    let sawData = false;

    const record = () => {
      const sequence = Number(eventId);
      const shouldRecord = sawData;
      const recordedEventName = eventName;
      eventName = "message";
      eventId = null;
      sawData = false;
      if (!shouldRecord) return;
      const binding = globalThis.__workbenchRecordSseEvidence;
      if (typeof binding === "function") {
        void Promise.resolve(binding({
          afterSequence,
          eventName: recordedEventName,
          sequence,
        })).catch(() => undefined);
      }
    };
    const consumeLine = (rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        record();
        return;
      }
      if (line.startsWith(":")) return;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") eventName = value;
      else if (field === "id") eventId = value;
      else if (field === "data") sawData = true;
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (buffer.length > 1_048_576) {
        const binding = globalThis.__workbenchRecordSseEvidence;
        if (typeof binding === "function") {
          void Promise.resolve(binding(null)).catch(() => undefined);
        }
        await reader.cancel();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (buffer) consumeLine(buffer);
        record();
        return;
      }
    }
  }
}

async function pollBrowserJson(page, pathname, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      return { status: response.status, body: await response.text() };
    }, pathname);
    if (result.status === 200) {
      const body = JSON.parse(result.body);
      if (done(body)) return body;
    }
    await delay(250);
  }
  throw new Error(`browser API endpoint did not reach a terminal state: ${pathname}`);
}

async function browserProjectPersistenceCounts(projectId) {
  const result = await queryDatabase(`
    SELECT
      (SELECT count(*)::int FROM workbench.submission_intents WHERE project_id = $1) AS submission_intents,
      (SELECT count(*)::int FROM workbench.runs WHERE project_id = $1) AS runs,
      (
        SELECT count(*)::int
        FROM workbench.runtime_attempts attempt
        JOIN workbench.runs run ON run.id = attempt.run_id
        WHERE run.project_id = $1
      ) AS runtime_attempts,
      (
        SELECT count(*)::int
        FROM workbench.run_events event
        JOIN workbench.runs run ON run.id = event.run_id
        WHERE run.project_id = $1
      ) AS run_events,
      (SELECT count(*)::int FROM workbench.artifacts WHERE project_id = $1) AS artifacts,
      (SELECT count(*)::int FROM workbench.artifact_versions WHERE project_id = $1) AS artifact_versions,
      (SELECT count(*)::int FROM workbench.board_nodes WHERE project_id = $1) AS board_nodes
  `, [projectId]);
  const row = result.rows[0];
  assert.ok(row, "browser Project persistence counts were unavailable");
  return {
    submissionIntents: Number(row.submission_intents),
    runs: Number(row.runs),
    runtimeAttempts: Number(row.runtime_attempts),
    runEvents: Number(row.run_events),
    artifacts: Number(row.artifacts),
    artifactVersions: Number(row.artifact_versions),
    boardNodes: Number(row.board_nodes),
  };
}

async function runtimeExecuteQueueJobCount() {
  const result = await queryDatabase(`
    SELECT count(*)::int AS count
    FROM workbench_jobs.job
    WHERE name = 'runtime.execute'
  `);
  return Number(result.rows[0]?.count ?? 0);
}

async function attributePersistedTerminalSseAborts(candidates) {
  const attributed = [];
  for (const candidate of candidates) {
    // Playwright can report the stream abort immediately after the terminal SSE
    // frame while the API transaction is still committing the Run terminal row.
    // Give that bounded commit race a chance to settle, but keep the underlying
    // attribution predicate strict: only a 200 stream with a fully persisted,
    // sequence-matched terminal event may be treated as expected cleanup.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await queryDatabase(`
        SELECT
          run.status::text,
          run.event_sequence,
          terminal_event.sequence AS terminal_event_sequence,
          terminal_event.type AS terminal_event_type
        FROM workbench.runs run
        LEFT JOIN LATERAL (
          SELECT event.sequence, event.type
          FROM workbench.run_events event
          WHERE event.run_id = run.id
          ORDER BY event.sequence DESC
          LIMIT 1
        ) terminal_event ON TRUE
        WHERE run.id = $1
      `, [candidate.runId]);
      const row = result.rows[0];
      const attribution = persistedTerminalSseAbortAttribution({
        afterSequence: candidate.afterSequence,
        failure: candidate.failure,
        persistedRun: row
          ? {
              status: row.status,
              eventSequence: Number(row.event_sequence),
              terminalEventSequence: Number(row.terminal_event_sequence),
              terminalEventType: row.terminal_event_type,
            }
          : null,
        responseStatus: candidate.responseStatus,
      });
      if (attribution) {
        candidate.failure.abortAttribution = attribution;
        attributed.push(candidate.failure);
        break;
      }
      if (attempt < 19) await delay(100);
    }
  }
  return attributed;
}

async function latestBrowserExternalDelivery(projectId) {
  const result = await queryDatabase(`
    SELECT
      delivery.id,
      delivery.status::text,
      delivery.attempt,
      delivery.confirmed_at,
      delivery.transfer_authorized_at,
      delivery.failure_code,
      (
        SELECT count(*)::int
        FROM workbench_jobs.job
        WHERE name = 'export.delivery'
          AND data->>'deliveryId' = delivery.id
      ) AS queue_jobs
    FROM workbench.external_export_deliveries delivery
    JOIN workbench.export_jobs export_job ON export_job.id = delivery.export_job_id
    JOIN workbench.project_releases release ON release.id = export_job.release_id
    WHERE release.project_id = $1
    ORDER BY delivery.created_at DESC
    LIMIT 1
  `, [projectId]);
  const row = result.rows[0];
  assert.ok(row, "browser Project External Delivery was not persisted");
  return {
    id: row.id,
    status: row.status,
    attempt: Number(row.attempt),
    confirmedAt: row.confirmed_at,
    transferAuthorizedAt: row.transfer_authorized_at,
    failureCode: row.failure_code,
    queueJobs: Number(row.queue_jobs),
  };
}

async function captureBrowserPreviewFailure({ bffRequests, outputDir, page, projectId }) {
  const diagnostics = {
    bffRequests: bffRequests
      .filter(({ pathClass }) => /(?:\/previews|\/projects\/:id\/previews)/u.test(pathClass))
      .map(({ method, pathClass, status }) => ({ method, pathClass, status })),
    database: null,
    screenshot: null,
    ui: null,
  };

  try {
    diagnostics.ui = await page.locator("[data-project-preview]").evaluate((element) => {
      const status = element.querySelector('[data-isolated-preview] [role="status"]')?.textContent?.trim();
      return {
        emptySelection: element.textContent?.includes("暂无可预览内容") ?? false,
        hasCapabilityFrame: element.querySelector("iframe[data-preview-capability]") !== null,
        status: status === "预览加载失败，请刷新重试"
          ? "error"
          : status === "正在准备预览..."
            ? "preparing"
            : status
              ? "other"
              : "absent",
      };
    });
  } catch {
    diagnostics.ui = { overlay: "absent" };
  }

  try {
    const result = await queryDatabase(`
      SELECT
        export_job.status::text,
        export_job.purpose::text,
        export_job.failure_code,
        (
          SELECT count(*)::int
          FROM workbench_jobs.job
          WHERE name = 'export.build'
            AND data->>'exportJobId' = export_job.id
        ) AS queue_jobs
      FROM workbench.project_previews preview
      JOIN workbench.export_jobs export_job ON export_job.id = preview.export_job_id
      WHERE preview.project_id = $1
      ORDER BY preview.created_at DESC
      LIMIT 1
    `, [projectId]);
    const row = result.rows[0];
    diagnostics.database = row
      ? {
          persisted: true,
          status: row.status,
          purpose: row.purpose,
          failureCode: row.failure_code,
          queueJobs: Number(row.queue_jobs),
        }
      : { persisted: false };
  } catch {
    diagnostics.database = { query: "failed" };
  }

  try {
    const screenshotPath = path.join(outputDir, "workbench-real-stack-preview-failure.png");
    const bytes = await page.screenshot({ path: screenshotPath, fullPage: false });
    diagnostics.screenshot = {
      path: path.relative(root, screenshotPath),
      sha256: sha256(bytes),
    };
  } catch {
    diagnostics.screenshot = { capture: "failed" };
  }

  return diagnostics;
}

async function assertBrowserArtifactPersistence(projectId) {
  const result = await queryDatabase(`
    SELECT
      run.status::text AS run_status,
      run.event_sequence,
      run.request->'requestedArtifactKinds' AS requested_artifact_kinds,
      artifact.kind::text AS artifact_kind,
      artifact.revision AS artifact_revision,
      version.version,
      version.status::text AS version_status,
      version.checksum,
      version.content,
      (
        SELECT count(*)::int
        FROM workbench.runtime_attempts attempt
        WHERE attempt.run_id = run.id
      ) AS attempt_count,
      (
        SELECT count(*)::int
        FROM workbench.runtime_attempts attempt
        WHERE attempt.run_id = run.id AND attempt.status = 'succeeded'
      ) AS succeeded_attempt_count,
      EXISTS (
        SELECT 1
        FROM workbench.board_nodes node
        WHERE node.project_id = run.project_id
          AND node.artifact_id = version.artifact_id
          AND node.artifact_version_id = version.id
      ) AS board_pinned
    FROM workbench.runs run
    JOIN workbench.artifact_versions version ON version.created_by_run_id = run.id
    JOIN workbench.artifacts artifact ON artifact.id = version.artifact_id
    WHERE run.project_id = $1
      AND version.status = 'ready'
    ORDER BY run.created_at ASC
  `, [projectId]);
  const expectedKinds = ["prd", "prototype"];
  const summary = {};
  for (const expectedKind of expectedKinds) {
    const row = result.rows.find((candidate) => (
      Array.isArray(candidate.requested_artifact_kinds)
      && candidate.requested_artifact_kinds.length === 1
      && candidate.requested_artifact_kinds[0] === expectedKind
      && candidate.artifact_kind === expectedKind
    ));
    assert.ok(row, `browser ${expectedKind} Run omitted its ready ArtifactVersion`);
    assert.equal(row.run_status, "succeeded", `browser ${expectedKind} Run was not persisted as succeeded`);
    assert.ok(Number(row.event_sequence) > 0, `browser ${expectedKind} Run omitted durable events`);
    assert.ok(Number(row.attempt_count) >= 1, `browser ${expectedKind} Run omitted its RuntimeAttempt`);
    assert.equal(row.succeeded_attempt_count, row.attempt_count, `browser ${expectedKind} RuntimeAttempt was not succeeded`);
    assert.ok(Number(row.artifact_revision) >= 1, `browser ${expectedKind} Artifact revision did not advance`);
    assert.ok(Number(row.version) >= 1, `browser ${expectedKind} ArtifactVersion version was invalid`);
    assert.equal(row.version_status, "ready", `browser ${expectedKind} ArtifactVersion was not ready`);
    if (expectedKind === "prototype") {
      assert.ok(
        Array.isArray(row.content.actions) && row.content.actions.length > 0,
        "browser Prototype fixture was not interactive and could not enter product Preview",
      );
    }
    assert.match(row.checksum, /^[0-9a-f]{64}$/u, `browser ${expectedKind} ArtifactVersion checksum was invalid`);
    assert.equal(
      row.checksum,
      sha256(canonicalJson(row.content)),
      `browser ${expectedKind} ArtifactVersion checksum did not match canonical content`,
    );
    assert.equal(row.board_pinned, true, `browser ${expectedKind} ArtifactVersion was not pinned to the Board`);
    summary[expectedKind] = {
      runStatus: row.run_status,
      eventSequence: Number(row.event_sequence),
      runtimeAttempts: Number(row.attempt_count),
      artifactRevision: Number(row.artifact_revision),
      artifactVersion: Number(row.version),
      versionStatus: row.version_status,
      checksumVerified: true,
      createdByRunVerified: true,
      boardPinned: true,
    };
  }
  return summary;
}

function rectanglesOverlap(left, right) {
  if (!left || !right) return false;
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function resolveCandidateSourceCommit() {
  for (const [name, value] of [
    ["WORKBENCH_CANDIDATE_SHA", process.env.WORKBENCH_CANDIDATE_SHA],
    ["GITHUB_SHA", process.env.GITHUB_SHA],
  ]) {
    const commit = value?.trim();
    if (!commit) continue;
    assert.match(commit, /^[0-9a-f]{40}$/u, `${name} must be a full lowercase Git commit`);
    return commit;
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.match(commit, /^[0-9a-f]{40}$/u, "candidate source commit is invalid");
  return commit;
}

function currentSourceCommit() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.match(commit, /^[0-9a-f]{40}$/u, "current source commit is invalid");
  return commit;
}

function resolveCandidateSourceSnapshot() {
  const maximumSnapshotBytes = 64 * 1024 * 1024;
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: null,
    maxBuffer: maximumSnapshotBytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const trackedDiff = execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
    cwd: root,
    encoding: null,
    maxBuffer: maximumSnapshotBytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const untrackedNames = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: null,
    maxBuffer: maximumSnapshotBytes,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const untrackedPaths = untrackedNames.toString("utf8").split("\0").filter(Boolean);
  const untrackedHashes = untrackedPaths.length === 0
    ? Buffer.alloc(0)
    : execFileSync("git", ["hash-object", "--no-filters", "--", ...untrackedPaths], {
        cwd: root,
        encoding: null,
        maxBuffer: maximumSnapshotBytes,
        stdio: ["ignore", "pipe", "ignore"],
      });
  return {
    clean: status.byteLength === 0,
    digest: sha256(Buffer.concat([status, trackedDiff, untrackedNames, untrackedHashes])),
    entryCount: status.byteLength === 0
      ? 0
      : status.toString("utf8").split("\0").filter(Boolean).length,
  };
}

async function writeEvidenceManifest(manifestPath, manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, bytes);
  return sha256(bytes);
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const service of [...services].reverse()) {
      await stopService(service);
    }
    if (fakeRuntime) {
      await fakeRuntime.close().catch(() => undefined);
      fakeRuntime = undefined;
    }
  })();
  return cleanupPromise;
}

async function stopService(service) {
  if (service.spawnError || !service.child.pid) return;
  await stopProcessTree(service.child, service.exited);
}

function dumpLogs() {
  for (const service of services) {
    console.error(`\n===== ${service.name} logs =====\n${service.log.value() || "(no output)"}`);
  }
  if (fakeRuntime) {
    console.error(`\n===== fake DeerFlow state =====\n${diagnosticFakeRuntimeState(fakeRuntime.state)}`);
  }
}

function boundedAppend(current, incoming, limit = 256_000) {
  const combined = current + incoming;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function testDatabaseUrl(raw) {
  if (!raw?.trim()) throw new Error("WORKBENCH_TEST_DATABASE_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("WORKBENCH_TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("WORKBENCH_TEST_DATABASE_URL must use postgresql:// or postgres://");
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || !isTestDatabaseName(name)) {
    throw new Error(`Refusing to use database without 'test' in its name: ${name || "(empty)"}`);
  }
  if (["postgres", "template0", "template1"].includes(name.toLowerCase())) {
    throw new Error(`Refusing to use protected PostgreSQL database: ${name}`);
  }
  url.searchParams.set("schema", "workbench");
  return url.toString();
}

function isTestDatabaseName(name) {
  return /(?:^|[_-])test(?:$|[_-])/i.test(name);
}

function assertSchemaResetConfirmation(name) {
  if (process.env.WORKBENCH_SCHEMA_RESET_CONFIRM !== name) {
    throw new Error(`WORKBENCH_SCHEMA_RESET_CONFIRM must exactly equal the test database name (${name})`);
  }
}

function pgConnectionUrl(value) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  url.searchParams.delete("options");
  return url.toString();
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
