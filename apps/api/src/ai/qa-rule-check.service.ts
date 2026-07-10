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
import { extractKnowledgeFrameworkRequirements } from "./knowledge-framework-checklist";

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

type MarkdownTable = {
  headers: string[];
  rows: string[][];
  raw: string;
};

const CHANNEL_DEFINITIONS = [
  {
    label: "端内渠道",
    aliases: /^(?:端内渠道|端内|APP|客户端)$/i,
    positive: /端内(?:渠道|入口|页面|投放)|(?:APP|客户端)(?:渠道|入口|页面|投放)/i,
    negative: /(?:不|未)(?:支持|覆盖|投放|发布到|包含).{0,10}(?:端内|APP|客户端)|(?:端内|APP|客户端).{0,10}(?:不|未)(?:支持|覆盖|投放|发布到|包含)|仅(?:支持|投放|发布到).{0,8}(?:H5|WAP|小程序)/i,
  },
  {
    label: "WAP/H5端外渠道",
    aliases: /^(?:WAP\/H5端外渠道|H5\/WAP端外渠道|WAP|H5|端外渠道)$/i,
    positive: /(?:WAP|H5)(?:端外)?(?:渠道|入口|页面|投放|上线)|端外(?:渠道|入口|页面|投放|上线)|(?:通过|发布到|投放到|覆盖|进入|访问|上线|支持).{0,12}(?:WAP|H5|端外)/i,
    negative: /(?:不|未)(?:支持|覆盖|投放|发布到|包含).{0,10}(?:WAP|H5|端外)|(?:WAP|H5|端外).{0,10}(?:不|未)(?:支持|覆盖|投放|发布到|包含)|仅(?:支持|投放|发布到).{0,8}(?:端内|小程序)/i,
  },
  {
    label: "小程序",
    aliases: /^小程序(?:渠道)?$/,
    positive: /小程序(?:渠道|入口|页面|投放|上线)|(?:通过|发布到|投放到|覆盖|进入|访问|上线|支持).{0,12}小程序/,
    negative: /(?:不|未)(?:支持|覆盖|投放|发布到|包含).{0,10}小程序|小程序.{0,10}(?:不|未)(?:支持|覆盖|投放|发布到|包含)|仅(?:支持|投放|发布到).{0,8}(?:端内|H5|WAP)/i,
  },
] as const;

const SENSITIVE_SAFETY_ROWS = [
  { index: 13, label: "身份证/生物识别/银行卡", evidence: /身份证(?:号码|照片)?|生物识别|银行卡/ },
  { index: 15, label: "第三方页面或应用跳转", evidence: /跳转.{0,12}第三方|第三方(?:页面|应用|链接)/ },
  { index: 16, label: "第三方接口数据交互", evidence: /第三方(?:公司|系统|平台).{0,24}(?:接口|数据交互|对接)|(?:接口|数据交互|对接).{0,24}第三方(?:公司|系统|平台)/ },
] as const;

