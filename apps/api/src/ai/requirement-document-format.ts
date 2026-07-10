import type {
  ConversationDesignState,
  RequirementDocBlock,
  RequirementDocSection,
  RequirementDocumentDraft,
} from "./ai-vibe.types";

type SafetyBaselineRow = {
  index: string;
  content: string;
  scope: string;
  status: "是" | "否" | "不涉及";
};

const SAFETY_BASELINE_ROWS: SafetyBaselineRow[] = [
  { index: "1", content: "是否有新开发功能接口或现有功能接口逻辑变动", scope: "信息系统（包含前端、后端、管理后台）", status: "是" },
  { index: "2", content: "业务功能是否面向公众用户", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "3", content: "是否涉及新开通公网暴露面", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "4", content: "管理后台涉及个人信息的内容要求脱敏展示，原则上不做非脱敏个人信息的导出功能。", scope: "管理后台", status: "不涉及" },
  { index: "5", content: "管理后台所有操作页面要有水印功能，水印至少包括姓名、手机号、操作时间等信息", scope: "管理后台", status: "不涉及" },
  { index: "6", content: "管理后台涉及查询的页面，不允许没有查询条件查询所有数据，必须输入查询条件后才可以查询数据；", scope: "管理后台", status: "不涉及" },
  { index: "7", content: "管理后台应接入4A统一管理，实现一点注销的功能，不允许有独立的账号体系；按4A要求实现日志留存，并实现风险预警功能；", scope: "管理后台", status: "不涉及" },
  { index: "8", content: "如未接入4A系统统一管理，应满足通行字的18项安全要求；要求细则找安全中心要；", scope: "管理后台", status: "不涉及" },
  { index: "9", content: "涉及后台配置内容的需要实现“敏感词过滤”能力；", scope: "管理后台", status: "不涉及" },
  { index: "10", content: "所有在前台展示的内容如为后台配置显示，均需要执行“先审后发”，1、具备“先审后发”能力，2、同步发布数据；3、内部发布上线和下线都需要经过“先审后发”。", scope: "前台展示", status: "不涉及" },
  { index: "11", content: "是否涉及展示《隐私政策》：新业务场景《隐私政策》或已有《隐私政策》的变更需要进行法务及安全审核；《隐私政策》应为独立的文档，四次点击应能访问到独立的菜单；用户未同意《隐私政策》前，不得获取用户任何信息；", scope: "前端页面", status: "不涉及" },
  { index: "12", content: "如涉及加载到APP或小程序，APP、小程序业务应实现双清单功能，“用户信息收集清单”应动态准实时展现采集的个人信息具体内容；“第三方信息共享清单”应涵盖业务所有涉及到的第三方公司及内容；", scope: "前端展示 / 底层接口获取数据", status: "不涉及" },
  { index: "13", content: "前台页面涉及采集身份证号码、身份证照片、生物识别和银行卡信息时，应再次获取用户的主动授权同意。", scope: "前端页面", status: "不涉及" },
  { index: "14", content: "是否涉及免密登录。免密登录的不能为无感知免密登录，需经过用户同意《数字生活隐私政策》后才可以进行免密登录。", scope: "前端页面", status: "不涉及" },
  { index: "15", content: "是否涉及跳转第三方页面或应用。如涉及，应进行弹窗提示，文案应包含：即将跳转的业务名称、第三方公司名称、传的用户信息用户操作目的及第三方的《隐私政策》相关内容，可参考线上已有弹窗。", scope: "前端页面", status: "不涉及" },
  { index: "16", content: "如涉及与第三方公司接口对接进行数据交互，应先查看对应的《数据使用审批单》无误后，才可以正式上线；", scope: "前台、后台", status: "不涉及" },
  { index: "17", content: "API接口安全管理：如为新增API接口，需完成台账填报；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "18", content: "涉及用户敏感信息或跨系统的API是否采用加密传输，具备接口鉴权、访问控制等措施；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "19", content: "是否涉及用户信息或重要数据存储，是否进行加密存储；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "20", content: "是否涉及数据采集，是否建立数据采集规范，明确数采集方式、渠道、数据格式、采集流程等；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "21", content: "是否对采集到的数据进行完整性和一致性校验；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
];

const SAFETY_BASELINE_INTRO = [
  "该部分内容为必填项，请按照如下表格中的内容先进行自查，并按照如下要求完善需求文档：",
  "1、如选择“是”，代表本项自查内容已符合安全要求，需要提供截图违依据",
  "2、如选择“否”，代表本项自查内容暂时不符合安全要求，请在需求文档中增加本部分内容安全改造需求，并发送网信安需求评审邮件，附上本需求文档用于安全评审；",
  "3、如选择“不涉及”，代表本项目各项需求安全基线均不涉及，则无需召开网信安需求评审会。",
  "建议：该表格请业务人员和开发人员共同参与自查并填写。",
].join("\n");

export function formatRequirementDocumentDraft(
  draft: RequirementDocumentDraft,
  state?: ConversationDesignState,
  options: { author?: string; date?: string } = {},
): RequirementDocumentDraft {
  const sourceSections = [...(draft.sections ?? [])].sort((a, b) => a.order - b.order);
  const title = getRequirementDocumentTitle(draft.title, state, sourceSections);
  const baseName = cleanRequirementTitleBase(title.replace(/需求说明书$/, "")) || "需求";
  const author = cleanDocumentAuthor(options.author || state?.updatedBy || state?.createdBy);
  const date = options.date || formatDate(state?.updatedAt);
  const sections: RequirementDocSection[] = [];
  const channelRows = buildChannelRows(state);

  const add = (section: Omit<RequirementDocSection, "order">) => {
    sections.push({ ...section, order: sections.length + 1 });
  };

  add({
    id: "version_history",
    title: "版 本 历 史",
    type: "overview",
    level: 1,
    content: renderMarkdownTable(
      ["版本/状态", "作者", "参与者", "起止日期", "备注"],
      [["讨论稿", author, "业务、研发、测试评审人", date, `新增《${title}》，覆盖核心业务规则、降级方案与安全基线。`]],
    ),
    sourcePaths: [],
  });
  add({
    id: "manual_toc",
    title: "目 录",
    type: "overview",
    level: 1,
    content: buildTocMarkdown(),
    sourcePaths: [],
  });
  add({
    id: "intro",
    title: "1 引言",
    type: "overview",
    level: 1,
    content: "本章说明项目背景、文档范围和核心使用场景。",
    sourcePaths: [],
  });
  add({
    id: "background",
    title: "1.1 项目背景",
    type: "background",
    level: 2,
    content: findSectionContent(sourceSections, ["background"], /背景|项目背景/) || buildBackgroundFallback(baseName, state),
    sourcePaths: ["background"],
  });
  add({
    id: "scope",
    title: "1.2 文档范围",
    type: "scope",
    level: 2,
    content: findSectionContent(sourceSections, ["scope"], /范围|文档范围/) || buildScopeFallback(baseName, state),
    sourcePaths: ["scope"],
  });
  add({
    id: "usage_scenarios",
    title: "1.3 使用场景（必填）",
    type: "user_scenarios",
    level: 2,
    content: [
      buildUsageScenarioContent(baseName, sourceSections),
      buildChannelScopeSummary(channelRows),
      renderMarkdownTable(["序号", "活动投放的可选渠道", "是否投放"], channelRows),
    ].join("\n\n"),
    sourcePaths: ["userScenarios"],
  });
  add({
    id: "business_requirements",
    title: "2 业务需求",
    type: "business_goal",
    level: 1,
    content: `总体目标：${getBusinessGoal(baseName, sourceSections, state)}`,
    sourcePaths: ["businessGoal"],
  });
  add({
    id: "page_links",
    title: "2.1 页面链接",
    type: "page_requirements",
    level: 2,
    content: findSectionContent(sourceSections, ["page_requirements"], /页面链接|页面入口/)
      || buildPageLinksFallback(baseName, state),
    sourcePaths: ["pages"],
  });

  const coreRuleSection = findSectionWithContentOrBlocks(
    sourceSections,
    ["business_rules", "backend_configs", "frontend_rules"],
    /核心业务规则|功能说明|业务规则|配置规则|字段|控件/,
  );
  add({
    id: "core_rules",
    title: "2.2 核心业务规则/功能说明",
    type: "business_rules",
    level: 2,
    content: coreRuleSection?.content.trim() || buildCoreRulesFallback(baseName, state),
    blocks: coreRuleSection?.blocks,
    sourcePaths: coreRuleSection?.sourcePaths ?? ["features", "businessRules"],
  });

  const processSection = findSectionWithContentOrBlocks(
    sourceSections,
    ["state_rules"],
    /核心流程|状态|页面要求|流程|流转|产品流程|产品架构/,
  );
  add({
    id: "core_flow_state",
    title: "2.3 核心流程/状态/页面要求",
    type: "state_rules",
    level: 2,
    content: processSection?.content.trim() || buildProcessFallback(baseName, state),
    blocks: ensureProcessDiagramBlocks(processSection?.blocks, baseName, state),
    sourcePaths: processSection?.sourcePaths ?? ["process", "stateRules", "pages"],
  });

  add({
    id: "acceptance_criteria",
    title: "2.4 验收标准",
    type: "acceptance_criteria",
    level: 2,
    content: findSectionContent(sourceSections, ["acceptance_criteria"], /验收/)
      || buildAcceptanceFallback(baseName, state),
    sourcePaths: ["acceptanceCriteria"],
  });
  add({
    id: "degradation_plan",
    title: "3 业务降级方案（必填）",
    type: "exception_scenarios",
    level: 1,
    content: findSectionContent(sourceSections, ["exception_scenarios"], /降级|异常|兜底|失败/)
      || buildDegradationFallback(baseName, state),
    sourcePaths: ["exceptionScenarios"],
  });
  add({
    id: "safety_baseline",
    title: "4 需求安全基线要求（必填）",
    type: "appendix",
    level: 1,
    content: [
      SAFETY_BASELINE_INTRO,
      renderMarkdownTable(
        ["序号", "需求安全基线内容", "范围", "是否涉及"],
        buildSafetyRows(title, sourceSections, state),
      ),
    ].join("\n\n"),
    sourcePaths: ["safetyBaseline"],
  });

  const tocSection = sections.find((section) => section.id === "manual_toc");
  if (tocSection) {
    tocSection.content = buildTocMarkdown(sections);
  }

  return {
    ...draft,
    title,
    sections,
    validationNotes: [...new Set([
      ...(draft.validationNotes ?? []),
      ...buildFormatValidationNotes(sections),
    ])],
  };
}

function getRequirementDocumentTitle(
  title: string,
  state?: ConversationDesignState,
  sections: RequirementDocSection[] = [],
) {
  const candidates = [
    state?.title,
    title,
    inferRequirementTitleFromSections(sections),
  ]
    .map(normalizeRequirementTitleCandidate)
    .filter((value): value is string => Boolean(value?.trim()));
  const preferred =
    candidates.find((candidate) => !isGenericRequirementTitle(candidate))
    ?? candidates[0]
    ?? "需求";
  const base = normalizeRequirementTitleBase(preferred);
  return `${base || "需求"}需求说明书`;
}

function normalizeRequirementTitleCandidate(value: string | undefined) {
  const title = value?.trim();
  if (!title) return undefined;
  if (!looksLikeCompletionSummaryTitle(title)) return title;
  return extractRequirementTitleFromSummary(title);
}

function looksLikeCompletionSummaryTitle(value: string) {
  const head = value.replace(/\s+/g, " ").slice(0, 320);
  const hasArtifactSubject = /(需求说明书|需求文档|产品需求文档|PRD|画布)/i.test(head);
  if (!hasArtifactSubject) return false;

  return (
    /^(已生成|已完成|已写入|PRD\s*已生成|需求文档已生成|产品需求文档已生成)/i.test(head) ||
    /(请在右侧|可在右侧|右侧\s*(PRD\s*)?画布|画布(中)?(查看|继续|评审|修改)|继续评审|继续修改)/i.test(head)
  );
}

function extractRequirementTitleFromSummary(value: string) {
  const quoted = value.match(/《([^》]{2,120}(?:需求说明书|需求文档|产品需求文档|PRD)?)》/i)?.[1]?.trim();
  if (quoted) return quoted;

  return value.match(/(?:已生成|已完成|已写入)\s*([^，。；\n]{2,80}(?:需求说明书|需求文档|产品需求文档|PRD))/i)?.[1]?.trim();
}

function inferRequirementTitleFromSections(sections: RequirementDocSection[]) {
  const text = sections
    .flatMap((section) => [
      section.title,
      section.content,
      ...(section.blocks ?? []).map((block) => block.content ?? ""),
    ])
    .join("\n")
    .slice(0, 6000);
  const match = text.match(/(^|\n|\s)([^。\n|]{2,60}?(?:需求说明书|需求文档|产品需求文档|PRD|prd))(?=\s|\n|\||$)/);
  return match?.[2]?.trim();
}

function isGenericRequirementTitle(value: string) {
  const base = normalizeRequirementTitleBase(value);
  return /^(产品需求方案|产品方案|需求方案|需求|方案|产品需求)$/.test(base);
}

function normalizeRequirementTitleBase(value: string) {
  return cleanRequirementTitleBase(value
    .replace(/\s+/g, " ")
    .replace(/(产品需求文档|需求说明书|需求文档|PRD|prd)$/i, "")
    .replace(/[－\-—_ ]+$/g, "")
    .trim());
}

function cleanRequirementTitleBase(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/[的之关于围绕]+$/g, "")
    .replace(/[－\-—_ ]+$/g, "")
    .trim();
}

