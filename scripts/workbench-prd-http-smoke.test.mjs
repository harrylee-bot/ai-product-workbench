import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { prdDocumentV2Example } from "@workbench/workbench-contracts";
import {
  assertPrdV2Structure,
  executePrdHttpSmoke,
} from "./workbench-prd-http-smoke.mjs";

const fixedNow = () => new Date("2026-07-23T09:00:00.000Z");
const smokeUuid = "11111111-2222-4333-8444-555555555555";
const email = "prd-smoke@example.test";
const password = "email-password-must-not-leak";
const existingCookie = "workbench.session_token=existing-session-must-not-leak";

test("runs the isolated PRD v2 HTTP flow through Better Auth email sign-in", async (t) => {
  const fake = await startFakeWorkbench();
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_EMAIL: email,
      WORKBENCH_PRD_SMOKE_PASSWORD: password,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.result, "PASS");
  assert.equal(result.evidence.authMode, "email");
  assert.equal(result.evidence.projectRetained, true);
  assert.equal(result.evidence.projectUrl, `${fake.origin}/projects/project-smoke`);
  assert.equal(result.evidence.checks.at(-1)?.name, "prd-board-node-verified");
  assert.equal(fake.state.authCalls, 1);
  assert.equal(fake.state.projectTitle.startsWith("[SMOKE] PRD HTTP "), true);
  assert.deepEqual(fake.state.submissionBody.request.requestedArtifactKinds, ["prd"]);
  assert.deepEqual(fake.state.submissionBody.attachments, []);
  assert.equal(fake.state.submissionBody.request.artifactTargets.length, 0);
  assert.equal(fake.state.submissionBody.request.canvasSnapshot, null);
  assert.equal(fake.state.selectedModelId, "model-generate");
  assert.ok(fake.state.apiCookies.every((cookie) => cookie === "workbench.session_token=fake-session"));
  assert.ok(fake.state.mutationOrigins.every((origin) => origin === fake.origin));
  assertNoSecretOrPrdBody(result, [email, password, "existing-session-must-not-leak"]);
});

test("uses an explicit existing session cookie without calling the sign-in route", async (t) => {
  const fake = await startFakeWorkbench();
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidence.authMode, "session-cookie");
  assert.equal(fake.state.authCalls, 0);
  assert.ok(fake.state.apiCookies.every((cookie) => cookie === existingCookie));
  assertNoSecretOrPrdBody(result, [existingCookie, email, password]);
});

test("fails closed before any HTTP write without the explicit write confirmation", async () => {
  let requests = 0;
  const result = await executePrdHttpSmoke({
    env: {
      NODE_ENV: "test",
      WORKBENCH_PRD_SMOKE_ALLOW_HTTP: "1",
      WORKBENCH_PRD_SMOKE_BASE_URL: "http://127.0.0.1:9",
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    },
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not be called");
    },
    now: fixedNow,
    randomUUID: () => smokeUuid,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "WRITE_CONFIRMATION_REQUIRED");
  assert.equal(result.evidence.projectUrl, undefined);
  assert.equal(requests, 0);
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects a Prototype from a PRD-only production Run", async (t) => {
  const fake = await startFakeWorkbench({ artifactKind: "prototype" });
  t.after(fake.close);

  const result = await executePrdHttpSmoke({
    env: smokeEnvironment(fake.origin, {
      WORKBENCH_PRD_SMOKE_SESSION_COOKIE: existingCookie,
    }),
    now: fixedNow,
    randomUUID: () => smokeUuid,
    sleep: async () => undefined,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "PROTOTYPE_ARTIFACT_FORBIDDEN");
  assert.equal(result.evidence.projectRetained, true);
  assert.equal(result.evidence.projectUrl, `${fake.origin}/projects/project-smoke`);
  assertNoSecretOrPrdBody(result, [existingCookie]);
});

test("rejects forbidden requirement-document placeholder wording", () => {
  const document = structuredClone(prdDocumentV2Example);
  document.sections.introduction.background.blocks[0].content[0].text = "待确认";

  assert.throws(
    () => assertPrdV2Structure(document),
    (error) => error?.code === "PRD_PLACEHOLDER_FORBIDDEN",
  );
});

function smokeEnvironment(origin, auth) {
  return {
    NODE_ENV: "test",
    WORKBENCH_PRD_SMOKE_ALLOW_HTTP: "1",
    WORKBENCH_PRD_SMOKE_BASE_URL: origin,
    WORKBENCH_PRD_SMOKE_CONFIRM_WRITE: "CREATE_ISOLATED_PRD_SMOKE_PROJECT",
    WORKBENCH_PRD_SMOKE_POLL_INTERVAL_MS: "1",
    WORKBENCH_PRD_SMOKE_REQUEST_TIMEOUT_MS: "1000",
    WORKBENCH_PRD_SMOKE_TIMEOUT_MS: "2000",
    ...auth,
  };
}

function assertNoSecretOrPrdBody(result, forbiddenValues) {
  const serialized = JSON.stringify(result);
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes("现有产品工作台已提供业务任务处理入口"), false);
  assert.equal(serialized.includes("依赖异常时保留用户输入"), false);
}