const SAFETY_BASELINE_ROW_PATTERNS = [
  /新开发功能接口|现有功能接口逻辑变动/,
  /面向公众用户/,
  /公网暴露面/,
  /个人信息.*脱敏|脱敏展示/,
  /水印/,
  /查询条件/,
  /4A统一管理|4A要求/i,
  /未接入4A.*安全要求|通行字.*18|18项安全/i,
  /敏感词过滤/,
  /先审后发/,
  /隐私政策/,
  /双清单/,
  /身份证|生物识别|银行卡/,
  /免密登录/,
  /第三方页面|第三方应用/,
  /第三方公司.*接口|数据交互/,
  /API接口.*台账|台账填报/i,
  /加密传输|接口鉴权|访问控制/,
  /加密存储/,
  /数据采集规范/,
  /完整性和一致性校验/,
] as const;

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

  const channelValidation = validateChannelTable(prd);
  if (!channelValidation.structurePassed) {
    issues.push(issue({
      id: "qa_prd_channel_table_invalid",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "PRD 渠道表不唯一或格式无效",
      description: channelValidation.structureEvidence,
      relatedPrdSectionIds: prd.sections
        .filter((section) => /使用场景|渠道/.test(`${section.title}\n${section.content}`))
        .map((section) => section.id),
      suggestion: "仅保留一张端内、WAP/H5 端外、小程序三行渠道表，并为每行填写唯一的是/否选择。",
    }));
  }
  if (!channelValidation.semanticPassed) {
    issues.push(issue({
      id: "qa_prd_channel_scope_conflict",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "PRD 渠道选择与业务范围冲突",
      description: channelValidation.semanticEvidence,
      relatedPrdSectionIds: prd.sections
        .filter((section) => /使用场景|渠道|页面入口|文档范围/.test(`${section.title}\n${section.content}`))
        .map((section) => section.id),
      suggestion: "根据渠道表之外的明确业务证据逐项勾选；未设计的渠道必须选择否，不得从候选项或安全模板反推为是。",
    }));
  }

  const safetyValidation = validateSafetyBaseline(prd);
  if (!safetyValidation.structurePassed) {
    issues.push(issue({
      id: "qa_prd_safety_baseline_invalid",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "安全基线表未完整保留 21 行",
      description: safetyValidation.structureEvidence,
      relatedPrdSectionIds: prd.sections
        .filter((section) => /安全基线/.test(`${section.title}\n${section.content}`))
        .map((section) => section.id),
      suggestion: "保留唯一一张序号 1-21 连续且状态仅为是、否、不涉及的安全基线表。",
    }));
  }
  if (!safetyValidation.evidencePassed) {
    issues.push(issue({
      id: "qa_prd_safety_evidence_conflict",
      checkType: "prd_completeness",
      severity: "blocking",
      title: "敏感信息或第三方安全项缺少设计证据",
      description: safetyValidation.evidenceEvidence,
      relatedPrdSectionIds: prd.sections
        .filter((section) => /安全基线/.test(`${section.title}\n${section.content}`))
        .map((section) => section.id),
      suggestion: "仅当安全表之外明确设计了身份证/生物识别/银行卡采集、第三方跳转或第三方接口交互时，对应行才可填写是。",
    }));
  }

  return issues;
}

function validateChannelTable(prd: RequirementDocument) {
  const bodyText = stringifyPrdSections(prd);
  const channelTables = parseMarkdownTables(bodyText).filter(isChannelTable);
  if (channelTables.length !== 1) {
    return {
      structurePassed: false,
      structureEvidence: `渠道表数量=${channelTables.length}，要求恰好 1 张。`,
      semanticPassed: false,
      semanticEvidence: "渠道表结构无效，无法核对渠道范围。",
    };
  }

  const table = channelTables[0];
  const channelIndex = table.headers.findIndex((header) => /渠道/.test(normalizeTableCell(header)));
  const statusIndex = table.headers.findIndex((header) => /是否投放|投放状态/.test(normalizeTableCell(header)));
  const rows = CHANNEL_DEFINITIONS.map((definition) => {
    const matches = table.rows.filter((row) => definition.aliases.test(normalizeTableCell(row[channelIndex] ?? "")));
    const selection = matches.length === 1 ? parseBinarySelection(matches[0][statusIndex] ?? "") : "invalid";
    return { definition, matches, selection };
  });
  const structurePassed = table.rows.length === 3
    && channelIndex >= 0
    && statusIndex >= 0
    && rows.every((row) => row.matches.length === 1 && row.selection !== "invalid");
  const structureEvidence = structurePassed
    ? "渠道表唯一，三类渠道行与是/否选择均有效。"
    : `渠道表 rows=${table.rows.length}；${rows.map((row) => `${row.definition.label}:count=${row.matches.length},status=${row.selection}`).join("；")}。`;

  if (!structurePassed) {
    return {
      structurePassed,
      structureEvidence,
      semanticPassed: false,
      semanticEvidence: "渠道表结构无效，无法核对渠道范围。",
    };
  }

  const evidenceText = prdBusinessEvidenceText(prd);
  const conflicts = rows.flatMap(({ definition, selection }) => {
    const expected = channelExpectedSelection(evidenceText, definition.positive, definition.negative);
    const evidenceStatus = expected === "conflict" ? "正负冲突" : expected === "yes" ? "是" : "否";
    return selection === expected ? [] : [`${definition.label}:表=${selection === "yes" ? "是" : "否"},正文证据=${evidenceStatus}`];
  });
  return {
    structurePassed,
    structureEvidence,
    semanticPassed: conflicts.length === 0,
    semanticEvidence: conflicts.length ? `渠道范围冲突：${conflicts.join("；")}。` : "渠道选择与渠道表之外的业务范围一致。",
  };
}

