import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { agentSystemPrompt } from "../agent-charter";
import type {
  AssumptionReference,
  ClarificationQuestionReference,
  ProductDesignState,
  RequirementDocSection,
  RequirementDocSectionType,
  RequirementDocTag,
  RequirementDocumentDraft,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PrdWriterInput = {
  productDesignState: ProductDesignState;
  mode: "draft" | "formal";
  generatedByRunId?: string;
};

type SectionConfig = {
  id: string;
  title: string;
  type: RequirementDocSectionType;
  paths: string[];
  tags?: RequirementDocTag[];
  render: (state: ProductDesignState) => string;
};

@Injectable()
export class PrdWriterAgentService extends BaseAgentService<PrdWriterInput, RequirementDocumentDraft> {
  readonly agentName = AgentName.prd_writer_agent;
  readonly taskType = ModelTaskType.prd_generation;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PrdWriterInput) {
    return [
      {
        role: "system" as const,
        content: agentSystemPrompt(
          this.agentName,
          "你是 PRD Writer Agent。只能基于 ProductDesignState 输出结构化 PRD JSON。不得编造 ProductDesignState 中不存在的业务规则；不得输出接口 URL、请求参数、数据库、SQL、代码、技术架构、部署或前后端实现细节。每个 section 必须包含 id、title、type、level、order、content、sourcePaths、tags。",
        ),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PrdWriterInput): RequirementDocumentDraft {
    return renderPrdFromState(input.productDesignState);
  }

  protected normalize(output: RequirementDocumentDraft, input: PrdWriterInput): RequirementDocumentDraft {
    const fallback = this.fallback(input);
    const sections = Array.isArray(output.sections) ? output.sections : fallback.sections;
    return {
      id: output.id,
      projectId: input.productDesignState.projectId,
      title: safeText(output.title) || fallback.title,
      sections: normalizeSections(sections, fallback.sections),
      assumptions: normalizeAssumptionRefs(output.assumptions, input.productDesignState),
      knowledgeRefs: input.productDesignState.knowledgeRefs,
      pendingQuestions: normalizeQuestionRefs(output.pendingQuestions, input.productDesignState),
      validationNotes: sanitizeNotes(output.validationNotes),
    };
  }
}

export function renderPrdFromState(state: ProductDesignState): RequirementDocumentDraft {
  const sections = SECTION_CONFIGS.map((config, index) => toSection(config, state, index + 1));
  return {
    projectId: state.projectId,
    title: `${state.title} PRD`,
    sections,
    assumptions: normalizeAssumptionRefs(undefined, state),
    knowledgeRefs: state.knowledgeRefs,
    pendingQuestions: normalizeQuestionRefs(undefined, state),
    validationNotes: ["PRD 已按 ProductDesignState 渲染，未包含接口、SQL、代码、数据库或部署实现细节。"],
  };
}

const SECTION_CONFIGS: SectionConfig[] = [
  {
    id: "overview",
    title: "1. 需求概述",
    type: "overview",
    paths: ["title", "summary"],
    render: (state) =>
      state.summary ||
      `本需求围绕“${state.title}”沉淀产品设计状态，并用于生成可评审的 PRD 与原型。`,
  },
  {
    id: "background",
    title: "2. 需求背景",
    type: "background",
    paths: ["background"],
    render: (state) => state.background || "暂无明确背景，需在后续沟通中补充。",
  },
  {
    id: "business_goal",
    title: "3. 业务目标",
    type: "business_goal",
    paths: ["businessGoal"],
    render: (state) => state.businessGoal || "暂无明确业务目标。",
  },
  {
    id: "target_users",
    title: "4. 目标用户",
    type: "target_users",
    paths: ["targetUsers"],
    render: (state) => listItems(state.targetUsers, ["name", "description"]),
  },
  {
    id: "user_scenarios",
    title: "5. 使用场景",
    type: "user_scenarios",
    paths: ["userScenarios"],
    render: (state) => listItems(state.userScenarios, ["title", "description"]),
  },
  {
    id: "scope",
    title: "6. 需求范围",
    type: "scope",
    paths: ["pages", "features"],
    render: (state) =>
      [
        listItems(state.pages, ["name", "description", "purpose"]),
        listItems(state.features, ["name", "description"]),
      ]
        .filter(Boolean)
        .join("\n"),
  },
  {
    id: "page_requirements",
    title: "7. 页面需求",
    type: "page_requirements",
    paths: ["pages"],
    render: (state) => listItems(state.pages, ["name", "description", "purpose", "interactions"]),
  },
  {
    id: "backend_configs",
    title: "8. 后台配置需求",
    type: "backend_configs",
    paths: ["backendConfigs"],
    render: (state) => listItems(state.backendConfigs, ["name", "description", "validationRules", "affects"]),
  },
  {
    id: "frontend_rules",
    title: "9. 前端展示规则",
    type: "frontend_rules",
    paths: ["frontendRules"],
    render: (state) => listItems(state.frontendRules, ["title", "description"]),
  },
  {
    id: "business_rules",
    title: "10. 业务规则",
    type: "business_rules",
    paths: ["businessRules"],
    render: (state) => listItems(state.businessRules, ["title", "description"]),
  },
  {
    id: "state_rules",
    title: "11. 状态规则",
    type: "state_rules",
    paths: ["stateRules"],
    render: (state) => listItems(state.stateRules, ["name", "description", "conditions", "userVisibleText"]),
  },
  {
    id: "exception_scenarios",
    title: "12. 异常场景",
    type: "exception_scenarios",
    paths: ["exceptionScenarios"],
    render: (state) => listItems(state.exceptionScenarios, ["title", "trigger", "expectedBehavior", "userMessage"]),
  },
  {
    id: "acceptance_criteria",
    title: "13. 验收标准",
    type: "acceptance_criteria",
    paths: ["acceptanceCriteria"],
    render: (state) => listItems(state.acceptanceCriteria, ["title", "description"]),
  },
  {
    id: "assumptions",
    title: "14. AI 推断说明",
    type: "assumptions",
    paths: ["assumptions"],
    tags: ["ai_assumption"],
    render: (state) => listItems(state.assumptions, ["content", "reason", "status"]),
  },
  {
    id: "knowledge_refs",
    title: "15. 知识库引用",
    type: "knowledge_refs",
    paths: ["knowledgeRefs"],
    tags: ["knowledge_base"],
    render: (state) => listItems(state.knowledgeRefs, ["title", "snippet", "content", "type"]),
  },
  {
    id: "pending_questions",
    title: "16. 待确认问题",
    type: "pending_questions",
    paths: ["pendingQuestions"],
    tags: ["pending_question"],
    render: (state) => listItems(state.pendingQuestions, ["question", "title", "reason", "status"]),
  },
];

function toSection(config: SectionConfig, state: ProductDesignState, order: number): RequirementDocSection {
  const content = sanitizePrdContent(config.render(state)) || "暂无";
  const tags = uniqueTags([...(config.tags ?? []), ...tagsFromPaths(state, config.paths)]);
  return {
    id: config.id,
    title: config.title,
    type: config.type,
    level: 1,
    order,
    content,
    blocks: [
      {
        id: `${config.id}_body`,
        type: content.includes("\n- ") || content.startsWith("- ") ? "bullet_list" : "paragraph",
        content,
        sourcePaths: config.paths,
        tags,
      },
    ],
    sourcePaths: config.paths,
    sourceStatePaths: config.paths,
    tags,
  };
}

function normalizeSections(
  sections: RequirementDocSection[],
  fallbackSections: RequirementDocSection[],
): RequirementDocSection[] {
  return fallbackSections.map((fallback, index) => {
    const section = sections.find((item) => item.id === fallback.id) ?? sections[index] ?? fallback;
    const content = sanitizePrdContent(safeText(section.content)) || fallback.content;
    const sourcePaths = arrayOfText(section.sourcePaths).length
      ? arrayOfText(section.sourcePaths)
      : arrayOfText(section.sourceStatePaths).length
        ? arrayOfText(section.sourceStatePaths)
        : fallback.sourcePaths;
    const tags = uniqueTags([...arrayOfTags(section.tags), ...(fallback.tags ?? [])]);
    return {
      id: safeText(section.id) || fallback.id,
      title: safeText(section.title) || fallback.title,
      type: isSectionType(section.type) ? section.type : fallback.type,
      level: section.level === 2 || section.level === 3 ? section.level : 1,
      order: typeof section.order === "number" ? section.order : fallback.order,
      content,
      blocks: Array.isArray(section.blocks) && section.blocks.length
        ? section.blocks.map((block, blockIndex) => ({
            id: safeText(block.id) || `${fallback.id}_block_${blockIndex + 1}`,
            type: isBlockType(block.type) ? block.type : "paragraph",
            content: sanitizePrdContent(safeText(block.content)) || content,
            sourcePaths: arrayOfText(block.sourcePaths).length ? arrayOfText(block.sourcePaths) : sourcePaths,
            tags: uniqueTags([...arrayOfTags(block.tags), ...tags]),
          }))
        : fallback.blocks,
      sourcePaths,
      sourceStatePaths: sourcePaths,
      tags,
    };
  });
}

function normalizeAssumptionRefs(value: unknown, state: ProductDesignState): AssumptionReference[] {
  if (Array.isArray(value)) {
    const normalized = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      return [
        {
          assumptionId: safeText(record.assumptionId) || safeText(record.id),
          content: safeText(record.content),
          relatedSectionIds: arrayOfText(record.relatedSectionIds),
          status: normalizeAssumptionStatus(record.status),
        },
      ];
    });
    return normalized.length || !state.assumptions.length
      ? normalized
      : normalizeAssumptionRefs(undefined, state);
  }
  return state.assumptions.map((item) => ({
    assumptionId: safeText(item.id),
    content: safeText(item.content) || safeText(item.description),
    relatedSectionIds: ["assumptions"],
    status: normalizeAssumptionStatus(item.status),
  }));
}

