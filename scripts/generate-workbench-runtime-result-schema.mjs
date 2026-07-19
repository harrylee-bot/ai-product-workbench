#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const openApiPath = path.join(
  repoRoot,
  "packages/workbench-contracts/openapi/workbench.v1.yaml",
);
const outputPath = path.join(
  repoRoot,
  "integrations/deerflow/skills/workbench/references/runtime-result.schema.json",
);
const document = YAML.parse(await readFile(openApiPath, "utf8"));
const schemas = document?.components?.schemas;
if (!schemas?.RuntimeResult) throw new Error("OpenAPI does not define RuntimeResult");

const names = dependencyClosure("RuntimeResult", schemas);
const definitions = Object.fromEntries(
  [...names]
    .filter((name) => name !== "RuntimeResult")
    .sort()
    .map((name) => [name, rewriteRefs(schemas[name])]),
);
const generated = `${JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "产品工作台 DeerFlow Runtime Result",
  ...rewriteRefs(schemas.RuntimeResult),
  $defs: definitions,
}, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== generated) {
    throw new Error("Runtime result schema is stale; run npm run runtime:schema");
  }
  process.stdout.write("DeerFlow Runtime result schema is current\n");
} else {
  await writeFile(outputPath, generated);
  process.stdout.write(`Generated ${path.relative(repoRoot, outputPath)}\n`);
}

function dependencyClosure(rootName, allSchemas) {
  const found = new Set();
  const pending = [rootName];
  while (pending.length > 0) {
    const name = pending.shift();
    if (found.has(name)) continue;
    if (!allSchemas[name]) throw new Error(`Missing referenced OpenAPI schema ${name}`);
    found.add(name);
    for (const reference of schemaReferences(allSchemas[name])) {
      if (!found.has(reference)) pending.push(reference);
    }
  }
  return found;
}

function schemaReferences(value) {
  const references = new Set();
  visit(value);
  return references;

  function visit(candidate) {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    if (typeof candidate.$ref === "string") {
      const match = candidate.$ref.match(/^#\/components\/schemas\/(.+)$/);
      if (match) references.add(match[1]);
    }
    Object.values(candidate).forEach(visit);
  }
}

function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => (
    key === "$ref" && typeof child === "string"
      ? [key, child.replace(/^#\/components\/schemas\//, "#/$defs/")]
      : [key, rewriteRefs(child)]
  )));
}