function cleanDocumentAuthor(value: string | undefined) {
  const author = value?.trim();
  if (!author) return "产品经理";
  if (/^(cm|cl)[0-9a-z]{18,}$/i.test(author) || /^[0-9a-f-]{32,36}$/i.test(author)) {
    return "产品经理";
  }
  return author;
}

function buildTocMarkdown(sections: RequirementDocSection[] = []) {
  const titles = sections
    .filter((section) => !["version_history", "manual_toc"].includes(section.id))
    .map((section) => section.title.trim())
    .filter(Boolean);
  if (titles.length) return titles.join("\n");
  return [
    "1 引言",
    "1.1项目背景",
    "1.2文档范围",
    "1.3使用场景（必填）",
    "2 业务需求",
    "2.1页面链接",
    "2.2核心业务规则/功能说明",
    "2.3核心流程/状态/页面要求",
    "2.4验收标准",
    "3. 业务降级方案（必填）",
    "4. 需求安全基线要求（必填）",
  ].join("\n");
}

function findSectionContent(
  sections: RequirementDocSection[],
  types: RequirementDocSection["type"][],
  titlePattern: RegExp,
) {
  return sections.find((section) =>
    (types.includes(section.type) || titlePattern.test(section.title))
    && section.content.trim(),
  )?.content.trim();
}