function normalizeQuestionRefs(value: unknown, state: ProductDesignState): ClarificationQuestionReference[] {
  if (Array.isArray(value)) {
    const normalized = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      return [
        {
          questionId: safeText(record.questionId) || safeText(record.id),
          question: safeText(record.question) || safeText(record.title),
          reason: safeText(record.reason),
          relatedSectionIds: arrayOfText(record.relatedSectionIds),
          status: normalizeQuestionStatus(record.status),
        },
      ];
    });
    return normalized.length || !state.pendingQuestions.length
      ? normalized
      : normalizeQuestionRefs(undefined, state);
  }
  return state.pendingQuestions.map((item) => ({
    questionId: safeText(item.id),
    question: safeText(item.question) || safeText(item.title),
    reason: safeText(item.reason),
    relatedSectionIds: ["pending_questions"],
    status: normalizeQuestionStatus(item.status),
  }));
}

function listItems(items: Array<Record<string, unknown>>, keys: string[]) {
  if (!items.length) return "暂无";
  return items
    .map((item) => {
      const values = keys.flatMap((key) => formatValue(item[key])).filter(Boolean);
      return values.length ? `- ${values.join("：")}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatValue(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [];
}

function tagsFromPaths(state: ProductDesignState, paths: string[]): RequirementDocTag[] {
  const tags: RequirementDocTag[] = [];
  if (paths.includes("assumptions") && state.assumptions.length) tags.push("ai_assumption");
  if (paths.includes("knowledgeRefs") && state.knowledgeRefs.length) tags.push("knowledge_base");
  if (paths.includes("pendingQuestions") && state.pendingQuestions.length) tags.push("pending_question");
  if (state.confirmedFacts.some((fact) => paths.includes(safeText(fact.relatedPath)))) tags.push("user_confirmed");
  return tags;
}

function sanitizeNotes(value: unknown) {
  const notes = Array.isArray(value) ? value.map(safeText).filter(Boolean) : [];
  return notes.length
    ? notes.map(sanitizePrdContent).filter(Boolean)
    : ["PRD 已按 ProductDesignState 渲染，未包含接口、SQL、代码、数据库或部署实现细节。"];
}

function sanitizePrdContent(value: string) {
  const bannedPatterns = [
    /https?:\/\/\S+/gi,
    /\b(GET|POST|PUT|PATCH|DELETE)\s+\/\S+/gi,
    /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE TABLE\b/gi,
    /```[\s\S]*?```/g,
  ];
  return bannedPatterns.reduce((text, pattern) => text.replace(pattern, ""), value).trim();
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(safeText).filter(Boolean) : [];
}

function arrayOfTags(value: unknown): RequirementDocTag[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is RequirementDocTag =>
    tag === "ai_assumption" ||
    tag === "knowledge_base" ||
    tag === "user_confirmed" ||
    tag === "pending_question",
  );
}

function uniqueTags(tags: RequirementDocTag[]) {
  return [...new Set(tags)];
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAssumptionStatus(value: unknown): "pending" | "confirmed" | "rejected" {
  if (value === "confirmed" || value === "rejected") return value;
  return "pending";
}

function normalizeQuestionStatus(value: unknown): "pending" | "answered" | "skipped" {
  if (value === "answered" || value === "skipped") return value;
  return "pending";
}

function isSectionType(value: unknown): value is RequirementDocSectionType {
  return SECTION_CONFIGS.some((config) => config.type === value) || value === "appendix";
}

function isBlockType(value: unknown): value is "paragraph" | "bullet_list" | "table" | "quote" | "warning" | "info" {
  return value === "paragraph" || value === "bullet_list" || value === "table" || value === "quote" || value === "warning" || value === "info";
}
