import { describe, expect, it } from "vitest";

import { requestedArtifactKindsForPrompt } from "./artifact-intent";

describe("requestedArtifactKindsForPrompt", () => {
  it("routes an explicit PRD request to PRD", () => {
    expect(requestedArtifactKindsForPrompt("生成一份 PRD"))
      .toEqual(["prd"]);
    expect(requestedArtifactKindsForPrompt("生成需求说明书"))
      .toEqual(["prd"]);
    expect(requestedArtifactKindsForPrompt("整理这份需求说明"))
      .toEqual(["prd"]);
    expect(requestedArtifactKindsForPrompt("编写产品需求规格说明书"))
      .toEqual(["prd"]);
  });

  it("routes an explicit UI request to Prototype even with PRD context", () => {
    expect(requestedArtifactKindsForPrompt("基于此 PRD 生成 UI 界面设计", {
      prdContext: true,
    })).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("根据需求说明书生成原型"))
      .toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("生成 PRD 对应的 UI"))
      .toEqual(["prototype"]);
  });

  it("preserves an explicit mixed request so the sequential-Run contract rejects it", () => {
    expect(requestedArtifactKindsForPrompt("生成一份 PRD 和原型"))
      .toEqual(["prd", "prototype"]);
    expect(requestedArtifactKindsForPrompt("先编写完整需求文档，再制作页面原型"))
      .toEqual(["prd", "prototype"]);
    expect(requestedArtifactKindsForPrompt("输出产品需求规格说明书和 UI"))
      .toEqual(["prd", "prototype"]);
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
