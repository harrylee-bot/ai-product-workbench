import { describe, expect, it } from "vitest";

import { requestedArtifactKindsForPrompt } from "./artifact-intent";

describe("requestedArtifactKindsForPrompt", () => {
  it("routes an explicit PRD request to PRD", () => {
    expect(requestedArtifactKindsForPrompt("生成一份 PRD"))
      .toEqual(["prd"]);
  });

  it("routes an explicit UI request to Prototype even with PRD context", () => {
    expect(requestedArtifactKindsForPrompt("基于此 PRD 生成 UI 界面设计", {
      prdContext: true,
    })).toEqual(["prototype"]);
  });

  it("continues the PRD for an ordinary refinement in document mode", () => {
    expect(requestedArtifactKindsForPrompt("细化补签和奖励规则", {
      prdContext: true,
    })).toEqual(["prd"]);
  });

  it("defaults a new product prompt to Prototype outside PRD context", () => {
    expect(requestedArtifactKindsForPrompt("做一个活动管理后台"))
      .toEqual(["prototype"]);
  });
});
