import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  KnowledgeContext,
  PatchPlan,
  PatchRisk,
  ProductDesignState,
  PrototypeArtifactDraft,
  PrototypeComponentSpec,
  PrototypeInteraction,
  PrototypeNavigation,
  PrototypePageSpec,
  PrototypeSpec,
  PrototypeTargetDevice,
  QAIssue,
  QAProtocolOutput,
  QAReportStatus,
  RequirementDocument,
  RequirementDocumentDraft,
  RuntimeOutput,
  SelectedRegion,
} from "../ai-vibe.types";
import { ExternalRuntimeConfigService } from "./external-runtime-config.service";
import { ExternalRuntimeService } from "./external-runtime.service";
import {
  createPatchPlanFromInput,
  createQaOutputFromState,
  prototypeArtifactDraftFromSpec,
  renderPrdFromState,
  renderPrototypeSpecFromState,
} from "./local-protocol-renderers";
import type {
  PatchPlanRuntimeInput,
  PatchPlanRuntimeOutput,
  PrototypeSpecRuntimeInput,
  PrototypeSpecRuntimeOutput,
  QaRuntimeInput,
  QaRuntimeOutput,
  RuntimeProvider,
  RuntimeTaskType,
} from "./external-runtime.types";

type PrdInput = {
  runId: string;
  projectId: string;
  traceId: string;
  userId: string;
  productDesignState: ProductDesignState;
  mode?: "draft" | "formal";
};

type PrototypeSpecInput = {
  runId: string;
  projectId: string;
  traceId: string;
  userId: string;
  productDesignState: ProductDesignState;
  targetDevice?: PrototypeTargetDevice;
  targetView?: PrototypeTargetDevice;
};

type PrototypeHtmlInput = {
  runId: string;
  projectId: string;
  traceId: string;
  userId: string;
  prototypeSpec: PrototypeSpec;
  mode: "single_html";
};

type PatchPlanInput = {
  runId: string;
  projectId: string;
  traceId: string;
  userId: string;
  userInput: string;
  selectedRegion: SelectedRegion;
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  knowledgeContext?: KnowledgeContext;
};

type QaInput = {
  runId: string;
  projectId: string;
  traceId: string;
  userId: string;
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  patchPlan?: PatchPlan;
  knowledgeContext?: KnowledgeContext;
};

@Injectable()
export class ProductRuntimeService {
  constructor(
    private readonly config: ExternalRuntimeConfigService,
    private readonly runtime: ExternalRuntimeService,
  ) {}

  async generatePrd(input: PrdInput): Promise<RuntimeOutput<RequirementDocumentDraft>> {
    return { data: renderPrdFromState(input.productDesignState) };
  }

  async generatePrototypeSpec(input: PrototypeSpecInput): Promise<RuntimeOutput<PrototypeSpec>> {
    const fallback = renderPrototypeSpecFromState(
      input.productDesignState,
      input.targetDevice ?? input.targetView ?? "both",
      input.runId,
    );
    const provider = this.config.prototypeSpecProvider();
    if (isExternalProvider(provider)) {
      try {
        const result = await this.runtime.runTask<PrototypeSpecRuntimeInput, PrototypeSpecRuntimeOutput>(
          {
            id: randomUUID(),
            taskType: "generate_prototype",
            runId: input.runId,
            projectId: input.projectId,
            traceId: input.traceId,
            userId: input.userId,
            input: {
              productDesignState: input.productDesignState,
              targetDevice: input.targetDevice ?? input.targetView ?? "both",
              generatedByRunId: input.runId,
            },
            workspaceHint: input.productDesignState.id,
          },
          provider,
        );
        if (result.status === "completed" && result.output) {
          return { data: normalizePrototypeSpec(result.output, fallback, input) };
        }
        throw new Error(`PrototypeSpec runtime 未返回可用输出：${result.status}`);
      } catch (error) {
        if (!this.config.runtimeFallbackToLocal()) throw error;
      }
    }

    return { data: fallback };
  }

