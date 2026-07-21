#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";

const runId = randomUUID();
const body = Buffer.from(`workbench OSS public upload smoke ${runId}\n`, "utf8");
const sha256 = createHash("sha256").update(body).digest("hex");
let baseUrl;
let expectedUploadOrigin = "";
let email = "";
let password = "";
let timeoutMs = 0;
let forbiddenStorageTargets = [];
const evidence = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  checks: [],
};

let cookie = "";
let project = null;
let projectEtag = null;
let file = null;
let fileEtag = null;
let upload = null;
let uploadEtag = null;
let completed = false;

try {
  baseUrl = origin(required("WORKBENCH_UPLOAD_SMOKE_BASE_URL"));
  expectedUploadOrigin = origin(required("WORKBENCH_UPLOAD_SMOKE_EXPECTED_UPLOAD_ORIGIN")).origin;
  email = required("WORKBENCH_UPLOAD_SMOKE_EMAIL");
  password = required("WORKBENCH_UPLOAD_SMOKE_PASSWORD");
  timeoutMs = positiveInteger(process.env.WORKBENCH_UPLOAD_SMOKE_TIMEOUT_MS ?? "120000");
  forbiddenStorageTargets = commaSeparated(
    process.env.WORKBENCH_UPLOAD_SMOKE_FORBIDDEN_STORAGE_TARGETS,
  );
  evidence.baseOrigin = baseUrl.origin;
  evidence.expectedUploadOrigin = expectedUploadOrigin;
  await checkCsp();
  await signIn();

  const identity = await apiJson("/api/v1/identity/me");
  assertString(identity.defaultWorkspaceId, "identity.defaultWorkspaceId");
  pass("identity-bootstrap", { principalId: identity.id, workspaceId: identity.defaultWorkspaceId });

  ({ data: project, etag: projectEtag } = await apiJsonWithMetadata(
    `/api/v1/workspaces/${encodeURIComponent(identity.defaultWorkspaceId)}/projects`,
    {
      method: "POST",
      body: { title: `OSS upload smoke ${runId.slice(0, 8)}` },
      expectedStatus: 201,
    },
  ));
  assertString(project.id, "project.id");
  pass("project-created", { projectId: project.id });

  const created = await apiJsonWithMetadata(
    `/api/v1/projects/${encodeURIComponent(project.id)}/file-upload-sessions`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `upload-${runId}` },
      body: {
        fileName: `oss-smoke-${runId}.txt`,
        declaredMediaType: "text/plain",
        byteSize: body.byteLength,
        sha256,
      },
      expectedStatus: 201,
    },
  );
  file = created.data.file;
  upload = created.data.upload;
  uploadEtag = created.etag;
  assertString(file.id, "file.id");
  assertString(upload.id, "upload.id");
  if (upload.status !== "initiated") throw new Error(`upload status is ${upload.status}, expected initiated`);
  pass("multipart-created", {
    fileId: file.id,
    uploadSessionId: upload.id,
    byteSize: body.byteLength,
    sha256,
  });

  const signed = await apiJsonWithMetadata(
    `/api/v1/file-upload-sessions/${encodeURIComponent(upload.id)}/parts/1`,
    {
      method: "POST",
      headers: { "If-Match": uploadEtag },
      body: { contentLength: body.byteLength },
      expectedStatus: 200,
    },
  );
  uploadEtag = signed.etag;
  const signedUrl = new URL(assertString(signed.data.url, "signed upload URL"));
  if (signedUrl.origin !== expectedUploadOrigin) {
    throw new Error(`signed upload origin ${signedUrl.origin} does not match ${expectedUploadOrigin}`);
  }
  if (signedUrl.username || signedUrl.password || signedUrl.hash) {
    throw new Error("signed upload URL contains forbidden credentials or fragment");
  }
  pass("part-signed", {
    origin: signedUrl.origin,
    method: signed.data.method,
    expiresAt: signed.data.expiresAt,
  });

  await checkCors(signedUrl);
  const uploadedPartEtag = await putPart(signedUrl, signed.data.headers ?? {});
  pass("part-uploaded", { partNumber: 1, etag: uploadedPartEtag });

  const completedUpload = await apiJsonWithMetadata(
    `/api/v1/file-upload-sessions/${encodeURIComponent(upload.id)}/complete`,
    {
      method: "POST",
      headers: {
        "If-Match": uploadEtag,
        "Idempotency-Key": `complete-${runId}`,
      },
      body: {
        parts: [{ partNumber: 1, etag: uploadedPartEtag }],
        sha256,
      },
      expectedStatus: 202,
    },
  );
  completed = true;
  file = completedUpload.data.file;
  pass("multipart-completed", {
    uploadStatus: completedUpload.data.upload.status,
    fileStatus: file.status,
  });

  ({ data: file, etag: fileEtag } = await waitForReady(file.id));
  if (file.sha256 !== sha256) {
    throw new Error(`ready file digest ${file.sha256 ?? "missing"} does not match upload digest`);
  }
  pass("worker-verified", {
    fileStatus: file.status,
    detectedMediaType: file.detectedMediaType,
    sha256: file.sha256,
    verifiedAt: file.verifiedAt,
  });

  const contentResponse = await api(`/api/v1/files/${encodeURIComponent(file.id)}/content`);
  const downloaded = Buffer.from(await contentResponse.arrayBuffer());
  if (!downloaded.equals(body)) throw new Error("downloaded file content does not match uploaded content");
  pass("ready-content-read", {
    byteSize: downloaded.byteLength,
    sha256: createHash("sha256").update(downloaded).digest("hex"),
  });

  await api(`/api/v1/files/${encodeURIComponent(file.id)}`, {
    method: "DELETE",
    headers: { "If-Match": fileEtag },
    expectedStatus: 204,
  });
  file = null;
  pass("file-deleted");

  await archiveProject();
  evidence.finishedAt = new Date().toISOString();
  evidence.result = "PASS";
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} catch (error) {
  await bestEffortCleanup();
  const message = error instanceof Error ? error.message : String(error);
  evidence.finishedAt = new Date().toISOString();
  evidence.result = "FAIL";
  evidence.failure = {
    code: "PUBLIC_UPLOAD_SMOKE_FAILED",
    afterCheck: evidence.checks.at(-1)?.name ?? null,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stderr.write(`public upload smoke failed: ${redact(message)}\n`);
  process.exitCode = 1;
}

async function checkCsp() {
  const response = await request(new URL("/login", baseUrl), { expectedStatus: 200, authenticated: false });
  const csp = response.headers.get("content-security-policy") ?? "";
  if (!csp.includes(expectedUploadOrigin)) {
    throw new Error(`Web CSP does not include ${expectedUploadOrigin}`);
  }
  for (const forbidden of ["127.0.0.1:9100", "localhost:9100", "minio", ...forbiddenStorageTargets]) {
    if (csp.toLowerCase().includes(forbidden)) throw new Error(`Web CSP still contains forbidden storage target ${forbidden}`);
  }
  pass("web-csp", { uploadOrigin: expectedUploadOrigin });
}

async function signIn() {
  const response = await request(new URL("/api/auth/sign-in/email", baseUrl), {
    method: "POST",
    body: { email, password },
    expectedStatus: 200,
    authenticated: false,
  });
  cookie = sessionCookie(response.headers);
  if (!cookie) throw new Error("sign-in response did not set a session cookie");
  const payload = await response.json();
  pass("sign-in", { userId: payload.user?.id });
}

async function checkCors(signedUrl) {
  const response = await request(signedUrl, {
    method: "OPTIONS",
    headers: {
      Origin: baseUrl.origin,
      "Access-Control-Request-Method": "PUT",
    },
    expectedStatus: [200, 204],
    authenticated: false,
    includeOrigin: false,
  });
  assertCors(response.headers, "preflight");
  const methods = (response.headers.get("access-control-allow-methods") ?? "").toUpperCase();
  if (!methods.split(/\s*,\s*/u).includes("PUT")) throw new Error("OSS CORS preflight does not allow PUT");
  pass("oss-cors-preflight", { allowMethods: methods });
}

async function putPart(signedUrl, signedHeaders) {
  const response = await request(signedUrl, {
    method: "PUT",
    headers: {
      ...signedHeaders,
      Origin: baseUrl.origin,
      "Content-Length": String(body.byteLength),
    },
    rawBody: body,
    expectedStatus: 200,
    authenticated: false,
    includeOrigin: false,
  });
  assertCors(response.headers, "upload response");
  const exposed = (response.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  if (!exposed.split(/\s*,\s*/u).includes("etag")) throw new Error("OSS CORS response does not expose ETag");
  const etag = response.headers.get("etag");
  if (!etag || !/^"[\x21\x23-\x7e]{1,256}"$/u.test(etag)) {
    throw new Error("OSS upload response has no valid quoted ETag");
  }
  return etag;
}

async function waitForReady(fileId) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await apiJsonWithMetadata(`/api/v1/files/${encodeURIComponent(fileId)}`);
    if (latest.data.status === "ready") return latest;
    if (["failed", "quarantined", "deleted"].includes(latest.data.status)) {
      throw new Error(`file verification ended in ${latest.data.status}: ${latest.data.failure?.code ?? "unknown"}`);
    }
    await delay(1_000);
  }
  throw new Error(`file verification timed out in ${latest?.data?.status ?? "unknown"}`);
}

