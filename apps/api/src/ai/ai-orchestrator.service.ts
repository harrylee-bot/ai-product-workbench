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
import { ExternalRuntimeConfigService } from "./runtime/external-runtime-config.service";
import { ExternalRuntimeService } from "./runtime/external-runtime.service";
import type { RuntimeProvider, RequirementRuntimeInput, RequirementRuntimeOutput } from "./runtime/external-runtime.types";
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
    status: "not_configured" | "completed";
    provider?: Exclude<RuntimeProvider, "local">;
    expectedProviders?: Array<Exclude<RuntimeProvider, "local">>;
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
      reason: "用户确认 PRD 后继续生成原型，但原型 runtime adapter 尚未配置。",
      requiresSelection: false,
      isAmbiguous: false,
    };

    try {
      await this.runLog.markRunIntent(context.runId, intent.intent);
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
      throw new Error("Requirement runtime 未就绪：缺少 runtime 或 ProductDesignStateService");
    }

    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "step_started",
      step: "requirement_packaging",
      content: `正在把需求交给 ${providerLabel(provider)} runtime。`,
      data: { runtimeProvider: provider, runtimeTaskType: "intake_requirement" },
    });

    const runtimeResult = await this.runtime.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>(
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