  async generatePrototypeHtml(input: PrototypeHtmlInput): Promise<RuntimeOutput<PrototypeArtifactDraft>> {
    const provider = this.config.prototypeCodeProvider();
    if (provider === "codex" || provider === "deerflow") {
      try {
        const result = await this.runtime.runTask<{ prototypeSpec: PrototypeSpec; mode: "single_html"; generatedByRunId?: string }, PrototypeArtifactDraft>(
          {
            id: randomUUID(),
            taskType: "prototype_code_generation",
            runId: input.runId,
            projectId: input.projectId,
            traceId: input.traceId,
            userId: input.userId,
            input: {
              prototypeSpec: input.prototypeSpec,
              mode: input.mode,
              generatedByRunId: input.runId,
            },
            workspaceHint: input.prototypeSpec.id,
          },
          provider,
        );
        if (result.status === "completed" && result.output) {
          return { data: normalizePrototypeArtifactDraft(result.output, input.prototypeSpec, input.runId) };
        }
        throw new Error(`Prototype runtime 未返回可用 HTML artifact：${result.status}`);
      } catch (error) {
        if (!this.config.runtimeFallbackToLocal()) throw error;
      }
    }

    return { data: prototypeArtifactDraftFromSpec(input.prototypeSpec, input.runId) };
  }

  async planPatch(input: PatchPlanInput): Promise<RuntimeOutput<PatchPlan>> {
    const fallback = createPatchPlanFromInput({
      userInput: input.userInput,
      selectedRegion: input.selectedRegion,
      productDesignState: input.productDesignState,
    });
    const provider = this.config.patchPlanProvider();
    if (isExternalProvider(provider)) {
      try {
        const result = await this.runtime.runTask<PatchPlanRuntimeInput, PatchPlanRuntimeOutput>(
          {
            id: randomUUID(),
            taskType: input.selectedRegion.type === "prototype" ? "patch_prototype" : "patch_prd",
            runId: input.runId,
            projectId: input.projectId,
            traceId: input.traceId,
            userId: input.userId,
            input: {
              userInput: input.userInput,
              selectedRegion: input.selectedRegion,
              productDesignState: input.productDesignState,
              prdDocument: input.prdDocument,
              prototypeSpec: input.prototypeSpec,
              knowledgeContext: input.knowledgeContext,
            },
            workspaceHint: input.selectedRegion.targetId,
          },
          provider,
        );
        if (result.status === "completed" && result.output) {
          return { data: normalizePatchPlan(result.output, fallback, input) };
        }
        throw new Error(`PatchPlan runtime 未返回可用输出：${result.status}`);
      } catch (error) {
        if (!this.config.runtimeFallbackToLocal()) throw error;
      }
    }

    return { data: fallback };
  }

  async runQa(input: QaInput): Promise<RuntimeOutput<QAProtocolOutput>> {
    const fallback = createQaOutputFromState(input.productDesignState);
    const provider = this.config.qaProvider();
    if (isExternalProvider(provider)) {
      try {
        const result = await this.runtime.runTask<QaRuntimeInput, QaRuntimeOutput>(
          {
            id: randomUUID(),
            taskType: "qa_review",
            runId: input.runId,
            projectId: input.projectId,
            traceId: input.traceId,
            userId: input.userId,
            input: {
              productDesignState: input.productDesignState,
              prdDocument: input.prdDocument,
              prototypeSpec: input.prototypeSpec,
              patchPlan: input.patchPlan,
              knowledgeContext: input.knowledgeContext,
            },
            workspaceHint: input.productDesignState.id,
          },
          provider,
        );
        if (result.status === "completed" && result.output) {
          return { data: normalizeQaOutput(result.output, fallback) };
        }
        throw new Error(`QA runtime 未返回可用输出：${result.status}`);
      } catch (error) {
        if (!this.config.runtimeFallbackToLocal()) throw error;
      }
    }

    return { data: fallback };
  }
}

