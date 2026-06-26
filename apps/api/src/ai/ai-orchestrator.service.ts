import { Injectable, Optional } from "@nestjs/common";
import { MessageType, ProductDesignStateStatus, ProjectStatus, UserIntent } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeRunLogService } from "./runtime-run-log.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  RuntimeRunContext,
  AttachmentSummary,
  ExportArtifactSummary,
  InputQualityAssessment,
  IntentResult,
  KnowledgeCandidate,
  KnowledgeCandidateDraft,
  PatchPlan,
  PatchRecord,
  ProductBuildPlan,
  ProductDesignDraft,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QAReport,
  RequirementDocument,
  RequirementGateDecision,
  RequirementIntakeGraph,
  ContextFetchResult,
} from "./ai-vibe.types";
import { ExportService } from "./export.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { PrototypeService } from "./prototype.service";
import { QaService } from "./qa.service";
import { ExternalRuntimeConfigService } from "./runtime/external-runtime-config.service";
import { ExternalRuntimeService } from "./runtime/external-runtime.service";
import type {
  RuntimeProvider,
  RuntimeResult,
  RequirementRuntimeInput,
  RequirementRuntimeOutput,
} from "./runtime/external-runtime.types";
import { renderPrdFromState } from "./runtime/local-protocol-renderers";
import { ProductRuntimeService } from "./runtime/product-runtime.service";
import { projectStatusFromProductDesignState } from "./workspace-state-machine";
import { VibeStreamService } from "./vibe-stream.service";

type OrchestratorInput = {
  context: RuntimeRunContext;
  userMessageId: string;
  attachments: AttachmentSummary[];
};

type DecisionCardSummary = {
  id: string;
  sourceType: string;
  sourceId?: string;
  title: string;
  reasons: string[];
};

export type OrchestratorResult = {
  runId: string;
  projectId: string;
  intent: IntentResult;
  message: string;
  productDesignState?: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  prototypeArtifact?: PrototypeArtifact;
  qaReport?: QAReport;
  inputQuality?: InputQualityAssessment;
  productBuildPlan?: ProductBuildPlan;
  contextFetch?: ContextFetchResult;
  requirementGate?: RequirementGateDecision;
  requirementIntakeGraph?: RequirementIntakeGraph;
  decisionCards?: DecisionCardSummary[];
  patchPlan?: PatchPlan;
  patchRecord?: PatchRecord;
  patchPreview?: unknown;
  runtimeAdapter?: {
    status: "not_configured" | "completed" | "fallback";
    provider?: Exclude<RuntimeProvider, "local">;
    expectedProviders?: Array<Exclude<RuntimeProvider, "local">>;
    errorMessage?: string;
  };
  knowledgeCandidates?: Array<KnowledgeCandidate | KnowledgeCandidateDraft>;
  exportArtifact?: ExportArtifactSummary;
  nextAction?: {
    type: "ask_clarification" | "review_prd" | "review_prototype" | "review_qa" | "answer" | "download_export" | "confirm_patch";
    questions?: ProductDesignState["pendingQuestions"];
    risks?: PatchPlan["risks"];
    wantsPrototype?: boolean;
  };
};

/**
 * Runtime-only orchestrator boundary.
 *
 * The previous self-authored Vibe agent chain has intentionally been removed
 * from the active path. This class now owns only product-system duties:
 * run lifecycle, assistant message persistence, export passthrough, project
 * status updates, and stream terminal events. DeerFlow/Codex runtime adapters
 * will be wired behind this boundary in follow-up slices.
 */
@Injectable()
export class AiOrchestratorService {
  constructor(
    private readonly runLog: RuntimeRunLogService,
    private readonly stream: VibeStreamService,
    private readonly messageService: MessageService,
    private readonly prisma: PrismaService,
    private readonly exportService: ExportService,
    @Optional()
    private readonly runtimeConfig?: ExternalRuntimeConfigService,
    @Optional()
    private readonly runtime?: ExternalRuntimeService,
    @Optional()
    private readonly stateService?: ProductDesignStateService,
    @Optional()
    private readonly documentService?: RequirementDocumentService,
    @Optional()
    private readonly productRuntime?: ProductRuntimeService,
    @Optional()
    private readonly prototypeService?: PrototypeService,
    @Optional()
    private readonly qaService?: QaService,
  ) {}

