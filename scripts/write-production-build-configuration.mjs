#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const ID_PATTERN = /^[a-z0-9-]+$/u;
const PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ARGUMENT_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SECRET_ARGUMENT_PATTERN = /(?:API_KEY|ACCESS_KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/u;
const OPTIONAL_EMPTY_ARGUMENTS = new Set([
  "NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL",
  "NEXT_PUBLIC_WORKBENCH_FORUM_URL",
  "NEXT_PUBLIC_WORKBENCH_PRIVACY_URL",
]);
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
];

export function createProductionBuildConfiguration({
  id,
  sourceCommit,
  dockerfile,
  target,
  buildArgsSource = "",
}) {
  assert(ID_PATTERN.test(id ?? ""), "image id is invalid");
  assert(COMMIT_PATTERN.test(sourceCommit ?? ""), "source commit must be a 40-character lowercase Git SHA");
  assert(PATH_PATTERN.test(dockerfile ?? "") && !dockerfile.includes(".."), "Dockerfile path is invalid");
  assert(TARGET_PATTERN.test(target ?? ""), "Docker target is invalid");
  const payload = {
    schemaVersion: "workbench.production-build-configuration.v1",
    id,
    sourceCommit,
    dockerfile,
    target,
    buildArgs: parseBuildArguments(buildArgsSource),
  };
  return {
    ...payload,
    payloadSha256: sha256(canonicalJson(payload)),
  };
}

export function verifyProductionBuildConfiguration(configuration, expected = {}) {
  assert(configuration && typeof configuration === "object" && !Array.isArray(configuration), "build configuration is required");
  const keys = Object.keys(configuration).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify([
      "buildArgs",
      "dockerfile",
      "id",
      "payloadSha256",
      "schemaVersion",
      "sourceCommit",
      "target",
    ]),
    "build configuration fields are invalid",
  );
  const recreated = createProductionBuildConfiguration({
    id: configuration.id,
    sourceCommit: configuration.sourceCommit,
    dockerfile: configuration.dockerfile,
    target: configuration.target,
    buildArgsSource: Object.entries(configuration.buildArgs ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  });
  assert(SHA256_PATTERN.test(configuration.payloadSha256 ?? ""), "build configuration SHA-256 is invalid");
  assert(configuration.payloadSha256 === recreated.payloadSha256, "build configuration SHA-256 mismatch");
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined) assert(configuration[field] === value, `build configuration ${field} mismatch`);
  }
  return true;
}

function parseBuildArguments(source) {
  assert(typeof source === "string", "build args must be a string");
  const entries = [];
  const seen = new Set();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    assert(separator > 0, `invalid build argument line: ${line}`);
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    assert(ARGUMENT_PATTERN.test(name), `invalid build argument name: ${name}`);
    assert(!SECRET_ARGUMENT_PATTERN.test(name), `secret-like build argument is forbidden: ${name}`);
    assert(!seen.has(name), `duplicate build argument: ${name}`);
    assert(value.length > 0 || OPTIONAL_EMPTY_ARGUMENTS.has(name), `build argument ${name} must not be empty`);
    assert(!value.includes("\0") && !value.includes("\n") && !value.includes("\r"), `build argument ${name} is invalid`);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      assert(!pattern.test(value), `build argument ${name} contains credential-like data`);
    }
    seen.add(name);
    entries.push([name, value]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const result = {};
  const options = new Map([
    ["--id", "id"],
    ["--source-commit", "sourceCommit"],
    ["--dockerfile", "dockerfile"],
    ["--target", "target"],
    ["--build-args-env", "buildArgsEnv"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const property = options.get(argv[index]);
    assert(property, `unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    assert(value !== undefined, `${argv[index - 1]} requires a value`);
    result[property] = value;
  }
  for (const property of ["id", "sourceCommit", "dockerfile", "target", "buildArgsEnv"]) {
    assert(result[property], `--${property.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  assert(/^[A-Z][A-Z0-9_]*$/u.test(result.buildArgsEnv), "build args environment variable name is invalid");
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const configuration = createProductionBuildConfiguration({
    ...args,
    buildArgsSource: process.env[args.buildArgsEnv] ?? "",
  });
  process.stdout.write(`${JSON.stringify(configuration, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`production build configuration: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