function validateSafetyBaseline(prd: RequirementDocument) {
  const bodyText = stringifyPrdSections(prd);
  const safetyTables = parseMarkdownTables(bodyText).filter(isSafetyBaselineTable);
  if (safetyTables.length !== 1) {
    return {
      structurePassed: false,
      structureEvidence: `安全基线表数量=${safetyTables.length}，要求恰好 1 张。`,
      evidencePassed: false,
      evidenceEvidence: "安全基线表结构无效，无法核对敏感与第三方设计证据。",
    };
  }

  const table = safetyTables[0];
  const indexColumn = table.headers.findIndex((header) => normalizeTableCell(header) === "序号");
  const contentColumn = table.headers.findIndex((header) => /需求安全基线内容|安全基线内容/.test(normalizeTableCell(header)));
  const statusColumn = table.headers.findIndex((header) => /是否涉及/.test(normalizeTableCell(header)));
  const indexes = table.rows.map((row) => Number(normalizeTableCell(row[indexColumn] ?? "")));
  const statuses = table.rows.map((row) => parseSafetyStatus(row[statusColumn] ?? ""));
  const rowDefinitionsMatch = SAFETY_BASELINE_ROW_PATTERNS.every((pattern, offset) => {
    const row = table.rows.find((candidate) => Number(normalizeTableCell(candidate[indexColumn] ?? "")) === offset + 1);
    return Boolean(row && pattern.test(normalizeTableCell(row[contentColumn] ?? "")));
  });
  const structurePassed = table.rows.length === 21
    && indexColumn >= 0
    && contentColumn >= 0
    && statusColumn >= 0
    && indexes.every((value, offset) => value === offset + 1)
    && statuses.every((status) => status !== "invalid")
    && rowDefinitionsMatch;
  const structureEvidence = structurePassed
    ? "安全基线表唯一，序号 1-21 连续且状态值有效。"
    : `安全基线 rows=${table.rows.length}, indexes=${indexes.join(",") || "missing"}, invalidStatus=${statuses.filter((status) => status === "invalid").length}, rowDefinitions=${rowDefinitionsMatch ? "valid" : "invalid"}。`;

  if (!structurePassed) {
    return {
      structurePassed,
      structureEvidence,
      evidencePassed: false,
      evidenceEvidence: "安全基线表结构无效，无法核对敏感与第三方设计证据。",
    };
  }

  const evidenceText = prdBusinessEvidenceText(prd);
  const conflicts = SENSITIVE_SAFETY_ROWS.flatMap(({ index, label, evidence }) => {
    const rowOffset = indexes.indexOf(index);
    const status = statuses[rowOffset];
    const bodyIncludesBehavior = hasAffirmativeEvidence(evidenceText, evidence);
    if (status === "yes" && !bodyIncludesBehavior) {
      return [`第${index}行 ${label}:表=是,正文=未设计`];
    }
    if (status !== "yes" && bodyIncludesBehavior) {
      return [`第${index}行 ${label}:表=${status === "no" ? "否" : "不涉及"},正文=已设计`];
    }
    return [];
  });
  return {
    structurePassed,
    structureEvidence,
    evidencePassed: conflicts.length === 0,
    evidenceEvidence: conflicts.length
      ? `以下项目与安全表之外的设计证据不一致：${conflicts.join("、")}。`
      : "敏感信息与第三方项目的表格状态和正文设计证据双向一致。",
  };
}

