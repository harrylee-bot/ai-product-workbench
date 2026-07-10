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
  { index: "2", content: "业务功能是否面向公众用户", scope: "信息系统（包含前端、后端、管理后台）", status: "是" },
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
      [["讨论稿", author, "待确认", date, `新增《${title}》，覆盖核心业务规则、降级方案与安全基线。`]],
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
      findSectionContent(sourceSections, ["user_scenarios"], /使用场景|用户场景/)
        || `运营或管理人员在后台完成${baseName}相关配置与处理，目标用户在前台完成核心操作并获得明确结果反馈，管理人员可查询状态和数据记录。`,
      renderMarkdownTable(["序号", "活动投放的可选渠道", "是否投放"], buildChannelRows(sourceSections, state)),
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
      || buildDegradationFallback(baseName),
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
    validationNotes: [
      ...(draft.validationNotes ?? []),
      ...buildFormatValidationNotes(sections),
    ],
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
  if (!author) return "待确认";
  if (/^(cm|cl)[0-9a-z]{18,}$/i.test(author) || /^[0-9a-f-]{32,36}$/i.test(author)) {
    return "待确认";
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
    : `- ${baseName}相关运营后台配置、前台页面展示、业务流程、验收标准、降级方案和安全基线。\n- 覆盖配置保存、预览审核、发布上线、用户参与、结果记录、异常处理和数据报表闭环。`;
}

