#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_CHECKS = [
  "internalCallerOnly",
  "toolRuntimeDelivery",
  "runKwargsRedacted",
  "checkpointRedacted",
  "eventStreamRedacted",
  "traceRedacted",
];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  await main(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deerflow-secret-attestation] ${message}`);
  process.exitCode = 1;
}

async function main(options) {
  const attestationPath = required(options.attestation, "--attestation");
  const expectedCommit = required(options.commit, "--commit");
  const expectedImageDigest = required(options.imageDigest, "--image-digest");
  assertPattern(expectedCommit, /^[0-9a-f]{40}$/u, "DEERFLOW_COMMIT_PIN_INVALID");
  assertPattern(expectedImageDigest, /^sha256:[0-9a-f]{64}$/u, "DEERFLOW_IMAGE_DIGEST_PIN_INVALID");

  const raw = await readFile(path.resolve(attestationPath), "utf8");
  if (raw.includes("REPLACE_WITH_")) throw new Error("DEERFLOW_SECRET_ATTESTATION_PLACEHOLDER");
  const value = parseJson(raw);
  assertExactKeys(value, ["protocol", "deerflowCommit", "imageDigest", "evidenceSha256", "checks"], "DEERFLOW_SECRET_ATTESTATION_KEYS_INVALID");
  if (value.protocol !== "workbench.deerflow-request-scoped-secrets-attestation.v1") {
    throw new Error("DEERFLOW_SECRET_ATTESTATION_PROTOCOL_INVALID");
  }
  if (value.deerflowCommit !== expectedCommit) throw new Error("DEERFLOW_SECRET_ATTESTATION_COMMIT_MISMATCH");
  if (value.imageDigest !== expectedImageDigest) throw new Error("DEERFLOW_SECRET_ATTESTATION_IMAGE_MISMATCH");
  assertPattern(value.evidenceSha256, /^[0-9a-f]{64}$/u, "DEERFLOW_SECRET_ATTESTATION_EVIDENCE_INVALID");
  assertExactKeys(value.checks, REQUIRED_CHECKS, "DEERFLOW_SECRET_ATTESTATION_CHECKS_INVALID");
  for (const name of REQUIRED_CHECKS) {
    if (value.checks[name] !== true) throw new Error(`DEERFLOW_SECRET_ATTESTATION_CHECK_FAILED:${name}`);
  }

  console.log(JSON.stringify({
    status: "verified",
    deerflowCommit: expectedCommit,
    imageDigest: expectedImageDigest,
    evidenceSha256: value.evidenceSha256,
  }));
}

function parseArgs(argv) {
  const parsed = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg.startsWith("--attestation=")) parsed.attestation = arg.slice("--attestation=".length);
    else if (arg === "--attestation") parsed.attestation = argv[++index];
    else if (arg.startsWith("--commit=")) parsed.commit = arg.slice("--commit=".length);
    else if (arg === "--commit") parsed.commit = argv[++index];
    else if (arg.startsWith("--image-digest=")) parsed.imageDigest = arg.slice("--image-digest=".length);
    else if (arg === "--image-digest") parsed.imageDigest = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function parseJson(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("DEERFLOW_SECRET_ATTESTATION_JSON_INVALID");
  }
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(code);
}

function assertPattern(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(code);
}

function required(value, flag) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${flag} is required`);
  return value.trim();
}

function printHelp() {
  console.log(`Usage: node scripts/assert-deerflow-secret-channel-attestation.mjs \\
  --attestation <release-attestation.json> \\
  --commit <40-char-git-commit> \\
  --image-digest <sha256:image-digest>`);
}
