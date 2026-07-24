import { createHash } from "node:crypto";
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
  "../../../integrations/deerflow/test-fixtures/prd-runtime-result.example.json",
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
  "../../../integrations/deerflow/skills/requirement-doc-template/references/structure.md",
  import.meta.url,
));
const prdStructureSource = readFileSync(prdStructurePath, "utf8");
const prdQualityPath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/requirement-doc-template/references/quality-standards.md",
  import.meta.url,
));
const prdQualitySource = readFileSync(prdQualityPath, "utf8");
const prdTransportSchemaPath = fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/prd-runtime-result.schema.json",
  import.meta.url,
));
const prdTransportSchemaSource = readFileSync(prdTransportSchemaPath, "utf8");

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
    expect(workbenchSkillSource).toContain("/mnt/skills/public/requirement-doc-template/SKILL.md");
    expect(workbenchSkillSource).toContain("/mnt/skills/public/requirement-doc-template/references/structure.md");
    expect(workbenchSkillSource).toContain("/mnt/skills/public/requirement-doc-template/references/quality-standards.md");
    expect(workbenchSkillSource).toContain("references/prd-runtime-result.schema.json");
    expect(workbenchSkillSource).not.toContain("prd-runtime-result.example.json");
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

  it("vendors the complete canonical requirement-document skill byte for byte", () => {
    const files = [
      ["SKILL.md", "f59cf65306078cdcdc7cc98486860a47f20ff80b81f0a849af381494183c78e1"],
      ["agents/openai.yaml", "f93eee46ee2b76146c7d2b212f6c26da3c16b28d566eac0a3158c92f9425afc0"],
      ["assets/requirement-template.docx", "3070777f5c624be731bd264f72955ca4d15d5ac68d20867318ce8c0081789ebf"],
      ["references/quality-standards.md", "45e76fe4c178e8609cd1dd3c4a6c9642c280a219b0470295b3204e469a6b4168"],
      ["references/structure.md", "9d0a8f6efe520809cb4e6cf94dd4d4f55f6a21ef52338ccbb6667419a11352a5"],
      ["scripts/docx_quality_check.py", "722aa28067ef0d34233191275440285dcee68b0764eb55d65f5bec8e16b8cf21"],
    ] as const;
    for (const [relativePath, expectedDigest] of files) {
      const source = readFileSync(fileURLToPath(new URL(
        `../../../integrations/deerflow/skills/requirement-doc-template/${relativePath}`,
        import.meta.url,
      )));
      expect(createHash("sha256").update(source).digest("hex")).toBe(expectedDigest);
    }
  });

  it("keeps the filled test fixture outside model-visible and production validation paths", () => {
    expect(prdExamplePath).toContain("integrations/deerflow/test-fixtures/");
    expect(workbenchSkillSource).not.toContain("任务页面");
    expect(prdTransportSchemaSource).not.toContain("任务页面");
    expect(prdTransportSchemaSource).not.toContain("提交任务");
    expect(prdTransportSchemaSource).not.toContain("prd-example");
  });

  it("keeps every safety-baseline meaning model-visible", () => {
    expect(prdSafetyBaselineItems).toHaveLength(21);
    expect(prdStructureSource).toContain("Use the 21-row safety baseline table from the template");
    for (const item of prdSafetyBaselineItems) {
      expect(prdStructureSource).toContain(
        `| ${item.sequence} | ${item.requirement} | ${item.scope} |`,
      );
    }
    expect(prdStructureSource).toContain("For `不涉及`, set `remarks` to `null`");
    expect(prdStructureSource).toContain("public/user-facing page: row 2 `是`");
    expect(prdStructureSource).toContain("new API: row 17 `是`");
    expect(prdQualitySource).toContain("Keep the standard 21-row safety baseline table");
    expect(prdQualitySource).toContain("Determine each value from explicit requirement facts outside the safety table");
  });

  it("publishes the validator's typed IR invariants to the authoring model", () => {
    expect(workbenchSkillSource).toContain("globally unique across the document");
    expect(workbenchSkillSource).toContain("requirement/criterion references bidirectional");
    expect(prdTransportSchemaSource).toContain('"PrdDiagramEdge"');
    expect(workbenchSkillSource).toContain("A revision returns the complete next PRD/Prototype document");
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
