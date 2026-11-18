#!/usr/bin/env node
// Real-stack Studio acceptance test using ONLY deepseek-flash (4.1flash).
// Zero browser API interception; fixed PostgreSQL migrations, Temporal, S3, TEI/Reranker, Preview, and DeerFlow (deepseek-flash).
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { verifyStudioRuntime } from "../test-support/studio-live-runtime.mjs";
import { runStudioLiveScenarios } from "./studio-live-scenarios.mjs";
import { runStudioLiveFileScenarios } from "./studio-live-file-scenarios.mjs";
import { runStudioLiveAccessScenarios } from "./studio-live-access-scenarios.mjs";
import { startLiveKnowledgeFixture } from "../test-support/studio-live-knowledge.mjs";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const runId = String(Date.now());
const phase = process.env.WORKBENCH_STUDIO_LIVE_PHASE ?? "generation";
assert.ok(["generation", "prd", "joint", "stop", "access", "files", "delivery"].includes(phase));
const generates = ["generation", "prd", "joint", "stop"].includes(phase);
const activityContract = process.env.WORKBENCH_STUDIO_LIVE_ACTIVITY_CONTRACT === "1";
assert.ok(!activityContract || ["prd", "joint"].includes(phase), "The local activity contract applies to PRD and joint acceptance");
const usesModelFixture = generates || phase === "access";
const needsTemporal = generates || phase === "delivery";
const suiteDirectory = { stop: "studio-live-stop", joint: "studio-live-joint", prd: "studio-live-prd", files: "file-delivery", delivery: "artifact-delivery" }[phase] ?? "studio-live-flash";
const auditRoot = path.join(root, "output/audit/1.0.0");
const outDir = path.join(auditRoot, suiteDirectory, runId);
await mkdir(outDir, { recursive: true });
await writeFile(path.join(auditRoot, `${suiteDirectory}-latest.json`), JSON.stringify({ runId, outDir }));
const dbName = `workbench_studio_live_test_${runId}`;
// All credentials and machine-specific locations are supplied externally.
const requiredEnv = (key) => { assert.ok(process.env[key], `${key} is required`); return process.env[key]; };
const checkAccess = phase === "access" || (phase === "generation" && Boolean(process.env.WORKBENCH_STUDIO_LIVE_MAILBOX_URL));
const mailboxOrigin = checkAccess ? new URL(requiredEnv("WORKBENCH_STUDIO_LIVE_MAILBOX_URL")) : null;
const smtpUrl = checkAccess ? new URL(requiredEnv("WORKBENCH_STUDIO_LIVE_SMTP_URL")) : null;
if (checkAccess) {
  assert.equal(mailboxOrigin.protocol, "http:");
  assert.equal(smtpUrl.protocol, "smtp:");
  for (const url of [mailboxOrigin, smtpUrl]) assert.equal(url.hostname, "127.0.0.1", "Use an isolated local mailbox");
}
const adminDbUrl = requiredEnv("WORKBENCH_STUDIO_LIVE_ADMIN_DATABASE_URL");
const dbAddress = new URL(adminDbUrl);
assert.ok(["127.0.0.1", "localhost", "::1"].includes(dbAddress.hostname), "Use an isolated local PostgreSQL server");
const dbUrlObject = new URL(adminDbUrl); dbUrlObject.pathname = `/${dbName}`; dbUrlObject.searchParams.set("schema", "workbench");
const dbUrl = dbUrlObject.toString();
const handoffDir = requiredEnv("V2_TLS_DIRECTORY");
const providerEnvFile = usesModelFixture ? requiredEnv("V2_PROVIDER_ENV_FILE") : null;
const inferenceEnvFile = usesModelFixture ? requiredEnv("V2_INFERENCE_ENV_FILE") : null;
const s3EnvFile = requiredEnv("V2_S3_ENV_FILE");
const requirementsConfigPath = usesModelFixture ? requiredEnv("WORKBENCH_STUDIO_LIVE_REQUIREMENTS_CONFIG") : null;
const publishedPath = usesModelFixture ? requiredEnv("WORKBENCH_STUDIO_LIVE_PUBLISHED_KNOWLEDGE") : null;
const serviceRoot = path.resolve(requiredEnv("WORKBENCH_STUDIO_LIVE_SERVICE_ROOT"));
const expectedBackendCommit = requiredEnv("WORKBENCH_STUDIO_LIVE_BACKEND_COMMIT");
const node = process.execPath;
const bin = path.dirname(node);
const chromiumPath = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH || chromium.executablePath();