function findSectionWithContentOrBlocks(
  sections: RequirementDocSection[],
  types: RequirementDocSection["type"][],
  titlePattern: RegExp,
) {
  return sections.find((section) =>
    (types.includes(section.type) || titlePattern.test(section.title))
    && (section.content.trim() || section.blocks?.length),
  );
}

function buildBackgroundFallback(baseName: string, state?: ConversationDesignState) {
  return state?.background
    || state?.summary
    || `${baseName}涉及现有产品平台的前后台业务能力。本次需求用于补充配置、页面展示、状态联动、结果校验和验收口径，支撑业务评审、研发实现与测试用例编写。`;
}

function buildScopeFallback(baseName: string, state?: ConversationDesignState) {
  const rows = [
    ...compactRecordItems(state?.pages, "页面"),
    ...compactRecordItems(state?.backendConfigs, "后台配置"),
    ...compactRecordItems(state?.frontendRules, "前端规则"),
    ...compactRecordItems(state?.businessRules, "业务规则"),
  ];
  return rows.length
    ? rows.map((item) => `- ${item}`).join("\n")
    : `- ${baseName}涉及的目标用户、业务场景、页面范围、核心功能、规则、状态、异常和验收口径。\n- 覆盖用户发起、系统校验、状态变化、结果反馈、异常处理和业务记录闭环。`;
}

function buildUsageScenarioContent(baseName: string, sections: RequirementDocSection[]) {
  const fallback = `运营或管理人员在后台完成${baseName}相关配置与处理，目标用户在前台完成核心操作并获得明确结果反馈，管理人员可查询状态和数据记录。`;
  return stripChannelTables(
    findSectionContent(sections, ["user_scenarios"], /使用场景|用户场景/) || fallback,
  ) || fallback;
}

function buildChannelRows(state?: ConversationDesignState) {
  const evidence = collectDesignBusinessEvidence(state);
  const selected = (kind: ChannelKind) => hasExplicitChannelEvidence(state, evidence, kind);
  return ([
    ["1", "端内渠道", selected("in_app")],
    ["2", "WAP/H5端外渠道", selected("h5")],
    ["3", "小程序", selected("mini_program")],
  ] as Array<[string, string, boolean]>).map(([index, channel, isSelected]) => [
    index,
    channel,
    isSelected ? "☑是 □否" : "□是 ☑否",
  ]);
}

