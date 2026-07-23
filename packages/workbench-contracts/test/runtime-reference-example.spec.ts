import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runtimeResultSchema } from "../src/runtime.js";
import { prdSafetyBaselineItems } from "../src/prd.js";

const prototypeExamplePath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/prototype-runtime-result.example.json",
  import.meta.url,
));
const prototypeExampleSource = readFileSync(prototypeExamplePath, "utf8");
const prdExamplePath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/prd-runtime-result.example.json",
  import.meta.url,
));
const prdExampleSource = readFileSync(prdExamplePath, "utf8");
const workbenchSkillPath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/SKILL.md",
  import.meta.url,
));
const workbenchSkillSource = readFileSync(workbenchSkillPath, "utf8");
const normalizedWorkbenchSkillSource = workbenchSkillSource.replace(/\s+/gu, " ");
const prdStructurePath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/requirement-doc-template/structure.md",
  import.meta.url,
));
const prdStructureSource = readFileSync(prdStructurePath, "utf8");
const prdQualityPath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/requirement-doc-template/quality-standards.md",
  import.meta.url,
));
const prdQualitySource = readFileSync(prdQualityPath, "utf8");
const prdSourceProfilePath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/requirement-doc-template/source-profile.json",
  import.meta.url,
));
const prdSourceProfile = JSON.parse(readFileSync(prdSourceProfilePath, "utf8")) as {
  protocol: string;
  sourceSkill: { name: string; files: Array<{ path: string; sha256: string }> };
  runtimeAdaptation: { format: string; semanticAnchors: string[] };
};
const prdFingerprintPath = fileURLToPath(new URL(
  "../../../integrations/deerflow/runtime-tools/deerflow_workbench_tools/prd_reference_fingerprint.json",
  import.meta.url,
));
const prdFingerprint = JSON.parse(readFileSync(prdFingerprintPath, "utf8")) as {
  protocol: string;
  sourceDocumentSha256: string;
  businessText: string[];
  sampleIds: string[];
};