function parseMarkdownTables(value: string): MarkdownTable[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const tables: MarkdownTable[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = parseMarkdownRow(lines[index]);
    const separator = parseMarkdownRow(lines[index + 1]);
    if (!headers || !separator || separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      continue;
    }
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const row = parseMarkdownRow(lines[cursor]);
      if (!row) break;
      rows.push(row);
      cursor += 1;
    }
    tables.push({ headers, rows, raw: lines.slice(index, cursor).join("\n") });
    index = cursor - 1;
  }
  return tables;
}

function parseMarkdownRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !/^\|?.+\|?$/.test(trimmed)) return null;
  const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = content.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
  return cells.length >= 2 ? cells : null;
}

function isChannelTable(table: MarkdownTable) {
  const headers = table.headers.map(normalizeTableCell);
  return headers.some((header) => /活动投放的可选渠道|投放渠道/.test(header))
    && headers.some((header) => /是否投放|投放状态/.test(header));
}

function isSafetyBaselineTable(table: MarkdownTable) {
  const headers = table.headers.map(normalizeTableCell);
  return headers.some((header) => /需求安全基线内容|安全基线内容/.test(header))
    && headers.some((header) => /是否涉及/.test(header));
}

function normalizeTableCell(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/[`*_]/g, "").replace(/\s+/g, "").trim();
}

function parseBinarySelection(value: string): "yes" | "no" | "invalid" {
  const normalized = normalizeTableCell(value);
  const checkedYes = /(?:☑|☒|✅|\[[xX]\])是/.test(normalized);
  const checkedNo = /(?:☑|☒|✅|\[[xX]\])否/.test(normalized);
  if (checkedYes !== checkedNo) return checkedYes ? "yes" : "no";
  if (normalized === "是") return "yes";
  if (normalized === "否" || normalized === "不涉及") return "no";
  return "invalid";
}

function parseSafetyStatus(value: string): "yes" | "no" | "not_applicable" | "invalid" {
  const normalized = normalizeTableCell(value);
  if (normalized === "是") return "yes";
  if (normalized === "否") return "no";
  if (normalized === "不涉及") return "not_applicable";
  return "invalid";
}

function prdBusinessEvidenceText(prd: RequirementDocument) {
  return prd.sections
    .filter((section) => !/安全基线/.test(`${section.id}\n${section.title}`))
    .map((section) => [
      section.title,
      stripContractTables(section.content),
      ...(section.blocks ?? []).map((block) => stripContractTables(block.content)),
    ].join("\n"))
    .join("\n");
}

function stripContractTables(value: string) {
  return parseMarkdownTables(value)
    .filter((table) => isChannelTable(table) || isSafetyBaselineTable(table))
    .reduce((textValue, table) => textValue.replace(table.raw, ""), value);
}

function channelExpectedSelection(textValue: string, positive: RegExp, negative: RegExp): "yes" | "no" | "conflict" {
  const clauses = splitEvidenceClauses(textValue);
  const positiveHit = clauses.some((clause) => hasAffirmativeEvidence(clause, positive));
  const negativeHit = clauses.some((clause) => negative.test(clause));
  if (positiveHit && negativeHit) return "conflict";
  return positiveHit ? "yes" : "no";
}

function hasAffirmativeEvidence(textValue: string, pattern: RegExp) {
  return splitEvidenceClauses(textValue)
    .some((clause) => pattern.test(clause) && !/(?:不涉及|不包含|不采集|不获取|不跳转|不对接|不支持|不覆盖|不在本期|无需|未设计|可选|候选|如需|如涉及|若涉及|按需)/.test(clause));
}

function splitEvidenceClauses(value: string) {
  return value.split(/[，,。！？；;\n]/).map((clause) => clause.trim()).filter(Boolean);
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

    const responsiveContract = evaluateResponsivePrototypeContract(html);
    if (!responsiveContract.viewportPassed) {
      issues.push(issue({
        id: "qa_prototype_invalid_viewport",
        checkType: "prototype_completeness",
        severity: "blocking",
        title: "原型缺少有效移动端 viewport",
        description: responsiveContract.viewportEvidence,
        suggestion: "在 head 中加入 name=viewport 且 content 同时包含 width=device-width 和有效 initial-scale 的 meta 标签。",
      }));
    }
    if (!responsiveContract.mobileCssPassed) {
      issues.push(issue({
        id: "qa_prototype_mobile_css_missing",
        checkType: "prototype_completeness",
        severity: "blocking",
        title: "原型缺少移动端专用响应式样式",
        description: responsiveContract.mobileCssEvidence,
        suggestion: "增加 max-width 不大于 768px 的媒体查询，并在窄屏下重排导航、工具栏、表单、表格和内容网格。",
      }));
    }
    if (!responsiveContract.overflowGuardPassed) {
      issues.push(issue({
        id: "qa_prototype_horizontal_overflow_unprotected",
        checkType: "prototype_completeness",
        severity: "blocking",
        title: "原型缺少横向溢出防护",
        description: responsiveContract.overflowGuardEvidence,
        suggestion: "为页面根节点设置 overflow-x 防护，并让表格/宽内容使用 max-width:100% 或可控的横向滚动容器。",
      }));
    }

    const interactionContract = evaluatePrototypeInteractionContract(html);
    if (!interactionContract.passed) {
      issues.push(issue({
        id: "qa_prototype_key_actions_not_interactive",
        checkType: "prototype_completeness",
        severity: "blocking",
        title: "原型关键按钮没有实际交互",
        description: interactionContract.evidence,
        suggestion: "为保存、预览、提交、发布、签到、重试、导出等关键按钮绑定 click 事件，并产生可见状态、文案、弹层或页面变化。",
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

function evaluateResponsivePrototypeContract(html: string) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const viewportTag = metaTags.find((tag) => readHtmlAttribute(tag, "name").toLowerCase() === "viewport");
  const viewportContent = viewportTag ? readHtmlAttribute(viewportTag, "content") : "";
  const initialScale = viewportContent.match(/(?:^|,)\s*initial-scale\s*=\s*([0-9.]+)/i)?.[1];
  const viewportPassed = /(?:^|,)\s*width\s*=\s*device-width\s*(?:,|$)/i.test(viewportContent)
    && Boolean(initialScale && Number(initialScale) > 0);

  const styleText = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join("\n");
  const mobileBreakpoints = [...styleText.matchAll(/@media[^\{]*max-width\s*:\s*(\d+)px/gi)]
    .map((match) => Number(match[1]));
  const mobileCssPassed = mobileBreakpoints.some((width) => width > 0 && width <= 768);
  const rootOverflowGuard = /(?:html\s*,\s*body|body\s*,\s*html|html|body)[^{]*\{[^}]*overflow-x\s*:\s*(?:hidden|clip)/i.test(styleText);
  const wideContentGuard = /overflow-x\s*:\s*auto|max-width\s*:\s*100%/i.test(styleText);
  const overflowGuardPassed = rootOverflowGuard && wideContentGuard;

  return {
    viewportPassed,
    viewportEvidence: viewportPassed
      ? `viewport=${viewportContent}`
      : `viewport=${viewportContent || "missing"}，要求 width=device-width, initial-scale>0。`,
    mobileCssPassed,
    mobileCssEvidence: mobileCssPassed
      ? `mobile breakpoints=${mobileBreakpoints.join(",")}px`
      : `breakpoints=${mobileBreakpoints.join(",") || "missing"}，要求至少一个 max-width<=768px。`,
    overflowGuardPassed,
    overflowGuardEvidence: `root=${rootOverflowGuard ? "guarded" : "missing"}, wide-content=${wideContentGuard ? "guarded" : "missing"}。`,
  };
}

function readHtmlAttribute(tag: string, name: string) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return String(match?.[2] ?? match?.[3] ?? "");
}

function evaluatePrototypeInteractionContract(html: string) {
  const scripts = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [])
    .map((script) => script.replace(/^<script\b[^>]*>|<\/script>$/gi, ""))
    .join("\n");
  const keyActionPattern = /保存|预览|提交|审核|发布|下线|签到|领取|登录|确认|重试|补偿|导出|上传|删除|新增|创建|发送|搜索|查询/;
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)]
    .map((match) => ({
      attributes: match[1],
      label: match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    }));
  const keyButtons = buttons.filter((button) =>
    keyActionPattern.test(button.label)
    && !/(?:^|\s)disabled(?:\s|=|$)|aria-disabled\s*=\s*(["'])?true\1/i.test(button.attributes),
  );
  const hasClickBinding = /addEventListener\s*\(\s*["']click["']|\.onclick\s*=|\bonclick\s*=|\.on\s*\(\s*["']click["']/i.test(`${scripts}\n${html}`);
  const hasVisibleEffect = /classList\.|textContent\s*=|innerHTML\s*=|\.hidden\s*=|style\.[a-z-]+\s*=|setAttribute\s*\(|showModal\s*\(|\balert\s*\(|\bconfirm\s*\(|location\.(?:href|assign)|\.value\s*=/i.test(`${scripts}\n${keyButtons.map((button) => button.attributes).join("\n")}`);
  const genericButtonBinding = /querySelectorAll\s*\(\s*["'][^"']*button[^"']*["']\s*\)[\s\S]{0,240}addEventListener\s*\(\s*["']click["']/i.test(scripts);
  const unbound = keyButtons.filter((button) => {
    if (/\bonclick\s*=/i.test(button.attributes) || genericButtonBinding) return false;
    const references = [
      button.attributes.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2],
      button.attributes.match(/\bdata-action\s*=\s*(["'])(.*?)\1/i)?.[2],
      ...(button.attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? []),
    ].filter((value): value is string => Boolean(value && value.length >= 2));
    return !references.some((reference) => scripts.includes(reference));
  });
  const hasExecutableScript = scripts.trim().length > 0 || keyButtons.some((button) => /\bonclick\s*=/i.test(button.attributes));
  const passed = keyButtons.length > 0 && hasExecutableScript && hasClickBinding && hasVisibleEffect && unbound.length === 0;
  return {
    passed,
    evidence: passed
      ? `关键按钮 ${keyButtons.length} 个均有 click 绑定和可见状态变化。`
      : `keyButtons=${keyButtons.length}, script=${hasExecutableScript ? "present" : "missing"}, click=${hasClickBinding ? "bound" : "missing"}, effect=${hasVisibleEffect ? "present" : "missing"}, unbound=${unbound.map((button) => button.label).slice(0, 8).join("、") || "none"}。`,
  };
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
    const entities = (state[key] ?? [])
      .map((item) => ({ item, name: entityName(item) }))
      .filter((entity): entity is { item: Record<string, unknown>; name: string } =>
        Boolean(entity.name) && entity.name.length >= 2,
      );
    if (!entities.length) return [];
    const missing = entities
      .filter(({ item }) => !artifactCoversEntity(artifactText, item))
      .map(({ name }) => name);
    const hitRatio = (entities.length - missing.length) / entities.length;
    return hitRatio >= 0.75 ? [] : [{
      key,
      label: DESIGN_COVERAGE_LABELS[key],
      missing,
      total: entities.length,
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
  const items: Array<{ name: string; evidence?: string }> = [];
  for (const page of spec.pages) {
    if (page.name?.trim()) items.push({ name: page.name.trim(), evidence: page.layout });
    for (const state of page.states ?? []) {
      if (state.name?.trim()) items.push({ name: state.name.trim(), evidence: state.description });
    }
    collectPrototypeComponentCoverage(page.components, items);
  }
  const unique = [...new Map(
    items.filter((item) => item.name.length >= 2).map((item) => [item.name, item]),
  ).values()];
  if (!unique.length) return [];
  const missing = unique
    .filter((item) =>
      !artifactContainsLabel(html, item.name) &&
      !artifactContainsEvidence(html, item.evidence),
    )
    .map((item) => item.name);
  return (unique.length - missing.length) / unique.length >= 0.75 ? [] : missing;
}

function collectPrototypeComponentCoverage(
  components: PrototypeSpec["pages"][number]["components"],
  output: Array<{ name: string; evidence?: string }>,
) {
  for (const component of components ?? []) {
    if (component.name?.trim()) output.push({ name: component.name.trim() });
    collectPrototypeComponentCoverage(component.children ?? [], output);
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

function cleanKnowledgeTerm(value: string) {
  return value
    .replace(/[`*_~]/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/^(支持|展示|配置|包括|包含|需要|必须)/, "")
    .trim();
}

