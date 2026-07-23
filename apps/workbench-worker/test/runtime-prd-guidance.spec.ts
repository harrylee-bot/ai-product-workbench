import { describe, expect, it } from "vitest";

import {
  runtimePrdResultGuidance,
  runtimePrdResultStarter,
} from "../src/runtime/runtime-prd-guidance.js";

describe("runtimePrdResultGuidance", () => {
  it("routes new PRDs to the installed v2 reference without injecting sample business content", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "generate");

    expect(runtimePrdResultStarter.artifacts[0]).toMatchObject({
      kind: "prd",
      schemaVersion: 2,
      content: { protocol: "workbench.prd.v2" },
    });
    expect(guidance).toContain("references/prd-runtime-result.example.json exactly once");
    expect(guidance).not.toContain("<workbench_prd_result_starter>");
    expect(guidance).not.toContain(JSON.stringify(runtimePrdResultStarter));
  });

  it("preserves the targeted protocol for edits without injecting a create starter", () => {
    const guidance = runtimePrdResultGuidance(["prd"], "edit");

    expect(guidance).toContain("Legacy workbench.prd.v1 targets remain v1");
    expect(guidance).toContain("workbench.prd.v2 targets remain v2");
    expect(guidance).not.toContain("<workbench_prd_result_starter>");
  });

  it("does not inject PRD instructions into non-PRD runs", () => {
    expect(runtimePrdResultGuidance(["prototype"], "generate")).toBeNull();
  });
});