function isExternalProvider(provider: RuntimeProvider): provider is Exclude<RuntimeProvider, "local"> {
  return provider === "codex" || provider === "deerflow";
}

function normalizePrototypeSpec(
  output: PrototypeSpecRuntimeOutput,
  fallback: PrototypeSpec,
  input: PrototypeSpecInput,
): PrototypeSpec {
  const source = asRecord(output) ?? {};
  const styleGuide = asRecord(source.styleGuide);
  const pages = recordArray(source.pages)
    .map((page, index) => normalizePrototypePage(page, fallback.pages[index], index))
    .filter((page): page is PrototypePageSpec => Boolean(page));
  return {
    ...fallback,
    ...output,
    id: safeText(source.id) || fallback.id,
    projectId: input.projectId,
    productDesignStateId: input.productDesignState.id,
    productDesignStateVersion: input.productDesignState.version,
    title: safeText(source.title) || fallback.title,
    targetDevice: normalizeTargetDevice(source.targetDevice) ?? fallback.targetDevice,
    styleGuide: styleGuide ? { ...fallback.styleGuide, ...styleGuide } : fallback.styleGuide,
    pages: pages.length ? pages : fallback.pages,
    navigation: recordArray(source.navigation)
      .map((item, index) => normalizeNavigation(item, fallback.navigation[index]))
      .filter((item): item is PrototypeNavigation => Boolean(item)),
    interactions: recordArray(source.interactions)
      .map((item, index) => normalizeInteraction(item, fallback.interactions[index]))
      .filter((item): item is PrototypeInteraction => Boolean(item)),
    assumptions: Array.isArray(output.assumptions) ? output.assumptions : fallback.assumptions,
    knowledgeRefs: Array.isArray(output.knowledgeRefs) ? output.knowledgeRefs : fallback.knowledgeRefs,
    generatedByRunId: input.runId,
  };
}

function normalizePatchPlan(
  output: PatchPlanRuntimeOutput,
  fallback: PatchPlan,
  input: PatchPlanInput,
): PatchPlan {
  const source = asRecord(output) ?? {};
  const regenerationPlanSource = asRecord(source.regenerationPlan);
  const operations = recordArray(source.operations)
    .map(normalizePatchOperation)
    .filter((operation): operation is PatchPlan["operations"][number] => Boolean(operation));
  const risks = recordArray(source.risks)
    .map(normalizePatchRisk)
    .filter((risk): risk is PatchRisk => Boolean(risk));
  return {
    ...fallback,
    ...output,
    id: safeText(source.id) || fallback.id,
    projectId: input.projectId,
    selectedRegion: input.selectedRegion,
    patchType: normalizePatchType(source.patchType) ?? fallback.patchType,
    targetNodes: stringArray(source.targetNodes).length ? stringArray(source.targetNodes) : fallback.targetNodes,
    impactScope: stringArray(source.impactScope).length ? stringArray(source.impactScope) : fallback.impactScope,
    operations: operations.length ? operations : fallback.operations,
    regenerationPlan: regenerationPlanSource ? {
      prd: normalizeRegenerationMode(regenerationPlanSource.prd, ["none", "affected_sections", "full"]) ?? fallback.regenerationPlan?.prd ?? "full",
      prototypeSpec: normalizeRegenerationMode(regenerationPlanSource.prototypeSpec, ["none", "affected_pages", "full"]) ?? fallback.regenerationPlan?.prototypeSpec ?? "full",
      htmlPrototype: normalizeRegenerationMode(regenerationPlanSource.htmlPrototype, ["none", "affected_pages", "full"]) ?? fallback.regenerationPlan?.htmlPrototype ?? "full",
      qa: normalizeRegenerationMode(regenerationPlanSource.qa, ["none", "basic", "full"]) ?? fallback.regenerationPlan?.qa ?? "basic",
    } : fallback.regenerationPlan,
    risks: risks.length ? risks : fallback.risks,
    needUserConfirm: Boolean(source.needUserConfirm ?? source.needsUserConfirmation ?? fallback.needUserConfirm),
    needsUserConfirmation: Boolean(source.needsUserConfirmation ?? source.needUserConfirm ?? fallback.needsUserConfirmation),
    reason: safeText(source.reason) || fallback.reason,
    summary: safeText(source.summary) || fallback.summary,
  };
}