  async run(input: OrchestratorInput): Promise<OrchestratorResult> {
    const { context } = input;
    const intent = detectIntent(context.userInput);

    try {
      await this.runLog.markRunIntent(context.runId, intent.intent);

      if (intent.intent === UserIntent.export_word || intent.intent === UserIntent.export_html) {
        return await this.finishExport(context, intent);
      }

      const requirementRuntime = this.requirementRuntimeProvider();
      if (requirementRuntime) {
        return await this.finishRequirementRuntime(input, intent, requirementRuntime);
      }

      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "message_delta",
        content: "当前未配置 DeerFlow/Codex runtime adapter。本轮已停在安全终态，未改动产品状态。",
        data: {
          runtimeAdapter: {
            status: "not_configured",
            expectedProviders: ["deerflow", "codex"],
          },
        },
      });

      const result: OrchestratorResult = {
        runId: context.runId,
        projectId: context.projectId,
        intent,
        message: "当前未配置 DeerFlow/Codex runtime adapter。请配置 runtime 后再生成需求、PRD、原型和 QA；本轮已安全结束，没有改动产品状态。",
        productDesignState: context.productDesignState,
        runtimeAdapter: {
          status: "not_configured",
          expectedProviders: ["deerflow", "codex"],
        },
        nextAction: { type: "answer" },
      };

