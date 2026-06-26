import { Injectable } from "@nestjs/common";
import type {
  KnowledgeContext,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QACheckType,
  QAIssue,
  RequirementDocument,
} from "./ai-vibe.types";

export type QaRuleCheckInput = {
  productDesignState?: ProductDesignState | null;
  prdDocument?: RequirementDocument | null;
  prototypeSpec?: PrototypeSpec | null;
  prototypeArtifact?: PrototypeArtifact | null;
  knowledgeContext?: KnowledgeContext;
  checkTypes?: QACheckType[];
};

@Injectable()
export class QaRuleCheckService {
  run(input: QaRuleCheckInput): QAIssue[] {
    const enabled = new Set<QACheckType>(input.checkTypes ?? DEFAULT_CHECK_TYPES);
    const issues: QAIssue[] = [];
    const state = input.productDesignState;
    const prd = input.prdDocument;
    const spec = input.prototypeSpec;
    const artifact = input.prototypeArtifact;

    if (enabled.has("state_schema")) {
      if (!state) {
        issues.push(issue({
          id: "qa_state_missing",
          checkType: "state_schema",
          severity: "blocking",
          title: "ProductDesignState 不存在",
          description: "项目缺少 ProductDesignState，无法生成可信的 PRD 或原型。",
          relatedStatePaths: ["*"],
          suggestion: "先通过对话生成或恢复 ProductDesignState。",
        }));
      } else {
        if (!state.pages.length) {
          issues.push(issue({
            id: "qa_state_pages_empty",
            checkType: "state_schema",
            severity: "blocking",
            title: "缺少页面定义",
            description: "ProductDesignState.pages 为空，PRD 与原型缺少页面范围依据。",
            relatedStatePaths: ["pages"],
            suggestion: "补充核心页面、页面用途和入口关系。",
          }));
        }
        if (!state.businessRules.length) {
          issues.push(issue({
            id: "qa_state_business_rules_empty",
            checkType: "state_schema",
            severity: "major",
            title: "缺少业务规则",
            description: "ProductDesignState.businessRules 为空，可能导致后续 PRD 与原型缺少业务约束。",
            relatedStatePaths: ["businessRules"],
            suggestion: "补充关键业务规则或明确说明该阶段没有业务规则。",
          }));
        }
        const pendingQuestions = state.pendingQuestions.filter((item) => text(item.status) !== "answered");
        if (pendingQuestions.length) {
          issues.push(issue({
            id: "qa_pending_questions",
            checkType: "assumption_risk",
            severity: "info",
            title: "存在待确认问题",
            description: `当前仍有 ${pendingQuestions.length} 个 pending question，后续确认可能改变 PRD 或原型。`,
            relatedStatePaths: ["pendingQuestions"],
            suggestion: "优先回答影响范围、规则和关键状态的问题。",
          }));
        }
        const pendingAssumptions = state.assumptions.filter((item) => {
          const status = text(item.status);
          return !status || status === "pending";
        });
        if (pendingAssumptions.length) {
          issues.push(issue({
            id: "qa_pending_assumptions",
            checkType: "assumption_risk",
            severity: "info",
            title: "存在未确认 AI 推断",
            description: `当前仍有 ${pendingAssumptions.length} 个 AI assumption 未确认。`,
            relatedStatePaths: ["assumptions"],
            suggestion: "确认、否定或补充这些推断，避免被误当成正式规则。",
          }));
        }
      }
    }

    if (enabled.has("prd_completeness")) {
      if (!prd) {
        issues.push(issue({
          id: "qa_prd_missing",
          checkType: "prd_completeness",
          severity: "blocking",
          title: "PRD 不存在",
          description: "项目尚未生成当前 ProductDesignState 对应的 PRD。",
          suggestion: "基于当前 ProductDesignState 重新生成 PRD。",
        }));
      } else if (!prd.sections.length) {
        issues.push(issue({
          id: "qa_prd_sections_empty",
          checkType: "prd_completeness",
          severity: "blocking",
          title: "PRD 缺少章节",
          description: "RequirementDocument.sections 为空，无法完成需求评审。",
          relatedPrdSectionIds: [],
          suggestion: "重新生成 PRD 或修复 PRD 渲染链路。",
        }));
      }
    }

    if (enabled.has("prototype_completeness")) {
      if (!artifact) {
        issues.push(issue({
          id: "qa_prototype_missing",
          checkType: "prototype_completeness",
          severity: "blocking",
          title: "HTML 原型不存在",
          description: "项目尚未生成当前 ProductDesignState 对应的 HTML 原型。",
          suggestion: "基于当前 ProductDesignState 重新生成 PrototypeSpec 与 HTML 原型。",
        }));
      } else if (artifact.status !== "ready") {
        issues.push(issue({
          id: "qa_prototype_not_ready",
          checkType: "prototype_completeness",
          severity: "blocking",
          title: "HTML 原型不可用",
          description: `PrototypeArtifact.status = ${artifact.status}，当前原型不可用于评审。`,
          relatedPrototypePageIds: spec?.pages.map((page) => page.id).slice(0, 5),
          suggestion: "修复原型生成失败原因后重新生成。",
        }));
      }
      if (!spec || !spec.pages.length) {
        issues.push(issue({
          id: "qa_prototype_spec_pages_empty",
          checkType: "prototype_completeness",
          severity: "blocking",
          title: "PrototypeSpec 缺少页面",
          description: "PrototypeSpec.pages 为空，HTML 原型缺少结构化页面来源。",
          suggestion: "重新生成 PrototypeSpec。",
        }));
      }
    }

    if (state && prd && enabled.has("state_prd_consistency")) {
      const prdText = JSON.stringify(prd.sections);
      const missingPages = state.pages.filter((page) => {
        const name = entityName(page);
        return name && !prdText.includes(name);
      });
      if (missingPages.length) {
        issues.push(issue({
          id: "qa_state_prd_missing_pages",
          checkType: "state_prd_consistency",
          severity: "major",
          title: "PRD 未覆盖部分页面",
          description: `PRD 未明确覆盖 ${missingPages.length} 个 ProductDesignState 页面。`,
          relatedStatePaths: missingPages.map((page) => `pages.${text(page.id) || entityName(page)}`),
          relatedPrdSectionIds: prd.sections.map((section) => section.id).slice(0, 5),
          suggestion: "补充页面需求章节或重新生成 PRD。",
        }));
      }
    }

    if (state && spec && enabled.has("state_prototype_consistency")) {
      const specText = JSON.stringify(spec.pages);
      const missingPages = state.pages.filter((page) => {
        const name = entityName(page);
        return name && !specText.includes(name);
      });
      if (missingPages.length) {
        issues.push(issue({
          id: "qa_state_prototype_missing_pages",
          checkType: "state_prototype_consistency",
          severity: "major",
          title: "原型未覆盖部分页面",
          description: `PrototypeSpec 未明确覆盖 ${missingPages.length} 个 ProductDesignState 页面。`,
          relatedStatePaths: missingPages.map((page) => `pages.${text(page.id) || entityName(page)}`),
          relatedPrototypePageIds: spec.pages.map((page) => page.id).slice(0, 5),
          suggestion: "补充原型页面或重新生成 PrototypeSpec。",
        }));
      }
    }

    if (prd && spec && enabled.has("prd_prototype_consistency")) {
      const specText = JSON.stringify(spec.pages);
      const pageSections = prd.sections.filter((section) =>
        section.type === "page_requirements" || section.sourcePaths?.includes("pages"),
      );
      const missingSections = pageSections.filter((section) => {
        const normalized = section.content.replace(/\s+/g, "");
        if (!normalized || normalized === "暂无") return false;
        return !specText.includes(section.title.replace(/^\d+\.\s*/, "").slice(0, 8));
      });
      if (missingSections.length && !spec.pages.length) {
        issues.push(issue({
          id: "qa_prd_prototype_missing_mapping",
          checkType: "prd_prototype_consistency",
          severity: "major",
          title: "PRD 页面需求与原型缺少映射",
          description: "PRD 中存在页面需求，但原型页面未能建立可识别映射。",
          relatedPrdSectionIds: missingSections.map((section) => section.id),
          relatedPrototypePageIds: spec.pages.map((page) => page.id).slice(0, 5),
          suggestion: "重新生成原型或补充 sourcePaths/sourcePageId。",
        }));
      }
    }

    if (enabled.has("knowledge_rule_compliance")) {
      for (const rule of input.knowledgeContext?.strongRules ?? []) {
        const haystack = JSON.stringify({ state, prd, spec });
        const signature = rule.content.slice(0, 12);
        if (signature && !haystack.includes(signature)) {
          issues.push(issue({
            id: `qa_strong_rule_${rule.knowledgeId ?? rule.id}`,
            checkType: "knowledge_rule_compliance",
            severity: "major",
            title: `强规则未明确体现：${rule.title}`,
            description: "知识库 strong_rule 未在当前 ProductDesignState、PRD 或 PrototypeSpec 中明确体现。",
            relatedKnowledgeIds: [rule.knowledgeId ?? rule.id],
            suggestion: "将该规则补充到 ProductDesignState 并重新生成 PRD/Prototype。",
          }));
        }
      }
      if (state) {
        for (const skill of input.knowledgeContext?.agentSkills ?? []) {
          if (isSkillReferencedByState(skill, state)) continue;
          issues.push(issue({
            id: `qa_skill_reference_missing_${safeId(skill.name)}`,
            checkType: "knowledge_rule_compliance",
            severity: "major",
            title: `Vibe Coding Skill 未落入 ProductDesignState：${skill.name}`,
            description: "本轮 runtime context 已加载该 skill，但 ProductDesignState.knowledgeRefs 未保留对应 knowledgeId、sourcePath 或名称，PRD、原型和调试链路无法追踪该执行约束。",
            relatedStatePaths: ["knowledgeRefs"],
            relatedKnowledgeIds: [skill.id || `agent-skill:${skill.name}`],
            suggestion: "先将该 skill 写入 ProductDesignState.knowledgeRefs，再重新生成 PRD、PrototypeSpec 和 QA。",
          }));
        }
      }
    }

    return issues;
  }
}

export const DEFAULT_CHECK_TYPES: QACheckType[] = [
  "state_schema",
  "prd_completeness",
  "prototype_completeness",
  "state_prd_consistency",
  "state_prototype_consistency",
  "prd_prototype_consistency",
  "knowledge_rule_compliance",
  "assumption_risk",
];

function issue(input: Omit<QAIssue, "status" | "autoFixable" | "createdAt" | "updatedAt"> & {
  status?: QAIssue["status"];
  autoFixable?: boolean;
}): QAIssue {
  const now = new Date().toISOString();
  return {
    ...input,
    status: input.status ?? "open",
    autoFixable: input.autoFixable ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function entityName(value: Record<string, unknown>) {
  return text(value.name) || text(value.title) || text(value.label);
}

function isSkillReferencedByState(
  skill: NonNullable<KnowledgeContext["agentSkills"]>[number],
  state: ProductDesignState,
) {
  const haystack = JSON.stringify(state.knowledgeRefs ?? []);
  return [skill.id, `agent-skill:${skill.name}`, skill.name, skill.sourcePath]
    .filter(Boolean)
    .some((token) => haystack.includes(token));
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}