function normalizeQaOutput(output: QaRuntimeOutput, fallback: QAProtocolOutput): QAProtocolOutput {
  const source = asRecord(output) ?? {};
  const issues = recordArray(source.issues)
    .map(normalizeQaIssue)
    .filter((issue): issue is QAIssue => Boolean(issue));
  return {
    status: normalizeQaStatus(source.status) ?? fallback.status,
    summary: safeText(source.summary) || fallback.summary,
    issues: issues.length ? issues : fallback.issues,
  };
}

function normalizePrototypeArtifactDraft(
  output: PrototypeArtifactDraft,
  spec: PrototypeSpec,
  runId: string,
): PrototypeArtifactDraft {
  const fallback = prototypeArtifactDraftFromSpec(spec, runId);
  const html = safeText(output.htmlContent) || safeText(output.html) || fallback.htmlContent;
  return {
    ...fallback,
    ...output,
    projectId: spec.projectId,
    prototypeSpecId: spec.id,
    productDesignStateId: spec.productDesignStateId,
    productDesignStateVersion: spec.productDesignStateVersion,
    title: safeText(output.title) || fallback.title,
    htmlContent: ensureCompleteHtml(html ?? ""),
    html: ensureCompleteHtml(html ?? ""),
    entryFilePath: safeText(output.entryFilePath) || safeText(output.entryFile) || "index.html",
    entryFile: safeText(output.entryFilePath) || safeText(output.entryFile) || "index.html",
    targetDevice: output.targetDevice ?? spec.targetDevice,
    pageCount: output.pageCount && output.pageCount > 0 ? output.pageCount : spec.pages.length || 1,
    generatedByRunId: runId,
    assets: Array.isArray(output.assets) ? output.assets : [],
  };
}

function normalizePrototypePage(
  value: Record<string, unknown>,
  fallback: PrototypePageSpec | undefined,
  index: number,
): PrototypePageSpec | null {
  const id = safeText(value.id) || fallback?.id || `page_${index + 1}`;
  const name = safeText(value.name) || safeText(value.title) || fallback?.name || `页面 ${index + 1}`;
  const components = recordArray(value.components)
    .map((component, componentIndex) => normalizePrototypeComponent(component, fallback?.components[componentIndex], componentIndex))
    .filter((component): component is PrototypeComponentSpec => Boolean(component));
  return {
    id,
    name,
    route: safeText(value.route) || fallback?.route || `#${id}`,
    sourcePageId: safeText(value.sourcePageId) || fallback?.sourcePageId,
    device: normalizePageDevice(value.device) ?? fallback?.device ?? "responsive",
    layout: normalizePageLayout(value.layout) ?? fallback?.layout ?? "custom",
    description: safeText(value.description) || fallback?.description,
    components: components.length ? components : fallback?.components ?? [],
    states: Array.isArray(value.states) ? value.states as PrototypePageSpec["states"] : fallback?.states,
    sourcePaths: stringArray(value.sourcePaths).length ? stringArray(value.sourcePaths) : fallback?.sourcePaths ?? ["runtime.output"],
    order: numberValue(value.order) ?? fallback?.order ?? index + 1,
  };
}

