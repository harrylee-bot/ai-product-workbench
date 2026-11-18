// Start the built API three times against its own local, seeded test database.
// Supply its ordinary local development environment, including approved Flash,
// profile pins and separate real embedding/reranker endpoints. No workers run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@workbench/workbench-db";

const url = new URL(process.env.WORKBENCH_REQUIREMENTS_TEST_DATABASE_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.match(url.pathname, /_test_/u);
assert.ok(process.env.WORKBENCH_REQUIREMENTS_API_KEY && process.env.WORKBENCH_TEI_API_KEY && process.env.WORKBENCH_KNOWLEDGE_RERANKER_API_KEY);
assert.equal(new URL(process.env.WORKBENCH_TEI_URL).hostname, "127.0.0.1");
assert.ok(["deepseek-flash", "deepseek-4.1-flash"].includes(process.env.WORKBENCH_REQUIREMENTS_MODEL));
const subject = "outage-proof-" + randomUUID();
const db = new PrismaClient({ datasourceUrl: url.href });
const report = { subject, database: url.pathname.slice(1), receipts: [] };
let sessionId, turnId, threadId, origin, child;
async function localPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function api(path, { body, etag, status = body ? 201 : 200 } = {}) {
  const response = await fetch(origin + "/api/v1" + path, {
    method: body ? "POST" : "GET", headers: { "x-workbench-dev-subject": subject, "content-type": "application/json",
      ...(body && { "idempotency-key": randomUUID() }), ...(etag && { "if-match": etag }) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5_000),
  });
  const value = await response.json();
  assert.equal(response.status, status, path + ": " + value?.code);
  return { value, etag: response.headers.get("etag") };
}
async function boot(stage) {
  const port = await localPort();
  origin = "http://127.0.0.1:" + port;
  // Bind a local endpoint that immediately closes each incoming socket.
  // This interrupts only the adapter selected for this isolated API process.
  const broken = createServer(socket => socket.destroy());
  broken.listen(0, "127.0.0.1");
  await once(broken, "listening");
  const deadHost = "127.0.0.1:" + broken.address().port;
  child = spawn(process.execPath, [fileURLToPath(new URL("../../apps/workbench-api/dist/main.js", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "test", WORKBENCH_DATABASE_URL: url.href, WORKBENCH_AUTH_MODE: "development",
      WORKBENCH_REQUIREMENTS_MODEL: "deepseek-flash", WORKBENCH_API_HOST: "127.0.0.1", WORKBENCH_API_PORT: String(port),
      ...(stage === "embedding" && { WORKBENCH_TEI_URL: "http://" + deadHost }),
      ...(stage === "model" && { WORKBENCH_REQUIREMENTS_BASE_URL: "https://" + deadHost }) },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return broken;
}
async function runStage(stage, expectedCode) {
  const broken = await boot(stage);
  try {
    let me;
    for (let attempt = 0; attempt < 100 && !me; attempt++) {
      assert.equal(child.exitCode, null, "API failed to start");
      try { me = (await api("/identity/me")).value; } catch { await delay(200); }
    }
    assert.ok(me, "Local API did not become available");
    if (!sessionId) {
      const project = (await api("/workspaces/" + me.defaultWorkspaceId + "/projects", { body: { title: "需求故障恢复" } })).value;
      threadId = (await api("/projects/" + project.id + "/threads", { body: { title: "同一条消息" } })).value.id;
      const prompt = "优化活动";
      const session = await api("/threads/" + threadId + "/requirement-sessions", { body: { generationRequest: {
        prompt, modelId: "deepseek-flash", workflow: "generate", targetSurface: "web",
        designStyle: { kind: "automatic" }, sourceIds: [], requestedArtifactKinds: ["prd"],
      } } });
      sessionId = session.value.id;
      turnId = (await api("/requirement-sessions/" + sessionId + "/messages", { body: { text: prompt }, etag: session.etag, status: 202 })).value.activeTurn.id;
    } else {
      const session = await api("/requirement-sessions/" + sessionId);
      await api(`/requirement-sessions/${sessionId}/turns/${turnId}/retry`, { body: {}, etag: session.etag, status: 202 });
    }
    let turn;
    for (let attempt = 0; attempt < 145; attempt++) {
      turn = (await api("/requirement-sessions/" + sessionId)).value.activeTurn;
      if (["failed", "succeeded"].includes(turn.status)) break;
      await delay(1_000);
    }
    assert.equal(turn.status, expectedCode ? "failed" : "succeeded");
    assert.equal(turn.id, turnId);
    assert.equal(turn.attempt, report.receipts.length + 1);
    assert.equal(turn.modelId, "deepseek-flash");
    assert.equal(turn.failureCode, expectedCode);
    if (expectedCode) assert.equal(turn.inputTokens, null);
    else assert.ok(turn.inputTokens > 0 && turn.outputTokens > 0);
    assert.equal(await db.threadEntry.count({ where: { requirementSessionId: sessionId, role: "user" } }), 1);
    assert.equal(await db.requirementTurn.count({ where: { sessionId } }), 1);
    assert.equal(await db.run.count({ where: { threadId } }), 0);
    report.receipts.push({ stage, turnId, attempt: turn.attempt, model: turn.modelId, status: turn.status,
      code: turn.failureCode, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens });
    console.log(stage, turn.status, turn.failureCode);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try { await stopped; } finally { clearTimeout(deadline); }
    }
    await new Promise(resolve => broken.close(resolve));
  }
}
try {
  await runStage("embedding", "REQUIREMENT_KNOWLEDGE_UNAVAILABLE");
  await runStage("model", "REQUIREMENT_MODEL_UNAVAILABLE");
  await runStage("restored", null);
  report.status = "passed";
} finally {
  await db.$disconnect();
  const output = new URL("../../output/audit/1.0.0/requirements/", import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL(subject + ".json", output), JSON.stringify(report, null, 2));
}
