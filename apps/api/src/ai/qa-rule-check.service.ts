import { Injectable } from "@nestjs/common";
import { KnowledgeType } from "@prisma/client";
import type {
  KnowledgeContext,
  ConversationDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QACheckType,
  QAIssue,
  RequirementDocument,
} from "./ai-vibe.types";

export type QaRuleCheckInput = {
  conversationDesignState?: ConversationDesignState | null;
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
    const state = input.conversationDesignState;
    const prd = input.prdDocument;
    const spec = input.prototypeSpec;
    const artifact = input.prototypeArtifact;

    if (enabled.has("state_schema")) {
      if (!state) {
        issues.push(issue({
          id: "qa_state_missing",
          checkType: "state_schema",
          severity: "blocking",
          title: "ConversationDesignState 不存在",
          description: "项目缺少 ConversationDesignState，无法生成可信的 PRD 或原型。",
          relatedStatePaths: ["*"],
          suggestion: "先通过对话生成或恢复 ConversationDesignState。",
        }));
      } else {
        if (!state.businessGoal.trim() || /待补充|待确认|暂未明确|后续明确/.test(state.businessGoal)) {
          issues.push(issue({
            id: "qa_state_business_goal_missing",
            checkType: "state_schema",
            severity: "blocking",
            title: "缺少可评审业务目标",
            description: "ConversationDesignState.businessGoal 为空或仍是占位话术。",
            relatedStatePaths: ["businessGoal"],
            suggestion: "根据当前业务域明确目标对象、期望变化和可衡量结果，再继续生成产物。",
          }));
        }
        if (!state.pages.length) {
          issues.push(issue({
            id: "qa_state_pages_empty",
            checkType: "state_schema",
            severity: "blocking",
            title: "缺少页面定义",
            description: "ConversationDesignState.pages 为空，PRD 与原型缺少页面范围依据。",
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
            description: "ConversationDesignState.businessRules 为空，可能导致后续 PRD 与原型缺少业务约束。",
            relatedStatePaths: ["businessRules"],
            suggestion: "补充关键业务规则或明确说明该阶段没有业务规则。",
          }));
        }
        const stateGroups: Array<[string, Array<Record<string, unknown>>]> = [
          ["目标用户", state.targetUsers],
          ["使用场景", state.userScenarios],
          ["功能清单", state.features],
          ["后台配置", state.backendConfigs],
          ["前台规则", state.frontendRules],
          ["状态规则", state.stateRules],
          ["异常场景", state.exceptionScenarios],
          ["验收标准", state.acceptanceCriteria],
        ];
        const missingStateGroups = stateGroups.filter(([, items]) => items.length === 0).map(([label]) => label);
        if (missingStateGroups.length) {
          issues.push(issue({
            id: "qa_state_required_groups_incomplete",
            checkType: "state_schema",
            severity: "major",
            title: "产品设计状态信息不完整",
            description: `缺少：${missingStateGroups.join("、")}。`,
            relatedStatePaths: missingStateGroups,
            suggestion: "先补齐目标用户、场景、前后台页面、功能、规则、状态、异常和验收，再生成正式 PRD 与原型。",
          }));
        }
        const unlabeledStateGroups = stateGroups
          .filter(([, items]) => items.some((item) => !entityName(item)))
          .map(([label]) => label);
        if (unlabeledStateGroups.length) {
          issues.push(issue({
            id: "qa_state_required_group_labels_missing",
            checkType: "state_schema",
            severity: "major",
            title: "产品设计状态存在不可核验条目",
            description: `以下分组存在缺少 name/title/label/role 的条目：${unlabeledStateGroups.join("、")}。`,
            relatedStatePaths: unlabeledStateGroups,
            suggestion: "为每个目标用户、场景、功能、配置、规则、状态、异常和验收项填写可识别名称。",
          }));
        }
      }
    }

    if (state && enabled.has("assumption_risk")) {
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

    if (enabled.has("prd_completeness")) {
      if (!prd) {
        issues.push(issue({
          id: "qa_prd_missing",
          checkType: "prd_completeness",
          severity: "blocking",
          title: "PRD 不存在",
          description: "项目尚未生成当前 ConversationDesignState 对应的 PRD。",
          suggestion: "基于当前 ConversationDesignState 重新生成 PRD。",
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
      } else {
        issues.push(...checkPrdContentQuality(prd));
      }
    }

    if (enabled.has("prototype_completeness")) {
      if (!artifact) {
        issues.push(issue({
          id: "qa_prototype_missing",
          checkType: "prototype_completeness",
          severity: "blocking",
          title: "HTML 原型不存在",
          description: "项目尚未生成当前 ConversationDesignState 对应的 HTML 原型。",
          suggestion: "基于当前 ConversationDesignState 重新生成 PrototypeSpec 与 HTML 原型。",
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
      if (artifact?.status === "ready") {
        issues.push(...checkPrototypeContentQuality({ state, prd, spec, artifact, knowledgeContext: input.knowledgeContext }));
      }
    }

    if (state && prd && enabled.has("state_prd_consistency")) {
      const prdText = JSON.stringify(prd.sections);
      const missingGroups = findMissingDesignCoverage(state, prdText, [
        "targetUsers",
        "userScenarios",
        "pages",
        "features",
        "backendConfigs",
        "frontendRules",
        "businessRules",
        "stateRules",
        "exceptionScenarios",
        "acceptanceCriteria",
      ]);
      if (missingGroups.length) {
        issues.push(issue({
          id: "qa_state_prd_incomplete_coverage",
          checkType: "state_prd_consistency",
          severity: "major",
          title: "PRD 未完整覆盖产品设计状态",
          description: formatMissingCoverageDescription(missingGroups),
          relatedStatePaths: missingGroups.flatMap((group) => group.missing.map((name) => `${group.key}.${name}`)),
          relatedPrdSectionIds: prd.sections.map((section) => section.id).slice(0, 5),
          suggestion: "按产品设计状态补齐目标用户、场景、页面、功能、配置、规则、状态、异常和验收。",
        }));
      }
    }

    if (state && spec && enabled.has("state_prototype_consistency")) {
      const specText = JSON.stringify(spec.pages);
      const missingGroups = findMissingDesignCoverage(state, specText, [
        "pages",
        "features",
        "backendConfigs",
        "frontendRules",
        "businessRules",
        "stateRules",
        "exceptionScenarios",
      ]);
      if (missingGroups.length) {
        issues.push(issue({
          id: "qa_state_prototype_incomplete_coverage",
          checkType: "state_prototype_consistency",
          severity: "major",
          title: "原型规格未完整覆盖产品设计状态",
          description: formatMissingCoverageDescription(missingGroups),
          relatedStatePaths: missingGroups.flatMap((group) => group.missing.map((name) => `${group.key}.${name}`)),
          relatedPrototypePageIds: spec.pages.map((page) => page.id).slice(0, 5),
          suggestion: "补齐前后台页面、功能、配置、业务规则、状态和异常场景，再重新生成 HTML 原型。",
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
        if (!knowledgeRuleCovered(rule, haystack)) {
          issues.push(issue({
            id: `qa_strong_rule_${rule.knowledgeId ?? rule.id}`,
            checkType: "knowledge_rule_compliance",
            severity: "major",
            title: `强规则未明确体现：${rule.title}`,
            description: "知识库 strong_rule 未在当前 ConversationDesignState、PRD 或 PrototypeSpec 中明确体现。",
            relatedKnowledgeIds: [rule.knowledgeId ?? rule.id],
            suggestion: "将该规则补充到 ConversationDesignState 并重新生成 PRD/Prototype。",
          }));
        }
      }
    }

    return issues;
  }
}

const REQUIRED_PRD_SECTION_PATTERNS: Array<[string, RegExp]> = [
  ["1 引言", /(^|\n)1\s*引言($|\n)/],
  ["1.1 项目背景", /(^|\n)1\.1\s*项目背景($|\n)/],
  ["1.2 文档范围", /(^|\n)1\.2\s*文档范围($|\n)/],
  ["1.3 使用场景（必填）", /(^|\n)1\.3\s*使用场景（必填）($|\n)/],
  ["2 业务需求", /(^|\n)2\s*业务需求($|\n)/],
  ["2.1 页面链接", /(^|\n)2\.1\s*页面链接($|\n)/],
  ["2.2 核心业务规则/功能说明", /(^|\n)2\.2\s*核心业务规则\/功能说明($|\n)/],
  ["2.3 核心流程/状态/页面要求", /(^|\n)2\.3\s*核心流程\/状态\/页面要求($|\n)/],
  ["2.4 验收标准", /(^|\n)2\.4\s*验收标准($|\n)/],
  ["3 业务降级方案（必填）", /(^|\n)3\s*业务降级方案（必填）($|\n)/],
  ["4 需求安全基线要求（必填）", /(^|\n)4\s*需求安全基线要求（必填）($|\n)/],
];

const GENERATION_TRACE_PATTERNS = [
  "用户输入：",
  "原始需求：",
  "用户原话",
  "知识库打底",
  "知识库命中",
  "公开资料补齐",
  "模型补齐",
  "联网补齐",
  "补齐策略",
  "公开证据",
  "外部参考",
  "externalResearch",
  "Building an Effective Loyalty Program",
  "Idempotent requests",
  "429 Too Many Requests",
  "模型生成超过时间盒",
  "可编辑初稿",
];

const VAGUE_PRD_PATTERNS = [
  "待补充业务目标",
  "以实际上线地址为准",
  "待确认",
  "符合评审确认范围",
  "按业务评审确认后执行",
  "以本需求评审确认的配置和规则为准",
  "具体上线范围以业务评审、技术方案和联调结果为准",
  "需明确触发条件、前置校验、成功结果、失败处理、重复操作规则和数据记录口径",
];

function checkPrdContentQuality(prd: RequirementDocument): QAIssue[] {
  const issues: QAIssue[] = [];
  const titleText = prd.sections.map((section) => section.title).join("\n");
  const bodyText = stringifyPrdSections(prd);

  const missingSections = REQUIRED_PRD_SECTION_PATTERNS
    .filter(([, pattern]) => !pattern.test(titleText))
    .map(([label]) => label);
  if (missingSections.length) {
    issues.push(issue({
      id: "qa_prd_standard_sections_missing",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "PRD 未符合固定章节结构",
      description: `缺少固定章节：${missingSections.join("、")}。`,
      relatedPrdSectionIds: prd.sections.map((section) => section.id).slice(0, 8),
      suggestion: "按固定 Word 需求说明书结构重新生成，不要输出自由格式摘要。",
    }));
  }

  const emptySections = prd.sections.filter((section) =>
    section.id !== "manual_toc" && !section.content.trim() && !(section.blocks?.length),
  );
  if (emptySections.length) {
    issues.push(issue({
      id: "qa_prd_empty_sections",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "PRD 存在空章节",
      description: `空章节：${emptySections.map((section) => section.title).join("、")}。`,
      relatedPrdSectionIds: emptySections.map((section) => section.id),
      suggestion: "每个保留章节都必须写出可评审内容；无关章节应删除。",
    }));
  }

  if (/(^|\n|\s)(?:\d+(?:\.\d+)?\s*)?本需求涉及新增\/修改的接口/.test(bodyText)) {
    issues.push(issue({
      id: "qa_prd_forbidden_interface_section",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "PRD 包含已禁用的接口章节",
      description: "用户已明确要求删除“本需求涉及新增/修改的接口”这类独立接口章节。",
      relatedPrdSectionIds: prd.sections
        .filter((section) => /本需求涉及新增\/修改的接口/.test(`${section.title}\n${section.content}`))
        .map((section) => section.id),
      suggestion: "删除独立接口章节，将安全相关内容保留在安全基线表内。",
    }));
  }

  const hasFlowDiagram = prd.sections.some((section) =>
    /产品流程图/.test(`${section.title}\n${section.content}`)
    || section.blocks?.some((block) => block.type === "diagram" && /产品流程图|流程/.test(`${block.title ?? ""}\n${block.content}`)),
  );
  const hasArchitectureDiagram = prd.sections.some((section) =>
    /产品架构图/.test(`${section.title}\n${section.content}`)
    || section.blocks?.some((block) => block.type === "diagram" && /产品架构图|架构/.test(`${block.title ?? ""}\n${block.content}`)),
  );
  if (!hasFlowDiagram || !hasArchitectureDiagram) {
    issues.push(issue({
      id: "qa_prd_required_diagrams_missing",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "PRD 缺少产品流程图或产品架构图",
      description: `当前${hasFlowDiagram ? "已包含产品流程图" : "缺少产品流程图"}，${hasArchitectureDiagram ? "已包含产品架构图" : "缺少产品架构图"}。`,
      relatedPrdSectionIds: prd.sections.map((section) => section.id).slice(0, 8),
      suggestion: "在 2.3 核心流程/状态/页面要求中补充两个 Mermaid 图，并写清与需求的关系。",
    }));
  }

  const traceHits = GENERATION_TRACE_PATTERNS.filter((pattern) => bodyText.includes(pattern));
  if (traceHits.length) {
    issues.push(issue({
      id: "qa_prd_contains_generation_trace",
      checkType: "prd_completeness",
      severity: "major",
      title: "PRD 正文包含生成过程痕迹",
      description: `命中不应展示给业务评审的过程词：${traceHits.join("、")}。`,
      relatedPrdSectionIds: prd.sections.map((section) => section.id).slice(0, 8),
      suggestion: "仅保留业务结论、规则、流程、验收和降级方案，不展示知识库/联网/模型补齐过程。",
    }));
  }

  const vagueHits = VAGUE_PRD_PATTERNS.filter((pattern) => bodyText.includes(pattern));
  if (vagueHits.length) {
    issues.push(issue({
      id: "qa_prd_vague_fallback_text",
      checkType: "prd_completeness",
      severity: "major",
      title: "PRD 存在泛化兜底话术",
      description: `命中泛化话术：${vagueHits.join("、")}。`,
      relatedPrdSectionIds: prd.sections.map((section) => section.id).slice(0, 8),
      suggestion: "改为具体业务字段、触发条件、状态、异常和验收口径。",
    }));
  }

  return issues;
}

function checkPrototypeContentQuality(input: {
  state?: ConversationDesignState | null;
  prd?: RequirementDocument | null;
  spec?: PrototypeSpec | null;
  artifact: PrototypeArtifact;
  knowledgeContext?: KnowledgeContext;
}): QAIssue[] {
  const issues: QAIssue[] = [];
  const html = String(input.artifact.htmlContent ?? input.artifact.html ?? "");
  const prototypeKnowledgeRefs = collectKnowledgeReferences(input.knowledgeContext)
    .filter((ref) => ref.type === KnowledgeType.prototype_asset_ref
      || ref.type === KnowledgeType.prototype_rule
      || /原型资产|高保真HTML原型框架|Axure|RP资产|HTML原型|页面框架/.test(`${ref.title}\n${ref.content}`));

  if (html.trim()) {
    if (!/^<!doctype\s+html/i.test(html.trim()) || !/<html[\s>]/i.test(html) || !/<style[\s>][\s\S]*<\/style>/i.test(html)) {
      issues.push(issue({
        id: "qa_prototype_not_standalone_html",
        checkType: "prototype_completeness",
        severity: "blocking",
        title: "原型不是完整高保真 HTML 文档",
        description: "HTML 原型必须包含 doctype、html 根节点和内联样式，不能只是片段。",
        suggestion: "重新生成完整 standalone HTML 原型。",
      }));
    }

    const traceHits = GENERATION_TRACE_PATTERNS.filter((pattern) => html.includes(pattern));
    const prototypeReviewOnlyHits = [
      "当前原型用于",
      "用于评审后台配置",
      "业务覆盖",
      "评审覆盖",
      "知识覆盖",
    ].filter((pattern) => html.includes(pattern));
    if (traceHits.length) {
      issues.push(issue({
        id: "qa_prototype_contains_generation_trace",
        checkType: "prototype_completeness",
        severity: "blocking",
        title: "原型页面包含生成过程痕迹",
        description: `命中不应出现在页面里的过程词：${traceHits.join("、")}。`,
        suggestion: "原型页面只呈现最终业务界面，不展示知识库、联网、模型补齐和工具日志。",
      }));
    }
    if (prototypeReviewOnlyHits.length) {
      issues.push(issue({
        id: "qa_prototype_contains_review_scaffold",
        checkType: "prototype_completeness",
        severity: "major",
        title: "原型页面包含评审说明脚手架",
        description: `命中不应作为产品界面出现的说明块：${prototypeReviewOnlyHits.join("、")}。`,
        suggestion: "把评审说明改成真实产品页面，例如审核流转、报表筛选、异常列表或前台状态，而不是说明原型覆盖了什么。",
      }));
    }

    if (!/(后台|运营|管理|配置中心|工作台)/.test(html) || !/(前台|用户端|客户端|用户页面|用户入口|移动端)/.test(html)) {
      issues.push(issue({
        id: "qa_prototype_missing_front_back_views",
        checkType: "prototype_completeness",
        severity: "major",
        title: "原型未同时覆盖前台和后台",
        description: "完整原型需要同时体现后台配置/治理页面和用户前台使用页面。",
        suggestion: "依据本轮知识库页面框架补齐后台配置、审核/处理、数据治理，以及前台核心操作、结果反馈和异常状态。",
      }));
    }

    if (!/<(?:table|form|input|select|textarea|button)\b/i.test(html)) {
      issues.push(issue({
        id: "qa_prototype_lacks_interactive_controls",
        checkType: "prototype_completeness",
        severity: "major",
        title: "原型缺少可评审控件密度",
        description: "高保真原型至少需要表格、表单控件或操作按钮来表达配置、查询和用户操作。",
        suggestion: "按知识库高保真 HTML 原型框架补充配置表单、状态表格、按钮和提示态。",
      }));
    }

    const stateCoverage = findMissingDesignCoverage(input.state, html, [
      "pages",
      "features",
      "backendConfigs",
      "frontendRules",
      "businessRules",
      "stateRules",
      "exceptionScenarios",
    ]);
    if (stateCoverage.length) {
      issues.push(issue({
        id: "qa_prototype_html_incomplete_state_coverage",
        checkType: "prototype_completeness",
        severity: "major",
        title: "HTML 原型未完整覆盖产品设计状态",
        description: formatMissingCoverageDescription(stateCoverage),
        relatedPrototypePageIds: input.spec?.pages.map((page) => page.id).slice(0, 8),
        suggestion: "把设计状态中的页面、功能、配置、规则、状态和异常场景落实为可见页面内容。",
      }));
    }

    const specCoverage = findMissingPrototypeSpecCoverage(input.spec, html);
    if (specCoverage.length) {
      issues.push(issue({
        id: "qa_prototype_html_incomplete_spec_coverage",
        checkType: "prototype_completeness",
        severity: "major",
        title: "HTML 原型未完整实现 PrototypeSpec",
        description: `未呈现：${specCoverage.slice(0, 12).join("、")}。`,
        relatedPrototypePageIds: input.spec?.pages.map((page) => page.id).slice(0, 8),
        suggestion: "按 PrototypeSpec 补齐页面、组件和关键状态，不要只生成结构相似的演示页。",
      }));
    }

    const frameworkCoverage = findMissingKnowledgeFrameworkCoverage(prototypeKnowledgeRefs, html);
    if (frameworkCoverage.length) {
      issues.push(issue({
        id: "qa_prototype_knowledge_framework_incomplete",
        checkType: "knowledge_rule_compliance",
        severity: "major",
        title: "原型未完整复用知识库页面框架",
        description: `未覆盖：${frameworkCoverage.slice(0, 10).join("、")}。`,
        relatedKnowledgeIds: prototypeKnowledgeRefs.map((ref) => ref.knowledgeId ?? ref.id).slice(0, 8),
        suggestion: "按本轮召回的原型知识表格逐组补齐必须字段、控件和状态。",
      }));
    }
  }

  const prototypeAssetRefs = prototypeKnowledgeRefs
    .filter((ref) => ref.type === KnowledgeType.prototype_asset_ref || /原型资产|高保真HTML原型框架|Axure|RP资产|HTML原型/.test(`${ref.title}\n${ref.content}`));
  if (prototypeAssetRefs.length && !artifactUsesPrototypeAsset(input, prototypeAssetRefs)) {
    issues.push(issue({
      id: "qa_prototype_asset_ref_not_used",
      checkType: "knowledge_rule_compliance",
      severity: "major",
      title: "原型资产知识未被最终产物引用",
      description: `知识库命中了原型资产/框架，但 PRD 或原型规格未体现引用：${prototypeAssetRefs.map((ref) => ref.title).slice(0, 3).join("、")}。`,
      relatedKnowledgeIds: prototypeAssetRefs.map((ref) => ref.knowledgeId ?? ref.id).slice(0, 5),
      suggestion: "在 knowledgeRefsUsed / PrototypeSpec.knowledgeRefs 中引用原型资产，并按其信息架构生成页面。",
    }));
  }

  return issues;
}

function stringifyPrdSections(prd?: RequirementDocument | null) {
  if (!prd) return "";
  return prd.sections.map((section) => [
    section.title,
    section.content,
    ...(section.blocks ?? []).map((block) => `${block.title ?? ""}\n${block.content}`),
  ].join("\n")).join("\n");
}

type DesignCoverageKey =
  | "targetUsers"
  | "userScenarios"
  | "pages"
  | "features"
  | "backendConfigs"
  | "frontendRules"
  | "businessRules"
  | "stateRules"
  | "exceptionScenarios"
  | "acceptanceCriteria";

type MissingCoverageGroup = {
  key: DesignCoverageKey;
  label: string;
  missing: string[];
  total: number;
};

const DESIGN_COVERAGE_LABELS: Record<DesignCoverageKey, string> = {
  targetUsers: "目标用户",
  userScenarios: "使用场景",
  pages: "页面",
  features: "功能",
  backendConfigs: "后台配置",
  frontendRules: "前台规则",
  businessRules: "业务规则",
  stateRules: "状态规则",
  exceptionScenarios: "异常场景",
  acceptanceCriteria: "验收标准",
};

function findMissingDesignCoverage(
  state: ConversationDesignState | null | undefined,
  artifactText: string,
  keys: DesignCoverageKey[],
): MissingCoverageGroup[] {
  if (!state) return [];
  return keys.flatMap((key) => {
    const names = (state[key] ?? [])
      .map((item) => entityName(item))
      .filter((name): name is string => Boolean(name) && name.length >= 2);
    if (!names.length) return [];
    const missing = names.filter((name) => !artifactContainsLabel(artifactText, name));
    const hitRatio = (names.length - missing.length) / names.length;
    return hitRatio >= 0.75 ? [] : [{
      key,
      label: DESIGN_COVERAGE_LABELS[key],
      missing,
      total: names.length,
    }];
  });
}

function formatMissingCoverageDescription(groups: MissingCoverageGroup[]) {
  return groups
    .map((group) => `${group.label}缺少 ${group.missing.slice(0, 5).join("、")}（共 ${group.total} 项）`)
    .join("；");
}

function findMissingPrototypeSpecCoverage(spec: PrototypeSpec | null | undefined, html: string) {
  if (!spec) return [];
  const labels: string[] = [];
  for (const page of spec.pages) {
    if (page.name?.trim()) labels.push(page.name.trim());
    for (const state of page.states ?? []) {
      if (state.name?.trim()) labels.push(state.name.trim());
    }
    collectPrototypeComponentLabels(page.components, labels);
  }
  const unique = [...new Set(labels.filter((label) => label.length >= 2))];
  if (!unique.length) return [];
  const missing = unique.filter((label) => !artifactContainsLabel(html, label));
  return (unique.length - missing.length) / unique.length >= 0.75 ? [] : missing;
}

function collectPrototypeComponentLabels(
  components: PrototypeSpec["pages"][number]["components"],
  output: string[],
) {
  for (const component of components ?? []) {
    if (component.name?.trim()) output.push(component.name.trim());
    collectPrototypeComponentLabels(component.children ?? [], output);
  }
}

function findMissingKnowledgeFrameworkCoverage(
  refs: ReturnType<typeof collectKnowledgeReferences>,
  html: string,
) {
  return refs.flatMap((ref) => extractKnowledgeFrameworkRequirements(ref.content).flatMap((requirement) => {
    const hitCount = requirement.terms.filter((term) => artifactContainsLabel(html, term)).length;
    const requiredHits = Math.min(3, Math.max(1, Math.ceil(requirement.terms.length * 0.35)));
    return hitCount >= requiredHits ? [] : [`${ref.title} / ${requirement.group}`];
  }));
}

function extractKnowledgeFrameworkRequirements(content: string) {
  const lines = content.split(/\r?\n/);
  const results: Array<{ group: string; terms: string[] }> = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headers = markdownTableCells(lines[index]);
    if (headers.length < 2 || !/^\s*\|?\s*:?-{3}/.test(lines[index + 1] ?? "")) continue;
    const groupColumn = headers.findIndex((header) => /分组|状态|页面|模块|区域/.test(header));
    const requirementColumn = headers.findIndex((header) => /必须|字段|控件|展示内容|必须展示/.test(header));
    if (groupColumn < 0 || requirementColumn < 0) continue;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = markdownTableCells(lines[rowIndex]);
      if (cells.length !== headers.length) break;
      const group = cleanKnowledgeTerm(cells[groupColumn]);
      const terms = cells[requirementColumn]
        .split(/、|，|；|;|<br\s*\/?>/i)
        .map(cleanKnowledgeTerm)
        .filter((term) => term.length >= 2 && term.length <= 24);
      if (group && terms.length) results.push({ group, terms: [...new Set(terms)] });
    }
  }
  return results;
}

function markdownTableCells(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
}

function cleanKnowledgeTerm(value: string) {
  return value
    .replace(/[`*_~]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/^(支持|展示|配置|包括|包含|需要|必须)/, "")
    .trim();
}

function artifactContainsLabel(artifactText: string, label: string) {
  const haystack = normalizeCoverageText(artifactText);
  const needle = normalizeCoverageText(label);
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const parts = label
    .split(/[：:、，；;\/\s]+/)
    .map(normalizeCoverageText)
    .filter((part) => part.length >= 2);
  return parts.length >= 2 && parts.filter((part) => haystack.includes(part)).length / parts.length >= 0.75;
}

function normalizeCoverageText(value: string) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

function knowledgeRuleCovered(
  rule: ReturnType<typeof collectKnowledgeReferences>[number],
  artifactText: string,
) {
  if (artifactContainsLabel(artifactText, rule.title)) return true;
  const terms = rule.content
    .split(/[，。；;、\n]|必须|需要|应当|不得|不可|并且|且/)
    .map(cleanKnowledgeTerm)
    .filter((term) => term.length >= 2 && term.length <= 24)
    .slice(0, 8);
  if (!terms.length) return true;
  const hits = terms.filter((term) => artifactContainsLabel(artifactText, term)).length;
  return hits / terms.length >= 0.6;
}

function collectKnowledgeReferences(context?: KnowledgeContext) {
  return [
    ...(context?.strongRules ?? []),
    ...(context?.defaultRules ?? []),
    ...(context?.referenceCases ?? []),
    ...(context?.designPatterns ?? []),
    ...(context?.prdWritingRules ?? []),
    ...(context?.prototypeRules ?? []),
    ...(context?.businessConcepts ?? []),
  ];
}

function artifactUsesPrototypeAsset(input: {
  state?: ConversationDesignState | null;
  prd?: RequirementDocument | null;
  spec?: PrototypeSpec | null;
}, refs: ReturnType<typeof collectKnowledgeReferences>) {
  const artifactText = JSON.stringify({
    stateRefs: input.state?.knowledgeRefs,
    prdRefs: input.prd?.knowledgeRefs,
    specRefs: input.spec?.knowledgeRefs,
    specPages: input.spec?.pages,
  });
  return refs.some((ref) => {
    const candidates = [ref.knowledgeId, ref.id, ref.title, ref.relatedPath].filter(Boolean) as string[];
    return candidates.some((candidate) => artifactText.includes(candidate));
  });
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
  return text(value.name) || text(value.title) || text(value.label) || text(value.role);
}

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}
