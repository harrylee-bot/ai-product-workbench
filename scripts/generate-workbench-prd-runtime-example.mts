import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prdDocumentV2Example } from "../packages/workbench-contracts/src/prd-example.js";

const outputUrl = new URL(
  "../integrations/deerflow/skills/workbench/references/prd-runtime-result.example.json",
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

const fingerprintOutputUrl = new URL(
  "../integrations/deerflow/runtime-tools/deerflow_workbench_tools/prd_reference_fingerprint.json",
  import.meta.url,
);
const businessTextKeys = new Set([
  "actor",
  "description",
  "label",
  "notes",
  "outcome",
  "remarks",
  "statement",
  "successMetric",
  "text",
  "title",
  "trigger",
]);
const fixedTemplateText = new Set([
  "目 录",
  "1 引言",
  "1.1项目背景",
  "1.2文档范围",
  "1.3使用场景（必填）",
  "2 业务需求",
  "2.1页面链接",
  "2.2 核心业务规则/功能说明",
  "2.3 核心流程/状态/页面要求",
  "2.4 验收标准",
  "3 业务降级方案（必填）",
  "4 需求安全基线要求（必填）",
  "活动投放渠道",
  "图1 产品流程图",
  "图2 产品架构图",
  "功能点",
  "业务规则",
  "页面要求",
  "序号",
  "验收项",
  "验收标准",
]);
const genericSourceText = new Set([
  "形成首版需求说明书并进入评审。",
  "页面与状态可见性",
  "验收标准、业务降级方案和需求安全基线。",
]);

function normalizedFingerprintText(value: string): string {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase("und");
}

function collectReferenceFingerprints(value: unknown): {
  businessText: string[];
  sampleIds: string[];
} {
  const businessText = new Set<string>();
  const sampleIds = new Set<string>();
  const visit = (current: unknown, key: string | null): void => {
    if (typeof current === "string") {
      const normalized = normalizedFingerprintText(current);
      if (key === "id") {
        sampleIds.add(current);
      }
      if (
        key !== null
        && businessTextKeys.has(key)
        && !fixedTemplateText.has(current)
        && !genericSourceText.has(current)
        && normalized.length >= 16
      ) {
        businessText.add(current);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key);
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [childKey, child] of Object.entries(current)) visit(child, childKey);
    }
  };
  visit(value, null);
  return {
    businessText: [...businessText].sort(),
    sampleIds: [...sampleIds].sort(),
  };
}

const fingerprints = collectReferenceFingerprints(prdDocumentV2Example);
const fingerprintOutput = `${JSON.stringify({
  protocol: "workbench.prd-reference-fingerprint.v1",
  sourceDocumentSha256: createHash("sha256")
    .update(JSON.stringify(prdDocumentV2Example))
    .digest("hex"),
  normalization: "NFKC; remove Unicode whitespace, punctuation, and symbols; lowercase",
  ...fingerprints,
}, null, 2)}\n`;

const generatedOutputs = [
  { url: outputUrl, output, label: "PRD Runtime example" },
  { url: fingerprintOutputUrl, output: fingerprintOutput, label: "PRD reference fingerprint" },
];

if (process.argv.includes("--check")) {
  for (const generated of generatedOutputs) {
    let current = "";
    try {
      current = readFileSync(generated.url, "utf8");
    } catch {
      // The mismatch message below is sufficient for a missing generated file.
    }
    if (current !== generated.output) {
      console.error(`${generated.label} is stale; run npm run runtime:prd-example`);
      process.exitCode = 1;
    }
  }
} else {
  for (const generated of generatedOutputs) {
    writeFileSync(generated.url, generated.output);
    console.log(`Wrote ${fileURLToPath(generated.url)}`);
  }
}
