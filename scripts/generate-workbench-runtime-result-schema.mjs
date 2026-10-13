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
const prdOutputPath = path.join(
  repoRoot,
  "integrations/deerflow/skills/workbench/references/prd-runtime-result.schema.json",
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
const prdNames = dependencyClosure("RuntimeArtifactDraftPrdV2", schemas);
const prdDefinitions = Object.fromEntries(
  [...prdNames]
    .sort()
    .map((name) => [name, rewriteRefs(schemas[name])]),
);
const prdGenerated = `${serializePrdSchema({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "产品工作台 PRD Runtime Result",
  description: "Read x-workbench-authoring-guide: business-neutral transport fragments only; validation constraints are unchanged.",
  "x-workbench-authoring-guide": prdAuthoringGuide(schemas),
  type: "object",
  properties: {
    protocol: {
      type: "string",
      enum: ["workbench.runtime.result.v1"],
    },
    message: {
      type: "string",
      maxLength: 100_000,
    },
    artifacts: {
      type: "array",
      items: { $ref: "#/$defs/RuntimeArtifactDraftPrdV2" },
      minItems: 1,
      maxItems: 1,
    },
  },
  required: ["protocol", "message", "artifacts"],
  additionalProperties: false,
  $defs: prdDefinitions,
})}\n`;

const outputs = [
  { path: outputPath, content: generated, label: "Runtime result schema" },
  { path: prdOutputPath, content: prdGenerated, label: "PRD Runtime result schema" },
];

if (process.argv.includes("--check")) {
  for (const output of outputs) {
    const existing = await readFile(output.path, "utf8").catch(() => "");
    if (existing !== output.content) {
      throw new Error(`${output.label} is stale; run npm run runtime:schema`);
    }
  }
  process.stdout.write("DeerFlow Runtime result schemas are current\n");
} else {
  for (const output of outputs) {
    await writeFile(output.path, output.content);
    process.stdout.write(`Generated ${path.relative(repoRoot, output.path)}\n`);
  }
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

function prdAuthoringGuide(allSchemas) {
  const literal = (schemaName, property) => {
    const values = allSchemas[schemaName]?.properties?.[property]?.enum;
    if (!Array.isArray(values) || values.length !== 1) {
      throw new Error(`Expected one fixed OpenAPI literal: ${schemaName}.${property}`);
    }
    return values[0];
  };
  const text = (value) => ({ type: literal("PrdTextInline", "type"), text: value, marks: [] });
  const paragraph = {
    id: "replace-paragraph-id",
    type: literal("PrdParagraphBlock", "type"),
    content: [text("REPLACE_WITH_TEXT")],
  };
  const bulletList = {
    id: "replace-list-id",
    type: literal("PrdBulletListBlock", "type"),
    items: [
      { id: "replace-item-a", content: [text("REPLACE_WITH_SCOPE_A")] },
      { id: "replace-item-b", content: [text("REPLACE_WITH_SCOPE_B")] },
    ],
  };
  const table = {
    id: "replace-table-id",
    type: literal("PrdTableBlock", "type"),
    columns: [
      { id: "replace-column-a", label: "REPLACE_WITH_LABEL_A" },
      { id: "replace-column-b", label: "REPLACE_WITH_LABEL_B" },
    ],
    rows: [{
      id: "replace-row-id",
      cells: [
        { columnId: "replace-column-a", content: [text("REPLACE_WITH_CELL_A")] },
        { columnId: "replace-column-b", content: [text("REPLACE_WITH_CELL_B")] },
      ],
    }],
  };
  const document = allSchemas.PrdDocumentV2;
  const sectionSchemas = document.properties.sections.properties;
  const introEnum = sectionSchemas.safetyBaseline.properties.intro.enum;
  if (!Array.isArray(introEnum) || introEnum.length !== 1) throw new Error("Expected one fixed safety intro literal");
  return {
    purpose: "STRUCTURE ONLY, not a complete publishable draft. Replace replace-* IDs and REPLACE_WITH_* text from authorized facts; omit this guide. No business facts, citations, channels, degradation or safety decisions are supplied.",
    constructionRules: [
      "blocks contains complete objects, never strings, IDs, schema names, $ref or JSON-encoded objects. Put text in typed inline objects with marks: [].",
      "Scope needs a bulletList/orderedList. Each items entry is {id,content}, without type. Never append item IDs or section names as sibling blocks.",
      "Table rows require typed cells; requirement/goal objects belong in sibling blocks. IDs are unique; columnId references a declared column.",
      "sectionFields lists required fields for four sibling objects under content.sections; none belongs inside introduction. Keep every section during repairs.",
      "Copy fixed schema literals verbatim, including all intro characters. JSON \\n decodes to a real newline; never double-escape. TOC punctuation follows the canonical structure reference.",
      "Replace markers and pass all checks. After rejection, use repair:{baseCandidateChecksum,operations:[{op,path,value?,from?}]} with the latest ACK checksum; add/replace/remove/move only erroneous fields, never artifact identity.",
    ],
    requiredDocumentFields: document.required,
    sectionFields: Object.fromEntries(Object.entries(sectionSchemas).map(([name, schema]) => [name, schema.required])),
    fixedLiterals: { "content.sections.safetyBaseline.intro": introEnum[0] },
    typedBlockFragments: { paragraph, bulletList, table },
  };
}

function serializePrdSchema(schema) {
  // Keep the authoring annotation compact within the fixed reference-read budget.
  return `{
${Object.entries(schema).map(([key, value]) => (
    `  ${JSON.stringify(key)}: ${JSON.stringify(value, null, key === "x-workbench-authoring-guide" ? 0 : 2).replace(/\n/gu, "\n  ")}`
  )).join(",\n")}
}`;
}
