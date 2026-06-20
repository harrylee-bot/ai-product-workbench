import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type {
  AssumptionReference,
  ProductDesignState,
  PrototypeComponentSpec,
  PrototypeInteraction,
  PrototypeNavigation,
  PrototypePageSpec,
  PrototypeSpec,
  PrototypeTargetDevice,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PrototypeDesignerInput = {
  productDesignState: ProductDesignState;
  targetView?: PrototypeTargetDevice;
  targetDevice?: PrototypeTargetDevice;
  designPreference?: string;
  generatedByRunId?: string;
};

@Injectable()
export class PrototypeDesignerAgentService extends BaseAgentService<
  PrototypeDesignerInput,
  PrototypeSpec
> {
  readonly agentName = AgentName.prototype_designer_agent;
  readonly taskType = ModelTaskType.prototype_design;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PrototypeDesignerInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Prototype Designer Agent。只能从 ProductDesignState 输出 PrototypeSpec JSON，不直接输出 HTML。每个 page/component 必须有稳定 id、sourcePaths；不得新增 ProductDesignState 中不存在的核心业务规则。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PrototypeDesignerInput): PrototypeSpec {
    return renderPrototypeSpecFromState(input.productDesignState, input.targetDevice ?? input.targetView ?? "both", input.generatedByRunId);
  }

  protected normalize(output: PrototypeSpec, input: PrototypeDesignerInput): PrototypeSpec {
    const fallback = this.fallback(input);
    const pages = Array.isArray(output.pages) && output.pages.length
      ? normalizePages(output.pages, fallback.pages)
      : fallback.pages;
    const interactions = Array.isArray(output.interactions) && output.interactions.length
      ? normalizeInteractions(output.interactions, pages, fallback.interactions)
      : fallback.interactions;
    return {
      id: safeText(output.id) || fallback.id,
      projectId: input.productDesignState.projectId,
      productDesignStateId: input.productDesignState.id,
      productDesignStateVersion: input.productDesignState.version,
      title: safeText(output.title) || fallback.title,
      targetDevice: normalizeTargetDevice(output.targetDevice) ?? fallback.targetDevice,
      styleGuide: {
        ...fallback.styleGuide,
        ...(output.styleGuide && typeof output.styleGuide === "object" && !Array.isArray(output.styleGuide)
          ? output.styleGuide
          : {}),
      },
      pages,
      navigation: Array.isArray(output.navigation) ? normalizeNavigation(output.navigation, pages) : fallback.navigation,
      interactions,
      assumptions: fallback.assumptions,
      knowledgeRefs: input.productDesignState.knowledgeRefs,
      generatedByRunId: input.generatedByRunId ?? output.generatedByRunId,
    };
  }
}