async function archiveProject() {
  if (!project || !projectEtag) return;
  await api(`/api/v1/projects/${encodeURIComponent(project.id)}`, {
    method: "DELETE",
    headers: { "If-Match": projectEtag },
    expectedStatus: 200,
  });
  pass("project-archived", { projectId: project.id });
  project = null;
}

async function bestEffortCleanup() {
  if (!cookie) return;
  if (!completed && upload?.id) {
    try {
      const current = await apiJsonWithMetadata(
        `/api/v1/file-upload-sessions/${encodeURIComponent(upload.id)}`,
      );
      if (!["aborted", "completed"].includes(current.data.status)) {
        await api(`/api/v1/file-upload-sessions/${encodeURIComponent(upload.id)}`, {
          method: "DELETE",
          headers: { "If-Match": current.etag },
          expectedStatus: 204,
        });
      }
    } catch {}
  }
  if (file?.id) {
    try {
      const current = await apiJsonWithMetadata(`/api/v1/files/${encodeURIComponent(file.id)}`);
      await api(`/api/v1/files/${encodeURIComponent(file.id)}`, {
        method: "DELETE",
        headers: { "If-Match": current.etag },
        expectedStatus: 204,
      });
    } catch {}
  }
  try {
    await archiveProject();
  } catch {}
}

