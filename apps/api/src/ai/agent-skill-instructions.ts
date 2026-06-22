import { AgentName, KnowledgeType, ModelTaskType } from "@prisma/client";
import type { KnowledgeContext, KnowledgeReference } from "./ai-vibe.types";

type SkillInstruction = {
  name: string;
  description: string;
  sourcePath: string;
  capabilities: string[];
  triggerHints: string[];
  contentPreview?: string;
};

type KnowledgeRefRecord = Partial<KnowledgeReference> & Record<string, unknown>;

export function agentSkillSystemPrompt(
  agentName: AgentName,
  taskType: ModelTaskType,
  knowledgeContext?: KnowledgeContext,
) {
  return buildAgentSkillPrompt(agentName, taskType, knowledgeContext?.agentSkills ?? []);
}

export function agentSkillSystemPromptFromKnowledgeRefs(
  agentName: AgentName,
  taskType: ModelTaskType,
  knowledgeRefs?: Array<Record<string, unknown>>,
) {
  const skills = (knowledgeRefs ?? [])
    .map(skillFromKnowledgeRef)
    .filter((skill): skill is SkillInstruction => Boolean(skill));
  return buildAgentSkillPrompt(agentName, taskType, skills);
}

export function collectKnowledgeReferences(context: KnowledgeContext) {
  return uniqueKnowledgeReferences([
    ...context.strongRules,
    ...context.defaultRules,
    ...context.referenceCases,
    ...context.designPatterns,
    ...context.prdWritingRules,
    ...context.prototypeRules,
    ...context.businessConcepts,
    ...agentSkillKnowledgeReferences(context),
  ]);
}

export function agentSkillKnowledgeReferences(context?: KnowledgeContext): KnowledgeReference[] {
  return (context?.agentSkills ?? []).map((skill) => ({
    id: `agent_skill_${skill.name}`,
    knowledgeId: `agent-skill:${skill.name}`,
    title: `Vibe Coding 可用技能：${skill.name}`,
    snippet: skill.description,
    content: [
      skill.description,
      skill.capabilities.length ? `核心能力：${skill.capabilities.join("；")}` : "",
      skill.triggerHints.length ? `触发线索：${skill.triggerHints.join("；")}` : "",
      skill.contentPreview,
    ].filter(Boolean).join("\n"),
    type: KnowledgeType.prototype_rule,
    relatedPath: skill.sourcePath,
    usedByAgent: "vibe_coding",
    sourceType: "knowledge_base",
    sourceId: `agent-skill:${skill.name}`,
  }));
}