      await this.finishRun(
        context,
        result,
        context.currentProjectStatus ?? projectStatusFromProductDesignState(context.productDesignState),
      );
      return result;
    } catch (error) {
      await this.handleRunFailure(context, error);
      throw error;
    }
  }

  async confirmPrdAndContinue(input: OrchestratorInput): Promise<OrchestratorResult> {
    const { context } = input;
    const intent: IntentResult = {
      intent: UserIntent.generate_prototype,
      confidence: 1,
      reason: "用户确认 PRD 后继续生成原型。",
      requiresSelection: false,
      isAmbiguous: false,
    };

    try {
      await this.runLog.markRunIntent(context.runId, intent.intent);
      if (this.productRuntime && this.prototypeService && this.stateService) {
        return await this.finishPrototypeRuntime(input, intent);
      }

      const result: OrchestratorResult = {
        runId: context.runId,
        projectId: context.projectId,
        intent,
        message: "确认门已记录。请配置 DeerFlow/Codex runtime adapter 后继续生成原型。",
        productDesignState: context.productDesignState,
        runtimeAdapter: {
          status: "not_configured",
          expectedProviders: ["deerflow", "codex"],
        },
        nextAction: { type: "answer" },
      };
      await this.finishRun(
        context,
        result,
        context.currentProjectStatus ?? projectStatusFromProductDesignState(context.productDesignState),
      );
      return result;
    } catch (error) {
      await this.handleRunFailure(context, error);
      throw error;
    }
  }

  private async finishPrototypeRuntime(
    input: OrchestratorInput,
    intent: IntentResult,
  ): Promise<OrchestratorResult> {
    const { context } = input;
    if (!this.productRuntime || !this.prototypeService || !this.stateService) {
      throw new Error("Prototype runtime 未就绪：缺少 ProductRuntimeService、PrototypeService 或 ProductDesignStateService");
    }
    const sourceState = context.productDesignState;
    if (!sourceState) {
      throw new Error("Prototype runtime 未就绪：缺少已确认的 ProductDesignState");
    }

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "step_started",
      step: "prototype_code_generation",
      content: "正在根据已确认 PRD 生成原型规格。",
    });
    const prototypeSpec = await this.productRuntime.generatePrototypeSpec({
      runId: context.runId,
      projectId: context.projectId,
      traceId: context.traceId,
      userId: context.userId,
      productDesignState: sourceState,
      targetDevice: "both",
    });

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "step_started",
      step: "prototype_code_generation",
      content: "正在生成 HTML 原型。",
    });
    const prototypeDraft = await this.productRuntime.generatePrototypeHtml({
      runId: context.runId,
      projectId: context.projectId,
      traceId: context.traceId,
      userId: context.userId,
      prototypeSpec: prototypeSpec.data,
      mode: "single_html",
    });

    const savedPrototype = await this.prototypeService.saveGeneratedPrototype(
      sourceState,
      prototypeSpec.data,
      prototypeDraft.data,
      {
        userId: context.userId,
        runId: context.runId,
        reason: "用户确认 PRD 后生成 HTML 原型",
      },
    );

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "prototype_updated",
      step: "prototype_code_generation",
      content: "HTML 原型已生成。",
      data: {
        prototypeSpec: savedPrototype.prototypeSpec,
        prototypeArtifact: savedPrototype.artifact,
      },
    });

    let productDesignState = await this.stateService.attachGeneratedArtifacts(sourceState.id, {
      prdDocument: sourceState.prdDocument,
      prototypeSpec: prototypeSpec.data,
      status: ProductDesignStateStatus.prototype_ready,
      userId: context.userId,
      runId: context.runId,
      messageId: input.userMessageId,
      reason: "用户确认 PRD 后同步 PrototypeSpec",
    });

    let qaReport: QAReport | undefined;
    if (this.qaService) {
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "step_started",
        step: "qa_check",
        content: "正在执行 PRD 与原型一致性 QA。",
      });
      qaReport = await this.qaService.runForProject(context.projectId, context.userId, {
        trigger: "initial_generation",
        runId: context.runId,
        traceId: context.traceId,
        prdDocument: sourceState.prdDocument,
        prototypeSpec: prototypeSpec.data,
        prototypeArtifact: savedPrototype.artifact,
      });
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "qa_completed",
        step: "qa_check",
        content: "QA 已完成。",
        data: qaReport,
      });
    }

    productDesignState = {
      ...productDesignState,
      prototypeSpec: savedPrototype.prototypeSpec,
    };

    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: qaReport
        ? "已根据确认后的 PRD 生成 HTML 原型并完成 QA，请查看 QA 结果。"
        : "已根据确认后的 PRD 生成 HTML 原型，请查看原型。",
      productDesignState,
      prdDocument: sourceState.prdDocument,
      prototypeSpec: savedPrototype.prototypeSpec,
      prototypeArtifact: savedPrototype.artifact,
      qaReport,
      runtimeAdapter: {
        status: "completed",
        provider: this.runtimeConfig?.prototypeCodeProvider() === "deerflow" ? "deerflow" : "codex",
      },
      nextAction: qaReport ? { type: "review_qa" } : { type: "review_prototype" },
    };

    await this.finishRun(context, result, projectStatusFromProductDesignState(productDesignState));
    return result;
  }

  private async finishExport(context: RuntimeRunContext, intent: IntentResult) {
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "message_delta",
      content: "正在准备导出产物...",
    });
    const artifact = intent.intent === UserIntent.export_word
      ? await this.exportService.createPrdWordExport(context.projectId)
      : await this.exportService.createPrototypeHtmlExport(context.projectId);
    const { buffer: _buffer, ...summary } = artifact;
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "export_ready",
      content: "导出产物已准备好",
      data: summary,
    });

    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: `已准备好导出文件：${summary.fileName}`,
      productDesignState: context.productDesignState,
      exportArtifact: summary,
      nextAction: { type: "download_export" },
    };
    await this.finishRun(
      context,
      result,
      context.currentProjectStatus ?? projectStatusFromProductDesignState(context.productDesignState),
    );
    return result;
  }

  private async finishRequirementRuntime(
    input: OrchestratorInput,
    intent: IntentResult,
    provider: Exclude<RuntimeProvider, "local">,
  ) {
    const { context } = input;
    if (!this.runtime || !this.stateService) {
      const error = new Error("Requirement runtime 未就绪：缺少 runtime 或 ProductDesignStateService");
      if (this.runtimeConfig?.runtimeFallbackToLocal() && this.stateService) {
        return this.finishRequirementFallback(input, intent, provider, error);
      }
      throw error;
    }

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "step_started",
      step: "requirement_packaging",
      content: `正在把需求交给 ${providerLabel(provider)} runtime。`,
      data: { runtimeProvider: provider, runtimeTaskType: "intake_requirement" },
    });

    let runtimeResult: RuntimeResult<RequirementRuntimeOutput>;
    try {
      runtimeResult = await this.runtime.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>(
        {
          id: randomUUID(),
          taskType: "intake_requirement",
          runId: context.runId,
          projectId: context.projectId,
          traceId: context.traceId,
          userId: context.userId,
          input: {
            userInput: context.userInput,
            conversationId: context.conversationId,
            recentMessages: context.recentMessages,
            attachments: input.attachments,
            productDesignState: context.productDesignState,
            selectedRegion: context.selectedRegion,
            previewMode: context.previewMode,
          },
          workspaceHint: context.conversationId,
        },
        provider,
      );
    } catch (error) {
      if (!this.runtimeConfig?.runtimeFallbackToLocal()) throw error;
      return this.finishRequirementFallback(input, intent, provider, error);
    }

    for (const runtimeEvent of runtimeResult.events) {
      if (!runtimeEvent.content) continue;
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "message_delta",
        step: "requirement_packaging",
        content: runtimeEvent.content,
        data: runtimeEvent,
      });
    }

    if (!runtimeResult.output?.productDesignDraft) {
      throw new Error(`${providerLabel(provider)} runtime 未返回 ProductDesignDraft`);
    }

    const state = await this.stateService.createDraft(
      context.projectId,
      runtimeResult.output.productDesignDraft,
      {
        userId: context.userId,
        runId: context.runId,
        messageId: input.userMessageId,
        reason: `${providerLabel(provider)} runtime 生成 ProductDesignState`,
      },
    );

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "state_updated",
      step: "requirement_packaging",
      content: "ProductDesignState 已由 runtime 输出落库。",
      data: { productDesignState: state, runtimeProvider: provider },
    });

    let productDesignState = state;
    let prdDocument: RequirementDocument | undefined;
    if (runtimeResult.output.requirementDocumentDraft && this.documentService) {
      prdDocument = await this.documentService.saveGeneratedDocument(
        state,
        runtimeResult.output.requirementDocumentDraft,
        {
          userId: context.userId,
          runId: context.runId,
          reason: `${providerLabel(provider)} runtime 生成 PRD`,
        },
      );
      productDesignState = await this.stateService.attachGeneratedArtifacts(state.id, {
        prdDocument,
        status: ProductDesignStateStatus.doc_ready,
        userId: context.userId,
        runId: context.runId,
        messageId: input.userMessageId,
        reason: "PRD 已生成，等待用户确认后继续原型",
      });
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "prd_updated",
        step: "prd_generation",
        content: "PRD 已生成，等待确认。",
        data: { prdDocument, productDesignState, runtimeProvider: provider },
      });
    }

    const pendingQuestions = productDesignState.pendingQuestions ?? [];
    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: runtimeResult.output.message || defaultRequirementRuntimeMessage(provider, {
        hasPrd: Boolean(prdDocument),
        pendingQuestionCount: pendingQuestions.length,
      }),
      productDesignState,
      prdDocument,
      runtimeAdapter: {
        status: "completed",
        provider,
      },
      nextAction: prdDocument
        ? { type: "review_prd" }
        : pendingQuestions.length
          ? { type: "ask_clarification", questions: pendingQuestions }
          : { type: "answer" },
    };

    await this.finishRun(context, result, projectStatusFromProductDesignState(productDesignState));
    return result;
  }

  private async finishRequirementFallback(
    input: OrchestratorInput,
    intent: IntentResult,
    provider: Exclude<RuntimeProvider, "local">,
    error: unknown,
  ) {
    const { context } = input;
    if (!this.stateService) {
      throw new Error("Requirement fallback 未就绪：缺少 ProductDesignStateService");
    }

    const message = errorMessage(error);
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "fallback_used",
      step: "requirement_packaging",
      content: `${providerLabel(provider)} runtime 暂不可用，已使用 Vibe 产品协议 fallback 继续生成可测试状态。`,
      data: {
        provider,
        reason: message,
        errorMessage: message,
        userMessage: "外部 runtime 暂不可用，系统已使用规则兜底生成 PRD 草稿，方便先测试产品闭环。",
      },
    });

    const state = await this.stateService.createDraft(
      context.projectId,
      fallbackProductDesignDraft(context),
      {
        userId: context.userId,
        runId: context.runId,
        messageId: input.userMessageId,
        reason: `${providerLabel(provider)} runtime 失败后使用 Vibe 产品协议 fallback`,
      },
    );

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "state_updated",
      step: "requirement_packaging",
      content: "ProductDesignState 已由 fallback 输出落库。",
      data: { productDesignState: state, runtimeProvider: provider, fallback: true },
    });

    let productDesignState = state;
    let prdDocument: RequirementDocument | undefined;
    if (this.documentService) {
      prdDocument = await this.documentService.saveGeneratedDocument(
        state,
        renderPrdFromState(state),
        {
          userId: context.userId,
          runId: context.runId,
          reason: "外部 runtime 失败后由 Vibe 产品协议 fallback 生成 PRD",
        },
      );
      productDesignState = await this.stateService.attachGeneratedArtifacts(state.id, {
        prdDocument,
        status: ProductDesignStateStatus.doc_ready,
        userId: context.userId,
        runId: context.runId,
        messageId: input.userMessageId,
        reason: "PRD fallback 已生成，等待用户确认后继续原型",
      });
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "prd_updated",
        step: "prd_generation",
        content: "PRD fallback 已生成，等待确认。",
        data: { prdDocument, productDesignState, runtimeProvider: provider, fallback: true },
      });
    }

    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: prdDocument
        ? `${providerLabel(provider)} runtime 暂不可用，已使用 Vibe 产品协议 fallback 生成产品状态和 PRD，请先确认 PRD 后继续生成原型。`
        : `${providerLabel(provider)} runtime 暂不可用，已使用 Vibe 产品协议 fallback 生成产品状态。`,
      productDesignState,
      prdDocument,
      runtimeAdapter: {
        status: "fallback",
        provider,
        errorMessage: message,
      },
      nextAction: prdDocument ? { type: "review_prd" } : { type: "answer" },
    };

    await this.finishRun(context, result, projectStatusFromProductDesignState(productDesignState));
    return result;
  }

  private async finishRun(
    context: RuntimeRunContext,
    result: OrchestratorResult,
    projectStatus: ProjectStatus,
  ) {
    await this.messageService.createAssistantMessage({
      projectId: context.projectId,
      conversationId: context.conversationId,
      content: result.message,
      type: MessageType.agent_summary,
      metadata: toInputJson({
        runId: context.runId,
        intent: result.intent,
        nextAction: result.nextAction,
        runtimeAdapter: result.runtimeAdapter,
        productDesignState: result.productDesignState,
        prdDocument: result.prdDocument,
        prototypeSpec: result.prototypeSpec,
        prototypeArtifact: result.prototypeArtifact,
        qaReport: result.qaReport,
        exportArtifact: result.exportArtifact,
      }),
      relatedRunId: context.runId,
    });
    await this.runLog.completeRun(context.runId, result, result.message);
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "run_completed",
      content: result.message,
      data: result,
    });
    await this.messageService.updateProjectActivity(context.projectId);
    await this.prisma.project.update({
      where: { id: context.projectId },
      data: { status: projectStatus, lastActivityAt: new Date() },
    });
  }

  private async handleRunFailure(context: RuntimeRunContext, error: unknown) {
    const message = errorMessage(error);
    await this.runLog.failRun(context.runId, error);
    await Promise.allSettled([
      this.messageService.createAssistantMessage({
        projectId: context.projectId,
        conversationId: context.conversationId,
        content: message,
        type: MessageType.error,
        metadata: toInputJson({
          runId: context.runId,
          errorMessage: message,
        }),
        relatedRunId: context.runId,
      }),
      this.prisma.project.update({
        where: { id: context.projectId },
        data: {
          status: context.currentProjectStatus ?? projectStatusFromProductDesignState(context.productDesignState),
          lastActivityAt: new Date(),
        },
      }),
    ]);
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "run_failed",
      content: message,
      data: { message, errorMessage: message, runId: context.runId, projectId: context.projectId },
    });
  }

  private requirementRuntimeProvider(): Exclude<RuntimeProvider, "local"> | undefined {
    const provider = this.runtimeConfig?.requirementProvider() ?? "local";
    if (provider === "codex" || provider === "deerflow") return provider;
    return undefined;
  }
}