describe("DeerFlow PRD Runtime Result reference", () => {
  it("stays compact and valid against the production Runtime result schema", () => {
    const example = JSON.parse(prdExampleSource) as unknown;
    const result = runtimeResultSchema.parse(example);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "prd",
      schemaVersion: 2,
      operation: { kind: "create" },
    });
    expect(Buffer.byteLength(prdExampleSource, "utf8")).toBeLessThan(64_000);
    expect(prdExampleSource.split("\n").length).toBeLessThan(1_200);
  });

  it("loads the versioned template references without embedding a second starter", () => {
    expect(workbenchSkillSource).toContain("references/requirement-doc-template/structure.md");
    expect(workbenchSkillSource).toContain("references/requirement-doc-template/quality-standards.md");
    expect(workbenchSkillSource).toContain("references/prd-runtime-result.example.json");
    expect(workbenchSkillSource).not.toContain("prd-runtime-inline-example");
    expect(workbenchSkillSource).not.toContain('"protocol":"workbench.prd.v1"');
    expect(workbenchSkillSource).not.toContain("produce a complete `workbench.prd.v1`");
    expect(workbenchSkillSource).toContain("PRD drafting: whenever `requestedArtifactKinds` contains `prd`");
  });

  it("activates the fixed PRD profile from the requested Artifact kind", () => {
    expect(normalizedWorkbenchSkillSource).toContain("Inspect `requestedArtifactKinds` before classifying");
    expect(normalizedWorkbenchSkillSource).toContain("Whenever `requestedArtifactKinds` contains `prd`");
    expect(normalizedWorkbenchSkillSource).toContain("regardless of the natural-language prompt");
    expect(normalizedWorkbenchSkillSource).toContain("a PRD never inherits the speculative asset");
    expect(normalizedWorkbenchSkillSource).toContain("Make a conservative assumption");
    expect(normalizedWorkbenchSkillSource).toContain("Runtime contract rejects a Run");
    expect(normalizedWorkbenchSkillSource).toContain("PRD-only Run must complete");
    expect(normalizedWorkbenchSkillSource).toContain("returning `ok:true`");
  });

  it("tracks the exact local requirement skill snapshot and its runtime semantics", () => {
    expect(prdSourceProfile).toMatchObject({
      protocol: "workbench.requirement-doc-template-source-profile.v1",
      sourceSkill: { name: "requirement-doc-template" },
      runtimeAdaptation: { format: "workbench.prd.v2" },
    });
    expect(prdSourceProfile.sourceSkill.files).toHaveLength(5);
    for (const file of prdSourceProfile.sourceSkill.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    const runtimeAuthoringSource = [
      workbenchSkillSource,
      prdStructureSource,
      prdQualitySource,
    ].join("\n");
    for (const anchor of prdSourceProfile.runtimeAdaptation.semanticAnchors) {
      expect(runtimeAuthoringSource).toContain(anchor);
    }
  });

  it("fingerprints the complete sample business body and nested sample IDs", () => {
    expect(prdFingerprint.protocol).toBe("workbench.prd-reference-fingerprint.v1");
    expect(prdFingerprint.sourceDocumentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(prdFingerprint.businessText.length).toBeGreaterThanOrEqual(30);
    expect(prdFingerprint.sampleIds.length).toBeGreaterThanOrEqual(60);
    expect(prdFingerprint.businessText).toContain("页面入口：产品工作台 > 当前项目 > 任务页面。");
    expect(prdFingerprint.businessText).toContain("无任务权限的用户不可创建任务；合法请求在处理中禁用重复提交，同一请求只形成一条任务记录。");
    expect(prdFingerprint.sampleIds).toContain("requirement-main");
    expect(prdFingerprint.sampleIds).toContain("acceptance-recovery");
  });

  it("keeps every safety-baseline meaning model-visible", () => {
    expect(prdSafetyBaselineItems).toHaveLength(21);
    for (const item of prdSafetyBaselineItems) {
      expect(prdStructureSource).toContain(`| ${item.sequence} | ${item.requirement} | ${item.scope} |`);
    }
    expect(prdStructureSource).toContain("`是`: the topic applies");
    expect(prdStructureSource).toContain("`否`: the topic applies but is not yet compliant");
    expect(prdStructureSource).toContain("`不涉及`: no affirmative fact");
    expect(prdQualitySource).toContain("A positive body fact and `不涉及` are contradictory and invalid");
  });

  it("publishes the validator's typed IR invariants to the authoring model", () => {
    expect(prdStructureSource).toContain("globally unique across the whole document");
    expect(prdStructureSource).toContain("requirement-to-criterion references are bidirectional");
    expect(prdStructureSource).toContain("Every diagram edge references declared nodes");
    expect(prdStructureSource).toContain("A revision retains `documentId`");
  });
});

describe("DeerFlow Prototype Runtime Result reference", () => {
  it("stays compact and valid against the production Runtime result schema", () => {
    const example = JSON.parse(prototypeExampleSource) as unknown;
    const result = runtimeResultSchema.parse(example);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      kind: "prototype",
      schemaVersion: 1,
      operation: { kind: "create" },
    });
    if (result.artifacts[0]?.kind !== "prototype") throw new Error("Expected Prototype reference");
    expect(result.artifacts[0].content.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: { kind: "variable", path: "form.name" } }),
      expect.objectContaining({
        source: { kind: "state", stateId: "state-ready", field: "submitLabel" },
      }),
    ]));
    expect(Buffer.byteLength(prototypeExampleSource, "utf8")).toBeLessThan(16_000);
    expect(prototypeExampleSource.split("\n").length).toBeLessThan(400);
  });

  it("accepts canonical date inputs through the complete Runtime result envelope", () => {
    const example = JSON.parse(prototypeExampleSource) as {
      artifacts: Array<{
        content: {
          nodes: Array<{ id: string; inputType?: string }>;
          variables: Array<{ path: string; initialValue: unknown }>;
        };
      }>;
    };
    const content = example.artifacts[0]!.content;
    const input = content.nodes.find((node) => node.id === "node-name");
    const variable = content.variables.find((candidate) => candidate.path === "form.name");
    if (!input || !variable) throw new Error("Prototype Runtime Result date fixture is incomplete");
    input.inputType = "date";
    variable.initialValue = "2026-07-16";

    expect(runtimeResultSchema.safeParse(example).success).toBe(true);
    variable.initialValue = "2026-02-29";
    expect(runtimeResultSchema.safeParse(example).success).toBe(false);
  });
});
