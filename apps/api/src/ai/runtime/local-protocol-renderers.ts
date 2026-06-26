import { randomUUID } from "node:crypto";
import type {
  PatchPlan,
  ProductDesignState,
  PrototypeArtifactDraft,
  PrototypeComponentSpec,
  PrototypePageSpec,
  PrototypeSpec,
  PrototypeTargetDevice,
  QAProtocolOutput,
  QAIssue,
  RequirementDocSection,
  RequirementDocSectionType,
  RequirementDocumentDraft,
  SelectedRegion,
} from "../ai-vibe.types";

type PatchPlanInput = {
  userInput: string;
  selectedRegion: SelectedRegion;
  productDesignState: ProductDesignState;
};

export function renderPrdFromState(state: ProductDesignState): RequirementDocumentDraft {
  const sections = SECTION_CONFIGS.map((config, index) => {
    const content = config.render(state) || "暂无";
    return {
      id: config.id,
      title: config.title,
      type: config.type,
      level: 1 as const,
      order: index + 1,
      content,
      blocks: [{
        id: `${config.id}_body`,
        type: "paragraph" as const,
        content,
        sourcePaths: config.paths,
        tags: config.tags,
      }],
      sourcePaths: config.paths,
      sourceStatePaths: config.paths,
      tags: config.tags,
    };
  });
  return {
    projectId: state.projectId,
    title: `${state.title} PRD`,
    sections,
    assumptions: state.assumptions.map((item, index) => ({
      assumptionId: text(item.id) || `assumption_${index + 1}`,
      content: text(item.content) || text(item.description) || "待确认假设",
      relatedSectionIds: ["assumptions"],
      status: item.status === "confirmed" || item.status === "rejected" ? item.status : "pending",
    })),
    knowledgeRefs: state.knowledgeRefs,
    pendingQuestions: state.pendingQuestions.map((item, index) => ({
      questionId: text(item.id) || text(item.questionId) || `question_${index + 1}`,
      question: text(item.question) || text(item.title) || "请补充该需求细节。",
      reason: text(item.reason) || "该信息会影响后续 PRD 或原型生成。",
      relatedSectionIds: [],
      status: item.status === "answered" || item.status === "skipped" ? item.status : "pending",
    })),
    validationNotes: ["PRD 由 Vibe 产品协议 fallback 渲染，未包含接口、SQL、代码、数据库或部署实现细节。"],
  };
}

const SECTION_CONFIGS: Array<{
  id: string;
  title: string;
  type: RequirementDocSectionType;
  paths: string[];
  render: (state: ProductDesignState) => string;
  tags?: RequirementDocSection["tags"];
}> = [
  { id: "overview", title: "1. 需求概述", type: "overview", paths: ["title", "summary"], render: (state) => state.summary || `本需求围绕“${state.title}”沉淀产品设计状态。` },
  { id: "background", title: "2. 需求背景", type: "background", paths: ["background"], render: (state) => state.background || "暂无明确背景，需后续补充。" },
  { id: "business_goal", title: "3. 业务目标", type: "business_goal", paths: ["businessGoal"], render: (state) => state.businessGoal || "暂无明确业务目标。" },
  { id: "target_users", title: "4. 目标用户", type: "target_users", paths: ["targetUsers"], render: (state) => listItems(state.targetUsers) },
  { id: "user_scenarios", title: "5. 使用场景", type: "user_scenarios", paths: ["userScenarios"], render: (state) => listItems(state.userScenarios) },
  { id: "scope", title: "6. 需求范围", type: "scope", paths: ["features", "prototypeOutline"], render: (state) => state.features.length ? listItems(state.features) : outlineText(state.prototypeOutline) },
  { id: "page_requirements", title: "7. 页面需求", type: "page_requirements", paths: ["pages"], render: (state) => listItems(state.pages) },
  { id: "backend_configs", title: "8. 后端配置", type: "backend_configs", paths: ["backendConfigs"], render: (state) => listItems(state.backendConfigs) },
  { id: "frontend_rules", title: "9. 前端规则", type: "frontend_rules", paths: ["frontendRules"], render: (state) => listItems(state.frontendRules) },
  { id: "business_rules", title: "10. 业务规则", type: "business_rules", paths: ["businessRules"], render: (state) => listItems(state.businessRules) },
  { id: "state_rules", title: "11. 状态规则", type: "state_rules", paths: ["stateRules"], render: (state) => listItems(state.stateRules) },
  { id: "exception_scenarios", title: "12. 异常场景", type: "exception_scenarios", paths: ["exceptionScenarios"], render: (state) => listItems(state.exceptionScenarios) },
  { id: "acceptance_criteria", title: "13. 验收标准", type: "acceptance_criteria", paths: ["acceptanceCriteria"], render: (state) => listItems(state.acceptanceCriteria) },
  { id: "assumptions", title: "14. 假设与前提", type: "assumptions", paths: ["assumptions"], render: (state) => listItems(state.assumptions), tags: ["ai_assumption"] },
  { id: "knowledge_refs", title: "15. 知识引用", type: "knowledge_refs", paths: ["knowledgeRefs"], render: (state) => listItems(state.knowledgeRefs), tags: ["knowledge_base"] },
  { id: "pending_questions", title: "16. 待确认问题", type: "pending_questions", paths: ["pendingQuestions"], render: (state) => listItems(state.pendingQuestions), tags: ["pending_question"] },
];