function buildChannelScopeSummary(rows: string[][]) {
  const selected = rows
    .filter((row) => row[2] === "☑是 □否")
    .map((row) => row[1]);
  return selected.length
    ? `本期明确投放渠道：${selected.join("、")}。`
    : "本期未设计端内、WAP/H5 端外或小程序投放渠道。";
}

function getBusinessGoal(baseName: string, sections: RequirementDocSection[], state?: ConversationDesignState) {
  return state?.businessGoal
    || findSectionContent(sections, ["business_goal"], /目标/)
    || state?.summary
    || `${baseName}形成可配置、可查询、可导出、可审计、可降级的业务闭环。`;
}

function buildPageLinksFallback(baseName: string, state?: ConversationDesignState) {
  const pages = arrayOfRecords(state?.pages);
  if (!pages.length) {
    return [
      `- 管理入口：所属产品工作台 > ${baseName}，承载管理、配置、处理和查询。`,
      `- 用户入口：所属产品用户端 > ${baseName}，承载核心操作、结果反馈和异常状态。`,
    ].join("\n");
  }
  return renderMarkdownTable(
    ["页面/入口", "进入方式/路由", "页面职责"],
    pages.map((page, index) => [
      recordName(page, `页面${index + 1}`),
      recordValue(page, ["entry", "entryPath", "route", "url", "path", "menuPath", "navigation"])
        || `所属产品入口 > ${recordName(page, `页面${index + 1}`)}`,
      recordValue(page, ["description", "purpose", "summary", "responsibility", "content"])
        || "展示当前业务状态、可执行操作、结果反馈和异常处理入口",
    ]),
  );
}

function buildCoreRulesFallback(baseName: string, state?: ConversationDesignState) {
  const rows = collectRequirementRows(state);
  if (!rows.length) return buildGenericCoreRules(baseName);
  return renderMarkdownTable(
    ["功能点", "业务规则", "页面要求"],
    rows.slice(0, 12),
  );
}

function buildProcessFallback(baseName: string, state?: ConversationDesignState) {
  const pages = recordNames(state?.pages, "页面").slice(0, 5);
  const features = recordNames(state?.features, "功能").slice(0, 5);
  const rules = recordNames(state?.businessRules, "规则").slice(0, 5);
  const states = recordNames(state?.stateRules, "状态").slice(0, 5);
  const exceptions = recordNames(state?.exceptionScenarios, "异常").slice(0, 5);
  const pageText = pages.length ? pages.join("、") : `${baseName}业务入口与结果页面`;
  const featureText = features.length ? features.join("、") : "核心业务操作";
  const ruleText = rules.length ? rules.join("、") : "资格、边界和重复操作规则";
  const stateText = states.length ? states.join("、") : "初始、处理中、成功和失败状态";
  const exceptionText = exceptions.length ? exceptions.join("、") : "失败、重复、超时、无权限和空态";
  return [
    `${baseName}主流程覆盖${pageText}，用户或管理人员发起${featureText}后，系统按${ruleText}完成校验，更新为${stateText}中的对应状态，并同步展示结果和业务记录。`,
    `页面要求：每个步骤均明确入口、前置条件、可执行动作、成功结果和下一步去向；关键状态在相关页面保持一致。`,
    `异常要求：覆盖${exceptionText}，明确提示文案、状态记录、可恢复动作和人工处理入口。`,
  ].join("\n");
}

function ensureProcessDiagramBlocks(
  blocks: RequirementDocSection["blocks"],
  baseName: string,
  state?: ConversationDesignState,
) {
  const existing = blocks ?? [];
  const hasFlow = existing.some((block) => block.type === "diagram" && /流程|flow/i.test(`${block.title ?? ""}\n${block.content}`));
  const hasArchitecture = existing.some((block) => block.type === "diagram" && /架构|architecture/i.test(`${block.title ?? ""}\n${block.content}`));
  const additions: NonNullable<RequirementDocSection["blocks"]> = [];
  const pageNames = recordNames(state?.pages, "页面").slice(0, 4);
  const featureNames = recordNames(state?.features, "功能").slice(0, 4);
  const configNames = recordNames(state?.backendConfigs, "配置").slice(0, 3);
  const ruleNames = uniqueNames([
    ...recordNames(state?.businessRules, "规则"),
    ...recordNames(state?.frontendRules, "前台规则"),
  ]).slice(0, 4);
  const stateNames = recordNames(state?.stateRules, "状态").slice(0, 4);
  const exceptionNames = recordNames(state?.exceptionScenarios, "异常").slice(0, 3);
  const acceptanceNames = recordNames(state?.acceptanceCriteria, "验收项").slice(0, 3);
  if (!hasFlow) {
    additions.push({
      id: "product_flow_diagram",
      type: "diagram",
      title: "产品流程图",
      diagramSyntax: "mermaid",
      content: [
        "flowchart TD",
        `  A[${diagramGroupLabel("业务入口", pageNames.slice(0, 1), baseName)}] --> B[${diagramGroupLabel("核心操作", featureNames, "执行核心业务操作")}]`,
        `  B --> C{${diagramGroupLabel("规则校验", ruleNames, "校验前置条件与边界")}}`,
        `  C -->|通过| D[${diagramGroupLabel("状态更新", stateNames, "写入业务状态与记录")}]`,
        `  C -->|不通过| E[${diagramGroupLabel("异常处理", exceptionNames, "展示原因与恢复动作")}]`,
        `  D --> F[${diagramGroupLabel("结果页面", pageNames.slice(1), "展示结果与下一步")}]`,
        "  E --> F",
        `  F --> G[${diagramGroupLabel("验收与追踪", acceptanceNames, "查询结果并完成验收")}]`,
      ].join("\n"),
    });
  }
  if (!hasArchitecture) {
    additions.push({
      id: "product_architecture_diagram",
      type: "diagram",
      title: "产品架构图",
      diagramSyntax: "mermaid",
      content: [
        "flowchart LR",
        `  PAGE[${diagramGroupLabel("页面层", pageNames, "业务入口与结果页面")}] --> CAP[${diagramGroupLabel("能力层", featureNames, "核心业务能力")}]`,
        `  CFG[${diagramGroupLabel("配置层", configNames, "业务参数与权限配置")}] --> CAP`,
        `  CAP --> RULE[${diagramGroupLabel("规则层", ruleNames, "业务规则与前台规则")}]`,
        `  RULE --> STATE[${diagramGroupLabel("状态与记录层", stateNames, "状态、流水与业务记录")}]`,
        `  STATE --> EX[${diagramGroupLabel("异常治理层", exceptionNames, "失败恢复与人工处理")}]`,
        `  STATE --> VERIFY[${diagramGroupLabel("验收追踪层", acceptanceNames, "查询、指标与验收")}]`,
        "  EX --> VERIFY",
      ].join("\n"),
    });
  }
  return [...existing, ...additions];
}

