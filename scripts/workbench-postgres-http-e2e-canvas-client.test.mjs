import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasToolIdempotencyKey,
  executeCanvasToolRequest,
} from "./workbench-postgres-http-e2e-canvas-client.mjs";

const descriptor = {
  endpoint: "http://127.0.0.1:4319/api/v1/runtime/canvas/tools/execute",
  token: "canvas-capability-token",
};
const toolName = "navigate_canvas";
const toolCallId = "canvas-quick-edit-navigate";
const input = { screenId: "screen-home" };

test("Canvas revision mismatch retries the exact same invocation request", async () => {
  const calls = [];
  const responses = [
    response(412, "application/problem+json; charset=utf-8", {
      code: "CANVAS_REVISION_MISMATCH",
      detail: "The Canvas snapshot changed before the tool invocation was reserved",
    }),
    response(200, "application/json", {
      protocol: "workbench.canvas-agent-tool-result.v1",
      status: "succeeded",
      data: { kind: "single", items: [] },
    }),
  ];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request: structuredClone(request) });
    return responses.shift();
  };

  const result = await executeCanvasToolRequest({
    descriptor,
    toolName,
    toolCallId,
    input,
    deadline: Date.now() + 1_000,
    fetchImpl,
    retryDelayMs: 0,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].request.headers.Authorization, `Bearer ${descriptor.token}`);
  assert.equal(
    calls[0].request.headers["Idempotency-Key"],
    canvasToolIdempotencyKey(toolCallId),
  );
  assert.deepEqual(JSON.parse(calls[0].request.body), {
    protocol: "workbench.canvas-agent-tool.v1",
    toolName,
    toolCallId,
    input,
  });
});

for (const scenario of [
  {
    name: "a different HTTP status",
    status: 409,
    contentType: "application/problem+json",
    body: { code: "CANVAS_REVISION_MISMATCH" },
  },
  {
    name: "a different content type",
    status: 412,
    contentType: "application/json",
    body: { code: "CANVAS_REVISION_MISMATCH" },
  },
  {
    name: "a different problem code",
    status: 412,
    contentType: "application/problem+json",
    body: { code: "PRECONDITION_FAILED" },
  },
]) {
  test(`Canvas invocation does not retry ${scenario.name}`, async () => {
    let callCount = 0;
    const body = JSON.stringify(scenario.body);

    await assert.rejects(
      executeCanvasToolRequest({
        descriptor,
        toolName,
        toolCallId,
        input,
        deadline: Date.now() + 1_000,
        retryDelayMs: 0,
        fetchImpl: async () => {
          callCount += 1;
          return response(scenario.status, scenario.contentType, scenario.body);
        },
      }),
      (error) => {
        assert.equal(
          error.message,
          `Canvas tool ${toolName} returned HTTP ${scenario.status}: ${body}`,
        );
        return true;
      },
    );
    assert.equal(callCount, 1);
  });
}

function response(status, contentType, body) {
  const text = JSON.stringify(body);
  return {
    status,
    headers: new Headers({ "Content-Type": contentType }),
    text: async () => text,
  };
}
