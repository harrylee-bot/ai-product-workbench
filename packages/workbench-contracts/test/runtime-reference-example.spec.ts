import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runtimeResultSchema } from "../src/runtime.js";
import { prdBlockSchema, prdDocumentV2Schema, prdSafetyBaselineIntro, prdSafetyBaselineItems } from "../src/prd.js";

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
const transportSchemaSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/runtime-result.schema.json",
  import.meta.url,
)), "utf8");

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
    expect(normalizedWorkbenchSkillSource).toContain("no free-form clarification resume path");
    expect(normalizedWorkbenchSkillSource).toContain("never call `ask_clarification`");
    expect(normalizedWorkbenchSkillSource).toContain("still complete the PRD");
    expect(normalizedWorkbenchSkillSource).toContain("only a non-PRD Run may request input");
    expect(normalizedWorkbenchSkillSource).toContain("generation is blocked for every Artifact kind");
    expect(normalizedWorkbenchSkillSource).not.toContain("otherwise request input");
    expect(normalizedWorkbenchSkillSource).not.toContain("or use clarification where");
    expect(normalizedWorkbenchSkillSource).toContain("PRD and Prototype is one linked Run");
    expect(normalizedWorkbenchSkillSource).toContain("Submit both artifacts once");
  });

  it("vendors the complete canonical requirement-document skill byte for byte", () => {
    const files = [
      ["SKILL.md", "fe668773ece4fb6790a59e8dc9981482def6a959079c280080a8a99600ba97e9"],
      ["agents/openai.yaml", "f93830939dc43fc1adbb565cc579b0181b8ac291b9c0e9ae8e3d242d73b0a988"],
      ["assets/requirement-template.docx", "9e1abdd5c63b2ee8224f68d129e4df8d2bb63835c754012e04b73ce053d85aa6"],
      ["references/quality-standards.md", "16f5019a156bd13648e2c2c7ed929392f1532473a739123a5f4ca1341aa113ee"],
      ["references/structure.md", "cfd9695845c2ad9bb1449bd912e8f491d008d69eb2ac88dbbe5d97868967299a"],
      ["scripts/docx_quality_check.py", "aab6a8ac17d53e1ca9de20aa97b17dbe8c811db7bd23bc86ec57563b68169fdb"],
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

  it("adds authoring annotations without changing any shared transport constraint", () => {
    const schema = JSON.parse(prdTransportSchemaSource);
    const runtimeSchema = JSON.parse(transportSchemaSource);
    expect(schema.description).toContain("business-neutral transport fragments only");
    expect(Object.keys(schema).filter((key) => !["description", "x-workbench-authoring-guide"].includes(key))).toEqual([
      "$schema", "title", "type", "properties", "required", "additionalProperties", "$defs",
    ]);
    expect(schema.required).toEqual(["protocol", "message", "artifacts"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toEqual({
      protocol: { type: "string", enum: ["workbench.runtime.result.v1"] },
      message: { type: "string", maxLength: 100_000 },
      artifacts: { type: "array", items: { $ref: "#/$defs/RuntimeArtifactDraftPrdV3" }, minItems: 1, maxItems: 1 },
    });
    for (const [name, definition] of Object.entries(schema.$defs)) {
      expect(definition, name).toEqual(runtimeSchema.$defs[name]);
    }
  });

  it("provides valid inline typed fragments without supplying publishable business content", () => {
    const schema = JSON.parse(prdTransportSchemaSource);
    const guide = schema["x-workbench-authoring-guide"];
    expect(guide.purpose).toContain("not a complete publishable draft");
    expect(guide.typedBlockFragments).toHaveProperty("paragraph");
    expect(guide.typedBlockFragments).toHaveProperty("bulletList");
    expect(guide.typedBlockFragments).toHaveProperty("table");
    for (const fragment of Object.values(guide.typedBlockFragments)) {
      expect(prdBlockSchema.safeParse(fragment).success).toBe(true);
      expect(runtimeResultSchema.safeParse(fragment).success).toBe(false);
    }
    const list = guide.typedBlockFragments.bulletList;
    expect(list.items).toHaveLength(2);
    expect(list.items.every((item: { type?: unknown; content: Array<{ marks: unknown }> }) => (
      item.type === undefined && item.content.every((inline) => Array.isArray(inline.marks))
    ))).toBe(true);
    const table = guide.typedBlockFragments.table;
    for (const row of table.rows) {
      expect(row.cells.map((cell: { columnId: string }) => cell.columnId)).toEqual(
        table.columns.map((column: { id: string }) => column.id),
      );
    }
    expect(JSON.stringify(guide.typedBlockFragments)).not.toMatch(/"(?:citations|applicability|applicable|enabled)":/u);
    expect(Object.keys(guide.sectionFields)).toEqual(["introduction", "businessRequirements", "degradation", "safetyBaseline"]);
    expect(guide.sectionFields.introduction).toEqual(["title", "background", "scope", "usageScenarios"]);
    expect(guide.fixedLiterals["content.sections.safetyBaseline.intro"]).toBe(prdSafetyBaselineIntro);
    expect(guide.fixedLiterals["content.sections.safetyBaseline.intro"].split("\n")).toHaveLength(5);
    expect(guide.fixedLiterals["content.sections.safetyBaseline.intro"]).not.toContain("\\n");
    expect(Buffer.byteLength(prdTransportSchemaSource, "utf8")).toBeLessThan(50_000);
  });

  it("continues rejecting misplaced section-name strings and incomplete inline text", () => {
    const example = JSON.parse(prdExampleSource);
    const scope = example.artifacts[0].content.sections.introduction.scope;
    scope.blocks.push("usageScenarios");
    let result = runtimeResultSchema.safeParse(example);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Misplaced section name was accepted");
    const documentResult = prdDocumentV2Schema.safeParse(example.artifacts[0].content);
    if (documentResult.success) throw new Error("Misplaced section name was accepted by document schema");
    expect(documentResult.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: ["sections", "introduction", "scope", "blocks", scope.blocks.length - 1],
      }),
    ]));
    scope.blocks.pop();
    const invalidParagraph = {
      id: "invalid-paragraph", type: "paragraph", content: [{ type: "text", text: "完整正文必须携带显式格式字段。" }],
    };
    expect(prdBlockSchema.safeParse(invalidParagraph).success).toBe(false);
    result = runtimeResultSchema.safeParse(example);
    expect(result.success).toBe(true);
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
