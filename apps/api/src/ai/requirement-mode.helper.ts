import { KnowledgeType } from "@prisma/client";

/**
 * 需求模式四元组（与 SOUL.md / SKILL.md / final-action-contract.md 保持一致）。
 * DeerFlow 在 final action 中给出权威判定；本类型用于检索阶段的预分类与可观测。
 */
export type RequirementMode =
  | "historical_extension"
  | "new_capability"
  | "brand_new_system"
  | "one_sentence_completion";

/**
 * 每种需求模式偏重的知识类型。
 * 检索排序时对这些类型给予额外加权（仅影响排序，不收缩召回），让 requirementMode 真正驱动检索，
 * 而非「判了也白判」（kb-redesign P1-1）。
 */
export const MODE_BOOST_TYPES: Record<RequirementMode, KnowledgeType[]> = {
  // 扩展既有项目：复用既有结构，偏重架构/页面清单/原型资产/强规则
  historical_extension: [
    KnowledgeType.product_architecture,
    KnowledgeType.page_inventory,
    KnowledgeType.prototype_asset_ref,
    KnowledgeType.strong_rule,
  ],
  // 既有产品内新能力：偏重架构/UI 样式/PRD 写作规则
  new_capability: [
    KnowledgeType.product_architecture,
    KnowledgeType.ui_style_guide,
    KnowledgeType.prd_writing_rule,
  ],
  // 全新系统：偏重 UI 样式/PRD 写作/原型规则（若有 ui_style_guide 则遵循）
  brand_new_system: [
    KnowledgeType.ui_style_guide,
    KnowledgeType.prd_writing_rule,
    KnowledgeType.prototype_rule,
  ],
  // 一句话补全：偏重业务概念/历史案例/强规则以补全常规细节
  one_sentence_completion: [
    KnowledgeType.business_concept,
    KnowledgeType.reference_case,
    KnowledgeType.strong_rule,
  ],
};

const NEW_CAPABILITY_SIGNALS = ["新模块", "新工作台", "新能力", "新对象", "新角色", "闭环", "新闭环"];
const BRAND_NEW_SIGNALS = ["新系统", "从零", "全新", "新平台", "独立页面", "新项目", "从无到有"];
const ONE_SENTENCE_GOAL_SIGNALS = [
  "做一个",
  "做个",
  "生成一个",
  "生成一份",
  "写一个",
  "写一份",
  "我想做",
  "我要做",
  "帮我做",
  "帮我生成",
];

/**
 * 预检索启发式分类（v1）。
 *
 * 仅用于驱动知识检索排序与运行时可观测，不替代 DeerFlow 在 final action 中的权威 requirementMode。
 * 设计为保守且无召回损失：无法确定时回落到 historical_extension（有既有态）或 brand_new_system（无既有态）。
 *
 * 可选增强：用 ModelGatewayService 的 `requirement_mode_classify` 任务做 LLM 分类（需配置 ModelTaskProfile
 * 与供应商），失败或未配置时回落到本启发式。当前默认走启发式，避免在热路径引入未配置的网络调用。
 */
export function classifyRequirementMode(
  message: string,
  opts: { hasExistingState: boolean },
): RequirementMode {
  const text = (message ?? "").trim();

  // 极短或一句话目标（如「做一个抽奖活动」「我想做一个签到领积分的活动」）→ 一句话补全
  if (isOneSentenceGoal(text)) {
    return "one_sentence_completion";
  }

  // 明确的全新系统信号，或无既有态 → 全新系统
  if (BRAND_NEW_SIGNALS.some((signal) => text.includes(signal)) || !opts.hasExistingState) {
    return "brand_new_system";
  }

  // 既有态下的新模块/新能力信号 → 新能力
  if (NEW_CAPABILITY_SIGNALS.some((signal) => text.includes(signal))) {
    return "new_capability";
  }

  // 默认：扩展既有项目
  return "historical_extension";
}

function isOneSentenceGoal(text: string) {
  if (!text) return true;
  if (text.length <= 16 || countTokens(text) <= 8) return true;
  const businessGoal = stripGenerationInstructions(text);
  if (
    businessGoal !== text &&
    businessGoal.length <= 42 &&
    !/[，,；;。！？!?]/.test(businessGoal) &&
    ONE_SENTENCE_GOAL_SIGNALS.some((signal) => businessGoal.includes(signal))
  ) {
    return true;
  }
  if (text.length > 42) return false;
  if (/[，,；;。！？!?]/.test(text)) return false;
  return ONE_SENTENCE_GOAL_SIGNALS.some((signal) => text.includes(signal));
}

function stripGenerationInstructions(text: string) {
  return text
    .replace(/[，,；;。！？!?]\s*请?根据知识库内容/g, "")
    .replace(/请?根据知识库内容/g, "")
    .replace(/生成(一份|一个)?(完整)?(需求文档|需求说明书|PRD|prd)(和|及|与)?原型?/gi, "")
    .replace(/生成(一份|一个)?(完整)?原型(和|及|与)?(需求文档|需求说明书|PRD|prd)?/gi, "")
    .replace(/生成(一份|一个)?(完整)?(需求文档|需求说明书|PRD|prd)/gi, "")
    .replace(/\s+/g, "")
    .replace(/[，,；;。！？!?]+$/g, "")
    .trim();
}

function countTokens(text: string): number {
  const matches = text.toLowerCase().match(/[a-z0-9]{2,}|[一-龥]/g) ?? [];
  return matches.length;
}