function buildAcceptanceFallback(baseName: string, state?: ConversationDesignState) {
  const criteria = arrayOfRecords(state?.acceptanceCriteria);
  if (criteria.length) {
    return renderMarkdownTable(
      ["序号", "验收项", "验收标准"],
      criteria.slice(0, 12).map((item, index) => [
        String(index + 1),
        recordName(item, `验收项${index + 1}`),
        recordValue(item, ["description", "criterion", "standard", "expectedBehavior", "expectedResult", "content"])
          || "触发条件、页面反馈、状态记录和最终业务结果均与本文规则一致",
      ]),
    );
  }
  const pageNames = arrayOfRecords(state?.pages).map((item, index) => recordName(item, `页面${index + 1}`)).slice(0, 4);
  const ruleNames = arrayOfRecords(state?.businessRules).map((item, index) => recordName(item, `规则${index + 1}`)).slice(0, 4);
  const exceptionNames = arrayOfRecords(state?.exceptionScenarios).map((item, index) => recordName(item, `异常${index + 1}`)).slice(0, 4);
  return renderMarkdownTable(
    ["序号", "验收项", "验收标准"],
    [
      ["1", "页面可见性", `${pageNames.join("、") || `${baseName}前后台页面`}的入口、标题、操作权限和结果展示与本文一致。`],
      ["2", "业务规则", `${ruleNames.join("、") || "核心业务规则"}在正常、重复操作和边界条件下均得到一致执行。`],
      ["3", "异常处理", `${exceptionNames.join("、") || "失败、超时、无权限和空态"}均有明确页面提示、状态记录和后续处理方式。`],
      ["4", "存量影响", "存量业务数据、既有配置和历史页面不受本需求影响，新增能力可按权限和配置开关控制。"],
    ],
  );
}

function buildDegradationFallback(baseName: string, state?: ConversationDesignState) {
  const operations = recordNames(state?.features, "功能").slice(0, 4);
  const exceptions = recordNames(state?.exceptionScenarios, "异常").slice(0, 4);
  const operationText = operations.length ? operations.join("、") : `${baseName}核心操作`;
  const exceptionText = exceptions.length ? exceptions.join("、") : "失败、超时、重复操作和依赖不可用";
  return [
    `当${operationText}出现${exceptionText}时，页面保留最后一致状态并展示明确原因，不得出现空白页、重复提交、错误成功态或不可恢复的中间态。`,
    "系统记录业务对象标识、操作人、操作时间、操作前后状态和失败原因；可安全重试的操作提供重试入口，不可自动恢复的操作进入人工处理。",
    "依赖能力不可用时停止后续状态推进，避免产生重复记录或错误结果；依赖恢复后按业务记录继续处理，并校验页面状态、业务状态和最终结果一致。",
  ].join("\n");
}