async function startFakeWorkbench({ artifactKind = "prd" } = {}) {
  const state = {
    apiCookies: [],
    authCalls: 0,
    bootstrapCalls: 0,
    mutationOrigins: [],
    projectTitle: "",
    runPolls: 0,
    selectedModelId: null,
    submissionBody: null,
  };
  const server = http.createServer((request, response) => {
    void handleFakeRequest(request, response, state, artifactKind).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded) response.end(JSON.stringify({ code: "FAKE_SERVER_FAILURE" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server did not bind TCP");
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    origin: `http://127.0.0.1:${address.port}`,
    state,
  };
}

async function handleFakeRequest(request, response, state, artifactKind) {
  const url = new URL(request.url ?? "/", "http://fake.test");
  const method = request.method ?? "GET";
  if (!["GET", "HEAD"].includes(method)) state.mutationOrigins.push(request.headers.origin ?? "");

  if (method === "POST" && url.pathname === "/api/auth/sign-in/email") {
    state.authCalls += 1;
    const body = await requestJson(request);
    assert.deepEqual(body, { email, password });
    return sendJson(response, 200, { user: { id: "principal-smoke" } }, {
      "Set-Cookie": "workbench.session_token=fake-session; Path=/; HttpOnly; Secure; SameSite=Lax",
    });
  }

  if (url.pathname.startsWith("/api/v1/")) {
    state.apiCookies.push(request.headers.cookie ?? "");
  }
  if (method === "GET" && url.pathname === "/api/v1/identity/me") {
    return sendJson(response, 200, {
      id: "principal-smoke",
      defaultWorkspaceId: "workspace-smoke",
    });
  }
  if (method === "GET" && url.pathname === "/api/v1/runtime/models") {
    return sendJson(response, 200, {
      items: [
        { id: "model-edit", supportedWorkflows: ["edit"] },
        { id: "model-generate", supportedWorkflows: ["generate", "edit"] },
      ],
    });
  }
  if (method === "POST" && url.pathname === "/api/v1/workspaces/workspace-smoke/projects") {
    const body = await requestJson(request);
    state.projectTitle = body.title;
    return sendJson(response, 201, { id: "project-smoke" });
  }
  if (method === "GET" && url.pathname === "/api/v1/projects/project-smoke/bootstrap") {
    state.bootstrapCalls += 1;
    return sendJson(response, 200, state.bootstrapCalls === 1
      ? initialBootstrap()
      : completedBootstrap());
  }
  if (method === "POST" && url.pathname === "/api/v1/threads/thread-smoke/submission-intents") {
    state.submissionBody = await requestJson(request);
    state.selectedModelId = state.submissionBody.request.modelId;
    return sendJson(response, 201, { id: "intent-smoke", status: "pending" });
  }
  if (method === "POST" && url.pathname === "/api/v1/submission-intents/intent-smoke/submit") {
    return sendJson(response, 202, {
      intent: { id: "intent-smoke", runId: "run-smoke", status: "submitted" },
      run: runFixture("queued"),
    });
  }
  if (method === "GET" && url.pathname === "/api/v1/runs/run-smoke") {
    state.runPolls += 1;
    return sendJson(response, 200, runFixture(
      state.runPolls === 1 ? "queued" : state.runPolls === 2 ? "running" : "succeeded",
    ));
  }
  if (method === "GET" && url.pathname === "/api/v1/projects/project-smoke/artifacts") {
    return sendJson(response, 200, {
      items: [artifactKind === "prototype" ? prototypeArtifactFixture() : prdArtifactFixture()],
      nextCursor: null,
    });
  }
  if (
    method === "GET"
    && url.pathname === "/api/v1/artifacts/artifact-smoke/versions/version-smoke"
  ) {
    return sendJson(response, 200, prdVersionFixture());
  }
  return sendJson(response, 404, { code: "FAKE_ROUTE_NOT_FOUND" });
}

function initialBootstrap() {
  return {
    artifacts: [],
    board: { nodes: [] },
    selectedThreadId: "thread-smoke",
    threads: [{ id: "thread-smoke" }],
  };
}

function completedBootstrap() {
  return {
    artifacts: [prdArtifactFixture()],
    board: {
      nodes: [{
        artifactId: "artifact-smoke",
        artifactVersionId: "version-smoke",
        data: { artifactKind: "prd" },
        size: { height: 500, width: 500 },
      }],
    },
    threads: [{ id: "thread-smoke" }],
  };
}

function runFixture(status) {
  return {
    failure: null,
    id: "run-smoke",
    progress: status === "succeeded" ? 1 : status === "running" ? 0.5 : 0,
    projectId: "project-smoke",
    requestedArtifactKinds: ["prd"],
    status,
    threadId: "thread-smoke",
  };
}

function prdArtifactFixture() {
  return {
    id: "artifact-smoke",
    kind: "prd",
    currentVersion: {
      artifactId: "artifact-smoke",
      artifactVersionId: "version-smoke",
      createdByRunId: "run-smoke",
      kind: "prd",
      schemaVersion: 2,
      status: "ready",
    },
  };
}

function prototypeArtifactFixture() {
  return {
    id: "artifact-prototype",
    kind: "prototype",
    currentVersion: {
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype",
      createdByRunId: "run-smoke",
      kind: "prototype",
      schemaVersion: 1,
      status: "ready",
    },
  };
}

function prdVersionFixture() {
  return {
    artifactId: "artifact-smoke",
    artifactVersionId: "version-smoke",
    checksum: "a".repeat(64),
    citations: [],
    content: structuredClone(prdDocumentV2Example),
    contentMode: "inline",
    createdAt: "2026-07-23T09:01:00.000Z",
    createdByRunId: "run-smoke",
    kind: "prd",
    knowledgeReleaseId: null,
    schemaVersion: 2,
    status: "ready",
    version: 1,
  };
}

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}