const resources = [];
const tlsCloses = [];
let browser, currentPage, externalStorage, webDist, nextEnvBackup;

const evidence = {
  runId,
  phase,
  evidenceLevel:
    generates ? "isolated-real-studio-stack-model-retrieval-and-object-storage" : phase === "delivery" ? "isolated-real-export-workers-with-fixed-versioned-inputs" : phase === "files" ? "isolated-real-studio-file-upload-scan-and-extraction" : "isolated-real-studio-authentication-and-project-permissions",
  browserApiInterception: false,
  allowedModelId: "deepseek-flash",
  forbiddenModelIds: ["deepseek-pro", "deepseek-v4-pro"],
  forbiddenModelAttempted: false,
  checks: {},
  steps: [],
  failures: [],
  networkErrors: [],
};

function step(name) {
  console.log(`[studio-live-flash] ${name}`);
  evidence.steps.push({ name, at: new Date().toISOString() });
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

async function sql(query, values = [], targetUrl = adminDbUrl) {
  const c = new pg.Client({ connectionString: targetUrl });
  await c.connect();
  try {
    return await c.query(query, values);
  } finally {
    await c.end();
  }
}

async function runCmd(name, args, cwd = root, env = process.env) {
  const log = createWriteStream(path.join(outDir, `${name}.log`));
  const child = spawn(node, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((r) => child.once("exit", r));
  log.end();
  assert.equal(code, 0, `${name} exited with code ${code}`);
}

function startService(name, args, env, cwd = root) {
  const log = createWriteStream(path.join(outDir, `service-${name}.log`));
  const child = spawn(node, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  resources.push({ name, child, log });
  return child;
}

async function waitUntil(check, label, timeout = 120000, interval = 500) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      if (err?.fatal) throw err;
      lastError = err;
    }
    await delay(interval);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function health(url) {
  return waitUntil(
    async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      return r.ok;
    },
    `health ${url}`,
    90000,
    400,
  );
}

async function loadTls(directory) {
  const caPath = path.join(directory, "ca.crt");
  const [key, cert, ca] = await Promise.all([
    readFile(path.join(directory, "server.key")),
    readFile(path.join(directory, "server.crt")),
    readFile(caPath, "utf8"),
  ]);
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), ca]);
  const spkiPin = createHash("sha256")
    .update(
      new X509Certificate(cert).publicKey.export({
        type: "spki",
        format: "der",
      }),
    )
    .digest("base64");
  return {
    caPath,
    spkiPin,
    async proxy({ port, upstreamPort, publicOrigin, listenHost = "127.0.0.1" }) {
      const authority = new URL(publicOrigin).host;
      const sockets = new Set();
      const server = https.createServer({ key, cert }, (request, response) => {
        const headers = {
          ...request.headers,
          host: authority,
          "x-forwarded-host": authority,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "127.0.0.1",
          "x-workbench-client-ip": "127.0.0.1",
        };
        delete headers["x-workbench-edge-client-ip"];
        delete headers["x-workbench-edge-auth"];
        const upstream = http.request(
          {
            host: "127.0.0.1",
            port: upstreamPort,
            method: request.method,
            path: request.url,
            headers,
          },
          (res) => {
            response.writeHead(res.statusCode ?? 502, res.headers);
            res.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.on("aborted", () => upstream.destroy());
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, listenHost, resolve);
      });
      tlsCloses.push(async () => {
        for (const s of sockets) s.destroy();
        await new Promise((resolve) => server.close(resolve));
      });
    },
  };
}

