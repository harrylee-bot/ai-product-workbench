import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canvasAgentToolResultSchema } from "../packages/workbench-contracts/dist/index.js";

test("secret-channel mock serves the runtime canvas contract and records authenticated evidence", async (t) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const canvasToken = `wbct1.${randomUUID()}`;
  const evidenceSecret = randomUUID();
  const marker = "Public canvas contract regression marker";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./workbench-deerflow-secret-channel-mock.mjs", import.meta.url))], {
    env: {
      ...process.env,
      WORKBENCH_SECRET_CHANNEL_MOCK_PORT: String(port),
      WORKBENCH_SECRET_CHANNEL_KNOWLEDGE_TOKEN: `wbkg1.${randomUUID()}`,
      WORKBENCH_SECRET_CHANNEL_CANVAS_TOKEN: canvasToken,
      WORKBENCH_SECRET_CHANNEL_RELEASE_ID: "release-regression",
      WORKBENCH_SECRET_CHANNEL_EXPECTED_PROBE: "Public knowledge probe",
      WORKBENCH_SECRET_CHANNEL_EXPECTED_CITATION: "regression.md",
      WORKBENCH_SECRET_CHANNEL_CANVAS_MARKER: marker,
      WORKBENCH_SECRET_CHANNEL_EVIDENCE_SECRET: evidenceSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await closed;
      clearTimeout(force);
    }
  });
  await Promise.race([
    once(lines, "line", { signal: AbortSignal.timeout(10_000) }).then(([line]) => {
      assert.deepEqual(JSON.parse(line), { ready: true, port });
    }),
    once(child, "exit").then(() => { throw new Error("Mock exited before ready"); }),
  ]);
  const origin = `http://127.0.0.1:${port}`;
  const body = {
    protocol: "workbench.canvas-agent-tool.v1",
    toolName: "get_visible_screens",
    toolCallId: "tool-call-regression",
    input: {},
  };
  const request = (route, overrides = {}) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${canvasToken}`,
      "Idempotency-Key": "invocation-regression",
      ...overrides.headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const canonical = "/api/v1/runtime/canvas/tools/execute";
  for (const route of [canonical, canonical, "/canvas"]) {
    const response = await request(route);
    assert.equal(response.status, 200);
    const result = canvasAgentToolResultSchema.parse(await response.json());
    assert.equal(result.toolCallId, body.toolCallId);
    assert.equal(result.status, "succeeded");
    assert.equal(result.data.items[0].name, marker);
  }
  const denied = await request(canonical, { headers: {
    Authorization: "Bearer invalid",
    "Idempotency-Key": "must-not-be-recorded",
  } });
  assert.equal(denied.status, 400);
  assert.deepEqual(await denied.json(), { error: "unauthorized" });
  assert.equal((await request("/api/v1/runtime/canvas/tools/unknown")).status, 404);
  assert.equal((await fetch(`${origin}${canonical}`)).status, 404);
  assert.equal((await fetch(`${origin}/evidence`)).status, 401);
  const evidenceResponse = await fetch(`${origin}/evidence`, {
    headers: { "x-validation-evidence-secret": evidenceSecret },
  });
  assert.equal(evidenceResponse.status, 200);
  const evidence = await evidenceResponse.json();
  assert.equal(evidence.protocol, "workbench.secret-channel-validation-evidence.v1");
  assert.equal(evidence.canvasTokenSha256, createHash("sha256").update(canvasToken).digest("hex"));
  assert.deepEqual(evidence.canvasCalls, [{
    invocationKey: "invocation-regression",
    toolCallIdSha256: createHash("sha256").update(body.toolCallId).digest("hex"),
    toolName: "get_visible_screens",
  }]);
  assert.deepEqual(evidence.knowledgeCalls, []);
  assert.equal(JSON.stringify(evidence).includes(canvasToken), false);
});
