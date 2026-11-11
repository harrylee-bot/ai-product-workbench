import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prdDocumentV2Example, prdDocumentV3Example } from "../packages/workbench-contracts/src/prd-example.js";
import { sourceCitations } from "../packages/workbench-contracts/test/knowledge-citation.fixture.js";

// Retain the v2 fixture for explicit legacy/causal-history regression coverage.
// New authoring and v3-focused tests use the v3 fixture; neither is model-visible.
for (const [version, document, fileName] of [
  [2, prdDocumentV2Example, "prd-runtime-result.example.json"],
  [3, prdDocumentV3Example, "prd-runtime-result-v3.example.json"],
] as const) {
  const outputUrl = new URL(`../integrations/deerflow/test-fixtures/${fileName}`, import.meta.url);
  const runtimeExample = {
    protocol: "workbench.runtime.result.v1",
    message: "需求说明书已生成。",
    artifacts: [{ kind: "prd", schemaVersion: version, title: document.title,
      operation: { kind: "create" }, citations: sourceCitations,
      content: { ...document, citations: sourceCitations } }],
  };
  const output = `${JSON.stringify(runtimeExample, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(outputUrl, "utf8"); } catch { /* mismatch below covers a missing file */ }
    if (current !== output) {
      console.error(`PRD v${version} Runtime test fixture is stale; run npm run runtime:prd-example`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outputUrl, output);
    console.log(`Wrote ${fileURLToPath(outputUrl)}`);
  }
}