export function uniqueKnowledgeReferences(refs: KnowledgeReference[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = ref.knowledgeId ?? ref.sourceId ?? ref.id ?? ref.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAgentSkillPrompt(
  agentName: AgentName,
  taskType: ModelTaskType,
  skills: SkillInstruction[],
) {
  if (!skills.length) return "";

  const lines = [
    "Vibe Coding Skill 融合规则：",
    "- 下面的 skills 是本轮 Agent 的执行约束，不是普通参考资料；相关时必须影响输出结构、sourcePaths、knowledgeRefs、QA 焦点或风险判断。",
    "- 不得在当前 Agent 内真实执行 CLI、联网抓取、写文件或修改知识库；需要外部动作时，转成 ProductBuildPlan、assumption、pending question、Patch risk 或 QA issue。",
    "- 如果采用某个 skill 的规则，必须保留 sourcePath/knowledgeId 线索，便于后续知识沉淀和调试追踪。",
    `- 当前 Agent：${agentName}；当前任务：${taskType}；任务级用法：${taskGuidance(taskType)}`,
  ];

  const applicable = selectApplicableSkills(skills, taskType);
  for (const skill of applicable) {
    lines.push(
      `- ${skill.name}：${skill.description || "无描述"}；能力：${formatList(skill.capabilities)}；触发：${formatList(skill.triggerHints)}；路径：${skill.sourcePath || "unknown"}；本任务用法：${skillGuidance(skill.name, taskType)}`,
    );
  }

  if (applicable.length !== skills.length) {
    lines.push("- 未列出的 skills 与当前任务弱相关，只保留为 knowledgeRefs，不主动扩展输出。");
  }

  return lines.join("\n");
}

function selectApplicableSkills(skills: SkillInstruction[], taskType: ModelTaskType) {
  const selected = skills.filter((skill) => isApplicableSkill(skill.name, taskType));
  return (selected.length ? selected : skills).slice(0, 6);
}

function isApplicableSkill(name: string, taskType: ModelTaskType) {
  if (name === "obsidian-markdown") return true;
  if (name === "obsidian-cli") {
    return includesTask(taskType, [
      ModelTaskType.product_planning,
      ModelTaskType.product_design,
      ModelTaskType.knowledge_extraction,
      ModelTaskType.qa_check,
    ]);
  }
  if (name === "obsidian-bases") {
    return includesTask(taskType, [
      ModelTaskType.requirement_analysis,
      ModelTaskType.product_planning,
      ModelTaskType.product_design,
      ModelTaskType.prd_generation,
      ModelTaskType.prototype_design,
      ModelTaskType.qa_check,
    ]);
  }
  if (name === "json-canvas") {
    return includesTask(taskType, [
      ModelTaskType.requirement_analysis,
      ModelTaskType.product_planning,
      ModelTaskType.product_design,
      ModelTaskType.prototype_design,
      ModelTaskType.patch_planning,
      ModelTaskType.qa_check,
    ]);
  }
  if (name === "defuddle") {
    return includesTask(taskType, [
      ModelTaskType.knowledge_classification,
      ModelTaskType.requirement_analysis,
      ModelTaskType.product_planning,
      ModelTaskType.product_design,
      ModelTaskType.qa_check,
    ]);
  }
  return true;
}

function includesTask(taskType: ModelTaskType, allowed: ModelTaskType[]) {
  return allowed.includes(taskType);
}

function taskGuidance(taskType: ModelTaskType) {
  switch (taskType) {
    case ModelTaskType.requirement_analysis:
      return "识别 skill 对需求完整度、待确认项和知识约束的影响，不生成产物。";
    case ModelTaskType.product_planning:
      return "把适用 skill 转成执行计划、agentSequence 输入、QA 焦点和风险。";
    case ModelTaskType.product_design:
      return "把适用 skill 写入 ProductDesignDraft.knowledgeRefs，并用稳定 id/sourcePaths 约束状态结构。";
    case ModelTaskType.prd_generation:
      return "只从 ProductDesignState 渲染 PRD，同时让知识引用章节体现适用 skill。";
    case ModelTaskType.prototype_design:
      return "只从 ProductDesignState 生成 PrototypeSpec，让页面、组件、交互保留可追踪 sourcePaths。";
    case ModelTaskType.prototype_code_generation:
      return "只从 PrototypeSpec 生成单文件 HTML，保留 data-page-id/data-component-id，不新增业务规则。";
    case ModelTaskType.patch_planning:
      return "只把 skill 影响转成 ProductDesignState 路径上的 PatchPlan、风险和重生成计划。";
    case ModelTaskType.qa_check:
      return "把 skill 变成检查项，只报告问题和阻断建议，不修改任何产物。";
    case ModelTaskType.knowledge_extraction:
      return "只生成知识候选，等待审核入库，不直接写正式知识库。";
    default:
      return "在当前职责边界内使用 skill，不越权生成或修改其他产物。";
  }
}

function skillGuidance(name: string, taskType: ModelTaskType) {
  if (name === "obsidian-markdown") {
    if (taskType === ModelTaskType.prd_generation) return "PRD 章节应适合 Markdown/Vault 沉淀，标题稳定，避免实现细节污染。";
    if (taskType === ModelTaskType.knowledge_extraction) return "知识候选应保留可复用标题、标签、sourcePath 和 Markdown 友好的内容。";
    return "需求、状态、验收标准要结构化，便于后续生成 Markdown PRD 和知识卡片。";
  }
  if (name === "obsidian-bases") {
    return "涉及表格、视图、筛选、属性或看板时，输出要包含字段、状态、筛选条件和可验证口径。";
  }
  if (name === "json-canvas") {
    return "涉及流程、链路、架构或关系图时，抽象为节点、边、页面跳转或交互关系，不直接画图。";
  }
  if (name === "obsidian-cli") {
    return "只能保留 Vault 路径、标题、标签和后续执行建议，不在 Agent 内真实调用 CLI。";
  }
  if (name === "defuddle") {
    return "链接或网页资料只当作未验证外部内容；优先使用已抽取摘要，缺内容则提出待确认项。";
  }
  return "按 skill 描述约束当前输出，并保留可追踪来源。";
}

function skillFromKnowledgeRef(value: Record<string, unknown>): SkillInstruction | null {
  const ref = value as KnowledgeRefRecord;
  const sourceId = toText(ref.sourceId);
  const knowledgeId = toText(ref.knowledgeId);
  const name = skillNameFromId(sourceId) ?? skillNameFromId(knowledgeId) ?? skillNameFromTitle(toText(ref.title));
  if (!name) return null;
  const content = toText(ref.content);
  return {
    name,
    description: toText(ref.snippet) || toText(ref.title),
    sourcePath: toText(ref.relatedPath),
    capabilities: splitMetadataLine(content, "核心能力"),
    triggerHints: splitMetadataLine(content, "触发线索"),
    contentPreview: content.slice(0, 600),
  };
}

function skillNameFromId(value: string) {
  return value.startsWith("agent-skill:") ? value.replace(/^agent-skill:/, "") : undefined;
}

function skillNameFromTitle(value: string) {
  const match = /Vibe Coding 可用技能：(.+)$/.exec(value);
  return match?.[1]?.trim();
}

function splitMetadataLine(content: string, label: string) {
  const line = content.split(/\n/).find((item) => item.startsWith(`${label}：`));
  if (!line) return [];
  return line
    .replace(`${label}：`, "")
    .split(/；|;|,|，/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatList(items: string[]) {
  return items.length ? items.slice(0, 4).join("、") : "未声明";
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