function buildSafetyRows(title: string, sections: RequirementDocSection[], state?: ConversationDesignState) {
  const evidence = [
    title,
    ...collectDesignBusinessEvidence(state),
    ...collectSectionBusinessEvidence(sections),
  ];
  const rows = SAFETY_BASELINE_ROWS.map((row) => ({ ...row }));
  const setYes = (...indexes: string[]) => {
    indexes.forEach((index) => {
      const row = rows.find((item) => item.index === index);
      if (row) row.status = "是";
    });
  };

  const hasAdmin = Boolean(state?.backendConfigs?.length)
    || hasPositiveBusinessEvidence(evidence, /后台|管理端|运营工作台|管理页面/);
  const hasPublicUser = hasPositiveBusinessEvidence(
    evidence,
    /公众用户|C端用户|用户端|客户端用户|消费者|会员|客户|前台(?:页面|入口|展示|操作)/i,
  );
  const hasPersonalInformation = hasPositiveBusinessEvidence(
    evidence,
    /个人信息|用户信息|手机号|手机号码|姓名|证件|身份证|银行卡|生物识别/,
    /采集|收集|填写|录入|上传|读取|获取|查询|展示|导出|存储|保存|校验|认证|授权|传输|共享|字段/,
  );
  const hasDataCollection = hasPositiveBusinessEvidence(
    evidence,
    /埋点|数据采集|采集数据|行为数据|访问人数|访问量|参与人数|转化率|统计指标|指标统计|数据报表|\b(?:pv|uv)\b/i,
  );
  const hasNewApi = hasPositiveBusinessEvidence(
    evidence,
    /(?:新增|新建|开发|改造|修改|变更|调整|对接).{0,18}(?:接口|api)|(?:接口|api).{0,18}(?:新增|新建|开发|改造|修改|变更|调整|对接)/i,
  );
  const hasThirdPartyIntegration = hasPositiveBusinessEvidence(
    evidence,
    /(?:第三方|外部公司|外部系统).{0,24}(?:接口|api|数据交互|数据传输|数据共享|回调|对接)|(?:接口|api|数据交互|数据传输|数据共享|回调|对接).{0,24}(?:第三方|外部公司|外部系统)/i,
  );

  if (hasPositiveBusinessEvidence(evidence, /公网|互联网公开/, /新增|开放|暴露|部署|访问/)) setYes("3");
  if (hasPublicUser) setYes("2");
  if (hasAdmin && hasPersonalInformation) setYes("4");
  if (hasAdmin) setYes("5", "6");
  if (hasPositiveBusinessEvidence(evidence, /4a统一管理|接入4a|4a登录/i)) setYes("7");
  if (hasPositiveBusinessEvidence(evidence, /未接入4a|独立账号体系|通行字18项/i)) setYes("8");
  if (hasPositiveBusinessEvidence(evidence, /敏感词|后台配置.{0,16}(?:文案|内容|素材|标题|文本)|配置(?:文案|内容|素材|标题|文本)/)) setYes("9");
  if (hasPositiveBusinessEvidence(evidence, /先审后发|审核发布|发布审核|后台配置.{0,24}前台展示|前台展示.{0,24}后台配置/)) setYes("10");
  if (hasPositiveBusinessEvidence(evidence, /隐私政策|个人信息授权|用户信息授权/) || hasPersonalInformation) setYes("11");
  if (
    hasExplicitChannelEvidence(state, evidence, "mini_program")
    || hasPositiveBusinessEvidence(evidence, /\bapp\b|客户端|原生应用/i, /加载|投放|发布|上线|接入|页面|活动|入口/)
  ) setYes("12");
  if (hasPositiveBusinessEvidence(
    evidence,
    /身份证(?:号码|照片)?|银行卡(?:号|信息)?|生物识别|人脸识别|指纹识别/,
    /采集|收集|填写|录入|上传|读取|获取|校验|认证|识别|绑卡|授权|字段/,
  )) setYes("13");
  if (hasPositiveBusinessEvidence(evidence, /免密登录|一键登录|本机号码登录|手机号快捷登录/)) setYes("14");
  if (hasPositiveBusinessEvidence(
    evidence,
    /(?:跳转|外链|打开).{0,20}(?:第三方|外部)(?:页面|应用|app|网站|链接)?|(?:第三方|外部)(?:页面|应用|app|网站|链接).{0,20}(?:跳转|外链|打开)/i,
  )) setYes("15");
  if (hasThirdPartyIntegration) setYes("16");
  if (hasNewApi) setYes("17");
  if (
    hasThirdPartyIntegration
    || hasPositiveBusinessEvidence(
      evidence,
      /(?:个人信息|用户信息|敏感信息|身份证|银行卡).{0,24}(?:接口|api|传输|共享)|(?:接口|api|传输|共享).{0,24}(?:个人信息|用户信息|敏感信息|身份证|银行卡)/i,
    )
  ) setYes("18");
  if (hasPositiveBusinessEvidence(
    evidence,
    /(?:个人信息|用户信息|敏感信息|重要数据).{0,24}(?:存储|保存|落库|持久化)|(?:存储|保存|落库|持久化).{0,24}(?:个人信息|用户信息|敏感信息|重要数据)/,
  )) setYes("19");
  if (hasDataCollection) setYes("20", "21");
  return rows.map((row) => [row.index, row.content, row.scope, row.status]);
}

type ChannelKind = "in_app" | "h5" | "mini_program";

const CHANNEL_PATTERNS: Record<ChannelKind, RegExp> = {
  in_app: /端内(?:渠道|活动页|页面|入口)?|\bapp\b/i,
  h5: /wap|h5|端外(?:渠道|活动页|页面|入口)?/i,
  mini_program: /小程序|mini[\s_-]?program/i,
};

const CHANNEL_ACTION_PATTERN = /投放|发布|上线|接入|加载|覆盖|部署|活动页|页面|入口|进入|访问|打开|运行于|渠道(?:为|是|包括|包含|覆盖|[:：])/i;
const NON_CURRENT_EVIDENCE_PATTERN = /(?:不|未|无需).{0,30}(?:投放|发布|上线|接入|加载|支持|启用|涉及|采集|收集|填写|录入|上传|读取|获取|存储|保存|传输|共享|跳转|对接|新增|开发|修改|变更)|暂不|禁止|关闭|禁用|取消|可后续|后续.{0,12}(?:扩展|支持|投放|接入|上线)|按实际.{0,20}(?:扩展|选择|启用)|配置扩展|候选|备选|可选|待确认|待定|预留|二期|未来|如(?:涉及|需|需要)|若(?:涉及|需|需要)|如果(?:涉及|需|需要)|视情况|可能支持|计划后续/i;
const EVIDENCE_IGNORED_KEYS = /^(?:id|source|sourcePaths|sourceStatePaths|createdAt|updatedAt|confidence|reason|status)$/i;

function stripChannelTables(content: string) {
  return stripMarkdownTables(content, /活动投放的可选渠道|WAP\/H5端外渠道/);
}

function stripSafetyTables(content: string) {
  return stripMarkdownTables(content, /需求安全基线内容|是否有新开发功能接口或现有功能接口逻辑变动/);
}

function stripMarkdownTables(content: string, marker: RegExp) {
  const lines = content.split("\n");
  const result: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!/^\s*\|.*\|\s*$/.test(lines[index] ?? "")) {
      result.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end] ?? "")) end += 1;
    const table = lines.slice(index, end);
    if (!marker.test(table.join("\n"))) result.push(...table);
    index = end;
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function collectDesignBusinessEvidence(state?: ConversationDesignState) {
  if (!state) return [];
  return collectEvidenceStrings([
    state.title,
    state.summary,
    state.businessGoal,
    state.background,
    state.targetUsers,
    state.userScenarios,
    state.pages,
    state.features,
    state.backendConfigs,
    state.frontendRules,
    state.businessRules,
    state.stateRules,
    state.exceptionScenarios,
    state.acceptanceCriteria,
    Array.isArray(state.assumptions) ? state.assumptions.filter(isConfirmedAssumption) : [],
    state.confirmedFacts,
  ]);
}

