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
const workbenchSkillSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/SKILL.md",
  import.meta.url,
)), "utf8");
const requirementSkillSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/requirement-doc-template/SKILL.md",
  import.meta.url,
)), "utf8");
const runtimeResultContractSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/skills/workbench/references/runtime-result-contract.md",
  import.meta.url,
)), "utf8");
const leadSource = readFileSync(fileURLToPath(new URL(
  "../../../integrations/deerflow/agents/workbench-lead/SOUL.md",
  import.meta.url,
)), "utf8");

describe("runtimePrdResultGuidance", () => {
  it("routes new PRDs to the installed v3 reference without injecting sample business content", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate");

    expect(runtimePrdResultFixture.artifacts[0]).toMatchObject({
      kind: "prd",
      schemaVersion: 2,
      content: { protocol: "workbench.prd.v2" },
    });
    expect(guidance).toContain("schemaVersion 3 with protocol workbench.prd.v3");
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
    expect(guidance).toContain("artifact_index 0");
    expect(guidance).toContain("trusted Runtime submits the exact normalized Draft once");
    expect(guidance).toContain("repair only the reported paths");
    expect(guidance).toContain("Never replace objects with positional arrays");
    expect(guidance).toContain("never an acceptance-table row ID");
  });

  it("keeps Worker guidance aligned with the installed requirement-document semantics", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate") ?? "";

    expect(guidance).toContain("regardless of the natural-language prompt");
    expect(guidance).toContain("Make conservative assumptions only when business meaning remains clear");
    expect(guidance).toContain("no free-form clarification resume path");
    expect(guidance).toContain("Never call ask_clarification");
    expect(guidance).toContain("still complete the requested PRD");
    expect(guidance).toContain("Do not invent assets, activity configuration, audit/publish, reporting, AI generation");
    expect(guidance).toContain("PRD-only or no Prototype/code are Runtime metadata, not business scope");
    expect(guidance).toContain("Do not invent default values, category members, enabled states");
    expect(guidance).toContain("PRD as an Artifact kind is never business evidence");
    expect(guidance).toContain("Never turn a generic request to write a PRD into an invented product");
    expect(guidance).toContain("Never translate or expand 端内 or 端内渠道 into an affirmative APP");
    expect(guidance).toContain("preserve explicit negative or excluded APP/mini-program facts verbatim");
    expect(guidance).toContain("every Runtime targetSurface value, including app and web, are not source evidence");
    expect(guidance).toContain("row 12 must be 不涉及 with null remarks");
    expect(guidance).toContain("Do not invent a concrete menu hierarchy");
    expect(guidance).toContain("role fallbacks 需求方, 业务评审人, 研发评审人, and 测试评审人");
    expect(guidance).toContain("only when the requirement body makes that dimension relevant");
    expect(guidance).toContain("Do not use 正常展示, 友好提示, 流转顺畅");
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
    expect(guidance).toContain("content.sections.businessRequirements.functionSections");
    expect(guidance).toContain("continuous 2.2, 2.3");
    expect(guidance).toContain("Independently choose neither diagram");
    expect(guidance).toContain("content.sections.degradation");
    expect(guidance).toContain("content.sections.safetyBaseline");
    expect(workbenchSkillSource).toContain("content.sections.businessRequirements.functionSections");
    expect(workbenchSkillSource).toContain("optional");
    expect(workbenchSkillSource).toContain("content.sections.degradation");
    expect(workbenchSkillSource).toContain("content.sections.safetyBaseline");
    expect(workbenchSkillSource).toContain("Never translate or expand `端内` or `端内渠道` into an affirmative APP");
    expect(workbenchSkillSource).toContain("every Runtime `targetSurface` value, including `app` and `web`, is not source evidence");
    expect(requirementSkillSource).toContain("every Runtime `targetSurface` value, including `app` and `web`, is not source evidence");
    expect(prdSafetyBaselineItems).toHaveLength(21);
    expect(prdStructureSource).toContain("Use the 21-row safety baseline table from the template");
    expect(prdStructureSource).toContain("new API: row 17 `是`");
    expect(prdStructureSource).toContain("every Runtime `targetSurface` value, including `app` and `web`, is not source evidence");
  });

  it.each([["prd", "prototype"], ["prototype", "prd"]])("uses accepted references for linked artifacts requested as %s then %s", (first, second) => {
    const guidance = runtimePrdResultGuidance([first, second], "generate") ?? "";

    expect(guidance).toContain("artifact_index 0");
    expect(guidance).toContain("artifact_index 1");
    expect(guidance).toContain("one complete Result");
    expect(guidance).toContain("explicitly call workbench_runtime_result_submit");
    expect(guidance).toContain("latest accepted ACK's finalSubmissionArtifact unchanged");
    expect(guidance).toContain("PRD at index 0 and Prototype at index 1");
    expect(guidance).toContain("{draftReference:{artifactIndex,draftChecksum}}");
    expect(guidance).toContain("artifactIndex equal to its array position");
    expect(guidance).toContain("Do not rewrite accepted bodies");
    expect(guidance).toContain("never invent a checksum, use a rejected ACK");
    expect(guidance).toContain("or combine the reference with content, kind, or other artifact fields");
    expect(guidance).toContain("Complete artifact entries remain supported when no accepted Draft exists");
    expect(guidance).toContain("fully validates");
    expect(guidance).toContain("external Runtime v1 result still contains complete artifacts");
    expect(guidance).not.toContain("trusted Runtime submits the exact normalized Draft once");
  });

  it("keeps installed final-submission guidance aligned with accepted references and the complete result contract", () => {
    for (const source of [workbenchSkillSource, runtimeResultContractSource, leadSource]) {
      expect(source).toContain("finalSubmissionArtifact");
      expect(source).toContain('"draftReference":{"artifactIndex":0,"draftChecksum":');
      expect(source).toContain("Complete artifact entries remain supported");
      expect(source).toContain("no accepted Draft exists");
      expect(source).toContain("PRD-only Run");
      expect(source).toContain("must not repeat that");
      expect(source).toContain("workbench.runtime.result.v1");
    }
    expect(runtimeResultContractSource).toContain("external Runtime v1 contract is unchanged");
    expect(runtimePrdResultGuidance(["prd"], "generate")).not.toContain("finalSubmissionArtifact");
    expect(runtimePrdResultGuidance(["prd"], "edit")).not.toContain("finalSubmissionArtifact");
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

  it("keeps linked edits progressing through both drafts without PRD-only stop instructions", () => {
    const linked = runtimePrdResultGuidance(["prd", "prototype"], "edit") ?? "";
    expect(linked).toContain("Legacy workbench.prd.v1 targets remain v1");
    expect(linked).toContain("complete the linked Prototype at artifact_index 1");
    expect(linked).toContain("submit both accepted ACKs' finalSubmissionArtifact references together");
    expect(linked).not.toContain("do not call a Draft or Result tool");
    expect(linked).not.toContain("automatic Result validation fails");
    expect(runtimePrdResultGuidance(["prd"], "edit")).toContain("trusted Runtime submits the exact normalized Draft once");
  });

  it("does not inject PRD instructions into non-PRD runs", () => {
    expect(runtimePrdResultGuidance(["prototype"], "generate")).toBeNull();
  });
});
