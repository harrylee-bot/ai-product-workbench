import type { AttachmentSummary, InputQualityAssessment, InputQualityDimension } from "./ai-vibe.types";

const PRODUCT_LOGIC_CUES = [
  "规则",
  "条件",
  "状态",
  "流程",
  "奖励",
  "权限",
  "配置",
  "约束",
  "校验",
  "异常",
  "rule",
  "logic",
];
const INTERACTION_CUES = [
  "页面",
  "按钮",
  "点击",
  "表单",
  "弹窗",
  "列表",
  "跳转",
  "置灰",
  "空状态",
  "错误",
  "提示",
  "交互",
  "prototype",
  "interaction",
];
const USER_CONTEXT_CUES = [
  "用户",
  "运营",
  "商家",
  "管理员",
  "客服",
  "目标",
  "指标",
  "活跃",
  "转化",
  "留存",
  "增长",
  "audience",
  "goal",
];

export function assessInputQuality(
  userInput: string,
  attachments: AttachmentSummary[],
): InputQualityAssessment {
  const attachmentText = attachments
    .map((attachment) => [
      attachment.fileName,
      attachment.summary,
      attachment.extractedTextPreview,
    ].filter(Boolean).join(" "))
    .join(" ");
  const text = `${userInput} ${attachmentText}`.trim();
  const hardGateTriggered = hasTemplateAttachmentWithoutParsedContent(attachments);

  const productLogic = scoreDimension(text, PRODUCT_LOGIC_CUES, 35, 14, "产品逻辑/业务规则信息不足");
  const interactionDetail = scoreDimension(text, INTERACTION_CUES, 25, 10, "交互细节或页面状态不足");
  const userContext = scoreDimension(text, USER_CONTEXT_CUES, 20, 8, "目标用户或业务目标不够清晰");
  const formatCompleteness = scoreFormatCompleteness(userInput, attachments);
  const score = productLogic.score + interactionDetail.score + userContext.score + formatCompleteness.score;
  const warnings = [
    ...dimensionWarnings("产品逻辑", productLogic),
    ...dimensionWarnings("交互细节", interactionDetail),
    ...dimensionWarnings("用户/目标", userContext),
    ...dimensionWarnings("附件/格式", formatCompleteness),
    hardGateTriggered ? "疑似固定模板附件尚未解析出有效内容，需先补全或重新上传。" : "",
  ].filter(Boolean);
  const mustOptimize = hardGateTriggered ||
    score < 60 ||
    !productLogic.passedFloor ||
    !interactionDetail.passedFloor;
  const status = mustOptimize ? "must_optimize" : score < 85 ? "suggest_optimize" : "pass";

  return {
    score,
    status,
    shouldBlock: attachments.length > 0 && status === "must_optimize",
    hardGateTriggered,
    dimensions: {
      productLogic,
      interactionDetail,
      userContext,
      formatCompleteness,
    },
    warnings,
    suggestions: suggestionsFor(status, warnings),
    evaluatedAt: new Date().toISOString(),
  };
}

function scoreDimension(
  text: string,
  cues: string[],
  maxScore: number,
  floor: number,
  missingFinding: string,
): InputQualityDimension {
  const normalized = text.toLowerCase();
  const hitCount = cues.filter((cue) => normalized.includes(cue.toLowerCase())).length;
  const densityScore = Math.min(maxScore, Math.round((hitCount / Math.min(cues.length, 4)) * maxScore));
  const lengthScore = text.length > 240 ? Math.round(maxScore * 0.35) : text.length > 80 ? Math.round(maxScore * 0.2) : 0;
  const score = Math.min(maxScore, Math.max(densityScore, lengthScore));
  return {
    score,
    maxScore,
    passedFloor: score >= floor,
    findings: score >= floor ? [] : [missingFinding],
  };
}

function scoreFormatCompleteness(
  userInput: string,
  attachments: AttachmentSummary[],
): InputQualityDimension {
  if (!attachments.length) {
    const score = userInput.trim().length >= 12 ? 14 : 8;
    return {
      score,
      maxScore: 20,
      passedFloor: true,
      findings: [],
    };
  }
  const parsedCount = attachments.filter((attachment) =>
    Boolean(attachment.summary || attachment.extractedTextPreview),
  ).length;
  const score = Math.min(20, Math.round((parsedCount / attachments.length) * 16) + 4);
  return {
    score,
    maxScore: 20,
    passedFloor: score >= 8,
    findings: score >= 8 ? [] : ["附件未解析出足够文本或摘要"],
  };
}

function hasTemplateAttachmentWithoutParsedContent(attachments: AttachmentSummary[]) {
  return attachments.some((attachment) =>
    /模板|template|prd|需求文档|需求说明书/i.test(attachment.fileName) &&
    !attachment.summary &&
    !attachment.extractedTextPreview,
  );
}

function dimensionWarnings(label: string, dimension: InputQualityDimension) {
  return dimension.findings.map((finding) => `${label}: ${finding}`);
}

function suggestionsFor(status: InputQualityAssessment["status"], warnings: string[]) {
  if (status === "pass") return [];
  const base = [
    "补充目标用户、业务目标、核心页面、关键状态和异常规则。",
    "明确主要按钮/表单/跳转/反馈等交互细节。",
  ];
  if (warnings.some((warning) => warning.includes("附件"))) {
    base.push("重新上传可解析的需求文档，或在消息里粘贴附件中的关键内容。");
  }
  return base;
}
