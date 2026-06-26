import type { PrototypeComponentNode } from "./types";

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

/**
 * 把后端可能产出的英文术语映射成中文展示文案。
 *
 * 仅替换「完整术语」（带词边界），不做裸子串替换——否则会误伤正文里
 * 包含 product/strategy/runtime 等字母序列的普通单词或 URL。
 * 历史遗留的整句英文也已收录，后端切回中文后这些分支自然匹配不到。
 */
export function toChineseText(text: string) {
  return text
    .replace(/AI Product Workbench/g, "智能产品工作台")
    .replace(/AI Product OS/g, "智能产品操作系统")
    .replace(/\bAI Product\b/g, "智能产品")
    .replace(/Triple System Fusion/g, "运行时协议")
    .replace(/Triple System/g, "运行时协议")
    .replace(/Constraint Context/g, "约束上下文")
    .replace(/Constraint System/g, "约束协议")
    .replace(/Strategy Selector/g, "运行时策略")
    .replace(/System Preview/g, "系统预览")
    .replace(/System Policy/g, "系统策略")
    .replace(/ProductDesignState/g, "产品设计状态")
    .replace(/Generate multiple strategies and select one by weighted score\./g, "生成多个策略，并按加权得分选择最优策略。")
    .replace(/Avoid direct database mutation and protected module edits\./g, "避免直接修改数据库和受保护模块。")
    .replace(/Prefer lower-risk strategies when business value is similar\./g, "业务价值接近时优先选择低风险策略。")
    .replace(/QA passed and user satisfaction was strong\./g, "质检通过，用户满意度较高。")
    .replace(/\bPipeline\b/g, "流程")
    .replace(/\bStrategy\b/g, "策略")
    .replace(/\bOutcome\b/g, "结果")
    .replace(/\bDashboard\b/g, "看板")
    .replace(/\bRuntime\b/g, "运行时")
    .replace(/\bProduct\b/g, "产品");
}
