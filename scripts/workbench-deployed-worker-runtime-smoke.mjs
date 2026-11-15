#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalJson,
  createAndAssertRuntimeQueues,
  runtimeExecuteQueue,
  startRunRequestSchema,
} from "@workbench/workbench-contracts";
import { PrismaClient } from "@workbench/workbench-db";
import { fromPrisma, PgBoss } from "pg-boss";

const databaseUrl = required("WORKBENCH_DATABASE_URL");
const modelId = process.env.DEERFLOW_SMOKE_MODEL_ID?.trim() || "deepseek-flash";
const timeoutMs = positiveInteger(process.env.WORKBENCH_DEPLOYED_WORKER_SMOKE_TIMEOUT_MS || "360000");
const suffix = randomUUID().replaceAll("-", "");
const ids = {
  principalId: `principal_worker_smoke_${suffix}`,
  workspaceId: `workspace_worker_smoke_${suffix}`,
  projectId: `project_worker_smoke_${suffix}`,
  boardId: `board_worker_smoke_${suffix}`,
  threadId: `thread_worker_smoke_${suffix}`,
  runId: `run_worker_smoke_${suffix}`,
  requestId: `request_worker_smoke_${suffix}`,
  traceId: `trace_worker_smoke_${suffix}`,
};
const request = startRunRequestSchema.parse({
  prompt: "生成一份简短的部署验证记录，返回 document Artifact。正文说明 Workbench Worker 队列与 DeerFlow 真实运行链路验证成功。",
  modelId,
  workflow: "generate",
  generationIntent: null,
  targetSurface: "web",
  designStyle: { kind: "automatic" },
  sourceIds: [],
  artifactTargets: [],
  requestedArtifactKinds: ["document"],
  canvasSnapshot: null,
});
const requestHash = sha256(canonicalJson(request));
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const boss = new PgBoss({
  connectionString: pgConnectionString(databaseUrl),
  schema: "workbench_jobs",
  application_name: "workbench-deployed-worker-runtime-smoke",
  schedule: false,
  supervise: false,
  migrate: false,
  createSchema: false,
  useListenNotify: false,
});

