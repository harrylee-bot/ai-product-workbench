import { describe, expect, it } from "vitest";
import { KnowledgeType } from "@prisma/client";
import { classifyRequirementMode, MODE_BOOST_TYPES, type RequirementMode } from "../src/ai/requirement-mode.helper";

const MODES: RequirementMode[] = [
  "historical_extension",
  "new_capability",
  "brand_new_system",
  "one_sentence_completion",
];

describe("classifyRequirementMode", () => {
  it("classifies very short prompts as one_sentence_completion regardless of existing state", () => {
    expect(classifyRequirementMode("做一个抽奖活动", { hasExistingState: false })).toBe("one_sentence_completion");
    expect(classifyRequirementMode("做一个抽奖活动", { hasExistingState: true })).toBe("one_sentence_completion");
  });

  it("classifies a new conversation with no existing state and a detailed prompt as brand_new_system", () => {
    expect(
      classifyRequirementMode("我要做一个营销活动管理后台，包含活动创建、素材管理、奖品配置、审核发布和数据报表", {
        hasExistingState: false,
      }),
    ).toBe("brand_new_system");
  });

  it("classifies explicit brand-new signals as brand_new_system even with existing state", () => {
    expect(
      classifyRequirementMode("请从零搭建一个独立的会员积分新系统，覆盖积分获取、兑换与风控", {
        hasExistingState: true,
      }),
    ).toBe("brand_new_system");
  });

  it("classifies new module/capability signals on existing state as new_capability", () => {
    expect(
      classifyRequirementMode("在现有后台新增一个新模块：渠道归因分析工作台，形成归因闭环", {
        hasExistingState: true,
      }),
    ).toBe("new_capability");
  });

  it("classifies modification of existing state as historical_extension by default", () => {
    expect(
      classifyRequirementMode("把签到页的连续签到奖励改为阶梯式，并调整字段展示顺序", { hasExistingState: true }),
    ).toBe("historical_extension");
  });

  it("MODE_BOOST_TYPES covers all four modes with knowledge types", () => {
    for (const mode of MODES) {
      expect(MODE_BOOST_TYPES[mode].length).toBeGreaterThan(0);
      for (const type of MODE_BOOST_TYPES[mode]) {
        expect(Object.values(KnowledgeType)).toContain(type);
      }
    }
  });

  it("brand_new_system boosts ui_style_guide so a new system follows retrieved style", () => {
    expect(MODE_BOOST_TYPES.brand_new_system).toContain(KnowledgeType.ui_style_guide);
  });

  it("historical_extension boosts structure-reuse types", () => {
    expect(MODE_BOOST_TYPES.historical_extension).toContain(KnowledgeType.product_architecture);
    expect(MODE_BOOST_TYPES.historical_extension).toContain(KnowledgeType.prototype_asset_ref);
  });
});