function fallbackProductDesignDraft(context: RuntimeRunContext): ProductDesignDraft {
  const base = context.productDesignState;
  const title = titleFromUserInput(context.userInput, base?.title);
  return {
    projectId: context.projectId,
    title,
    summary: context.userInput.trim() || base?.summary || `围绕“${title}”生成产品需求草稿。`,
    background: base?.background,
    businessGoal: base?.businessGoal || "待补充业务目标。",
    targetUsers: base?.targetUsers ?? [],
    userScenarios: base?.userScenarios?.length
      ? base.userScenarios
      : [{ id: "scenario_1", title: title, description: context.userInput.trim() }],
    pages: base?.pages?.length
      ? base.pages
      : [{ id: "page_main", name: title, description: context.userInput.trim() }],
    features: base?.features?.length
      ? base.features
      : [{ id: "feature_1", name: title, description: context.userInput.trim() }],
    backendConfigs: base?.backendConfigs ?? [],
    frontendRules: base?.frontendRules ?? [],
    businessRules: base?.businessRules ?? [],
    stateRules: base?.stateRules ?? [],
    exceptionScenarios: base?.exceptionScenarios ?? [],
    acceptanceCriteria: base?.acceptanceCriteria?.length
      ? base.acceptanceCriteria
      : [{ id: "acceptance_1", content: "用户确认需求和 PRD 后，可以继续生成原型并进行 QA。" }],
    prototypeOutline: base?.prototypeOutline,
    assumptions: [
      ...(base?.assumptions ?? []),
      {
        id: "fallback_runtime_unavailable",
        content: "外部 runtime 暂不可用，本轮使用 Vibe 产品协议 fallback 生成草稿，后续需由用户确认。",
        status: "pending",
      },
    ],
    knowledgeRefs: base?.knowledgeRefs ?? [],
    pendingQuestions: base?.pendingQuestions ?? [],
    confirmedFacts: base?.confirmedFacts ?? [],
    createdBy: context.userId,
    updatedBy: context.userId,
  };
}

