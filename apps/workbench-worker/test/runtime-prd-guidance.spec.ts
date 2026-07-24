import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prdSafetyBaselineItems } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { runtimePrdResultGuidance } from "../src/runtime/runtime-prd-guidance.js";
import { runtimePrdResultFixture } from "./runtime-prd-result.fixture.js";

const prdStructureSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/requirement-doc-template/references/structure.md",
  import.meta.url,
)), "utf8");

describe("runtimePrdResultGuidance", () => {
  it("routes new PRDs to the installed v2 reference without injecting sample business content", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate");

    expect(runtimePrdResultFixture.artifacts[0]).toMatchObject({
      kind: "prd",
      schemaVersion: 2,
      content: { protocol: "workbench.prd.v2" },
    });
    expect(guidance).toContain("each required reference exactly once in this order");
    expect(guidance).toContain(
      "/mnt/skills/public/requirement-doc-template/SKILL.md",
    );
    expect(guidance).toContain(
      "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
    );
    expect(guidance).toContain("Never use a filled PRD example as an authoring source");
    expect(guidance).not.toContain("prd-runtime-result.example.json");
    expect(guidance).not.toContain("<workbench_prd_result_starter>");
    expect(guidance).not.toContain(JSON.stringify(runtimePrdResultFixture));
  });

  it("keeps Worker guidance aligned with the installed requirement-document semantics", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate") ?? "";

    expect(guidance).toContain("regardless of the natural-language prompt");
    expect(guidance).toContain("Make conservative assumptions only when business meaning remains clear");
    expect(guidance).toContain("Do not invent assets, activity configuration, audit/publish, reporting, AI generation");
    expect(guidance).toContain("PRD-only or no Prototype/code are Runtime metadata, not business scope");
    expect(guidance).toContain("Do not invent default values, category members, enabled states");
    expect(guidance).toContain("Do not invent a concrete menu hierarchy");
    expect(guidance).toContain("role fallbacks 需求方, 业务评审人, 研发评审人, and 测试评审人");
    expect(guidance).toContain("only when the requirement body makes that dimension relevant");
    expect(guidance).toContain("For 不涉及, set remarks to null");
    expect(guidance).toContain("不涉及 is invalid when the PRD body contains an affirmative fact");
    expect(guidance).toContain("Any requested construction, development, implementation, modification, or upgrade");
    expect(guidance).toContain("reusing existing defaults, settings, data, or category members only narrows scope");
    expect(guidance).toContain("Row 1 never uses 否");
    expect(guidance).toContain("remarks must name the concrete changed function, page, interface, or logic");
    expect(guidance).toContain("a local statement about reusing or not adding a default, setting, field, status, or category is not global no-change evidence");
    expect(guidance).toContain("端内渠道, 客户端, 消费者端, and 前端 do not prove APP or mini-program loading");
    expect(guidance).toContain("IDs globally unique across the document and every nested IR entity");
    expect(guidance).toContain("requirement/criterion references bidirectional");
    expect(prdSafetyBaselineItems).toHaveLength(21);
    expect(prdStructureSource).toContain("Use the 21-row safety baseline table from the template");
    expect(prdStructureSource).toContain("new API: row 17 `是`");
    expect(prdStructureSource).toContain("They must not activate row 12");
  });

  it("fails fast if an invalid mixed PRD and Prototype request reaches Worker guidance", () => {
    const guidance = runtimePrdResultGuidance(["prd", "prototype"], "generate") ?? "";

    expect(guidance).toContain("Invalid Runtime input");
    expect(guidance).toContain("two sequential Runs");
    expect(guidance).toContain("Do not use clarification to resume this Run");
    expect(guidance).not.toContain("workbench_artifact_draft_publish");
  });

  it("preserves the targeted protocol for edits without injecting a create starter", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "edit");

    expect(guidance).toContain("Legacy workbench.prd.v1 targets remain v1");
    expect(guidance).toContain("workbench.prd.v2 targets remain v2");
    expect(guidance).not.toContain("<workbench_prd_result_starter>");
    expect(guidance).not.toContain("fixed requirement-document profile");
    expect(guidance).not.toContain("all 21 safety-row meanings");
    expect(guidance).not.toContain("fixed cover, version history");
    expect(guidance).not.toContain("IDs globally unique across the document and every nested IR entity");
  });

  it("does not inject PRD instructions into non-PRD runs", () => {
    expect(runtimePrdResultGuidance(["prototype"], "generate")).toBeNull();
  });
});
