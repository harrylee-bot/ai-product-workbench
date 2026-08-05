import { describe, expect, it } from "vitest";

import {
  assertRunnableArtifactRequest,
  requestedArtifactKindsForPrompt,
  WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE,
} from "./artifact-intent";

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
    expect(requestedArtifactKindsForPrompt("Generate a detailed requirements document"))
      .toEqual(["prd"]);
    expect(requestedArtifactKindsForPrompt("生成一份包含登录页面流程的 PRD"))
      .toEqual(["prd"]);
    expect(requestedArtifactKindsForPrompt("在需求文档中补充页面流程", {
      prdContext: true,
    })).toEqual(["prd"]);
  });

  it("routes an explicit UI request to Prototype even with PRD context", () => {
    expect(requestedArtifactKindsForPrompt("基于此 PRD 生成 UI 界面设计", {
      prdContext: true,
    })).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("根据需求说明书生成原型"))
      .toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("生成 PRD 对应的 UI"))
      .toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("根据这份 PRD 做一个页面", {
      prdContext: true,
    })).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("根据需求文档生成页面设计", {
      prdContext: true,
    })).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("把它做成前端页面", {
      prdContext: true,
    })).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt("Based on this PRD, design a web page", {
      prdContext: true,
    })).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt(
      "Based on the existing PRD and prototype, generate a new page",
      { prdContext: true },
    )).toEqual(["prototype"]);
    expect(requestedArtifactKindsForPrompt(
      "参考现有需求文档和原型，生成新的页面设计",
      { prdContext: true },
    )).toEqual(["prototype"]);
  });

  it("preserves an explicit mixed request so the sequential-Run contract rejects it", () => {
    const prompts = [
      "生成一份 PRD 和原型",
      "先编写完整需求文档，再制作页面原型",
      "输出产品需求规格说明书和 UI",
      "先做原型，再给 PRD",
      "做一个 PRD 和原型",
      "生成需求文档+原型",
      "生成需求文档和页面设计",
      "Create a PRD and a prototype",
      "Generate a PRD and a prototype",
      "Design a PRD and prototype",
      "Prototype plus product requirements document",
      "我需要需求文档和原型",
      "做需求文档，同时做页面原型",
      "生成需求文档，随后制作原型",
      "Please create requirements and prototype",
      "Please create a requirements document together with a prototype",
      "Create a PRD alongside a prototype",
      "Create a requirements document as well as a prototype",
      "需求文档和原型",
      "请给我一份 PRD 和原型",
      "请提供需求文档和页面原型",
      "准备一份需求文档和原型",
      "规划需求文档和 UI",
      "Give me a PRD and prototype",
      "Provide a requirements document and prototype",
      "I would like a PRD and a prototype",
    ];

    for (const prompt of prompts) {
      const requestedArtifactKinds = requestedArtifactKindsForPrompt(prompt);
      expect(requestedArtifactKinds, prompt).toEqual(["prd", "prototype"]);
      expect(
        () => assertRunnableArtifactRequest(requestedArtifactKinds),
        prompt,
      ).toThrow(WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE);
    }
  });

  it("preserves explicit mixed requests across sentence boundaries", () => {
    expect(requestedArtifactKindsForPrompt("生成需求文档。然后生成原型"))
      .toEqual(["prd", "prototype"]);
    expect(requestedArtifactKindsForPrompt("生成需求文档. 创建原型"))
      .toEqual(["prd", "prototype"]);
    expect(requestedArtifactKindsForPrompt("编写产品需求说明书\n制作页面原型"))
      .toEqual(["prd", "prototype"]);
    expect(requestedArtifactKindsForPrompt("Generate a PRD. Then build a prototype"))
      .toEqual(["prd", "prototype"]);
  });

  it("continues the PRD for an ordinary refinement in document mode", () => {
    expect(requestedArtifactKindsForPrompt("细化补签和奖励规则", {
      prdContext: true,
    })).toEqual(["prd"]);
  });

  it("does not treat artifact context or comparison questions as a second output", () => {
    const prdPrompts = [
      "生成需求文档和登录页面的验收标准",
      "生成需求文档和页面流程",
      "Create a requirements document and page acceptance criteria",
      "Create requirements and UI guidelines",
    ];
    const contextualPrompts = [
      "需求文档和原型的区别是什么",
      "我想了解需求文档和原型的区别",
      "我要比较 PRD 和 prototype",
      "帮我解释需求文档与原型",
    ];

    for (const prompt of prdPrompts) {
      expect(requestedArtifactKindsForPrompt(prompt), prompt).toEqual(["prd"]);
    }
    for (const prompt of contextualPrompts) {
      expect(requestedArtifactKindsForPrompt(prompt), prompt).not.toEqual(["prd", "prototype"]);
    }
  });

  it("defaults a new product prompt to Prototype outside PRD context", () => {
    expect(requestedArtifactKindsForPrompt("做一个活动管理后台"))
      .toEqual(["prototype"]);
  });

  it("rejects mixed output kinds with a stable localized message", () => {
    expect(() => assertRunnableArtifactRequest(["prd", "prototype"]))
      .toThrow(WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE);
    expect(() => assertRunnableArtifactRequest(["code", "prd"]))
      .toThrow(WORKBENCH_MIXED_ARTIFACT_REQUEST_MESSAGE);
    expect(() => assertRunnableArtifactRequest(["prd"]))
      .not.toThrow();
    expect(() => assertRunnableArtifactRequest(["prototype"]))
      .not.toThrow();
  });
});