export function renderPrototypeSpecFromState(
  state: ProductDesignState,
  targetDevice: PrototypeTargetDevice = "both",
  generatedByRunId?: string,
): PrototypeSpec {
  const pages = state.pages.length ? state.pages : [{ id: "page_main", name: state.title, description: state.summary }];
  const pageSpecs = pages.map((page, index) => toPageSpec(page, state, index, targetDevice));
  const navigation = pageSpecs.slice(1).map((page, index) => ({
    id: `nav_${pageSpecs[0].id}_to_${page.id}`,
    fromPageId: pageSpecs[0].id,
    toPageId: page.id,
    triggerComponentId: pageSpecs[0].components[index + 1]?.id,
    label: page.name,
  }));
  const interactions = pageSpecs.flatMap((page) => toInteractions(page, state));

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
    navigation,
    interactions,
    assumptions: state.assumptions.map((item) => ({
      assumptionId: safeText(item.id),
      content: safeText(item.content) || safeText(item.description),
      relatedSectionIds: ["prototype"],
      status: normalizeAssumptionStatus(item.status),
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
  const pageId = safeText(page.id) || `page_${index + 1}`;
  const pageName = safeText(page.name) || safeText(page.title) || (index === 0 ? state.title : `页面 ${index + 1}`);
  const components: PrototypeComponentSpec[] = [
    {
      id: `${pageId}_header`,
      name: "页面标题",
      type: "header",
      content: pageName,
      description: safeText(page.description) || safeText(page.purpose) || state.summary,
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
      name: safeText(feature.name) || safeText(feature.title) || `核心功能 ${featureIndex + 1}`,
      type: "card" as const,
      content: safeText(feature.description) || safeText(feature.purpose) || "待补充功能说明",
      sourcePaths: [`features[${featureIndex}]`],
    })),
    {
      id: `${pageId}_primary_action`,
      name: "主行动按钮",
      type: "button",
      content: "执行核心操作",
      states: state.stateRules.map((rule) => safeText(rule.name) || safeText(rule.id)).filter(Boolean),
      interactions: ["click_primary_action"],
      sourcePaths: ["stateRules", "businessRules"],
    },
    {
      id: `${pageId}_state_list`,
      name: "状态展示",
      type: "list",
      content: state.stateRules.map((rule) => safeText(rule.name) || safeText(rule.description)).filter(Boolean).join(" / "),
      sourcePaths: ["stateRules"],
    },
    {
      id: `${pageId}_exception_toast`,
      name: "异常反馈",
      type: "status_badge",
      content: state.exceptionScenarios[0]
        ? safeText(state.exceptionScenarios[0].userMessage) ||
          safeText(state.exceptionScenarios[0].expectedBehavior) ||
          safeText(state.exceptionScenarios[0].title)
        : "操作失败，请稍后重试",
      sourcePaths: ["exceptionScenarios"],
    },
  ];

  return {
    id: pageId,
    name: pageName,
    route: `#${pageId}`,
    sourcePageId: safeText(page.id) || undefined,
    device: targetDevice === "mobile" ? "mobile" : targetDevice === "desktop" ? "desktop" : "responsive",
    layout: targetDevice === "mobile" ? "mobile_page" : "dashboard",
    description: safeText(page.description) || safeText(page.purpose),
    components,
    states: state.stateRules.map((rule, stateIndex) => ({
      id: safeText(rule.id) || `${pageId}_state_${stateIndex + 1}`,
      name: safeText(rule.name) || safeText(rule.state) || `状态 ${stateIndex + 1}`,
      description: safeText(rule.description) || safeText(rule.userVisibleText) || "待补充状态说明",
      disabledComponents: /禁用|不可|disabled/i.test(JSON.stringify(rule)) ? [`${pageId}_primary_action`] : undefined,
      copyChanges: safeText(rule.userVisibleText) ? { [`${pageId}_primary_action`]: safeText(rule.userVisibleText) } : undefined,
      sourcePaths: [`stateRules[${stateIndex}]`],
    })),
    sourcePaths: [`pages[${index}]`],
    order: index + 1,
  };
}

function toInteractions(page: PrototypePageSpec, state: ProductDesignState): PrototypeInteraction[] {
  const primaryAction = page.components.find((item) => item.type === "button") ?? page.components[0];
  return [
    {
      id: `${page.id}_click_primary_action`,
      pageId: page.id,
      componentId: primaryAction.id,
      event: "click",
      action: "show_toast",
      targetComponentId: `${page.id}_exception_toast`,
      mockResult: state.exceptionScenarios[0]
        ? safeText(state.exceptionScenarios[0].expectedBehavior) || safeText(state.exceptionScenarios[0].title)
        : "操作成功，页面状态已更新。",
      sourcePaths: ["businessRules", "exceptionScenarios"],
    },
  ];
}

function normalizePages(pages: PrototypePageSpec[], fallbackPages: PrototypePageSpec[]) {
  return pages.map((page, index) => {
    const fallback = fallbackPages[index] ?? fallbackPages[0];
    const id = safeText(page.id) || fallback.id || `page_${index + 1}`;
    return {
      ...fallback,
      ...page,
      id,
      name: safeText(page.name) || fallback.name,
      device: page.device === "desktop" || page.device === "mobile" || page.device === "responsive" ? page.device : fallback.device,
      layout: isPageLayout(page.layout) ? page.layout : fallback.layout,
      components: Array.isArray(page.components) && page.components.length
        ? page.components.map((component, componentIndex) => normalizeComponent(component, id, componentIndex))
        : fallback.components,
      sourcePaths: arrayOfText(page.sourcePaths).length ? arrayOfText(page.sourcePaths) : fallback.sourcePaths,
      order: typeof page.order === "number" ? page.order : index + 1,
    };
  });
}

function normalizeComponent(component: PrototypeComponentSpec, pageId: string, index: number): PrototypeComponentSpec {
  return {
    id: safeText(component.id) || `${pageId}_component_${index + 1}`,
    name: safeText(component.name) || `组件 ${index + 1}`,
    type: isComponentType(component.type) ? component.type : "custom",
    description: safeText(component.description) || undefined,
    content: safeText(component.content) || undefined,
    props: component.props && typeof component.props === "object" && !Array.isArray(component.props) ? component.props : undefined,
    children: Array.isArray(component.children)
      ? component.children.map((child, childIndex) => normalizeComponent(child, pageId, childIndex))
      : undefined,
    states: arrayOfText(component.states),
    interactions: arrayOfText(component.interactions),
    sourcePaths: arrayOfText(component.sourcePaths).length ? arrayOfText(component.sourcePaths) : ["pages"],
  };
}

function normalizeNavigation(value: PrototypeNavigation[], pages: PrototypePageSpec[]): PrototypeNavigation[] {
  const pageIds = new Set(pages.map((page) => page.id));
  return value.flatMap((item, index) => {
    if (!pageIds.has(item.fromPageId) || !pageIds.has(item.toPageId)) return [];
    return [{
      id: safeText(item.id) || `nav_${index + 1}`,
      fromPageId: item.fromPageId,
      toPageId: item.toPageId,
      triggerComponentId: safeText(item.triggerComponentId) || undefined,
      label: safeText(item.label) || undefined,
    }];
  });
}

function normalizeInteractions(
  value: PrototypeInteraction[],
  pages: PrototypePageSpec[],
  fallback: PrototypeInteraction[],
): PrototypeInteraction[] {
  const pageIds = new Set(pages.map((page) => page.id));
  const componentIds = new Set(pages.flatMap((page) => page.components.map((component) => component.id)));
  const normalized = value.flatMap((item, index) => {
    if (!pageIds.has(item.pageId) || !componentIds.has(item.componentId)) return [];
    return [{
      id: safeText(item.id) || `interaction_${index + 1}`,
      pageId: item.pageId,
      componentId: item.componentId,
      event: isInteractionEvent(item.event) ? item.event : "click",
      action: isInteractionAction(item.action) ? item.action : "show_toast",
      targetPageId: safeText(item.targetPageId) || undefined,
      targetComponentId: safeText(item.targetComponentId) || undefined,
      mockResult: safeText(item.mockResult) || undefined,
      sourcePaths: arrayOfText(item.sourcePaths).length ? arrayOfText(item.sourcePaths) : ["businessRules"],
    }];
  });
  return normalized.length ? normalized : fallback;
}

function normalizeTargetDevice(value: unknown): PrototypeTargetDevice | undefined {
  return value === "desktop" || value === "mobile" || value === "both" ? value : undefined;
}

function normalizeAssumptionStatus(value: unknown): "pending" | "confirmed" | "rejected" {
  if (value === "confirmed" || value === "rejected") return value;
  return "pending";
}

function isPageLayout(value: unknown): value is PrototypePageSpec["layout"] {
  return value === "single_column" || value === "two_column" || value === "dashboard" || value === "form" ||
    value === "list" || value === "detail" || value === "mobile_page" || value === "custom";
}

function isComponentType(value: unknown): value is PrototypeComponentSpec["type"] {
  return value === "header" || value === "nav" || value === "hero" || value === "card" || value === "form" ||
    value === "input" || value === "button" || value === "table" || value === "tabs" || value === "modal" ||
    value === "drawer" || value === "list" || value === "empty_state" || value === "status_badge" ||
    value === "calendar" || value === "timeline" || value === "chart_placeholder" || value === "image_placeholder" ||
    value === "custom";
}

function isInteractionEvent(value: unknown): value is PrototypeInteraction["event"] {
  return value === "click" || value === "change" || value === "submit" || value === "hover";
}

function isInteractionAction(value: unknown): value is PrototypeInteraction["action"] {
  return value === "navigate" || value === "open_modal" || value === "close_modal" || value === "toggle_state" ||
    value === "show_toast" || value === "switch_tab" || value === "update_mock_data";
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(safeText).filter(Boolean) : [];
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
