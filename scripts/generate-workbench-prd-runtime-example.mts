import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prdDocumentV3Example } from "../packages/workbench-contracts/src/prd-example.js";
import { sourceCitations } from "../packages/workbench-contracts/test/knowledge-citation.fixture.js";

const outputUrl = new URL("../integrations/deerflow/test-fixtures/prd-runtime-result.example.json", import.meta.url);
const runtimeExample = {
  protocol: "workbench.runtime.result.v1",
  message: "需求说明书已生成。",
  artifacts: [{
    kind: "prd", schemaVersion: 3, title: prdDocumentV3Example.title,
    operation: { kind: "create" }, citations: sourceCitations,
    content: { ...prdDocumentV3Example, citations: sourceCitations },
  }],
};
const output = `${JSON.stringify(runtimeExample, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(outputUrl, "utf8"); } catch { /* mismatch below covers a missing file */ }
  if (current !== output) {
    console.error(`PRD Runtime test fixture is stale; run npm run runtime:prd-example`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputUrl, output);
  console.log(`Wrote ${fileURLToPath(outputUrl)}`);
}
