#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = positiveInteger(process.env.WORKBENCH_SECRET_CHANNEL_MOCK_PORT || "4300");
const knowledgeToken = required("WORKBENCH_SECRET_CHANNEL_KNOWLEDGE_TOKEN");
const canvasToken = required("WORKBENCH_SECRET_CHANNEL_CANVAS_TOKEN");
const releaseId = required("WORKBENCH_SECRET_CHANNEL_RELEASE_ID");
const probe = required("WORKBENCH_SECRET_CHANNEL_EXPECTED_PROBE");
const citation = required("WORKBENCH_SECRET_CHANNEL_EXPECTED_CITATION");
const canvasMarker = required("WORKBENCH_SECRET_CHANNEL_CANVAS_MARKER");
const evidenceSecret = required("WORKBENCH_SECRET_CHANNEL_EVIDENCE_SECRET");

const calls = { knowledge: new Map(), canvas: new Map() };
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/evidence") {
      if (!constantTimeEqual(request.headers["x-validation-evidence-secret"], evidenceSecret)) {
        return json(response, 401, { error: "unauthorized" });
      }
      return json(response, 200, {
        protocol: "workbench.secret-channel-validation-evidence.v1",
        knowledgeTokenSha256: sha256(knowledgeToken),
        canvasTokenSha256: sha256(canvasToken),
        knowledgeCalls: [...calls.knowledge.values()],
        canvasCalls: [...calls.canvas.values()],
      });
    }
    if (request.method !== "POST") return json(response, 404, { error: "not_found" });
    if (request.url === "/knowledge") return handleKnowledge(request, response);
    if (request.url === "/canvas") return handleCanvas(request, response);
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    return json(response, 400, {
      error: error instanceof Error ? error.message : "invalid_request",
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`);
});

process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());

async function handleKnowledge(request, response) {
  assertBearer(request, knowledgeToken);
  const body = await readJson(request);
  if (
    body?.protocol !== "workbench.knowledge-retrieval-request.v1"
    || typeof body.query !== "string"
    || !body.query.trim()
  ) throw new Error("invalid_knowledge_request");
  const invocationKey = idempotencyKey(request);
  calls.knowledge.set(invocationKey, {
    invocationKey,
    querySha256: sha256(body.query.trim()),
  });
  return json(response, 200, {
    protocol: "workbench.knowledge-retrieval-result.v1",
    evidence: {
      schema: "workbench.knowledge-retrieval-evidence.v1",
      mode: "hybrid",
      routeScope: "production",
      release: { id: releaseId, key: "secret-channel-validation", version: 1 },
      embeddingProfile: { id: "secret-channel-embedding", specSha256: "a".repeat(64), dimension: 3 },
      retrievalProfile: { id: "secret-channel-retrieval", specSha256: "b".repeat(64) },
      candidateCounts: { lexical: 1, dense: 1, fused: 1 },
      fusion: { algorithm: "rrf", k: 60 },
      reranker: { status: "not_needed" },
      degraded: false,
    },
    items: [{
      rank: 1,
      rrfScore: 1,
      rerankerScore: null,
      citation: {
        id: "citation-secret-channel-validation",
        documentId: "document-secret-channel-validation",
        chunkId: "chunk-secret-channel-validation",
        sourcePath: citation,
        title: "Secret channel validation",
        quote: probe,
        locator: { heading: "Validation", startLine: 1, endLine: 1 },
      },
    }],
  });
}

async function handleCanvas(request, response) {
  assertBearer(request, canvasToken);
  const body = await readJson(request);
  if (
    body?.protocol !== "workbench.canvas-agent-tool.v1"
    || body.toolName !== "get_visible_screens"
    || typeof body.toolCallId !== "string"
    || !body.toolCallId
  ) throw new Error("invalid_canvas_request");
  const invocationKey = idempotencyKey(request);
  calls.canvas.set(invocationKey, {
    invocationKey,
    toolCallIdSha256: sha256(body.toolCallId),
    toolName: body.toolName,
  });
  return json(response, 200, {
    protocol: "workbench.canvas-agent-tool.v1",
    agentSessionId: "session-secret-channel-validation",
    toolCallId: body.toolCallId,
    toolName: body.toolName,
    status: "succeeded",
    boardRevision: 1,
    canvasStateRevision: 1,
    responseSha256: sha256(JSON.stringify(body)),
    data: {
      items: [{
        reference: {
          boardNodeId: "node-secret-channel-validation",
          artifactId: "artifact-secret-channel-validation",
          artifactVersionId: "version-secret-channel-validation",
          screenId: "screen-secret-channel-validation",
        },
        name: canvasMarker,
        route: "/secret-channel-validation",
        phase: "complete",
        viewport: { width: 1440, height: 900 },
      }],
      nextCursor: null,
      truncated: false,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    failure: null,
    approvalId: null,
    clientCommandId: null,
  });
}

function assertBearer(request, expected) {
  if (!constantTimeEqual(request.headers.authorization, `Bearer ${expected}`)) {
    throw new Error("unauthorized");
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function idempotencyKey(request) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !value) throw new Error("missing_idempotency_key");
  return value;
}

function json(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function constantTimeEqual(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("WORKBENCH_SECRET_CHANNEL_MOCK_PORT is invalid");
  }
  return parsed;
}