function artifactContainsLabel(artifactText: string, label: string) {
  if (artifactContainsStrictLabel(artifactText, label)) return true;
  const haystack = normalizeCoverageText(artifactText);
  const tokens = coverageTokens(label);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= Math.max(1, Math.ceil(tokens.length * 0.6));
}

function artifactContainsStrictLabel(artifactText: string, label: string) {
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

function artifactCoversEntity(artifactText: string, entity: Record<string, unknown>) {
  const name = entityName(entity);
  if (name && artifactContainsLabel(artifactText, name)) return true;
  return Object.entries(entity).some(([key, value]) =>
    !["id", "name", "title", "label", "role", "sourcePaths"].includes(key) &&
    artifactContainsEvidence(artifactText, typeof value === "string" ? value : undefined),
  );
}

function artifactContainsEvidence(artifactText: string, evidence: string | undefined) {
  if (!evidence) return false;
  const haystack = normalizeCoverageText(artifactText);
  const tokens = coverageTokens(evidence);
  if (!tokens.length) return false;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  const requiredHits = tokens.length <= 3
    ? Math.ceil(tokens.length * 0.6)
    : Math.min(5, Math.max(2, Math.ceil(tokens.length * 0.35)));
  return hits >= requiredHits;
}

type CoverageSegment = { segment: string; isWordLike?: boolean };
type CoverageSegmenter = { segment(value: string): Iterable<CoverageSegment> };
const CoverageSegmenterConstructor = (Intl as unknown as {
  Segmenter: new (locale: string, options: { granularity: "word" }) => CoverageSegmenter;
}).Segmenter;
const COVERAGE_SEGMENTER = new CoverageSegmenterConstructor("zh-CN", { granularity: "word" });
const COVERAGE_STOP_TOKENS = new Set([
  "与", "和", "及", "或", "的", "了", "为", "并", "在", "后", "时", "中", "内", "按", "对", "将",
  "可", "需", "应", "每个", "当前", "相关", "至少", "默认", "进行", "通过", "支持",
]);

function coverageTokens(value: string) {
  const tokens: string[] = [];
  let singleHanBuffer = "";
  const flushSingleHanBuffer = () => {
    if (singleHanBuffer.length >= 2) tokens.push(singleHanBuffer);
    singleHanBuffer = "";
  };

  for (const segment of COVERAGE_SEGMENTER.segment(value.toLowerCase())) {
    if (!segment.isWordLike) {
      flushSingleHanBuffer();
      continue;
    }
    const token = normalizeCoverageText(segment.segment);
    if (!token || COVERAGE_STOP_TOKENS.has(token)) {
      flushSingleHanBuffer();
      continue;
    }
    if (/^[\u4e00-\u9fa5]$/.test(token)) {
      singleHanBuffer += token;
      continue;
    }
    flushSingleHanBuffer();
    if (token.length >= 2) tokens.push(token);
  }
  flushSingleHanBuffer();
  return [...new Set(tokens)];
}

function normalizeCoverageText(value: string) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
}

function knowledgeRuleCovered(
  rule: ReturnType<typeof collectKnowledgeReferences>[number],
  artifactText: string,
) {
  if (artifactContainsStrictLabel(artifactText, rule.title)) return true;
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
