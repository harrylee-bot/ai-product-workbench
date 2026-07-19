import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bootstrapPath = path.join(scriptDir, "deerflow-bootstrap.mjs");

test("uses one admin session identity for the complete bootstrap write flow", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const requests = [];
  let installAttempts = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      internalToken: request.headers["x-deerflow-internal-token"],
      ownerUserId: request.headers["x-deerflow-owner-user-id"],
      cookie: request.headers.cookie,
      csrfToken: request.headers["x-csrf-token"],
      body,
    });

    if (request.method === "POST" && request.url === "/api/threads") {
      return sendJson(response, 200, { thread_id: "bootstrap-thread" });
    }
    if (request.method === "POST" && request.url === "/api/threads/bootstrap-thread/uploads") {
      return sendJson(response, 200, { files: [{ virtual_path: "mnt/user-data/uploads/workbench.skill" }] });
    }
    if (request.method === "POST" && request.url === "/api/skills/install") {
      installAttempts += 1;
      if (installAttempts === 1) return sendJson(response, 409, { detail: "already installed" });
      return sendJson(response, 200, { success: true, skill_name: "workbench" });
    }
    if (request.method === "DELETE" && request.url === "/api/skills/custom/workbench") {
      return sendJson(response, 200, { success: true });
    }
    if (request.method === "PUT" && request.url === "/api/skills/workbench") {
      return sendJson(response, 200, { enabled: true });
    }
    if (request.method === "PUT" && request.url === "/api/agents/workbench-lead") {
      return sendJson(response, 200, { name: "workbench-lead" });
    }
    return sendJson(response, 404, { detail: "unexpected request" });
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await runBootstrap([
    "--gateway-url", baseUrl,
    "--langgraph-url", `${baseUrl}/api`,
    "--agent-dir", fixture.agentDir,
    "--skill-dir", fixture.skillDir,
  ], {
    DEERFLOW_ADMIN_ACCESS_TOKEN: "admin.jwt.token",
    DEERFLOW_INTERNAL_AUTH_TOKEN: "must-not-be-used",
    DEER_FLOW_INTERNAL_AUTH_TOKEN: "must-not-be-used-either",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url}`),
    [
      "PUT /api/agents/workbench-lead",
      "POST /api/threads",
      "POST /api/threads/bootstrap-thread/uploads",
      "POST /api/skills/install",
      "DELETE /api/skills/custom/workbench",
      "POST /api/skills/install",
      "PUT /api/skills/workbench",
    ],
  );
  for (const request of requests) {
    assert.equal(request.authorization, undefined, `${request.method} ${request.url}`);
    assert.equal(request.internalToken, undefined, `${request.method} ${request.url}`);
    assert.equal(request.ownerUserId, undefined, `${request.method} ${request.url}`);
    assert.match(request.cookie ?? "", /^access_token=admin\.jwt\.token; csrf_token=[A-Za-z0-9_-]+$/, `${request.method} ${request.url}`);
    const csrfCookie = request.cookie?.match(/(?:^|; )csrf_token=([^;]+)/)?.[1];
    assert.equal(request.csrfToken, csrfCookie, `${request.method} ${request.url}`);
  }
  assert.equal(new Set(requests.map((request) => request.csrfToken)).size, 1);
});

test("fails closed instead of treating the internal token as an admin credential", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const result = await runBootstrap([
    "--gateway-url", "http://127.0.0.1:1",
    "--langgraph-url", "http://127.0.0.1:1/api",
    "--agent-dir", fixture.agentDir,
    "--skill-dir", fixture.skillDir,
  ], {
    DEERFLOW_INTERNAL_AUTH_TOKEN: "internal-only",
    DEER_FLOW_INTERNAL_AUTH_TOKEN: "internal-only",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /DEERFLOW_ADMIN_ACCESS_TOKEN is required/);
  assert.match(result.stderr, /cannot authorize skill management/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|fetch failed/);
});

test("preserves DeerFlow's admin role gate and does not retry a 403 as internal", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const requests = [];
  const server = createServer(async (request, response) => {
    await readRequestBody(request);
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "POST" && request.url === "/api/threads") {
      return sendJson(response, 200, { thread_id: "bootstrap-thread" });
    }
    if (request.method === "POST" && request.url === "/api/threads/bootstrap-thread/uploads") {
      return sendJson(response, 200, { files: [{ virtual_path: "mnt/user-data/uploads/workbench.skill" }] });
    }
    if (request.method === "POST" && request.url === "/api/skills/install") {
      return sendJson(response, 403, { detail: "Admin privileges required to manage skills." });
    }
    return sendJson(response, 500, { detail: "bootstrap must stop after the role denial" });
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const result = await runBootstrap([
    "--skip-agent",
    "--gateway-url", baseUrl,
    "--langgraph-url", `${baseUrl}/api`,
    "--agent-dir", fixture.agentDir,
    "--skill-dir", fixture.skillDir,
  ], {
    DEERFLOW_ADMIN_ACCESS_TOKEN: "non-admin.jwt.token",
    DEERFLOW_INTERNAL_AUTH_TOKEN: "must-not-be-used",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /403 Admin privileges required to manage skills/);
  assert.deepEqual(requests, [
    "POST /api/threads",
    "POST /api/threads/bootstrap-thread/uploads",
    "POST /api/skills/install",
  ]);
});

test("dry-run stays offline and does not require an admin token", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const result = await runBootstrap([
    "--dry-run",
    "--gateway-url", "http://127.0.0.1:1",
    "--langgraph-url", "http://127.0.0.1:1/api",
    "--agent-dir", fixture.agentDir,
    "--skill-dir", fixture.skillDir,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Dry run: would upsert agent 'workbench-lead'/);
  assert.match(result.stdout, /Dry run: would install or refresh skill 'workbench'/);
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-deerflow-bootstrap-test-"));
  const agentDir = path.join(root, "agent");
  const skillDir = path.join(root, "skill");
  await mkdir(agentDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(agentDir, "agent.json"), JSON.stringify({
    name: "workbench-lead",
    description: "产品工作台",
  }), "utf8");
  await writeFile(path.join(agentDir, "SOUL.md"), "# 产品工作台\n", "utf8");
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: workbench\ndescription: 产品工作台\n---\n", "utf8");
  return {
    agentDir,
    skillDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function runBootstrap(args, extraEnv = {}) {
  const env = { ...process.env };
  delete env.DEERFLOW_ADMIN_ACCESS_TOKEN;
  delete env.DEERFLOW_INTERNAL_AUTH_TOKEN;
  delete env.DEER_FLOW_INTERNAL_AUTH_TOKEN;
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, [bootstrapPath, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