try {
  await db.$connect();
  await boss.start();
  await createAndAssertRuntimeQueues(boss);
  const jobId = await seedAndEnqueue();
  const result = await waitForTerminalRun();
  assertSucceeded(result);
  const scannedNodes = assertNoCapabilityLeak(result);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    fixtureOrigin: "validation_prisma_queue",
    runId: ids.runId,
    projectId: ids.projectId,
    boardId: ids.boardId,
    threadId: ids.threadId,
    jobId,
    modelId,
    status: result.status,
    runtimeAttemptId: result.runtimeAttempts[0]?.id,
    externalThreadId: result.runtimeAttempts[0]?.externalThreadId,
    externalRunId: result.runtimeAttempts[0]?.externalRunId,
    artifactKind: result.artifactVersions[0]?.artifact.kind,
    artifactVersionStatus: result.artifactVersions[0]?.status,
    eventCount: result.events.length,
    persistedNodesScanned: scannedNodes,
  }, null, 2)}\n`);
} finally {
  await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
  await db.$disconnect().catch(() => undefined);
}

async function seedAndEnqueue() {
  return db.$transaction(async (tx) => {
    await tx.principal.create({
      data: {
        id: ids.principalId,
        issuer: "workbench-deployed-worker-runtime-smoke",
        subject: ids.principalId,
        displayName: "Deployed Worker Smoke",
      },
    });
    await tx.workspace.create({
      data: {
        id: ids.workspaceId,
        slug: `worker-smoke-${suffix}`,
        name: "Deployed Worker Smoke",
        createdById: ids.principalId,
      },
    });
    await tx.workspaceMember.create({
      data: {
        workspaceId: ids.workspaceId,
        principalId: ids.principalId,
        role: "owner",
      },
    });
    await tx.project.create({
      data: {
        id: ids.projectId,
        workspaceId: ids.workspaceId,
        createdById: ids.principalId,
        title: "Deployed Worker Smoke",
      },
    });
    await tx.projectMember.create({
      data: {
        projectId: ids.projectId,
        workspaceId: ids.workspaceId,
        principalId: ids.principalId,
        role: "owner",
      },
    });
    await tx.board.create({
      data: {
        id: ids.boardId,
        projectId: ids.projectId,
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    await tx.thread.create({
      data: {
        id: ids.threadId,
        projectId: ids.projectId,
        createdById: ids.principalId,
        title: "Deployed Worker Smoke",
        revision: 1,
        entrySequence: 1,
      },
    });
    await tx.threadEntry.create({
      data: {
        threadId: ids.threadId,
        sequence: 1,
        role: "user",
        kind: "message",
        content: {
          protocol: "workbench.entry.v1",
          type: "user.prompt",
          text: request.prompt,
          sourceIds: [],
        },
      },
    });
    await tx.run.create({
      data: {
        id: ids.runId,
        projectId: ids.projectId,
        threadId: ids.threadId,
        createdById: ids.principalId,
        idempotencyKey: `worker-smoke-${suffix}`,
        requestHash,
        requestId: ids.requestId,
        request,
        status: "queued",
        modelId,
        traceId: ids.traceId,
        eventSequence: 1,
      },
    });
    await tx.runEvent.create({
      data: {
        runId: ids.runId,
        sequence: 1,
        type: "run.queued",
        payload: { position: null },
        traceId: ids.traceId,
      },
    });
    const jobId = await boss.send(runtimeExecuteQueue, { runId: ids.runId }, {
      singletonKey: ids.runId,
      group: { id: ids.threadId },
      db: fromPrisma(tx),
    });
    if (!jobId) throw new Error("DEPLOYED_WORKER_SMOKE_QUEUE_REJECTED");
    return jobId;
  }, { maxWait: 10_000, timeout: 30_000 });
}

async function waitForTerminalRun() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await loadRun();
    if (["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await delay(1_000);
  }
  throw new Error("DEPLOYED_WORKER_SMOKE_TIMEOUT");
}

function loadRun() {
  return db.run.findUniqueOrThrow({
    where: { id: ids.runId },
    include: {
      runtimeAttempts: { orderBy: { attempt: "asc" } },
      outputEntry: true,
      draft: true,
      artifactVersions: {
        orderBy: { createdAt: "asc" },
        include: { artifact: { select: { kind: true, currentVersionId: true } } },
      },
      events: { orderBy: { sequence: "asc" } },
    },
  });
}

function assertSucceeded(run) {
  const attempt = run.runtimeAttempts[0];
  const version = run.artifactVersions[0];
  if (
    run.status !== "succeeded"
    || run.errorCode !== null
    || run.outputEntry === null
    || run.runtimeAttempts.length !== 1
    || attempt?.status !== "succeeded"
    || !attempt.externalThreadId
    || !attempt.externalRunId
    || attempt.executionOwnerId !== null
    || run.executionOwnerId !== null
    || run.artifactVersions.length !== 1
    || version?.artifact.kind !== "document"
    || version.status !== "ready"
    || version.artifact.currentVersionId !== version.id
  ) {
    throw new Error(
      `DEPLOYED_WORKER_SMOKE_FAILED:${run.status}:${run.errorCode ?? "none"}:${run.errorDetail ?? "none"}`,
    );
  }
  const eventTypes = new Set(run.events.map((event) => event.type));
  for (const requiredType of ["run.queued", "run.started", "message.completed", "run.completed"]) {
    if (!eventTypes.has(requiredType)) throw new Error(`DEPLOYED_WORKER_SMOKE_EVENT_MISSING:${requiredType}`);
  }
}

function assertNoCapabilityLeak(value) {
  const needles = [
    "WORKBENCH_KNOWLEDGE_CAPABILITY",
    "WORKBENCH_CANVAS_CAPABILITY",
    "wbkg1.",
    "wbct1.",
  ];
  let scanned = 0;
  walk(value, [], (candidate, key, valuePath) => {
    scanned += 1;
    if (scanned > 1_000_000) throw new Error("DEPLOYED_WORKER_SMOKE_SCAN_LIMIT_EXCEEDED");
    for (const item of [key, candidate]) {
      if (typeof item === "string" && needles.some((needle) => item.includes(needle))) {
        throw new Error(`DEPLOYED_WORKER_SMOKE_CAPABILITY_LEAK:${valuePath.join(".")}`);
      }
    }
  });
  return scanned;
}

function walk(value, valuePath, visit, seen = new WeakSet(), depth = 0) {
  if (depth > 128) throw new Error("DEPLOYED_WORKER_SMOKE_SCAN_DEPTH_EXCEEDED");
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

function pgConnectionString(value) {
  const url = new URL(value);
  url.searchParams.delete("schema");
  return url.toString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Invalid smoke timeout");
  return parsed;
}
