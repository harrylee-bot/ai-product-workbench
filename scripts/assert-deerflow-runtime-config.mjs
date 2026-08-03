#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";

import YAML from "yaml";

import {
  WORKBENCH_RUNTIME_TOOLS,
  WORKBENCH_TOOL_GROUP,
} from "./deerflow-workbench-tool-contract.mjs";
import { readDeploymentEnv } from "./workbench-origin-manifest.mjs";

const PRD_REFERENCE_READER_TOOL = Object.freeze({
  name: "read_file",
  group: "workbench",
  use: "deerflow_workbench_tools.prd_reference_tool:workbench_prd_reference_read",
});

try {
  const configPath = argumentValue("--config");
  const providerEnvPath = argumentValue("--provider-env");
  const config = readConfig(configPath);
  const providerEnv = readProviderEnv(providerEnvPath);
  const databaseBackend = validateConfig(config, providerEnv);
  console.log(JSON.stringify({
    status: "valid",
    configSha256: sha256(readFileSync(configPath)),
    model: providerEnv.WORKBENCH_DEERFLOW_PROVIDER_MODEL,
    databaseBackend,
    workbenchToolCount: config.tools.length,
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deerflow-runtime-config] ${message}`);
  process.exitCode = 1;
}

function readConfig(configPath) {
  requireArgument(configPath, "--config");
  const stat = lstatSync(configPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), "config must be a regular file");
  assert((stat.mode & 0o777) === 0o600, "effective config must have mode 0600");
  const document = YAML.parseDocument(readFileSync(configPath, "utf8"), {
    strict: true,
    uniqueKeys: true,
    prettyErrors: true,
  });
  assert(document.errors.length === 0, `config YAML is invalid: ${document.errors[0]?.message || "unknown error"}`);
  const config = document.toJS({ maxAliasCount: 100 });
  assert(isPlainObject(config), "config root must be an object");
  return config;
}

function readProviderEnv(providerEnvPath) {
  requireArgument(providerEnvPath, "--provider-env");
  const stat = lstatSync(providerEnvPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), "provider environment must be a regular file");
  const values = Object.fromEntries(readDeploymentEnv(readFileSync(providerEnvPath), {
    label: "DeerFlow provider environment",
  }));
  for (const key of ["OPENAI_API_KEY", "WORKBENCH_DEERFLOW_PROVIDER_BASE_URL", "WORKBENCH_DEERFLOW_PROVIDER_MODEL"]) {
    assert(typeof values[key] === "string" && values[key].length > 0, `${key} is required in provider environment`);
  }
  const providerUrl = new URL(values.WORKBENCH_DEERFLOW_PROVIDER_BASE_URL);
  assert(providerUrl.protocol === "https:", "provider base URL must use HTTPS");
  assert(!providerUrl.username && !providerUrl.password && !providerUrl.search && !providerUrl.hash, "provider base URL must not contain credentials, query, or fragment");
  return values;
}

function validateConfig(config, providerEnv) {
  assert(Number.isInteger(config.config_version) && config.config_version >= 1, "config_version must be a positive integer");
  assert(Array.isArray(config.models) && config.models.length > 0, "config must define at least one model");
  const modelName = providerEnv.WORKBENCH_DEERFLOW_PROVIDER_MODEL;
  const matchingModels = config.models.filter((model) => model?.name === modelName);
  assert(matchingModels.length === 1, `config must define exactly one model named ${modelName}`);
  const model = matchingModels[0];
  assert(model.model === modelName, "configured model name and API model must match the provider contract");
  assert(model.use === "langchain_openai:ChatOpenAI", "the configured provider must use langchain_openai:ChatOpenAI");
  assert(model.api_key === "$OPENAI_API_KEY", "model api_key must reference OPENAI_API_KEY without embedding a secret");
  assert(model.base_url === "$WORKBENCH_DEERFLOW_PROVIDER_BASE_URL", "model base_url must reference the approved provider environment value");

  const databaseBackend = validateDatabase(config.database, providerEnv);

  assert(isPlainObject(config.sandbox), "sandbox configuration is required");
  assert(config.sandbox.use === "deerflow.sandbox.local:LocalSandboxProvider", "sandbox must use the audited local provider");
  assert(config.sandbox.allow_host_bash === false, "sandbox host bash must remain disabled");

  assert(Array.isArray(config.tool_groups), "tool_groups must be an array");
  assert(Array.isArray(config.tools), "tools must be an array");
  const workbenchGroups = config.tool_groups.filter((group) => group?.name === WORKBENCH_TOOL_GROUP.name);
  assert(workbenchGroups.length === 1 && deepEqual(workbenchGroups[0], WORKBENCH_TOOL_GROUP), "effective config must contain the canonical Workbench tool group");
  const referenceReaders = config.tools.filter((tool) => tool?.name === PRD_REFERENCE_READER_TOOL.name);
  assert(
    referenceReaders.length === 1 && deepEqual(referenceReaders[0], PRD_REFERENCE_READER_TOOL),
    "effective config must contain exactly the canonical read_file tool",
  );
  for (const expectedTool of WORKBENCH_RUNTIME_TOOLS) {
    const matches = config.tools.filter((tool) => tool?.name === expectedTool.name);
    assert(matches.length === 1 && deepEqual(matches[0], expectedTool), `effective config must contain the canonical ${expectedTool.name} tool`);
  }
  assert(
    deepEqual(config.tool_groups, [WORKBENCH_TOOL_GROUP]),
    "effective config tool_groups must exactly equal the canonical Workbench allowlist",
  );
  assert(
    deepEqual(config.tools, WORKBENCH_RUNTIME_TOOLS),
    "effective config tools must exactly equal the canonical Workbench allowlist",
  );
  return databaseBackend;
}

function validateDatabase(database, providerEnv) {
  assert(isPlainObject(database), "database configuration is required");
  assert(database.backend !== "memory", "database.backend=memory is not allowed for production persistence");
  assert(database.backend === "sqlite" || database.backend === "postgres", "database.backend must be sqlite or postgres");

  if (database.backend === "sqlite") {
    validateSqliteDatabase(database);
    return "sqlite";
  }

  validatePostgresDatabase(database, providerEnv);
  return "postgres";
}

function validateSqliteDatabase(database) {
  const sqliteDir = database.sqlite_dir;
  assert(typeof sqliteDir === "string" && sqliteDir.length > 0, "database.sqlite_dir is required for the sqlite backend");
  assert(sqliteDir === sqliteDir.trim(), "database.sqlite_dir must not contain leading or trailing whitespace");
  assert(!sqliteDir.includes("\\"), "database.sqlite_dir must use a POSIX relative path");
  assert(!sqliteDir.startsWith("/") && !/^[A-Za-z]:/u.test(sqliteDir), "database.sqlite_dir must be relative");
  assert(
    !sqliteDir.includes(".."),
    "database.sqlite_dir must remain beneath .deer-flow/ and contain no ..",
  );

  const segments = sqliteDir.split("/");
  assert(
    segments[0] === ".deer-flow"
      && segments.length > 1
      && segments.slice(1).every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "database.sqlite_dir must remain beneath .deer-flow/ and contain no .. path segment",
  );
}

function validatePostgresDatabase(database, providerEnv) {
  const reference = database.postgres_url;
  assert(
    typeof reference === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(reference),
    "database.postgres_url must be an exact environment variable reference",
  );

  const variableName = reference.slice(1);
  assert(
    Object.hasOwn(providerEnv, variableName),
    `database.postgres_url environment variable ${variableName} must be declared in provider environment`,
  );
  const resolved = providerEnv[variableName];
  assert(
    typeof resolved === "string" && resolved.length > 0 && resolved === resolved.trim(),
    `database.postgres_url environment variable ${variableName} is required and must be non-empty`,
  );

  let parsed;
  try {
    parsed = new URL(resolved);
  } catch {
    assert(false, `database.postgres_url environment variable ${variableName} must be a valid PostgreSQL URL`);
  }
  assert(
    parsed.protocol === "postgres:" || parsed.protocol === "postgresql:",
    `database.postgres_url environment variable ${variableName} must use PostgreSQL`,
  );
  assert(
    parsed.hostname,
    `database.postgres_url environment variable ${variableName} must name a PostgreSQL host`,
  );
  assert(
    !parsed.search && !parsed.hash && !/[?#]/u.test(resolved),
    `database.postgres_url environment variable ${variableName} must not contain a query or fragment`,
  );
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireArgument(value, name) {
  assert(typeof value === "string" && value.trim() && !value.startsWith("--"), `${name} is required`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