function detectIntent(userInput: string): IntentResult {
  const text = userInput.trim();
  const intent = /导出|下载|export/i.test(text) && /html|原型/i.test(text)
    ? UserIntent.export_html
    : /导出|下载|export|word|doc/i.test(text)
      ? UserIntent.export_word
      : UserIntent.new_requirement;

  return {
    intent,
    confidence: intent === UserIntent.new_requirement ? 0.5 : 0.82,
    reason: "当前使用最小确定性路由；生成类任务交由 DeerFlow/Codex runtime adapter 接管。",
    requiresSelection: false,
    isAmbiguous: intent === UserIntent.new_requirement,
  };
}

function titleFromUserInput(userInput: string, fallback?: string) {
  const text = userInput.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 30);
  return fallback?.trim() || "产品需求方案";
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Runtime orchestrator 执行失败";
}

function providerLabel(provider: Exclude<RuntimeProvider, "local">) {
  return provider === "deerflow" ? "DeerFlow" : "Codex";
}

function defaultRequirementRuntimeMessage(
  provider: Exclude<RuntimeProvider, "local">,
  input: { hasPrd: boolean; pendingQuestionCount: number },
) {
  if (input.hasPrd) return `${providerLabel(provider)} runtime 已生成产品状态和 PRD，请先确认 PRD 后继续生成原型。`;
  if (input.pendingQuestionCount) {
    return `${providerLabel(provider)} runtime 已生成产品状态，并提出 ${input.pendingQuestionCount} 个待确认问题。`;
  }
  return `${providerLabel(provider)} runtime 已生成产品状态。`;
}
