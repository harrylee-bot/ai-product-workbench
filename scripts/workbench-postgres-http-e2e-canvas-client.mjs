import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const revisionMismatchCode = "CANVAS_REVISION_MISMATCH";
const problemJsonMediaType = "application/problem+json";

export async function executeCanvasToolRequest({
  descriptor,
  toolName,
  toolCallId,
  input,
  deadline,
  fetchImpl = globalThis.fetch,
  retryDelayMs = 50,
}) {
  if (!Number.isFinite(deadline)) throw new Error("Canvas tool request deadline is required");
  if (typeof fetchImpl !== "function") throw new Error("Canvas tool request fetch implementation is required");

  const endpoint = descriptor.endpoint;
  const request = {
    method: "POST",
    headers: {
      Accept: "application/json, application/problem+json",
      Authorization: `Bearer ${descriptor.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": canvasToolIdempotencyKey(toolCallId),
    },
    body: JSON.stringify({
      protocol: "workbench.canvas-agent-tool.v1",
      toolName,
      toolCallId,
      input,
    }),
  };
  let lastRevisionMismatch;

  while (Date.now() < deadline) {
    const response = await fetchImpl(endpoint, request);
    const responseText = await response.text();
    const error = canvasToolHttpError(toolName, response.status, responseText);

    if (isCanvasRevisionMismatch(response, responseText)) {
      lastRevisionMismatch = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw error;
      await delay(Math.min(retryDelayMs, remainingMs));
      continue;
    }
    if (response.status !== 200) throw error;
    return parseJson(responseText, `Canvas tool ${toolName}`);
  }

  if (lastRevisionMismatch) throw lastRevisionMismatch;
  throw new Error(`Canvas tool ${toolName} request deadline elapsed`);
}

export function canvasToolIdempotencyKey(toolCallId) {
  const digest = createHash("sha256")
    .update(`workbench.canvas-agent-invocation.v1\0${toolCallId}`)
    .digest("hex");
  return `canvas:${digest}`;
}

function isCanvasRevisionMismatch(response, responseText) {
  if (response.status !== 412) return false;
  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== problemJsonMediaType) return false;

  try {
    return JSON.parse(responseText)?.code === revisionMismatchCode;
  } catch {
    return false;
  }
}

function canvasToolHttpError(toolName, status, responseText) {
  return new Error(`Canvas tool ${toolName} returned HTTP ${status}: ${responseText.slice(0, 2_000)}`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}