function buildChannelRows(sections: RequirementDocSection[], state?: ConversationDesignState) {
  const text = JSON.stringify({ sections, state });
  return [
    ["1", "端内渠道", "☑是 □否"],
    ["2", "WAP/H5端外渠道", /H5|WAP|端外|wap|h5/.test(text) ? "☑是 □否" : "□是 ☑否"],
    ["3", "小程序", /小程序/.test(text) ? "☑是 □否" : "□是 ☑否"],
  ];
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
      `- 后台入口：${baseName}管理入口，承载配置、审核、发布、查询和数据治理。`,
      `- 前台入口：${baseName}用户入口，承载核心操作、结果反馈和异常状态。`,
      "- 页面 URL / 路由：以实际上线地址为准；最终路由不得替代本文中的页面职责和状态要求。",
    ].join("\n");
  }
  return renderMarkdownTable(
    ["页面/入口", "进入方式/路由", "页面职责"],
    pages.map((page, index) => [
      recordName(page, `页面${index + 1}`),
      recordValue(page, ["entry", "entryPath", "route", "url", "path", "menuPath", "navigation"])
        || "由上级菜单或业务入口进入，路由以实际上线地址为准",
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
  const pages = compactRecordItems(state?.pages, "页面").slice(0, 5);
  const states = compactRecordItems(state?.stateRules, "状态").slice(0, 5);
  const exceptions = compactRecordItems(state?.exceptionScenarios, "异常").slice(0, 5);
  const pageText = pages.length ? pages.join("、") : "后台配置页、前台展示页、审核发布页、数据报表页";
  const stateText = states.length ? states.join("、") : "草稿、待审核、已发布、已下线、失败待处理";
  const exceptionText = exceptions.length ? exceptions.join("、") : "失败、重复、超时、无权限、空态";
  return [
    `${baseName}流程需要覆盖${pageText}。业务从运营配置开始，经预览校验、提交审核、发布上线后进入用户参与或结果反馈，最终沉淀为数据报表和异常处理记录。`,
    `状态要求：至少覆盖${stateText}，每个状态必须说明触发条件、可执行动作和页面表现。`,
    `异常要求：至少覆盖${exceptionText}，不得出现无提示失败、重复提交、错误成功态或状态不一致。`,
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
  const pageNames = arrayOfRecords(state?.pages).map((item, index) => recordName(item, `页面${index + 1}`)).slice(0, 4);
  const firstPage = mermaidLabel(pageNames[0] || "后台配置/管理页面");
  const secondPage = mermaidLabel(pageNames[1] || "审核/处理页面");
  const userPage = mermaidLabel(pageNames[2] || "前台用户页面");
  if (!hasFlow) {
    additions.push({
      id: "product_flow_diagram",
      type: "diagram",
      title: "产品流程图",
      diagramSyntax: "mermaid",
      content: [
        "flowchart TD",
        `  A[进入${mermaidLabel(baseName)}] --> B[${firstPage}]`,
        `  B --> C[${secondPage}]`,
        "  C -->|通过| D[提交审核]",
        "  C -->|失败| B",
        "  D -->|审核通过| E[发布上线]",
        "  D -->|审核驳回| B",
        `  E --> F[${userPage}]`,
        "  F --> G{资格/状态校验}",
        "  G -->|通过| H[用户参与并生成记录]",
        "  G -->|不通过| I[展示不可参与原因]",
        "  H --> J[结果反馈/权益发放/状态更新]",
        "  J --> K[数据报表与异常处理]",
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
        "  OP[运营后台] --> CFG[配置中心]",
        "  CFG --> AUDIT[审核发布]",
        "  AUDIT --> PAGE[前台页面]",
        "  PAGE --> RULE[业务规则校验]",
        "  RULE --> RECORD[业务记录/状态流水]",
        "  RECORD --> BENEFIT[权益/结果处理]",
        "  BENEFIT --> COMP[异常补偿/人工处理]",
        "  RECORD --> REPORT[数据报表]",
        "  COMP --> REPORT",
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

function buildDegradationFallback(baseName: string) {
  return [
    `如${baseName}涉及的配置保存、发布审核、查询能力、状态同步或页面跳转出现异常，前台页面应保留当前可用状态并展示明确失败提示，不允许出现空白页、重复提交或错误成功态。`,
    "运营后台应记录失败原因、请求时间、关键配置编号和操作人，支持人工核对后重试或回滚到上一版已生效配置。",
    "下游系统或目标页面不可用时，平台应暂停后续处理或标记为待处理，待依赖恢复后由管理人员重新触发同步，确保用户可见状态、后台配置状态和最终业务结果保持一致。",
  ].join("\n");
}

function buildSafetyRows(title: string, sections: RequirementDocSection[], state?: ConversationDesignState) {
  const text = JSON.stringify({ title, sections, state }).toLowerCase();
  const rows = SAFETY_BASELINE_ROWS.map((row) => ({ ...row }));
  const setYes = (...indexes: string[]) => {
    indexes.forEach((index) => {
      const row = rows.find((item) => item.index === index);
      if (row) row.status = "是";
    });
  };

  if (/后台|管理|配置|运营/.test(text)) setYes("5", "6");
  if (/敏感词|后台配置|配置.*展示|前台展示|发布|上线|审核/.test(text)) setYes("9", "10");
  if (/隐私|个人信息|手机号|证件|身份证|银行卡|用户信息/.test(text)) setYes("4", "11", "12", "18", "19");
  if (/身份证|银行卡|生物识别/.test(text)) setYes("13");
  if (/免密|一键登录|登录/.test(text)) setYes("14");
  if (/第三方|外链|跳转.*app|跳转.*应用|跳转.*页面/.test(text)) setYes("15", "16");
  if (/接口|api|回调|联调|调用|新增|修改/.test(text)) setYes("17", "18");
  if (/埋点|采集|统计|pv|uv|快照|交易|数据|报表/.test(text)) setYes("20", "21");
  return rows.map((row) => [row.index, row.content, row.scope, row.status]);
}

function isStructuralSection(section: RequirementDocSection) {
  if (["background", "scope", "target_users", "user_scenarios", "business_goal", "acceptance_criteria", "backend_configs", "exception_scenarios", "assumptions", "knowledge_refs", "pending_questions", "appendix"].includes(section.type)) {
    return true;
  }
  return /^(封面|版\s*本|版本|目\s*录|引言|项目背景|文档范围|使用场景|用户场景|业务需求|页面链接|页面入口|接口|API|验收|业务降级|降级|异常|需求安全|安全基线)/.test(cleanHeadingTitle(section.title));
}

function buildFormatValidationNotes(sections: RequirementDocSection[]) {
  const notes: string[] = [];
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