function normalizePrototypeComponent(
  value: Record<string, unknown>,
  fallback: PrototypeComponentSpec | undefined,
  index: number,
): PrototypeComponentSpec | null {
  const id = safeText(value.id) || fallback?.id || `component_${index + 1}`;
  const name = safeText(value.name) || safeText(value.title) || fallback?.name || `组件 ${index + 1}`;
  const children = recordArray(value.children)
    .map((child, childIndex) => normalizePrototypeComponent(child, fallback?.children?.[childIndex], childIndex))
    .filter((component): component is PrototypeComponentSpec => Boolean(component));
  return {
    id,
    name,
    type: normalizeComponentType(value.type) ?? fallback?.type ?? "custom",
    description: safeText(value.description) || fallback?.description,
    content: safeText(value.content) || fallback?.content,
    props: asRecord(value.props) ?? fallback?.props,
    children: children.length ? children : fallback?.children,
    states: stringArray(value.states).length ? stringArray(value.states) : fallback?.states,
    interactions: stringArray(value.interactions).length ? stringArray(value.interactions) : fallback?.interactions,
    sourcePaths: stringArray(value.sourcePaths).length ? stringArray(value.sourcePaths) : fallback?.sourcePaths ?? ["runtime.output"],
  };
}

function normalizeNavigation(value: Record<string, unknown>, fallback: PrototypeNavigation | undefined): PrototypeNavigation | null {
  const fromPageId = safeText(value.fromPageId) || fallback?.fromPageId;
  const toPageId = safeText(value.toPageId) || fallback?.toPageId;
  if (!fromPageId || !toPageId) return null;
  return {
    id: safeText(value.id) || fallback?.id || `nav_${fromPageId}_to_${toPageId}`,
    fromPageId,
    toPageId,
    triggerComponentId: safeText(value.triggerComponentId) || fallback?.triggerComponentId,
    label: safeText(value.label) || fallback?.label,
  };
}

function normalizeInteraction(value: Record<string, unknown>, fallback: PrototypeInteraction | undefined): PrototypeInteraction | null {
  const pageId = safeText(value.pageId) || fallback?.pageId;
  const componentId = safeText(value.componentId) || fallback?.componentId;
  if (!pageId || !componentId) return null;
  return {
    id: safeText(value.id) || fallback?.id || `${pageId}_${componentId}_interaction`,
    pageId,
    componentId,
    event: normalizeInteractionEvent(value.event) ?? fallback?.event ?? "click",
    action: normalizeInteractionAction(value.action) ?? fallback?.action ?? "show_toast",
    targetPageId: safeText(value.targetPageId) || fallback?.targetPageId,
    targetComponentId: safeText(value.targetComponentId) || fallback?.targetComponentId,
    mockResult: safeText(value.mockResult) || fallback?.mockResult,
    sourcePaths: stringArray(value.sourcePaths).length ? stringArray(value.sourcePaths) : fallback?.sourcePaths ?? ["runtime.output"],
  };
}

function normalizePatchOperation(value: Record<string, unknown>): PatchPlan["operations"][number] | null {
  const op = normalizeOperation(value.op);
  const path = safeText(value.path);
  if (!op || !path) return null;
  return {
    op,
    path,
    value: value.value,
    reason: safeText(value.reason) || "Runtime PatchOperation",
  };
}

function normalizePatchRisk(value: Record<string, unknown>): PatchRisk | null {
  const level = normalizeRiskLevel(value.level);
  const message = safeText(value.message) || safeText(value.summary);
  if (!level || !message) return null;
  return {
    level,
    message,
    relatedPaths: stringArray(value.relatedPaths),
  };
}

function normalizeQaIssue(value: Record<string, unknown>): QAIssue | null {
  const title = safeText(value.title);
  const description = safeText(value.description) || safeText(value.detail);
  if (!title || !description) return null;
  return {
    id: safeText(value.id) || `qa_runtime_${randomUUID()}`,
    checkType: normalizeCheckType(value.checkType) ?? "state_prd_consistency",
    severity: normalizeSeverity(value.severity) ?? "minor",
    title,
    description,
    relatedStatePaths: stringArray(value.relatedStatePaths),
    relatedPrdSectionIds: stringArray(value.relatedPrdSectionIds),
    relatedPrototypePageIds: stringArray(value.relatedPrototypePageIds),
    relatedPrototypeComponentIds: stringArray(value.relatedPrototypeComponentIds),
    relatedKnowledgeIds: stringArray(value.relatedKnowledgeIds),
    suggestion: safeText(value.suggestion) || undefined,
    autoFixable: typeof value.autoFixable === "boolean" ? value.autoFixable : false,
    status: value.status === "resolved" || value.status === "ignored" ? value.status : "open",
  };
}

