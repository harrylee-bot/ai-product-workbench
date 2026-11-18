#!/usr/bin/env node
// Structural and optional network preflight for the real Flash acceptance stack.
// It never creates a database, starts a worker, calls a model, or invents a fallback.
import { verifyStudioRuntime } from "../test-support/studio-live-runtime.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outputPath = process.env.WORKBENCH_STUDIO_LIVE_PREFLIGHT_OUTPUT
  ?? path.join(root, "output/audit/1.0.0/studio-live-candidate-preflight.json");
const required = [
  "WORKBENCH_STUDIO_LIVE_SERVICE_ROOT",
  "WORKBENCH_STUDIO_LIVE_BACKEND_COMMIT",
  "WORKBENCH_STUDIO_LIVE_REQUIREMENTS_CONFIG",
  "WORKBENCH_STUDIO_LIVE_PUBLISHED_KNOWLEDGE",
  "V2_PROVIDER_ENV_FILE",
  "V2_INFERENCE_ENV_FILE",
  "V2_S3_ENV_FILE",
];
const missing = required.filter((key) => !process.env[key]);
const report = {
  status: "blocked",
  generatedAt: new Date().toISOString(),
  allowedModel: "deepseek-flash",
  missing,
  candidate: {},
  dependencies: [],
  failures: [],
  networkChecked: process.env.WORKBENCH_LIVE_PREFLIGHT_NETWORK === "1",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseEnvFile(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const at = trimmed.indexOf("=");
    result[trimmed.slice(0, at)] = trimmed.slice(at + 1);
  }
  return result;
}

function endpointSummary(value) {
  try {
    const url = new URL(value);
    return { protocol: url.protocol, hostname: url.hostname, port: url.port || null };
  } catch {
    return { invalid: true };
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function probe(name, value, headers = {}) {
  const summary = endpointSummary(value);
  const result = { name, endpoint: summary };
  if (summary.invalid || process.env.WORKBENCH_LIVE_PREFLIGHT_NETWORK !== "1") {
    result.reachable = null;
    report.dependencies.push(result);
    return;
  }
  try {
    const response = await fetch(value, { headers, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    result.reachable = response.ok;
    result.status = response.status;
  } catch (error) {
    result.reachable = false;
    result.code = error.cause?.code ?? error.code ?? error.name;
  }
  report.dependencies.push(result);
}

try {
  if (missing.length) throw new Error(`Missing required preflight variables: ${missing.join(", ")}`);
  const serviceRoot = path.resolve(process.env.WORKBENCH_STUDIO_LIVE_SERVICE_ROOT);
  const expectedCommit = process.env.WORKBENCH_STUDIO_LIVE_BACKEND_COMMIT;
  const actualCommit = git(serviceRoot, ["rev-parse", "HEAD"]);
  report.candidate.backendCommit = { expected: expectedCommit, actual: actualCommit, matches: actualCommit === expectedCommit };
  const dirtyRuntime = git(serviceRoot, ["status", "--porcelain", "--", "apps/*/src", "packages/*/src", "packages/workbench-db/prisma"]);
  report.candidate.runtimeSourcesClean = dirtyRuntime === "";

  const frontendOpenApi = await readFile(path.join(root, "packages/workbench-contracts/openapi/workbench.v1.yaml"));
  const backendOpenApi = await readFile(path.join(serviceRoot, "packages/workbench-contracts/openapi/workbench.v1.yaml"));
  report.candidate.sharedOpenApiSha256 = sha256(frontendOpenApi);
  report.candidate.backendOpenApiSha256 = sha256(backendOpenApi);
  report.candidate.sharedOpenApiMatches = report.candidate.sharedOpenApiSha256 === report.candidate.backendOpenApiSha256;

  const dockerfile = await readFile(path.join(serviceRoot, "integrations/deerflow/Dockerfile"), "utf8");
  const patchPath = dockerfile.match(/^COPY (integrations\/deerflow\/source-patches\/[a-f0-9]+)\//m)?.[1];
  if (!patchPath) throw new Error("Fixed DeerFlow Dockerfile does not select a source patch manifest");
  report.candidate.runtimePatchPath = patchPath;
  report.candidate.runtimeSourceManifestSha256 = sha256(await readFile(path.join(serviceRoot, patchPath, "manifest.json")));

  const requirements = JSON.parse(await readFile(process.env.WORKBENCH_STUDIO_LIVE_REQUIREMENTS_CONFIG, "utf8"));
  report.candidate.requirementsModel = requirements.model;
  report.candidate.modelAllowed = requirements.model === "deepseek-flash" || requirements.model === "deepseek-4.1-flash";
  const provider = parseEnvFile(await readFile(process.env.V2_PROVIDER_ENV_FILE, "utf8"));
  const inference = parseEnvFile(await readFile(process.env.V2_INFERENCE_ENV_FILE, "utf8"));
  const s3 = parseEnvFile(await readFile(process.env.V2_S3_ENV_FILE, "utf8"));
  report.candidate.providerModel = provider.V2_PROVIDER_MODEL_ID;
  report.candidate.providerModelAllowed = provider.V2_PROVIDER_MODEL_ID === "deepseek-flash";
  report.candidate.runtimeProof = process.env.WORKBENCH_STUDIO_LIVE_RUNTIME_PROOF
    ? await verifyStudioRuntime(serviceRoot, expectedCommit, process.env.WORKBENCH_STUDIO_LIVE_RUNTIME_PROOF)
    : { pathProvided: false };

  const published = JSON.parse(await readFile(process.env.WORKBENCH_STUDIO_LIVE_PUBLISHED_KNOWLEDGE, "utf8"));
  report.candidate.knowledge = {
    releaseIdPresent: Boolean(published.release?.id),
    chunkCount: Array.isArray(published.chunks) ? published.chunks.length : 0,
    sourcePathCount: new Set((published.chunks ?? []).map((chunk) => chunk.source_path)).size,
  };
  await probe("provider", provider.V2_PROVIDER_GATEWAY_URL + "/api/models", { "X-DeerFlow-Internal-Token": provider.V2_PROVIDER_TOKEN });
  await probe("embedding", inference.V2_INFERENCE_EMBEDDING_URL + "/info", { authorization: `Bearer ${inference.V2_INFERENCE_TOKEN}` });
  await probe("reranker", inference.V2_INFERENCE_RERANKER_URL + "/info", { authorization: `Bearer ${inference.V2_RERANKER_TOKEN ?? inference.V2_INFERENCE_TOKEN}` });
  await probe("object-storage", new URL("/minio/health/ready", s3.V2_S3_ENDPOINT).href);
  const structural = report.candidate.backendCommit.matches
    && report.candidate.runtimeSourcesClean
    && report.candidate.sharedOpenApiMatches
    && report.candidate.modelAllowed
    && report.candidate.providerModelAllowed
    && report.candidate.knowledge.releaseIdPresent
    && report.candidate.knowledge.chunkCount > 0
    && report.candidate.runtimeProof.verifiedFiles > 0;
  const unreachable = report.dependencies.filter((dependency) => dependency.reachable === false).map((dependency) => dependency.name);
  report.status = structural && report.networkChecked && unreachable.length === 0 ? "ready" : "blocked";
  if (!structural) report.failures.push("Candidate identity, Flash-only model, knowledge release, or runtime deployment proof is incomplete");
  if (unreachable.length) report.failures.push(`Live dependencies unavailable: ${unreachable.join(", ")}`);
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
}
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, outputPath, failures: report.failures, candidate: report.candidate, dependencies: report.dependencies }, null, 2));
process.exitCode = report.status === "ready" ? 0 : 2;