function collectSectionBusinessEvidence(sections: RequirementDocSection[]) {
  return sections.flatMap((section) => {
    if (section.id === "safety_baseline" || section.type === "appendix" || /安全基线|安全自查/.test(section.title)) {
      return [];
    }
    return [
      stripSafetyTables(stripChannelTables(section.content)),
      ...(section.blocks ?? []).map((block) => stripSafetyTables(stripChannelTables(block.content ?? ""))),
    ].map((value) => value.trim()).filter(Boolean);
  });
}

function collectEvidenceStrings(values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      return text ? [text] : [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => collectEvidenceStrings([item]));
    if (!value || typeof value !== "object") return [];
    const text = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !EVIDENCE_IGNORED_KEYS.test(key))
      .flatMap(([, item]) => collectEvidenceStrings([item]))
      .join(" ")
      .trim();
    return text ? [text] : [];
  });
}

function hasExplicitChannelEvidence(
  state: ConversationDesignState | undefined,
  evidence: string[],
  kind: ChannelKind,
) {
  if (hasStructuredChannelSelection(state, kind)) return true;
  const channelPattern = CHANNEL_PATTERNS[kind];
  return evidence.some((text) => splitEvidenceClauses(text).some((clause) =>
    channelPattern.test(clause)
    && CHANNEL_ACTION_PATTERN.test(clause)
    && !NON_CURRENT_EVIDENCE_PATTERN.test(clause),
  ));
}

function hasStructuredChannelSelection(state: ConversationDesignState | undefined, kind: ChannelKind) {
  if (!state) return false;
  const values = [
    state.userScenarios,
    state.pages,
    state.features,
    state.backendConfigs,
    state.frontendRules,
    state.businessRules,
    state.stateRules,
    Array.isArray(state.assumptions) ? state.assumptions.filter(isConfirmedAssumption) : [],
    state.confirmedFacts,
  ];
  return values.some((value) => findStructuredChannelSelection(value, kind));
}

function findStructuredChannelSelection(value: unknown, kind: ChannelKind): boolean {
  if (Array.isArray(value)) return value.some((item) => findStructuredChannelSelection(item, kind));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const explicitStatus = Object.entries(record).find(([key]) =>
    /^(?:enabled|selected|active|published|launched|isEnabled|isSelected|status|是否投放|是否发布)$/i.test(key),
  )?.[1];
  if (isExplicitNegativeValue(explicitStatus) || isExplicitNonCurrentValue(explicitStatus)) return false;

  return Object.entries(record).some(([key, item]) => {
    if (/可选|候选|备选|available|candidate|option/i.test(key)) return false;
    if (/^(?:channel|channels|deliveryChannel|deliveryChannels|publishChannel|publishChannels|launchChannel|launchChannels|platform|platforms|投放渠道|发布渠道|上线渠道)$/i.test(key)) {
      const text = collectEvidenceStrings([item]).join(" ");
      return CHANNEL_PATTERNS[kind].test(text)
        && !NON_CURRENT_EVIDENCE_PATTERN.test(text)
        && !isExplicitNegativeValue(explicitStatus);
    }
    if (keyNamesChannel(key, kind)) return isExplicitPositiveValue(item);
    return findStructuredChannelSelection(item, kind);
  });
}

function keyNamesChannel(key: string, kind: ChannelKind) {
  if (kind === "in_app") return /^(?:app|inApp|appChannel|端内|端内渠道)$/i.test(key);
  if (kind === "h5") return /^(?:h5|wap|h5Channel|wapChannel|端外|端外渠道)$/i.test(key);
  return /^(?:miniProgram|mini_program|wechatMiniProgram|小程序|小程序渠道)$/i.test(key);
}

function isExplicitPositiveValue(value: unknown) {
  if (value === true || value === 1) return true;
  return typeof value === "string" && /^(?:true|yes|on|enabled|selected|active|是|启用|投放|发布)$/i.test(value.trim());
}

function isExplicitNegativeValue(value: unknown) {
  if (value === false || value === 0) return true;
  return typeof value === "string" && /^(?:false|no|off|disabled|unselected|inactive|否|不启用|不投放|不发布)$/i.test(value.trim());
}

function isExplicitNonCurrentValue(value: unknown) {
  return typeof value === "string" && /^(?:pending|draft|candidate|future|待确认|待定|候选|草稿|后续)$/i.test(value.trim());
}

function isConfirmedAssumption(value: Record<string, unknown>) {
  return /^(?:confirmed|accepted|approved|已确认|已接受|已批准)$/i.test(String(value.status ?? "").trim());
}

function splitEvidenceClauses(text: string) {
  return text.split(/[，,；;。！？!?\n]+/).map((item) => item.trim()).filter(Boolean);
}

function hasPositiveBusinessEvidence(evidence: string[], subject: RegExp, action?: RegExp) {
  return evidence.some((text) => splitEvidenceClauses(text).some((clause) =>
    subject.test(clause)
    && (!action || action.test(clause))
    && !NON_CURRENT_EVIDENCE_PATTERN.test(clause),
  ));
}

function isStructuralSection(section: RequirementDocSection) {
  if (["background", "scope", "target_users", "user_scenarios", "business_goal", "acceptance_criteria", "backend_configs", "exception_scenarios", "assumptions", "knowledge_refs", "pending_questions", "appendix"].includes(section.type)) {
    return true;
  }
  return /^(封面|版\s*本|版本|目\s*录|引言|项目背景|文档范围|使用场景|用户场景|业务需求|页面链接|页面入口|接口|API|验收|业务降级|降级|异常|需求安全|安全基线)/.test(cleanHeadingTitle(section.title));
}

