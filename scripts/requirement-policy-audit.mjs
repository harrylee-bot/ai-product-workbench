#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const policyFiles = [
  "knowledge-vault/04-产品文档规范/PRD标准结构.md",
  "integrations/deerflow/skills/ai-product-workbench/SKILL.md",
  "apps/api/src/ai/deerflow-runtime.service.ts",
];
const requiredSections = [
  "1.1 项目背景",
  "1.2 文档范围",
  "1.3 使用场景（必填）",
  "2.1 页面链接",
  "2.2 核心业务规则/功能说明",
  "2.3 核心流程/状态/页面要求",
  "2.4 验收标准",
  "3 业务降级方案（必填）",
  "4 需求安全基线要求（必填）",
];

for (const relativePath of policyFiles) {
  const content = read(relativePath);
  for (const section of requiredSections) {
    assert(content.includes(section), `${relativePath} missing policy section: ${section}`);
  }
  assert(/产品流程图|product(?:\/business)? flow diagram/i.test(content), `${relativePath} missing 产品流程图 requirement`);
  assert(/产品架构图|product architecture/i.test(content), `${relativePath} missing 产品架构图 requirement`);
  assert(content.includes("本需求涉及新增/修改的接口"), `${relativePath} missing forbidden interface-section rule`);
}

const knowledge = read(policyFiles[0]);
assert(!/未知时写\s*`待确认`/.test(knowledge), "knowledge policy still recommends 待确认");
assert(!/未知时写\s*`以实际上线地址为准`/.test(knowledge), "knowledge policy still recommends a placeholder URL");
assert(knowledge.includes("安全模板行自己的文字不能触发自身"), "knowledge policy does not prevent safety-row self-triggering");

const formatter = read("apps/api/src/ai/requirement-document-format.ts");
for (const marker of ["usage_scenarios", "safety_baseline", "产品流程图", "产品架构图", "buildChannelScopeSummary", "isConfirmedAssumption"]) {
  assert(formatter.includes(marker), `formatter missing required marker: ${marker}`);
}

const qa = read("apps/api/src/ai/qa-rule-check.service.ts");
for (const marker of [
  "以实际上线地址为准",
  "待确认",
  "产品流程图",
  "产品架构图",
  "qa_prd_channel_table_invalid",
  "qa_prd_safety_evidence_conflict",
  "qa_prototype_invalid_viewport",
  "qa_prototype_mobile_css_missing",
  "qa_prototype_horizontal_overflow_unprotected",
  "qa_prototype_key_actions_not_interactive",
]) {
  assert(qa.includes(marker), `QA missing guard: ${marker}`);
}

const runtime = read("apps/api/src/ai/deerflow-runtime.service.ts");
const runtimeSkill = read("integrations/deerflow/skills/ai-product-workbench/SKILL.md");
const finalActionContract = read("integrations/deerflow/skills/ai-product-workbench/references/final-action-contract.md");
for (const [label, content] of [["runtime", runtime], ["runtime skill", runtimeSkill], ["final action contract", finalActionContract]]) {
  for (const marker of ["viewport", "768", "overflow", "390x844", "click"]) {
    assert(content.toLowerCase().includes(marker), `${label} missing prototype contract marker: ${marker}`);
  }
}
assert(!runtime.includes("If interaction cannot use scripts because stored prototypes are sanitized"), "runtime still permits inert static prototypes");

const localSkillRoot = process.env.REQUIREMENT_DOC_SKILL_ROOT
  || path.join(os.homedir(), ".codex", "skills", "requirement-doc-template");
if (existsSync(localSkillRoot)) {
  const skill = readAbsolute(path.join(localSkillRoot, "SKILL.md"));
  const structure = readAbsolute(path.join(localSkillRoot, "references", "structure.md"));
  for (const marker of ["2.4 验收标准", "产品流程图", "产品架构图"]) {
    assert(`${skill}\n${structure}`.includes(marker), `local requirement skill missing: ${marker}`);
  }
  assert(!/otherwise\s+`待确认`/.test(structure), "local requirement skill still recommends 待确认");
  assert(!/usually\s+`以实际上线地址为准`/.test(structure), "local requirement skill still recommends a placeholder URL");
}

console.log(JSON.stringify({ passed: true, policyFiles, localSkillRoot }, null, 2));

function read(relativePath) {
  return readAbsolute(path.join(root, relativePath));
}

function readAbsolute(filePath) {
  if (!existsSync(filePath)) throw new Error(`required policy file not found: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
