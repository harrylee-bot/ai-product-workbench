import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prdDocumentV2Example } from "../packages/workbench-contracts/src/prd-example.js";

const outputUrl = new URL(
  "../integrations/deerflow/test-fixtures/prd-runtime-result.example.json",
  import.meta.url,
);
const runtimeExample = {
  protocol: "workbench.runtime.result.v1",
  message: "需求说明书已生成。",
  artifacts: [{
    kind: "prd",
    schemaVersion: 2,
    title: prdDocumentV2Example.title,
    operation: { kind: "create" },
    citations: prdDocumentV2Example.citations,
    content: prdDocumentV2Example,
  }],
};
const output = `${JSON.stringify(runtimeExample, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outputUrl, "utf8");
  } catch {
    // The mismatch message below is sufficient for a missing generated file.
  }
  if (current !== output) {
    console.error("PRD Runtime test fixture is stale; run npm run runtime:prd-example");
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputUrl, output);
  console.log(`Wrote ${fileURLToPath(outputUrl)}`);
}