async function apiJson(path, options = {}) {
  return (await api(path, options)).json();
}

async function apiJsonWithMetadata(path, options = {}) {
  const response = await api(path, options);
  const data = await response.json();
  const etag = response.headers.get("etag");
  if (options.method && options.method !== "GET" && !etag && response.status !== 204) {
    throw new Error(`${options.method} ${path} did not return an ETag`);
  }
  if (etag && !/^"(0|[1-9]\d*)"$/u.test(etag)) throw new Error(`${path} returned an invalid revision ETag`);
  return { data, etag };
}

function api(path, options = {}) {
  return request(new URL(path, baseUrl), options);
}

async function request(url, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", options.rawBody ? "*/*" : "application/json");
  headers.set("User-Agent", "workbench-production-upload-smoke/1");
  if (options.authenticated !== false && cookie) headers.set("Cookie", cookie);
  if (options.includeOrigin !== false && !["GET", "HEAD"].includes(method)) {
    headers.set("Origin", baseUrl.origin);
  }
  let requestBody = options.rawBody;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(options.body);
  }
  const response = await fetch(url, {
    method,
    headers,
    body: requestBody,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const expected = Array.isArray(options.expectedStatus)
    ? options.expectedStatus
    : [options.expectedStatus ?? 200];
  if (!expected.includes(response.status)) {
    const detail = redact((await response.text()).slice(0, 1_000));
    throw new Error(`${method} ${url.origin}${url.pathname} returned ${response.status}: ${detail}`);
  }
  return response;
}

function assertCors(headers, operation) {
  const allowed = headers.get("access-control-allow-origin");
  if (allowed !== baseUrl.origin) {
    throw new Error(`OSS CORS ${operation} allowed origin ${allowed ?? "missing"}, expected ${baseUrl.origin}`);
  }
}

function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookie(headers.get("set-cookie") ?? "");
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function splitSetCookie(value) {
  return value ? value.split(/,(?=\s*[^;,=]+=[^;,]+)/u) : [];
}

function pass(name, detail = {}) {
  evidence.checks.push({ ...detail, name, status: "PASS", at: new Date().toISOString() });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${value} must be an HTTPS origin`);
  }
  return url;
}

function positiveInteger(value) {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error("WORKBENCH_UPLOAD_SMOKE_TIMEOUT_MS must be positive");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("WORKBENCH_UPLOAD_SMOKE_TIMEOUT_MS is too large");
  return parsed;
}

function commaSeparated(value) {
  if (!value?.trim()) return [];
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.some((entry) => /[\s/?#]/u.test(entry))) {
    throw new Error("WORKBENCH_UPLOAD_SMOKE_FORBIDDEN_STORAGE_TARGETS must contain comma-separated hosts");
  }
  return [...new Set(entries)];
}

function assertString(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} is missing`);
  return value;
}

function redact(value) {
  const withoutPassword = password ? value.replaceAll(password, "[REDACTED]") : value;
  return withoutPassword
    .replace(/([?&](?:X-Amz-[^=]+|Signature|OSSAccessKeyId)=[^&\s]+)/giu, "[SIGNED_QUERY_REDACTED]")
    .replace(/(?:__Secure-)?workbench\.[^=\s]+=[^;\s]+/giu, "[COOKIE_REDACTED]");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
