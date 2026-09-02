#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

export function deepMerge(base, overrides) {
  const result = structuredClone(base);

  function merge(target, patch, parts) {
    for (const [key, value] of Object.entries(patch)) {
      const nextParts = [...parts, key];
      if (isObject(value)) {
        if (!isObject(target[key])) {
          target[key] = {};
        }
        merge(target[key], value, nextParts);
      } else if (typeof value === "string") {
        target[key] = value;
      } else {
        throw new Error(`Locale override must be a string at ${formatPath(nextParts)}`);
      }
    }
  }

  merge(result, overrides, []);
  return result;
}

export function findMissingLeaves(source, locale) {
  const missing = [];

  function visit(sourceNode, localeNode, parts) {
    for (const [key, sourceValue] of Object.entries(sourceNode)) {
      const nextParts = [...parts, key];
      if (isObject(sourceValue)) {
        visit(sourceValue, hasOwn(localeNode, key) ? localeNode[key] : undefined, nextParts);
      } else if (
        !hasOwn(localeNode, key) ||
        typeof localeNode[key] !== "string" ||
        localeNode[key].trim() === ""
      ) {
        missing.push(nextParts);
      }
    }
  }

  visit(source, locale, []);
  return missing;
}

function findUnknownLeaves(source, overrides) {
  const unknown = [];

  function visit(sourceNode, overrideNode, parts) {
    for (const [key, overrideValue] of Object.entries(overrideNode)) {
      const nextParts = [...parts, key];
      if (!hasOwn(sourceNode, key)) {
        unknown.push(nextParts);
      } else if (isObject(overrideValue)) {
        if (!isObject(sourceNode[key])) {
          unknown.push(nextParts);
        } else {
          visit(sourceNode[key], overrideValue, nextParts);
        }
      } else if (typeof sourceNode[key] !== "string") {
        unknown.push(nextParts);
      }
    }
  }

  visit(source, overrides, []);
  return unknown;
}

function collectProtectedTokens(value) {
  const patterns = [
    /{{[^{}]+}}/g,
    /\$\{[^{}]+}/g,
    /%(?:\d+\$)?[a-zA-Z]/g,
    /`[^`]+`/g,
    /(?<=\])\([^\n)]*\)/g,
    /https?:\/\/[^\s)>]+/g,
    /<\/?[A-Za-z][^>]*>/g,
  ];
  return patterns
    .flatMap((pattern) => value.match(pattern) ?? [])
    .sort();
}

function getLeaf(object, parts) {
  let value = object;
  for (const part of parts) {
    value = value?.[part];
  }
  return value;
}

function collectOverrideLeaves(overrides) {
  const leaves = [];

  function visit(node, parts) {
    for (const [key, value] of Object.entries(node)) {
      const nextParts = [...parts, key];
      if (isObject(value)) {
        visit(value, nextParts);
      } else {
        leaves.push(nextParts);
      }
    }
  }

  visit(overrides, []);
  return leaves;
}

export function validateLocale(source, locale, overrides = {}) {
  const errors = [];
  const missing = findMissingLeaves(source, locale);
  if (missing.length > 0) {
    errors.push(
      `Locale is missing ${missing.length} source entries:\n${missing
        .slice(0, 20)
        .map(formatPath)
        .join("\n")}`,
    );
  }

  const unknown = findUnknownLeaves(source, overrides);
  if (unknown.length > 0) {
    errors.push(
      `Overrides contain ${unknown.length} entries that are not in the English locale:\n${unknown
        .slice(0, 20)
        .map(formatPath)
        .join("\n")}`,
    );
  }

  for (const parts of collectOverrideLeaves(overrides)) {
    const sourceValue = getLeaf(source, parts);
    const translatedValue = getLeaf(overrides, parts);
    if (typeof translatedValue !== "string" || translatedValue.trim() === "") {
      errors.push(`Override is empty at ${formatPath(parts)}`);
      continue;
    }
    const expectedTokens = collectProtectedTokens(sourceValue);
    const actualTokens = collectProtectedTokens(translatedValue);
    if (JSON.stringify(expectedTokens) !== JSON.stringify(actualTokens)) {
      errors.push(
        `Protected tokens changed at ${formatPath(parts)}\n` +
          `expected: ${JSON.stringify(expectedTokens)}\n` +
          `actual:   ${JSON.stringify(actualTokens)}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n\n"));
  }
}

function formatPath(parts) {
  return parts.map((part) => JSON.stringify(part)).join(" > ");
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function applyOverrides([englishPath, basePath, overridesPath, outputPath]) {
  if (!outputPath) {
    throw new Error(
      "usage: node deploy/grist-locales.mjs apply ENGLISH BASE OVERRIDES OUTPUT",
    );
  }

  const [source, base, overrides] = await Promise.all([
    readJson(englishPath),
    readJson(basePath),
    readJson(overridesPath),
  ]);
  const merged = deepMerge(base, overrides);
  validateLocale(source, merged, overrides);

  const tempPath = `${outputPath}.tmp`;
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await fs.writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, outputPath);
  process.stdout.write(
    `Wrote complete Simplified Chinese locale (${collectOverrideLeaves(overrides).length} overrides) to ${outputPath}\n`,
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [, , command, ...args] = process.argv;
  if (command !== "apply") {
    throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  }
  await applyOverrides(args);
}