function buildFormatValidationNotes(sections: RequirementDocSection[]) {
  const notes = [
    "补齐边界：未确认内容仅记录为假设或待确认项；不臆造生产地址、真实接口、密钥或内部敏感信息；知识库规则优先于模型推断和外部资料。",
  ];
  const hasVisual = sections.some((section) => section.blocks?.some((block) =>
    ["diagram", "image", "prototype_snapshot", "asset_reference"].includes(block.type),
  ));
  if (!hasVisual) {
    notes.push("当前 PRD 未引用流程图、架构图或原型截图，建议补充知识库视觉素材后重新生成。");
  }
  return notes;
}

function renderMarkdownTable(headers: string[], rows: string[][]) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function collectRequirementRows(state?: ConversationDesignState) {
  const groups: Array<{
    label: string;
    items: unknown;
    defaultPageRequirement: string;
  }> = [
    { label: "功能", items: state?.features, defaultPageRequirement: "页面展示可执行操作、操作结果和下一步入口" },
    { label: "后台配置", items: state?.backendConfigs, defaultPageRequirement: "后台展示字段、默认值、必填校验、权限和保存结果" },
    { label: "前台规则", items: state?.frontendRules, defaultPageRequirement: "前台展示正常、空态、禁用、失败和结果反馈" },
    { label: "业务规则", items: state?.businessRules, defaultPageRequirement: "相关页面按规则控制操作可用性、状态和提示文案" },
    { label: "状态规则", items: state?.stateRules, defaultPageRequirement: "页面明确展示当前状态、允许操作和状态变更结果" },
  ];

  return groups.flatMap((group) => arrayOfRecords(group.items).map((item, index) => {
    const name = recordName(item, `${group.label}${index + 1}`);
    const rule = recordValue(item, [
      "rule",
      "description",
      "content",
      "summary",
      "triggerCondition",
      "precondition",
      "expectedBehavior",
      "expectedResult",
      "defaultValue",
    ]) || `${name}在满足前置条件时执行，成功后写入业务状态和操作记录，失败时保留原因并允许后续处理`;
    const pageRequirement = recordValue(item, [
      "pageRequirement",
      "uiRequirement",
      "displayRule",
      "frontendBehavior",
      "pageBehavior",
    ]) || group.defaultPageRequirement;
    return [`${group.label}：${name}`, rule, pageRequirement];
  }));
}

function buildGenericCoreRules(baseName: string) {
  return renderMarkdownTable(
    ["功能点", "业务规则", "页面要求"],
    [
      ["后台配置", `${baseName}后台提供创建、编辑、保存、查询和权限控制，保存成功后形成可追踪版本。`, "必填项、默认值、权限、保存成功和保存失败状态均需可见。"],
      ["前台使用", `${baseName}前台按用户资格和当前业务状态展示可执行操作，成功后立即反馈结果。`, "覆盖正常态、空态、禁用态、无权限态和失败态。"],
      ["状态流转", `${baseName}每次关键操作均记录操作前状态、操作后状态、操作时间和操作结果。`, "当前状态、允许操作和不可操作原因必须清晰展示。"],
      ["数据治理", `${baseName}关键结果可查询、筛选和审计，失败记录可定位原因并进入后续处理。`, "后台提供筛选、明细、状态标签和处理入口。"],
    ],
  );
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function recordName(item: Record<string, unknown>, fallback: string) {
  return recordValue(item, ["name", "title", "label", "id"]) || fallback;
}

function recordValue(item: Record<string, unknown>, keys: string[]) {
  return keys
    .map((key) => item[key])
    .map((value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "")
    .find(Boolean) || "";
}

function recordNames(value: unknown, prefix: string) {
  return uniqueNames(
    arrayOfRecords(value).map((item, index) => recordName(item, `${prefix}${index + 1}`)),
  );
}

function uniqueNames(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function diagramGroupLabel(group: string, values: string[], fallback: string) {
  const content = values.length ? values.join(" / ") : fallback;
  return mermaidLabel(`${group}：${content}`);
}

function mermaidLabel(value: string) {
  return value.replace(/[\[\]{}()<>"'`|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 36) || "业务页面";
}

function escapeMarkdownCell(value: string) {
  return String(value ?? "").replace(/\n+/g, "<br>").replace(/\|/g, "｜");
}

function compactRecordItems(items: unknown, prefix: string) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => compactRecordItem(item, `${prefix}${index + 1}`))
    .filter(Boolean);
}

function compactRecordItem(item: unknown, fallback: string) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return String(item || "").trim();
  const record = item as Record<string, unknown>;
  const title = [record.name, record.title, record.label, record.id, fallback]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) || fallback;
  const detail = [record.description, record.summary, record.rule, record.content]
    .map((value) => String(value ?? "").trim())
    .find(Boolean);
  return detail ? `${title}：${detail}` : title;
}

function cleanHeadingTitle(value: string) {
  return value.replace(/^\s*\d+(\.\d+)*[.、]?\s*/, "").trim();
}

function formatDate(value: string | undefined) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function blockToMarkdown(block: RequirementDocBlock) {
  const title = block.title?.trim();
  const content = block.content?.trim() ?? "";
  if (block.type === "diagram") {
    return [
      title ? `**${title}**` : "",
      `\`\`\`${block.diagramSyntax ?? "mermaid"}`,
      content,
      "```",
    ].filter(Boolean).join("\n");
  }
  if ((block.type === "image" || block.type === "prototype_snapshot") && block.assetPath) {
    return [
      `![${title || content || "原型截图"}](${block.assetPath})`,
      content,
    ].filter(Boolean).join("\n\n");
  }
  if (block.type === "asset_reference") {
    return [
      title ? `**${title}**` : "**素材引用**",
      content,
      block.assetPath ? `素材路径：${block.assetPath}` : "",
    ].filter(Boolean).join("\n");
  }
  return [title ? `**${title}**` : "", content].filter(Boolean).join("\n");
}
