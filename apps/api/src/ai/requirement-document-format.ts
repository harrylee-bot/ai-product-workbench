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
  const title = getRequirementDocumentTitle(draft.title, state);
  const baseName = title.replace(/需求说明书$/, "") || "需求";
  const sourceSections = [...(draft.sections ?? [])].sort((a, b) => a.order - b.order);
  const author = options.author || state?.updatedBy || state?.createdBy || "待确认";
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
      [["V1.0", author, "待确认", date, `新增《${title}》，覆盖核心业务规则、接口、降级方案与安全基线。`]],
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
        || `运营人员在活动配置平台完成${baseName}相关配置，用户或下游系统按配置完成页面访问、结果查询或状态反馈。`,
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

  const coreSections = sourceSections
    .filter((section) => !isStructuralSection(section))
    .filter((section) => section.content.trim() || section.blocks?.length)
    .slice(0, 6);
  if (coreSections.length) {
    coreSections.forEach((section, index) => {
      add({
        ...section,
        id: `core_${index + 1}`,
        title: `2.${index + 2} ${cleanHeadingTitle(section.title) || "核心业务规则/功能说明"}`,
        type: section.type,
        level: 2,
        sourcePaths: section.sourcePaths ?? [],
      });
    });
  } else {
    add({
      id: "core_rules",
      title: "2.2 核心业务规则/功能说明",
      type: "business_rules",
      level: 2,
      content: buildCoreRulesFallback(baseName, state),
      sourcePaths: ["features", "businessRules"],
    });
  }

  // 接口信息章节已移除（根据需求：PRD 不应包含接口类信息）
  // 如果 DeerFlow 生成了 backend_configs 内容，仍保留但不强制生成
  const backendConfigContent = findSectionContent(sourceSections, ["backend_configs"], /接口|API|能力调用|新增\/修改/);
  if (backendConfigContent && backendConfigContent.trim().length > 0) {
    const interfaceNumber = `2.${sections.filter((section) => /^2\./.test(section.title)).length + 1}`;
    add({
      id: "interface_requirements",
      title: `${interfaceNumber} 本需求涉及新增/修改的接口`,
      type: "backend_configs",
      level: 2,
      content: backendConfigContent,
      sourcePaths: ["interfaces"],
    });
  }

  const acceptanceNumber = `2.${sections.filter((section) => /^2\./.test(section.title)).length + 1}`;
  add({
    id: "acceptance_criteria",
    title: `${acceptanceNumber} 验收标准`,
    type: "acceptance_criteria",
    level: 2,
    content: findSectionContent(sourceSections, ["acceptance_criteria"], /验收/)
      || buildAcceptanceFallback(baseName),
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

  return {
    ...draft,
    title,
    sections,
    validationNotes: [
      ...(draft.validationNotes ?? []),
      ...buildFormatValidationNotes(sourceSections),
    ],
  };
}

function getRequirementDocumentTitle(title: string, state?: ConversationDesignState) {
  const preferred = state?.title || title || "需求";
  const base = preferred
    .replace(/\s+/g, " ")
    .replace(/(产品需求文档|需求说明书|需求文档|PRD|prd)$/i, "")
    .replace(/[－\-—_ ]+$/g, "")
    .trim();
  return `${base || "需求"}需求说明书`;
}

function buildTocMarkdown() {
  return [
    "1 引言",
    "1.1 项目背景",
    "1.2 文档范围",
    "1.3 使用场景（必填）",
    "2 业务需求",
    "2.1 页面链接",
    "2.2 核心业务规则/功能说明",
    "2.x 本需求涉及新增/修改的接口",
    "2.x 验收标准",
    "3 业务降级方案（必填）",
    "4 需求安全基线要求（必填）",
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

function buildBackgroundFallback(baseName: string, state?: ConversationDesignState) {
  return state?.background
    || state?.summary
    || `${baseName}涉及活动配置平台相关业务能力。本次需求用于补充配置、页面展示、接口联动、结果校验和运营验收口径，支撑业务上线评审与测试用例编写。`;
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
    : `- ${baseName}相关页面、配置项、业务流程、接口、验收标准、降级方案和安全基线。\n- 具体上线范围以业务评审、技术方案和联调结果为准。`;
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
  const pageItems = compactRecordItems(state?.pages, "页面");
  return [
    `- 页面入口：${pageItems[0] || `${baseName}相关页面入口以活动配置平台实际菜单为准。`}`,
    "- 页面 URL / 路由：以实际上线地址为准。",
    "- 页面承载能力：配置、查询、展示、跳转、导出或结果反馈能力，不能只依赖链接说明。",
  ].join("\n");
}

function buildCoreRulesFallback(baseName: string, state?: ConversationDesignState) {
  const rows = [
    ...compactRecordItems(state?.features, "功能点"),
    ...compactRecordItems(state?.businessRules, "业务规则"),
    ...compactRecordItems(state?.stateRules, "状态规则"),
  ];
  if (!rows.length) {
    rows.push(`${baseName}需按业务配置完成展示、提交、查询、状态变更和结果反馈。`);
  }
  return renderMarkdownTable(
    ["功能点", "业务规则", "页面要求"],
    rows.slice(0, 8).map((item) => [item, "以本需求评审确认的配置和规则为准。", "页面需展示清晰状态、操作入口和异常提示。"]),
  );
}

function buildInterfaceFallback(baseName: string, sections: RequirementDocSection[], state?: ConversationDesignState) {
  const text = JSON.stringify({ sections, state });
  const type = /新增|新建|创建/.test(text) ? "新增/修改" : "修改";
  return [
    "具体接口地址以技术方案和联调结果为准，需求侧建议如下：",
    renderMarkdownTable(
      ["类型", "接口/能力", "说明"],
      [[type, `${baseName}配置、查询或状态同步能力`, "调用方为前台页面、运营后台或活动配置平台；被调用方为对应业务服务。触发时机包括页面加载、配置保存、发布审核、结果查询和状态回调；成功时返回配置/状态/结果数据，失败时需要返回明确错误码和提示文案。"]],
    ),
  ].join("\n\n");
}

function buildAcceptanceFallback(baseName: string) {
  return renderMarkdownTable(
    ["序号", "验收项", "验收标准"],
    [
      ["1", "页面可见性", `${baseName}相关入口、页面标题、配置项和结果展示符合评审确认范围。`],
      ["2", "业务规则", "配置保存、查询、状态流转、重复操作、空态和异常提示均符合需求规则。"],
      ["3", "接口处理", "接口成功、失败、超时和无权限场景均有明确返回、页面提示和日志记录。"],
      ["4", "存量影响", "存量活动、存量配置和历史页面不受本需求影响，新增能力可按权限和配置开关控制。"],
    ],
  );
}

function buildDegradationFallback(baseName: string) {
  return [
    `如${baseName}涉及的配置保存、发布审核、查询接口、状态同步或页面跳转出现异常，前台页面应保留当前可用状态并展示明确失败提示，不允许出现空白页、重复提交或错误成功态。`,
    "运营后台应记录失败原因、请求时间、关键配置编号和操作人，支持人工核对后重试或回滚到上一版已生效配置。",
    "下游系统或活动页面不可用时，平台应暂停继续发布或标记为待处理，待接口恢复后由运营重新触发同步，确保用户可见状态、后台配置状态和交易/活动结果保持一致。",
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