async function cleanup() {
  await browser?.close().catch(() => {});
  for (const { child } of [...resources].reverse()) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  }
  await delay(800);
  for (const { child, log } of resources) {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    log.end();
  }
  for (const close of tlsCloses) {
    await close().catch(() => {});
  }
  if (externalStorage && evidence.status === "passed") {
    const { client, bucket } = externalStorage;
    try {
      let listed;
      do {
        listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (listed.Contents?.length) {
          await Promise.all(
            listed.Contents.map((x) =>
              client.send(
                new DeleteObjectCommand({ Bucket: bucket, Key: x.Key }),
              ),
            ),
          );
        }
      } while (listed.Contents?.length);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {}
    client.destroy();
  }
  if (webDist) {
    await rm(webDist, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => {});
  }
  if (nextEnvBackup) {
    await writeFile(path.join(root, "apps/web/next-env.d.ts"), nextEnvBackup).catch(
      () => {},
    );
  }
  if (!process.env.V2_KEEP_DATABASE && evidence.status === "passed") {
    await sql(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(
      () => {},
    );
  }
}

process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

function parseEnvFile(content) {
  const out = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const at = trimmed.indexOf("=");
    out[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return out;
}

try {
  evidence.frontendCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  evidence.backendCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: serviceRoot, encoding: "utf8" }).trim();
  assert.equal(evidence.backendCommit, expectedBackendCommit, "Use the fixed backend checkout");
  const modifiedServiceFiles = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "apps/*/src", "packages/*/src", "packages/workbench-db/prisma"], { cwd: serviceRoot, encoding: "utf8" }).trim();
  assert.equal(modifiedServiceFiles, "", "Backend runtime sources must match the fixed commit");
  assert.equal(await readFile(path.join(serviceRoot, "packages/workbench-contracts/openapi/workbench.v1.yaml"), "utf8"), await readFile(path.join(root, "packages/workbench-contracts/openapi/workbench.v1.yaml"), "utf8"), "Frontend and backend must consume the same shared wire contract");
  const requirementsConfig = requirementsConfigPath ? JSON.parse(await readFile(requirementsConfigPath, "utf8")) : { model: "deepseek-flash" };
  assert.ok(["deepseek-flash", "deepseek-4.1-flash"].includes(requirementsConfig.model));
  const localTls = await loadTls(handoffDir);
  // The file and delivery suites run no model service. The API requires an origin
  // for its model catalog, so isolate that dependency on an unused local port.
  const localModelOrigin = !usesModelFixture ? `http://127.0.0.1:${await freePort()}` : null;
  const providerEnv = providerEnvFile ? parseEnvFile(await readFile(providerEnvFile, "utf8")) : {
    V2_PROVIDER_MODEL_ID: "deepseek-flash", V2_PROVIDER_GATEWAY_URL: localModelOrigin,
    V2_PROVIDER_URL: localModelOrigin, V2_PROVIDER_TOKEN: randomBytes(32).toString("hex"),
  };
  const s3Env = parseEnvFile(await readFile(s3EnvFile, "utf8"));
  const inferenceEnv = inferenceEnvFile ? parseEnvFile(await readFile(inferenceEnvFile, "utf8")) : {};
  assert.equal(
    providerEnv.V2_PROVIDER_MODEL_ID,
    "deepseek-flash",
    "Only deepseek-flash is permitted for live testing",
  );

  if (generates) {
  step("Check every live dependency before provisioning or model requests");
  const checks = [
    ["provider", `${providerEnv.V2_PROVIDER_GATEWAY_URL}/api/models`, { "X-DeerFlow-Internal-Token": providerEnv.V2_PROVIDER_TOKEN }],
    ["embedding", `${inferenceEnv.V2_INFERENCE_EMBEDDING_URL}/info`, { Authorization: `Bearer ${inferenceEnv.V2_INFERENCE_TOKEN}` }],
    ["reranker", `${inferenceEnv.V2_INFERENCE_RERANKER_URL}/info`, { Authorization: `Bearer ${inferenceEnv.V2_RERANKER_TOKEN ?? inferenceEnv.V2_INFERENCE_TOKEN}` }],
    ["object-storage", new URL("/minio/health/ready", s3Env.V2_S3_ENDPOINT).href, {}],
  ];
  evidence.preflight = await Promise.all(checks.map(async ([name, url, headers]) => {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      return { name, reachable: response.ok, status: response.status };
    } catch (error) {
      return { name, reachable: false, code: error.cause?.code ?? error.code ?? error.name };
    }
  }));
  const missing = evidence.preflight.filter(item => !item.reachable).map(item => item.name);
  assert.equal(missing.length, 0, `Live dependency unavailable: ${missing.join(", ")}`);
  // The runtime is independently deployed. Require its deployment owner's
  // inspection receipt; a model catalog alone cannot prove tool compatibility.
  const proofPath = requiredEnv("WORKBENCH_STUDIO_LIVE_RUNTIME_PROOF");
  if (phase === "prd" || phase === "joint") {
    const { verifyPrdRuntime } = await import("./studio-live-prd-runtime.mjs");
    evidence.runtimeDeploymentAttestation = await verifyPrdRuntime({ serviceRoot, backendCommit: expectedBackendCommit,
      runtimeCommit: requiredEnv("WORKBENCH_STUDIO_LIVE_RUNTIME_COMMIT"), proofPath, gatewayUrl: providerEnv.V2_PROVIDER_GATEWAY_URL });
  } else {
    evidence.runtimeDeploymentAttestation = await verifyStudioRuntime(serviceRoot, expectedBackendCommit, proofPath);
  }

  // Verify DeerFlow model catalog exposes ONLY deepseek-flash
  const catalogRes = await fetch(`${providerEnv.V2_PROVIDER_GATEWAY_URL}/api/models`, {
    headers: { "X-DeerFlow-Internal-Token": providerEnv.V2_PROVIDER_TOKEN },
  });
  assert.equal(catalogRes.status, 200);
  const catalog = await catalogRes.json();
  const catalogNames = catalog.models.map((m) => m.name);
  assert.deepEqual(
    catalogNames,
    ["deepseek-flash"],
    "DeerFlow test provider must expose only deepseek-flash",
  );
  evidence.checks.providerExposesOnlyFlash = true;
  }

  const envBase = {
    ...process.env,
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    NO_COLOR: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    WORKBENCH_DATABASE_URL: dbUrl,
  };
  for (const key of Object.keys(envBase)) {
    if (
      /^(DEERFLOW_|OPENAI_|WORKBENCH_|BETTER_AUTH_)/.test(key) &&
      key !== "WORKBENCH_DATABASE_URL"
    ) {
      delete envBase[key];
    }
  }

  step("Provision a dedicated PostgreSQL database with every fixed-backend migration");
  await sql(`CREATE DATABASE "${dbName}"`);
  // The deployment file includes psql client directives; pg accepts SQL only.
  const extensionSql = (await readFile(path.join(serviceRoot, "deploy/workbench-postgres-extensions.sql"), "utf8")).split("\n").filter(line => !line.trimStart().startsWith("\\")).join("\n");
  await sql(extensionSql, [], dbUrl);
  await runCmd(
    "migrations",
    ["scripts/deploy-workbench-migrations.mjs"],
    serviceRoot,
    envBase,
  );
  await runCmd(
    "queues",
    ["scripts/reconcile-workbench-runtime-queues.mjs"],
    serviceRoot,
    envBase,
  );
  const migCount = await sql(
    "SELECT count(*)::int AS c FROM workbench._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    [],
    dbUrl,
  );
  const migrations = (await readdir(path.join(serviceRoot, "packages/workbench-db/prisma/migrations"), { withFileTypes: true })).filter(item => item.isDirectory()).length;
  assert.equal(migCount.rows[0].c, migrations, "Apply every migration from the fixed backend");
  evidence.checks.migrationsApplied = migrations;

  let knowledge = { environment: {} };
  if (generates) {
  step("Seed real knowledge release with live TEI embedding and BGE reranker");
  process.env.V2_INFERENCE_ENV_FILE = inferenceEnvFile;
  knowledge = await startLiveKnowledgeFixture({ serviceRoot, publishedPath });
  await knowledge.seed(dbUrl);
  evidence.checks.liveKnowledgeConformance = knowledge.state.conformance;
  evidence.knowledgeSource = knowledge.state.source;
  }

  const [
    apiPort,
    webPort,
    webBackendPort,
    temporalPort,
    s3TlsPort,
    previewPort,
    previewTlsPort,
  ] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const apiTlsPort = generates ? Number(providerEnv.V2_CAPABILITY_TLS_PORT) : await freePort();
  assert.ok(apiTlsPort > 0 && apiTlsPort < 65536, "Provider callback port is required");
  const capabilityBase = `https://127.0.0.1:${apiTlsPort}/api/v1`;
  const webOrigin = `https://127.0.0.1:${webPort}`;
  const apiBase = `http://127.0.0.1:${apiPort}/api/v1`;
  const previewOrigin = `https://127.0.0.1:${previewTlsPort}`;
  const s3Endpoint = s3Env.V2_S3_ENDPOINT;
  const s3Port = Number(new URL(s3Endpoint).port);
  const bucket = `studio-live-${runId}`;

  const s3 = new S3Client({
    endpoint: s3Endpoint,
    region: s3Env.V2_S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3Env.V2_S3_ACCESS_KEY_ID,
      secretAccessKey: s3Env.V2_S3_SECRET_ACCESS_KEY,
    },
  });
  if (phase !== "access") {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    externalStorage = { client: s3, bucket };
  } else s3.destroy();

  await localTls.proxy({
    port: webPort,
    upstreamPort: webBackendPort,
    publicOrigin: webOrigin,
  });
  await localTls.proxy({
    port: apiTlsPort,
    upstreamPort: apiPort,
    publicOrigin: `https://127.0.0.1:${apiTlsPort}`,
  });
  await localTls.proxy({
    port: s3TlsPort,
    upstreamPort: s3Port,
    publicOrigin: `https://127.0.0.1:${s3TlsPort}`,
    listenHost: "127.0.0.1",
  });
  await localTls.proxy({
    port: previewTlsPort,
    upstreamPort: previewPort,
    publicOrigin: previewOrigin,
  });

  const secret = randomBytes(32).toString("base64url");
  const common = {
    ...envBase,
    ...knowledge.environment,
    NODE_ENV: "test",
    NODE_EXTRA_CA_CERTS: localTls.caPath,
    ...(phase === "delivery" && { WORKBENCH_KNOWLEDGE_TOOL_SECRET: secret }),
    WORKBENCH_WEB_ORIGIN: webOrigin,
    WORKBENCH_S3_BUCKET: bucket,
    WORKBENCH_S3_REGION: s3Env.V2_S3_REGION || "us-east-1",
    WORKBENCH_S3_INTERNAL_ENDPOINT: s3Endpoint,
    WORKBENCH_S3_INTERNAL_FORCE_PATH_STYLE: "true",
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: `https://127.0.0.1:${s3TlsPort}/${bucket}`,
    WORKBENCH_PREVIEW_ORIGIN: previewOrigin,
    WORKBENCH_PREVIEW_TOKEN_SECRET: secret,
    WORKBENCH_INVITATION_TOKEN_SECRET: secret,
    WORKBENCH_CANVAS_TOOL_SECRET: secret,
    WORKBENCH_CANVAS_TOOL_MAX_TTL_SECONDS: "900",
    WORKBENCH_KNOWLEDGE_TOOL_URL: `${capabilityBase}/runtime/knowledge/retrieve`,
    WORKBENCH_CANVAS_TOOL_URL: `${capabilityBase}/runtime/canvas/tools/execute`,
    WORKBENCH_CANVAS_VISUAL_URL: `${capabilityBase}/runtime/canvas/visuals`,
    WORKBENCH_EXPORT_CHROMIUM_PATH: chromiumPath,
    WORKBENCH_PROTOTYPE_ARTIFACT_S3_BUCKET: bucket,
    WORKBENCH_PROTOTYPE_ARTIFACT_S3_PREFIX: "studio-live",
    WORKBENCH_TEMPORAL_ADDRESS: phase === "files" ? `127.0.0.1:${temporalPort}` : requiredEnv("WORKBENCH_STUDIO_LIVE_TEMPORAL_ADDRESS"),
    WORKBENCH_TEMPORAL_TASK_QUEUE: `studio-live-${runId}`,
    WORKBENCH_TEMPORAL_WORKER_HEALTH_PORT: String(temporalPort),
    WORKBENCH_TEMPORAL_WORKFLOW_START_URL: `http://127.0.0.1:${temporalPort}/workflows/start`,
    WORKBENCH_TEMPORAL_WORKFLOW_CANCEL_URL: `http://127.0.0.1:${temporalPort}/workflows/cancel`,
    WORKBENCH_TEMPORAL_WORKFLOW_EXECUTE_URL: `http://127.0.0.1:${temporalPort}/workflows/execute`,
    WORKBENCH_REQUIREMENTS_BASE_URL: requirementsConfig.baseUrl,
    WORKBENCH_REQUIREMENTS_API_KEY: requirementsConfig.apiKey,
    WORKBENCH_REQUIREMENTS_MODEL: "deepseek-flash",
    DEERFLOW_LANGGRAPH_URL: providerEnv.V2_PROVIDER_URL,
    DEERFLOW_GATEWAY_URL: providerEnv.V2_PROVIDER_GATEWAY_URL,
    DEERFLOW_INTERNAL_AUTH_TOKEN: providerEnv.V2_PROVIDER_TOKEN,
    DEERFLOW_ASSISTANT_ID: "lead_agent",
    DEERFLOW_PROTOTYPE_MODEL_ID: "deepseek-flash",
    DEERFLOW_TIMEOUT_MS: "600000",
    DEERFLOW_IDLE_TIMEOUT_MS: "120000",
  };
  for (const role of [
    "API_STAGING",
    "API_READY_BLOB",
    "API_CANVAS_VISUAL",
    "RUNTIME_READY_BLOB",
    "PROTOTYPE_ARTIFACT",
    "EXPORT",
    "PREVIEW",
  ]) {
    common[`WORKBENCH_${role}_S3_ACCESS_KEY_ID`] = s3Env.V2_S3_ACCESS_KEY_ID;
    common[`WORKBENCH_${role}_S3_SECRET_ACCESS_KEY`] =
      s3Env.V2_S3_SECRET_ACCESS_KEY;
  }

  step(generates ? "Start API, Temporal V3 Worker (deepseek-flash), and Preview service" : "Start real API and Preview without model workers");
  startService(
    "api",
    [path.join(serviceRoot, "apps/workbench-api/dist/main.js")],
    {
      ...common,
      WORKBENCH_API_HOST: "127.0.0.1",
      WORKBENCH_API_PORT: String(apiPort),
      WORKBENCH_AUTH_MODE: "oidc",
      OIDC_ISSUER: webOrigin,
      OIDC_AUDIENCE: "workbench",
      OIDC_JWKS_URL: `${webOrigin}/api/auth/jwks`,
    },
    outDir,
  );
  if (needsTemporal) startService(
    "temporal",
    [path.join(serviceRoot, "apps/workbench-worker/dist/prototypes/temporal-worker-main.js")],
    common,
    outDir,
  );
  startService(
    "preview",
    [path.join(serviceRoot, "apps/workbench-preview/dist/main.js")],
    {
      ...common,
      WORKBENCH_PREVIEW_HOST: "127.0.0.1",
      WORKBENCH_PREVIEW_PORT: String(previewPort),
    },
    outDir,
  );
  if (generates) {
    startService("runtime-worker", [path.join(serviceRoot, "apps/workbench-worker/dist/main.js")], common, serviceRoot);
  }
  if (needsTemporal) {
    const office = process.env.WORKBENCH_STUDIO_LIVE_OFFICE_BIN;
    const python = process.env.WORKBENCH_EXPORT_PYTHON_PATH;
    startService("export-worker", [path.join(serviceRoot, "apps/workbench-export-worker/dist/main.js")], {
      ...common,
      ...(office && { WORKBENCH_SOFFICE_PATH: office }),
      ...(python && { WORKBENCH_EXPORT_PYTHON_PATH: python }),
    }, serviceRoot);
  }
  if (phase === "files" || activityContract) {
    const fileConfig = parseEnvFile(await readFile(requiredEnv("V2_FILE_PIPELINE_ENV_FILE"), "utf8"));
    assert.equal(fileConfig.WORKBENCH_FILE_SCAN_MODE, "clamav");
    const fileEnvironment = {
      ...fileConfig, ...common,
      WORKBENCH_FILE_PIPELINE_S3_ACCESS_KEY_ID: s3Env.V2_S3_ACCESS_KEY_ID,
      WORKBENCH_FILE_PIPELINE_S3_SECRET_ACCESS_KEY: s3Env.V2_S3_SECRET_ACCESS_KEY,
    };
    if (activityContract) await runCmd(
      "contract-file-preflight",
      [path.join(serviceRoot, "apps/workbench-file-worker/dist/healthcheck.js")],
      serviceRoot,
      fileEnvironment,
    );
    const fileWorker = startService("file-worker", [path.join(serviceRoot, "apps/workbench-file-worker/dist/main.js")], fileEnvironment, serviceRoot);
    if (activityContract) {
      evidence.checks.activityContractFileWorkerReady = await waitUntil(async () => {
        if (fileWorker.exitCode !== null || fileWorker.signalCode !== null)
          throw Object.assign(new Error("Contract file worker exited before opening its queues"), { fatal: true });
        const log = await readFile(path.join(outDir, "service-file-worker.log"), "utf8");
        return /\[file-worker\] listening .* with clamav scanner/u.test(log);
      }, "Isolated contract file worker queues and ClamAV", 45000);
    }
  }
  await health(`${apiBase}/system/live`);
  if (needsTemporal) await health(`http://127.0.0.1:${temporalPort}/healthz`);
  await health(`http://127.0.0.1:${previewPort}/healthz`);

  step("Build and start new Studio Next.js production bundle");
  nextEnvBackup = await readFile(path.join(root, "apps/web/next-env.d.ts"));
  const distName = `.next-e2e/studio-live-${runId}`;
  webDist = path.join(root, "apps/web", distName);
  const webEnv = {
    ...common,
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=4096",
    WORKBENCH_TYPES_PREVALIDATED: "1",
    WORKBENCH_NEXT_BUILD_CPUS: "2",
    WORKBENCH_NEXT_DIST_DIR: distName,
    BETTER_AUTH_URL: webOrigin,
    BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
    WORKBENCH_DATABASE_SCHEMA: "workbench",
    WORKBENCH_AUTH_CLIENT_IP_HEADER: "x-workbench-client-ip",
    WORKBENCH_PUBLIC_REGISTRATION_ENABLED: "true",
    ...(checkAccess && { WORKBENCH_AUTH_SMTP_URL: smtpUrl.href, WORKBENCH_AUTH_MAIL_FROM: "studio@example.test" }),
    WORKBENCH_API_INTERNAL_URL: apiBase,
  };
  await runCmd(
    "next-build",
    ["../../node_modules/next/dist/bin/next", "build", "--webpack"],
    path.join(root, "apps/web"),
    webEnv,
  );
  startService(
    "next",
    [
      "../../node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(webBackendPort),
    ],
    webEnv,
    path.join(root, "apps/web"),
  );
  await health(`${webOrigin}/login`);
  if (generates) await health(`${apiBase}/system/ready`);
  else if (phase === "access") evidence.generationReadiness = "Not asserted in account/permission phase; external model, retrieval and storage remain unavailable.";

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: [`--ignore-certificate-errors-spki-list=${localTls.spkiPin}`],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  page.on("pageerror", (e) =>
    evidence.failures.push({ type: "pageerror", message: e.message }),
  );
  page.on("request", (req) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method()) || !req.postData()) return;
    let body; try { body = req.postDataJSON(); } catch { return; }
    const inspect = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, field] of Object.entries(value)) {
        if (["model", "modelId"].includes(key) && field !== "deepseek-flash") evidence.forbiddenModelAttempted = true;
        else if (typeof field === "object") inspect(field);
      }
    }; inspect(body);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      evidence.networkErrors.push({
        status: res.status(),
        path: new URL(res.url()).pathname,
      });
    }
  });

  if (phase === "generation" || phase === "joint") await runStudioLiveScenarios({ page, browser, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence, step, runCmd, jointOnly: phase === "joint", activityContract });
  if (phase === "prd") {
    const { runStudioPrd } = await import("./studio-live-prd-scenarios.mjs");
    await runStudioPrd({ page, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence, step, activityContract });
  }
  if (phase === "stop") {
    const { runStudioLiveStopScenarios } = await import("./studio-live-stop-scenarios.mjs");
    const providerRunStatus = async (attempt) => {
      const route = "/threads/" + encodeURIComponent(attempt.external_thread_id) + "/runs/" + encodeURIComponent(attempt.external_run_id);
      const response = await fetch(providerEnv.V2_PROVIDER_URL.replace(/\/$/, "") + route, {
        headers: { "X-DeerFlow-Internal-Token": providerEnv.V2_PROVIDER_TOKEN, "X-DeerFlow-Owner-User-Id": attempt.owner_id },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200, "Read actual DeerFlow Run status");
      return (await response.json()).status;
    };
    await runStudioLiveStopScenarios({ page, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence, step, temporalAddress: common.WORKBENCH_TEMPORAL_ADDRESS, providerRunStatus });
  }
  if (phase === "delivery") {
    const { runStudioDeliveryFixture } = await import("./studio-live-delivery-scenarios.mjs");
    await runStudioDeliveryFixture({ page, browser, webOrigin, previewOrigin, outDir, runId, dbUrl, waitUntil, evidence, step, s3, bucket, chromiumPath, runCmd });
  }
  if (phase === "files") await runStudioLiveFileScenarios({ page, browser, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence, step, s3, bucket });
  if (checkAccess) {
    const accessEvidence = phase === "access" ? evidence : { checks: {} };
    const accessPage = phase === "access" ? page : await browser.newPage();
    try {
      await runStudioLiveAccessScenarios({ page: accessPage, browser, webOrigin, outDir, runId, dbUrl, sql, waitUntil, evidence: accessEvidence, step, mailboxOrigin });
      if (phase === "generation") evidence.access = accessEvidence;
    } finally {
      if (accessPage !== page) await accessPage.close();
    }
  }

  assert.equal(evidence.forbiddenModelAttempted, false);
  assert.deepEqual(evidence.failures, []);
  if (generates) assert.deepEqual(evidence.networkErrors, []);
  else {
    evidence.unavailableGenerationDependencies = evidence.networkErrors.filter(item => item.path === "/api/v1/runtime/models" && item.status === 502);
    assert.deepEqual(evidence.networkErrors.filter(item => !evidence.unavailableGenerationDependencies.includes(item)), []);
  }
  evidence.status = "passed";
  step(phase === "stop" ? "Completed real Flash stop and frozen retry" : phase === "joint" ? "Completed real linked PRD and interactive prototype generation" : phase === "prd" ? "Completed real Studio PRD-only delivery" : phase === "generation" ? "Completed Studio real-stack deepseek-flash acceptance scenario" : phase === "delivery" ? "Completed fixed-source artifact delivery" : phase === "files" ? "Completed real Studio file delivery" : "Completed real local account and permission checks; no generation or storage acceptance");
} catch (error) {
  evidence.status = "failed";
  evidence.failure = error.stack || String(error);
  console.error(error?.name ?? "Error", "Live acceptance failed; inspect local evidence.");
  if (currentPage) {
    const controls = await currentPage.locator("input,form").evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, id: element.id, type: element.getAttribute("type"),
      hiddenAncestor: !!element.closest("[hidden]"), visible: !!element.getClientRects().length,
    }))).catch(() => []);
    await writeFile(path.join(outDir, "failure-controls.json"), JSON.stringify(controls, null, 2));
    await currentPage
      .screenshot({
        path: path.join(outDir, "studio-live-flash-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(outDir, "results.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
  await cleanup();
}