export function renderPrototypeSpecFromState(
  state: ProductDesignState,
  targetDevice: PrototypeTargetDevice = "both",
  generatedByRunId?: string,
): PrototypeSpec {
  const pages = state.pages.length ? state.pages : [{ id: "page_main", name: state.title, description: state.summary }];
  const pageSpecs = pages.map((page, index) => toPageSpec(page, state, index, targetDevice));
  return {
    id: randomUUID(),
    projectId: state.projectId,
    productDesignStateId: state.id,
    productDesignStateVersion: state.version,
    title: `${state.title} HTML 原型`,
    targetDevice,
    styleGuide: {
      tone: "clean",
      primaryColor: "#111827",
      backgroundColor: "#f6f7f8",
      layoutDensity: "comfortable",
      borderRadius: "small",
      typography: {
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, sans-serif",
        titleSize: "28px",
        bodySize: "14px",
      },
      notes: ["用于产品评审和交互演示，不作为生产代码。"],
    },
    pages: pageSpecs,
    navigation: pageSpecs.slice(1).map((page, index) => ({
      id: `nav_${pageSpecs[0].id}_to_${page.id}`,
      fromPageId: pageSpecs[0].id,
      toPageId: page.id,
      triggerComponentId: pageSpecs[0].components[index + 1]?.id,
      label: page.name,
    })),
    interactions: pageSpecs.map((page) => ({
      id: `${page.id}_click_primary_action`,
      pageId: page.id,
      componentId: `${page.id}_primary_action`,
      event: "click",
      action: "show_toast",
      targetComponentId: `${page.id}_exception_toast`,
      mockResult: "操作成功，页面状态已更新。",
      sourcePaths: ["businessRules", "exceptionScenarios"],
    })),
    assumptions: state.assumptions.map((item, index) => ({
      assumptionId: text(item.id) || `assumption_${index + 1}`,
      content: text(item.content) || text(item.description) || "待确认假设",
      relatedSectionIds: ["prototype"],
      status: item.status === "confirmed" || item.status === "rejected" ? item.status : "pending",
    })),
    knowledgeRefs: state.knowledgeRefs,
    generatedByRunId,
  };
}

