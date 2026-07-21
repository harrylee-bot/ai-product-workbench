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

try {
  const configPath = argumentValue("--config");
  const providerEnvPath = argumentValue("--provider-env");
  const config = readConfig(configPath);
  const providerEnv = readProviderEnv(providerEnvPath);
  validateConfig(config, providerEnv);
  console.log(JSON.stringify({
    status: "valid",
    configSha256: sha256(readFileSync(configPath)),
    model: providerEnv.WORKBENCH_DEERFLOW_PROVIDER_MODEL,
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
  const values = Object.create(null);
  for (const [index, line] of readFileSync(providerEnvPath, "utf8").split(/\r?\n/u).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    assert(match, `provider environment line ${index + 1} is invalid`);
    assert(!(match[1] in values), `${match[1]} occurs more than once in provider environment`);
    values[match[1]] = match[2];
  }
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

  assert(isPlainObject(config.sandbox), "sandbox configuration is required");
  assert(config.sandbox.use === "deerflow.sandbox.local:LocalSandboxProvider", "sandbox must use the audited local provider");
  assert(config.sandbox.allow_host_bash === false, "sandbox host bash must remain disabled");

  assert(Array.isArray(config.tool_groups), "tool_groups must be an array");
  assert(Array.isArray(config.tools), "tools must be an array");
  const workbenchGroups = config.tool_groups.filter((group) => group?.name === WORKBENCH_TOOL_GROUP.name);
  assert(workbenchGroups.length === 1 && deepEqual(workbenchGroups[0], WORKBENCH_TOOL_GROUP), "effective config must contain the canonical Workbench tool group");
  for (const expectedTool of WORKBENCH_RUNTIME_TOOLS) {
    const matches = config.tools.filter((tool) => tool?.name === expectedTool.name);
    assert(matches.length === 1 && deepEqual(matches[0], expectedTool), `effective config must contain the canonical ${expectedTool.name} tool`);
  }
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
