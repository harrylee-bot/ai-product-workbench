import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prdSafetyBaselineItems } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  runtimePrdResultGuidance,
  runtimePrdResultStarter,
} from "../src/runtime/runtime-prd-guidance.js";

const prdStructureSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/requirement-doc-template/structure.md",
  import.meta.url,
)), "utf8");

describe("runtimePrdResultGuidance", () => {
  it("routes new PRDs to the installed v2 reference without injecting sample business content", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate");

    expect(runtimePrdResultStarter.artifacts[0]).toMatchObject({
      kind: "prd",
      schemaVersion: 2,
      content: { protocol: "workbench.prd.v2" },
    });
    expect(guidance).toContain("each required Runtime reference exactly once");
    expect(guidance).toContain(
      "/mnt/skills/public/workbench/references/prd-runtime-result.example.json",
    );
    expect(guidance).not.toContain("<workbench_prd_result_starter>");
    expect(guidance).not.toContain(JSON.stringify(runtimePrdResultStarter));
  });

  it("keeps Worker guidance aligned with the installed requirement-document semantics", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate") ?? "";

    expect(guidance).toContain("regardless of the natural-language prompt");
    expect(guidance).toContain("Make conservative assumptions only when business meaning remains clear");
    expect(guidance).toContain("Do not invent assets, activity configuration, audit/publish, reporting, AI generation");
    expect(guidance).toContain("role fallbacks 需求方, 业务评审人, 研发评审人, and 测试评审人");
    expect(guidance).toContain("only when the requirement body makes that dimension relevant");
    expect(guidance).toContain("不涉及 is invalid when the PRD body contains an affirmative fact");
    expect(guidance).toContain("IDs globally unique across the document and every nested IR entity");
    expect(guidance).toContain("requirement/criterion references bidirectional");
    for (const item of prdSafetyBaselineItems) {
      expect(prdStructureSource).toContain(`| ${item.sequence} | ${item.requirement} | ${item.scope} |`);
    }
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
