import type {
  Constraint,
  ConstraintContext,
  Phase2DecisionView,
  PrototypeComponentNode,
} from "./types";

export const RULE_LABELS: Record<Constraint["rule"], string> = {
  must_follow: "必须遵守",
  prefer: "优先考虑",
  avoid: "避免",
  warn: "提醒",
};

export const OUTCOME_LABELS: Record<Phase2DecisionView["evolution"]["finalOutcome"], string> = {
  success: "成功",
  failure: "失败",
  partial: "部分成功",
};

export function sectionEditKey(documentKey: string, sectionId: string) {
  return `${documentKey}:${sectionId}`;
}

export function splitParagraphs(content: string) {
  const paragraphs = content
    .split(/\n{2,}|\r?\n(?=(?:[0-9]+[.、]|[一二三四五六七八九十]+[、.]))/)
    .map((item) => item.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [content];
}

export function compactNumber(value: number) {
  return Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function constraintCount(context: ConstraintContext | null) {
  if (!context) return 0;
  return context.mustFollow.length + context.prefer.length + context.avoid.length + context.warn.length;
}

export function firstConstraints(context: ConstraintContext | null) {
  if (!context) return [];
  return [
    ...context.mustFollow,
    ...context.prefer,
    ...context.avoid,
    ...context.warn,
  ].slice(0, 4);
}

export function decisionConstraintContext(decision?: Phase2DecisionView | null) {
  return decision?.constraintContext
    ?? decision?.decisionPlan.constraintContext
    ?? decision?.agentInput?.constraintContext
    ?? null;
}

export function riskLabel(risk?: string) {
  if (risk === "high") return "高";
  if (risk === "medium") return "中";
  return "低";
}

export function normalizeRisk(value?: string): "low" | "medium" | "high" {
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

export function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    ready: "已生成",
    preview: "待预览",
    applied: "已应用",
    already_applied: "已应用",
    blocked: "已阻止",
    completed: "已完成",
    pending: "待处理",
    running: "运行中",
    failed: "失败",
  };
  return status ? labels[status] ?? status : "未知";
}

export function evolutionCopy(signalType: "promote" | "demote" | "neutral") {
  if (signalType === "promote") return "策略已提升";
  if (signalType === "demote") return "策略已降级";
  return "策略保持中性";
}

export function formatShortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function derivePrototypeComponents(html: string): PrototypeComponentNode[] {
  if (!html.trim()) return [];

  const nodes: PrototypeComponentNode[] = [];
  const structuralPattern = /<(header|nav|main|section|article|form|footer|aside)\b([^>]*)>/gi;
  Array.from(html.matchAll(structuralPattern)).slice(0, 9).forEach((match, index) => {
    const tag = match[1].toLowerCase();
    const attrs = match[2] ?? "";
    nodes.push({
      id: `structure-${index}-${tag}`,
      name: componentName(tag, attrs, index),
      type: tag.toUpperCase(),
      detail: componentDetail(attrs) || "结构容器",
      depth: tag === "main" || tag === "header" || tag === "footer" ? 0 : 1,
    });
  });

  const headingPattern = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  Array.from(html.matchAll(headingPattern)).slice(0, 4).forEach((match, index) => {
    nodes.push({
      id: `heading-${index}`,
      name: trimText(stripHtml(match[2]), `标题 ${index + 1}`),
      type: `H${match[1]}`,
      detail: "文案节点",
      depth: 2,
    });
  });

  const actionPattern = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  Array.from(html.matchAll(actionPattern)).slice(0, 4).forEach((match, index) => {
    nodes.push({
      id: `action-${index}`,
      name: trimText(stripHtml(match[3]), `动作 ${index + 1}`),
      type: match[1].toUpperCase(),
      detail: componentDetail(match[2] ?? "") || "可交互控件",
      depth: 2,
    });
  });

  if (!nodes.length) {
    nodes.push({
      id: "document-root",
      name: "页面根节点",
      type: "HTML",
      detail: "完整原型",
      depth: 0,
    });
  }

  return nodes.slice(0, 14);
}

function componentName(tag: string, attrs: string, index: number) {
  const explicit = attrs.match(/\b(?:aria-label|data-component|data-name|id)=["']([^"']+)["']/i)?.[1];
  if (explicit) return toChineseText(humanizeToken(explicit));
  const fallback: Record<string, string> = {
    header: "顶部导航",
    nav: "导航",
    main: "主内容",
    section: `内容区 ${index + 1}`,
    article: `内容卡片 ${index + 1}`,
    form: "表单",
    footer: "页脚",
    aside: "侧栏",
  };
  return fallback[tag] ?? `${tag} ${index + 1}`;
}

function componentDetail(attrs: string) {
  const className = attrs.match(/\bclass=["']([^"']+)["']/i)?.[1];
  if (!className) return "";
  return humanizeToken(className.split(/\s+/).slice(0, 2).join(" "));
}

function humanizeToken(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function trimText(value: string, fallback: string) {
  const text = value.trim();
  if (!text) return fallback;
  return toChineseText(text.length > 18 ? `${text.slice(0, 18)}...` : text);
}

export function toChineseText(text: string) {
  return text
    .replace(/AI Product Workbench/g, "智能产品工作台")
    .replace(/AI Product Company/g, "智能产品公司")
    .replace(/AI Product OS/g, "智能产品操作系统")
    .replace(/AI Product/g, "智能产品")
    .replace(/Triple System Fusion/g, "三系统融合")
    .replace(/Triple System/g, "三系统融合")
    .replace(/Constraint Context/g, "约束上下文")
    .replace(/Constraint System/g, "约束系统")
    .replace(/Decision System/g, "决策系统")
    .replace(/Evolution System/g, "进化系统")
    .replace(/Decision Engine/g, "决策引擎")
    .replace(/Review Board/g, "评审委员会")
    .replace(/Strategy Selector/g, "策略选择器")
    .replace(/Patch Preview/g, "补丁预览")
    .replace(/System Preview/g, "系统预览")
    .replace(/System Policy/g, "系统策略")
    .replace(/ProductDesignState/g, "产品设计状态")
    .replace(/Product Department/g, "产品部门")
    .replace(/Engineering Department/g, "工程部门")
    .replace(/Design Department/g, "设计部门")
    .replace(/QA Department/g, "质检部门")
    .replace(/Growth Department/g, "增长部门")
    .replace(/Evolution Department/g, "进化部门")
    .replace(/CEO Agent/g, "首席决策智能体")
    .replace(/Self-Generation Observer/g, "自生成观察智能体")
    .replace(/Flow Optimization Agent/g, "流程优化智能体")
    .replace(/Generate multiple strategies and select one by weighted score\./g, "生成多个策略，并按加权得分选择最优策略。")
    .replace(/Route through 补丁预览 before apply\./g, "执行前必须进入补丁预览。")
    .replace(/Avoid direct database mutation and protected module edits\./g, "避免直接修改数据库和受保护模块。")
    .replace(/Prefer lower-risk strategies when business value is similar\./g, "业务价值接近时优先选择低风险策略。")
    .replace(/QA passed and user satisfaction was strong\./g, "质检通过，用户满意度较高。")
    .replace(/Pipeline/g, "流程")
    .replace(/Agent/g, "智能体")
    .replace(/Strategy/g, "策略")
    .replace(/Outcome/g, "结果")
    .replace(/Company/g, "公司")
    .replace(/Dashboard/g, "看板")
    .replace(/Runtime/g, "运行时")
    .replace(/Product/g, "产品");
}