function ensureCompleteHtml(value: string) {
  return /^<!doctype html>/i.test(value.trim()) ? value : `<!doctype html>\n${value}`;
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTargetDevice(value: unknown): PrototypeTargetDevice | undefined {
  return value === "desktop" || value === "mobile" || value === "both" ? value : undefined;
}

function normalizePageDevice(value: unknown): PrototypePageSpec["device"] | undefined {
  return value === "desktop" || value === "mobile" || value === "responsive" ? value : undefined;
}

function normalizePageLayout(value: unknown): PrototypePageSpec["layout"] | undefined {
  const allowed: PrototypePageSpec["layout"][] = ["single_column", "two_column", "dashboard", "form", "list", "detail", "mobile_page", "custom"];
  return allowed.includes(value as PrototypePageSpec["layout"]) ? value as PrototypePageSpec["layout"] : undefined;
}

function normalizeComponentType(value: unknown): PrototypeComponentSpec["type"] | undefined {
  const allowed: PrototypeComponentSpec["type"][] = [
    "header",
    "nav",
    "hero",
    "card",
    "form",
    "input",
    "button",
    "table",
    "tabs",
    "modal",
    "drawer",
    "list",
    "empty_state",
    "status_badge",
    "calendar",
    "timeline",
    "chart_placeholder",
    "image_placeholder",
    "custom",
  ];
  return allowed.includes(value as PrototypeComponentSpec["type"]) ? value as PrototypeComponentSpec["type"] : undefined;
}

function normalizeInteractionEvent(value: unknown): PrototypeInteraction["event"] | undefined {
  return value === "click" || value === "change" || value === "submit" || value === "hover" ? value : undefined;
}

function normalizeInteractionAction(value: unknown): PrototypeInteraction["action"] | undefined {
  const allowed: PrototypeInteraction["action"][] = [
    "navigate",
    "open_modal",
    "close_modal",
    "toggle_state",
    "show_toast",
    "switch_tab",
    "update_mock_data",
  ];
  return allowed.includes(value as PrototypeInteraction["action"]) ? value as PrototypeInteraction["action"] : undefined;
}

function normalizePatchType(value: unknown): PatchPlan["patchType"] | undefined {
  return value === "document" || value === "prototype" || value === "state" || value === "global" ? value : undefined;
}

function normalizeOperation(value: unknown): PatchPlan["operations"][number]["op"] | undefined {
  return value === "add" || value === "update" || value === "delete" || value === "replace" || value === "remove" || value === "append"
    ? value
    : undefined;
}

function normalizeRiskLevel(value: unknown): PatchRisk["level"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeRegenerationMode<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return allowed.includes(value as T) ? value as T : undefined;
}

function normalizeQaStatus(value: unknown): QAReportStatus | undefined {
  return value === "running" || value === "passed" || value === "failed" || value === "warning" ? value : undefined;
}

function normalizeCheckType(value: unknown): QAIssue["checkType"] | undefined {
  const allowed: QAIssue["checkType"][] = [
    "state_schema",
    "prd_completeness",
    "prototype_completeness",
    "state_prd_consistency",
    "state_prototype_consistency",
    "prd_prototype_consistency",
    "knowledge_rule_compliance",
    "assumption_risk",
    "patch_regression",
  ];
  return allowed.includes(value as QAIssue["checkType"]) ? value as QAIssue["checkType"] : undefined;
}

function normalizeSeverity(value: unknown): QAIssue["severity"] | undefined {
  return value === "blocking" || value === "major" || value === "minor" || value === "info" ? value : undefined;
}