function toPageSpec(
  page: Record<string, unknown>,
  state: ProductDesignState,
  index: number,
  targetDevice: PrototypeTargetDevice,
): PrototypePageSpec {
  const pageId = text(page.id) || `page_${index + 1}`;
  const pageName = text(page.name) || text(page.title) || (index === 0 ? state.title : `页面 ${index + 1}`);
  return {
    id: pageId,
    name: pageName,
    route: `#${pageId}`,
    sourcePageId: text(page.id) || undefined,
    device: targetDevice === "mobile" ? "mobile" : targetDevice === "desktop" ? "desktop" : "responsive",
    layout: targetDevice === "mobile" ? "mobile_page" : "dashboard",
    description: text(page.description) || text(page.purpose),
    order: index + 1,
    sourcePaths: [`pages[${index}]`],
    components: [
      {
        id: `${pageId}_header`,
        name: "页面标题",
        type: "header",
        content: pageName,
        description: text(page.description) || text(page.purpose) || state.summary,
        sourcePaths: [`pages[${index}]`, "summary"],
      },
      {
        id: `${pageId}_goal_card`,
        name: "业务目标卡片",
        type: "card",
        content: state.businessGoal,
        sourcePaths: ["businessGoal"],
      },
      ...state.features.slice(0, 4).map((feature, featureIndex) => ({
        id: `${pageId}_feature_${featureIndex + 1}`,
        name: text(feature.name) || text(feature.title) || `核心功能 ${featureIndex + 1}`,
        type: "card" as const,
        content: text(feature.description) || text(feature.purpose) || "待补充功能说明",
        sourcePaths: [`features[${featureIndex}]`],
      })),
      {
        id: `${pageId}_primary_action`,
        name: "主行动按钮",
        type: "button",
        content: "执行核心操作",
        states: state.stateRules.map((rule) => text(rule.name) || text(rule.id)).filter(Boolean),
        interactions: ["click_primary_action"],
        sourcePaths: ["stateRules", "businessRules"],
      },
      {
        id: `${pageId}_state_list`,
        name: "状态展示",
        type: "list",
        content: state.stateRules.map((rule) => text(rule.name) || text(rule.description)).filter(Boolean).join(" / "),
        sourcePaths: ["stateRules"],
      },
      {
        id: `${pageId}_exception_toast`,
        name: "异常反馈",
        type: "status_badge",
        content: state.exceptionScenarios[0]
          ? text(state.exceptionScenarios[0].userMessage) ||
            text(state.exceptionScenarios[0].expectedBehavior) ||
            text(state.exceptionScenarios[0].title)
          : "操作失败，请稍后重试",
        sourcePaths: ["exceptionScenarios"],
      },
    ],
    states: state.stateRules.map((rule, stateIndex) => ({
      id: text(rule.id) || `${pageId}_state_${stateIndex + 1}`,
      name: text(rule.name) || text(rule.state) || `状态 ${stateIndex + 1}`,
      description: text(rule.description) || text(rule.userVisibleText) || "待补充状态说明",
      disabledComponents: /禁用|不可|disabled/i.test(JSON.stringify(rule)) ? [`${pageId}_primary_action`] : undefined,
      copyChanges: text(rule.userVisibleText) ? { [`${pageId}_primary_action`]: text(rule.userVisibleText) } : undefined,
      sourcePaths: [`stateRules[${stateIndex}]`],
    })),
  };
}

