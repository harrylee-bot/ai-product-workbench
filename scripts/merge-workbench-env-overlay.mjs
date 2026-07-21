#!/usr/bin/env node

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

export function mergeEnvironmentOverlay(baseSource, overlaySource, options = {}) {
  const base = parseEnvironmentAssignments(baseSource, "base");
  const overlay = parseEnvironmentAssignments(overlaySource, "overlay");
  const allowedNewNames = new Set(options.allowedNewNames ?? []);
  for (const name of allowedNewNames) {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`invalid allowed new name: ${name}`);
  }
  if (overlay.assignments.size === 0) throw new Error("overlay has no assignments");

  const lines = [...base.lines];
  for (const [name, assignment] of overlay.assignments) {
    const target = base.assignments.get(name);
    if (target) lines[target.index] = `${name}=${assignment.value}`;
    else if (allowedNewNames.has(name)) lines.push(`${name}=${assignment.value}`);
    else throw new Error(`${name} does not exist in base environment`);
  }
  return `${lines.join("\n")}${base.endsWithNewline ? "\n" : ""}`;
}

function parseEnvironmentAssignments(source, label) {
  if (typeof source !== "string") throw new Error(`${label} environment must be text`);
  const endsWithNewline = source.endsWith("\n");
  const lines = source.replace(/\n$/u, "").split(/\r?\n/u);
  const assignments = new Map();
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = rawLine.indexOf("=");
    if (separator <= 0) throw new Error(`${label} has an invalid entry at line ${index + 1}`);
    const name = rawLine.slice(0, separator).trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`${label} has an invalid name at line ${index + 1}`);
    }
    if (assignments.has(name)) throw new Error(`${label} contains duplicate ${name}`);
    assignments.set(name, { index, value: rawLine.slice(separator + 1) });
  }
  return { assignments, endsWithNewline, lines };
}

function parseArguments(argv) {
  const result = { allowedNewNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") result.base = argv[++index];
    else if (argument === "--overlay") result.overlay = argv[++index];
    else if (argument === "--output") result.output = argv[++index];
    else if (argument === "--allow-new") result.allowedNewNames.push(argv[++index]);
    else throw new Error(`unsupported argument: ${argument}`);
  }
  for (const name of ["base", "overlay", "output"]) {
    if (!result[name]) throw new Error(`--${name} is required`);
  }
  if (new Set([result.base, result.overlay, result.output].map((path) => resolve(path))).size !== 3) {
    throw new Error("base, overlay, and output paths must be distinct");
  }
  return result;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const merged = mergeEnvironmentOverlay(
    readFileSync(args.base, "utf8"),
    readFileSync(args.overlay, "utf8"),
    { allowedNewNames: args.allowedNewNames },
  );
  writeFileSync(args.output, merged, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(args.output, 0o600);
  process.stdout.write("environment overlay merged; output mode 0600\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`merge workbench environment: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
