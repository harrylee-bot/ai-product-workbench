#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

import {
  WORKBENCH_RUNTIME_TOOLS,
  WORKBENCH_TOOL_GROUP,
} from "./deerflow-workbench-tool-contract.mjs";

const EXPECTED_FRAGMENT_KEYS = ["tool_groups", "tools"];

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

try {
  await main(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[merge-deerflow-config] ${message}`);
  process.exitCode = 1;
}

async function main(options) {
  const basePath = requirePath(options.base, "--base");
  const fragmentPath = requirePath(options.fragment, "--fragment");
  const outputPath = requirePath(options.output, "--output");
  assertDistinctPaths(basePath, fragmentPath, outputPath);

  const [baseText, fragmentText] = await Promise.all([
    readFile(basePath, "utf8"),
    readFile(fragmentPath, "utf8"),
  ]);
  const base = parseYamlObject(baseText, basePath);
  const fragment = parseYamlObject(fragmentText, fragmentPath);
  validateFragment(fragment, fragmentPath);

  const merged = mergeNamedSections(base, fragment);
  const rendered = YAML.stringify(merged, { lineWidth: 0 });
  const sha256 = createHash("sha256").update(rendered).digest("hex");

  if (options.check) {
    await assertCurrentOutput(outputPath, rendered);
    printSummary("current", outputPath, merged, sha256);
    return;
  }

  await atomicWrite(outputPath, rendered);
  printSummary("written", outputPath, merged, sha256);
}

function mergeNamedSections(base, fragment) {
  const result = structuredClone(base);
  result.tool_groups = mergeNamedList(
    normalizeNamedList(base.tool_groups, "base.tool_groups"),
    fragment.tool_groups,
    "tool_groups",
  );
  result.tools = mergeNamedList(
    normalizeNamedList(base.tools, "base.tools"),
    fragment.tools,
    "tools",
  );

  const groupNames = new Set(result.tool_groups.map((group) => group.name));
  for (const tool of result.tools) {
    if (typeof tool.group !== "string" || !groupNames.has(tool.group)) {
      throw new Error(`DEERFLOW_CONFIG_UNKNOWN_TOOL_GROUP:${tool.name}:${String(tool.group)}`);
    }
  }
  return result;
}

function mergeNamedList(baseItems, fragmentItems, section) {
  const result = baseItems.map((item) => structuredClone(item));
  const byName = new Map(result.map((item) => [item.name, item]));
  for (const item of fragmentItems) {
    const existing = byName.get(item.name);
    if (!existing) {
      const cloned = structuredClone(item);
      result.push(cloned);
      byName.set(cloned.name, cloned);
      continue;
    }
    if (!isDeepStrictEqual(existing, item)) {
      throw new Error(`DEERFLOW_CONFIG_NAME_CONFLICT:${section}:${item.name}`);
    }
  }
  return result;
}

function validateFragment(fragment, sourcePath) {
  const keys = Object.keys(fragment).sort();
  if (!isDeepStrictEqual(keys, [...EXPECTED_FRAGMENT_KEYS].sort())) {
    throw new Error(`DEERFLOW_CONFIG_FRAGMENT_KEYS_INVALID:${sourcePath}`);
  }
  const groups = normalizeNamedList(fragment.tool_groups, "fragment.tool_groups");
  const tools = normalizeNamedList(fragment.tools, "fragment.tools");
  if (groups.length !== 1 || !isDeepStrictEqual(groups[0], WORKBENCH_TOOL_GROUP)) {
    throw new Error("DEERFLOW_CONFIG_FRAGMENT_WORKBENCH_GROUP_INVALID");
  }
  if (!isDeepStrictEqual(tools, WORKBENCH_RUNTIME_TOOLS)) {
    throw new Error("DEERFLOW_CONFIG_FRAGMENT_WORKBENCH_TOOL_INVALID");
  }
}

function normalizeNamedList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`DEERFLOW_CONFIG_SECTION_NOT_ARRAY:${label}`);
  const seen = new Set();
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.name !== "string" || item.name.trim() !== item.name || !item.name) {
      throw new Error(`DEERFLOW_CONFIG_NAMED_ENTRY_INVALID:${label}`);
    }
    if (seen.has(item.name)) throw new Error(`DEERFLOW_CONFIG_DUPLICATE_NAME:${label}:${item.name}`);
    seen.add(item.name);
  }
  return value;
}

function parseYamlObject(text, sourcePath) {
  const document = YAML.parseDocument(text, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(`DEERFLOW_CONFIG_YAML_INVALID:${sourcePath}:${document.errors[0].message}`);
  }
  const value = document.toJS({ maxAliasCount: 100 });
  if (!isPlainObject(value)) throw new Error(`DEERFLOW_CONFIG_ROOT_INVALID:${sourcePath}`);
  return value;
}

async function assertCurrentOutput(outputPath, expected) {
  let actual;
  try {
    actual = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`DEERFLOW_EFFECTIVE_CONFIG_MISSING:${outputPath}`);
    }
    throw error;
  }
  if (actual !== expected) throw new Error(`DEERFLOW_EFFECTIVE_CONFIG_STALE:${outputPath}`);
  const metadata = await stat(outputPath);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`DEERFLOW_EFFECTIVE_CONFIG_MODE_INVALID:${outputPath}`);
  }
}

async function atomicWrite(outputPath, content) {
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function assertDistinctPaths(basePath, fragmentPath, outputPath) {
  const resolved = [basePath, fragmentPath, outputPath].map((value) => path.resolve(value));
  if (new Set(resolved).size !== resolved.length) {
    throw new Error("DEERFLOW_CONFIG_INPUT_OUTPUT_PATHS_MUST_DIFFER");
  }
}

function parseArgs(argv) {
  const parsed = { check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--check") parsed.check = true;
    else if (arg.startsWith("--base=")) parsed.base = arg.slice("--base=".length);
    else if (arg === "--base") parsed.base = argv[++index];
    else if (arg.startsWith("--fragment=")) parsed.fragment = arg.slice("--fragment=".length);
    else if (arg === "--fragment") parsed.fragment = argv[++index];
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--output") parsed.output = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requirePath(value, flag) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${flag} is required`);
  return path.resolve(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printSummary(status, outputPath, config, sha256) {
  console.log(JSON.stringify({
    status,
    output: outputPath,
    sha256,
    toolGroupCount: config.tool_groups.length,
    toolCount: config.tools.length,
  }));
}

function printHelp() {
  console.log(`Usage: node scripts/merge-deerflow-config.mjs \\
  --base <deerflow-config.yaml> \\
  --fragment <workbench-config.fragment.yaml> \\
  --output <effective-config.yaml> [--check]

The fragment may contain only the canonical Workbench tool_groups/tools entries.
Entries are merged by name. Equal entries are idempotent; conflicting entries fail.
Without --check the output is atomically replaced with mode 0600. --check performs
an exact content and file-mode comparison without writing.`);
}