export function renderHtmlFromPrototypeSpec(spec: PrototypeSpec): string {
  const firstPageId = spec.pages[0]?.id ?? "page_main";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(spec.title)}</title>
  <style>
    * { box-sizing: border-box; }
    :root { --ink: #111827; --muted: #5b6472; --line: #e5e7eb; --bg: ${escapeHtml(spec.styleGuide.backgroundColor ?? "#f6f7f8")}; --card: #fff; --primary: ${escapeHtml(spec.styleGuide.primaryColor ?? "#111827")}; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font-family: ${escapeHtml(spec.styleGuide.typography?.fontFamily ?? "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, sans-serif")}; letter-spacing: 0; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
    nav { border-right: 1px solid var(--line); background: rgba(255,255,255,.78); padding: 22px 16px; }
    nav strong { display: block; margin-bottom: 14px; font-size: 14px; }
    nav button { width: 100%; margin-bottom: 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; padding: 10px 12px; text-align: left; color: var(--muted); cursor: pointer; }
    nav button.active { border-color: var(--line); background: #fff; color: var(--ink); font-weight: 700; }
    main { min-width: 0; padding: 28px; }
    .page { display: none; max-width: 1120px; margin: 0 auto; }
    .page.active { display: block; }
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.25; }
    p { color: var(--muted); line-height: 1.7; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .component { border: 1px solid var(--line); border-radius: 8px; background: var(--card); padding: 16px; box-shadow: 0 8px 22px rgba(15,23,42,.05); }
    .component strong { display: block; margin-bottom: 8px; font-size: 14px; }
    .primary-action { height: 42px; border: 0; border-radius: 8px; background: var(--primary); color: white; padding: 0 18px; font-weight: 700; cursor: pointer; }
    .list-item { border-radius: 8px; background: #f8fafc; padding: 10px 12px; color: #334155; margin-top: 8px; }
    .toast { position: fixed; right: 24px; bottom: 24px; display: none; max-width: 320px; border: 1px solid #bbf7d0; border-radius: 8px; background: #f0fdf4; color: #047857; padding: 12px 14px; box-shadow: 0 12px 30px rgba(15,23,42,.12); }
    .toast.show { display: block; }
    @media (max-width: 760px) { .shell { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid var(--line); } .grid { grid-template-columns: 1fr; } main { padding: 18px; } .page-header { display: block; } }
  </style>
</head>
<body>
  <div class="shell">
    <nav aria-label="原型页面导航">
      <strong>${escapeHtml(spec.title)}</strong>
      ${spec.pages.map((page) => `<button type="button" data-nav-target="${escapeHtml(page.id)}" class="${page.id === firstPageId ? "active" : ""}">${escapeHtml(page.name)}</button>`).join("")}
    </nav>
    <main>${spec.pages.map((page) => renderPage(page, firstPageId)).join("")}</main>
  </div>
  <div id="prototypeToast" class="toast">操作成功，页面状态已更新。</div>
  <script>
    (function () {
      var toast = document.getElementById("prototypeToast");
      document.querySelectorAll("[data-nav-target]").forEach(function (button) {
        button.addEventListener("click", function () {
          var target = button.getAttribute("data-nav-target");
          document.querySelectorAll("[data-nav-target]").forEach(function (item) { item.classList.remove("active"); });
          document.querySelectorAll("[data-page-id]").forEach(function (page) { page.classList.remove("active"); });
          button.classList.add("active");
          var page = document.querySelector('[data-page-id="' + target + '"]');
          if (page) page.classList.add("active");
        });
      });
      document.querySelectorAll("[data-action='show-toast']").forEach(function (button) {
        button.addEventListener("click", function () {
          toast.textContent = button.getAttribute("data-result") || "操作成功，页面状态已更新。";
          toast.classList.add("show");
          window.setTimeout(function () { toast.classList.remove("show"); }, 2200);
        });
      });
    })();
  </script>
</body>
</html>`;
}

function renderPage(page: PrototypePageSpec, firstPageId: string) {
  const header = page.components.find((component) => component.type === "header");
  const rest = page.components.filter((component) => component.type !== "header");
  return `<section class="page ${page.id === firstPageId ? "active" : ""}" data-page-id="${escapeHtml(page.id)}">
    <div class="page-header" data-page-id="${escapeHtml(page.id)}" data-component-id="${escapeHtml(header?.id ?? `${page.id}_header`)}">
      <div>
        <h1>${escapeHtml(header?.content ?? page.name)}</h1>
        <p>${escapeHtml(header?.description ?? page.description ?? "用于产品评审的 HTML 原型页面。")}</p>
      </div>
      ${renderPrimaryButton(page)}
    </div>
    <div class="grid">${rest.map((component) => renderComponent(page.id, component)).join("")}</div>
  </section>`;
}

function renderPrimaryButton(page: PrototypePageSpec) {
  const action = page.components.find((component) => component.type === "button");
  return action ? renderPrototypeComponentFragment(page, action) : "";
}

function renderComponent(pageId: string, component: PrototypeComponentSpec) {
  if (component.type === "button") return "";
  return renderPrototypeComponentFragment({ id: pageId } as PrototypePageSpec, component);
}

export function renderPrototypeComponentFragment(page: PrototypePageSpec, component: PrototypeComponentSpec): string {
  const pageId = page.id;
  if (component.type === "button") {
    return `<button class="primary-action" type="button" data-action="show-toast" data-page-id="${escapeHtml(pageId)}" data-component-id="${escapeHtml(component.id)}" data-result="${escapeHtml(component.content ?? "操作成功，页面状态已更新。")}">${escapeHtml(component.content ?? component.name)}</button>`;
  }
  const content = component.content || component.description || "待补充内容";
  if (component.type === "list") {
    const items = content.split(/\/|,|，|\n/).map((item) => item.trim()).filter(Boolean);
    return `<article class="component" data-page-id="${escapeHtml(pageId)}" data-component-id="${escapeHtml(component.id)}">
      <strong>${escapeHtml(component.name)}</strong>
      ${items.length ? items.map((item) => `<div class="list-item">${escapeHtml(item)}</div>`).join("") : `<p>${escapeHtml(content)}</p>`}
    </article>`;
  }
  return `<article class="component" data-page-id="${escapeHtml(pageId)}" data-component-id="${escapeHtml(component.id)}">
    <strong>${escapeHtml(component.name)}</strong>
    <p>${escapeHtml(content)}</p>
  </article>`;
}

export function prototypeArtifactDraftFromSpec(
  spec: PrototypeSpec,
  generatedByRunId?: string,
): PrototypeArtifactDraft {
  const html = renderHtmlFromPrototypeSpec(spec);
  return {
    id: randomUUID(),
    projectId: spec.projectId,
    prototypeSpecId: spec.id,
    productDesignStateId: spec.productDesignStateId,
    productDesignStateVersion: spec.productDesignStateVersion,
    title: spec.title,
    htmlContent: html,
    html,
    entryFilePath: "index.html",
    entryFile: "index.html",
    targetDevice: spec.targetDevice,
    pageCount: spec.pages.length || 1,
    generatedByRunId,
    assets: [],
  };
}

export function createPatchPlanFromInput(input: PatchPlanInput): PatchPlan {
  const patchType = input.selectedRegion.type === "prototype" ? "prototype" : "document";
  const affectedStatePaths = input.selectedRegion.sourcePaths?.length
    ? input.selectedRegion.sourcePaths
    : patchType === "prototype"
      ? ["frontendRules"]
      : ["businessRules"];
  const componentLocalPrototype = patchType === "prototype" && Boolean(input.selectedRegion.componentId);
  return {
    id: `patch_plan_${Date.now().toString(36)}`,
    projectId: input.productDesignState.projectId,
    intent: inferPatchIntent(input.userInput),
    selectedRegion: input.selectedRegion,
    patchType,
    targetNodes: [
      input.selectedRegion.componentId ||
        input.selectedRegion.sectionId ||
        input.selectedRegion.targetId ||
        "productDesignState",
    ],
    impactScope: patchType === "prototype"
      ? componentLocalPrototype
        ? ["frontendRules", "prototypeSpec", "htmlPrototype"]
        : ["frontendRules", "stateRules", "acceptanceCriteria", "prototypeSpec"]
      : ["businessRules", "acceptanceCriteria", "prdDocument"],
    operations: [{
      op: "add",
      path: affectedStatePaths[0],
      value: {
        id: `patch_${Date.now().toString(36)}`,
        title: input.selectedRegion.label || "局部修改",
        description: input.userInput,
        source: { type: "user_confirmed", confidence: 0.95, note: "来自用户局部修改指令" },
      },
      reason: "根据用户局部修改要求写入 ProductDesignState。",
    }],
    impactAnalysis: {
      affectedStatePaths,
      affectedPrdSectionIds: input.selectedRegion.sectionId ? [input.selectedRegion.sectionId] : [],
      affectedPrototypePageIds: input.selectedRegion.pageId ? [input.selectedRegion.pageId] : [],
      affectedPrototypeComponentIds: input.selectedRegion.componentId ? [input.selectedRegion.componentId] : [],
      affectedAcceptanceCriteriaIds: [],
      requiresPrdRegeneration: true,
      requiresPrototypeRegeneration: true,
      requiresQaCheck: true,
      reason: "局部修改通过 ProductDesignState 更新后，由 Vibe 状态机重新生成相关产物。",
    },
    regenerationPlan: {
      prd: componentLocalPrototype ? "affected_sections" : "full",
      prototypeSpec: componentLocalPrototype ? "affected_pages" : "full",
      htmlPrototype: componentLocalPrototype ? "affected_pages" : "full",
      qa: "basic",
    },
    risks: [{ level: "low", message: "Patch 会先进入候选确认，不会直接修改正式产物。", relatedPaths: affectedStatePaths }],
    needUserConfirm: false,
    needsUserConfirmation: false,
    reason: "Vibe runtime fallback 生成可追踪 PatchPlan。",
    summary: `根据局部修改指令更新 ${affectedStatePaths.join("、") || "ProductDesignState"}。`,
  };
}

export function createQaOutputFromState(state: ProductDesignState): QAProtocolOutput {
  const issues: QAIssue[] = [];
  if (!state.stateRules.length) {
    issues.push({
      id: "qa_missing_state_rules",
      checkType: "state_schema",
      severity: "major",
      title: "缺少状态规则",
      description: "ProductDesignState 缺少状态规则，可能导致 PRD 与原型无法表达关键状态。",
      relatedStatePaths: ["stateRules"],
      suggestion: "补齐关键状态、状态触发条件和用户可见反馈。",
      autoFixable: false,
      status: "open",
    });
  }
  if (!state.exceptionScenarios.length) {
    issues.push({
      id: "qa_missing_exception_scenarios",
      checkType: "state_schema",
      severity: "minor",
      title: "缺少异常场景",
      description: "ProductDesignState 缺少异常场景，评审时可能遗漏失败态和兜底反馈。",
      relatedStatePaths: ["exceptionScenarios"],
      suggestion: "补充至少一个异常场景及对应用户提示。",
      autoFixable: false,
      status: "open",
    });
  }
  return {
    status: issues.some((issue) => issue.severity === "blocking" || issue.severity === "major")
      ? "failed"
      : issues.length
        ? "warning"
        : "passed",
    summary: issues.length ? `QA fallback 发现 ${issues.length} 个风险点。` : "QA fallback 未发现明显一致性风险。",
    issues,
  };
}

function inferPatchIntent(input: string): NonNullable<PatchPlan["intent"]> {
  if (/文案|按钮|标题|改成|命名|叫/i.test(input)) return "copy_change";
  if (/规则|限制|条件|会员|奖励/i.test(input)) return "rule_change";
  if (/状态|置灰|禁用|启用/i.test(input)) return "state_change";
  if (/配置|后台|参数/i.test(input)) return "config_change";
  if (/流程|步骤|跳转/i.test(input)) return "flow_change";
  if (/新增|增加|补充|加一个/i.test(input)) return "add_requirement";
  if (/删除|去掉|不要/i.test(input)) return "remove_requirement";
  return "unknown";
}

function listItems(items: Array<Record<string, unknown>>) {
  if (!items.length) return "暂无";
  return items.map((item, index) => {
    const title = text(item.name) || text(item.title) || text(item.id) || `条目 ${index + 1}`;
    const description = text(item.description) || text(item.content) || text(item.purpose);
    return description ? `- ${title}：${description}` : `- ${title}`;
  }).join("\n");
}

function outlineText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "暂无明确范围。";
  return JSON.stringify(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
