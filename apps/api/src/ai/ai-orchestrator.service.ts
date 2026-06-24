import { Injectable } from "@nestjs/common";
import {
  AgentName,
  AgentStepStatus,
  MessageType,
  ProductDesignStateStatus,
  ProjectStatus,
  RequirementDocumentStatus,
  UserIntent,
} from "@prisma/client";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { fallbackStepOutput } from "./agent-fallback-policy";
import { qaCompletedPayload, toInputJson } from "./ai-vibe.helpers";
import { isCasualGeneralInput } from "./intent-classifier.helpers";
import type {
  AgentRunContext,
  AgentOutput,
  ExportArtifactSummary,
  AttachmentSummary,
  IntentResult,
  KnowledgeContext,
  KnowledgeCandidate,
  KnowledgeCandidateDraft,
  PatchPlan,
  PatchRecord,
  ProductBuildPlan,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QAReport,
  RequirementAnalysis,
  RequirementDocument,
} from "./ai-vibe.types";
import { KnowledgeExtractorAgentService } from "./agents/knowledge-extractor-agent.service";
import { KnowledgeAgentService } from "./agents/knowledge-agent.service";
import { PrdWriterAgentService } from "./agents/prd-writer-agent.service";
import { ProductDesignerAgentService } from "./agents/product-designer-agent.service";
import { ProductPlannerAgentService } from "./agents/product-planner-agent.service";
import { PrototypeCodeAgentService } from "./agents/prototype-code-agent.service";
import { PrototypeDesignerAgentService } from "./agents/prototype-designer-agent.service";
import { QaAgentService } from "./agents/qa-agent.service";
import { RequirementAnalystAgentService } from "./agents/requirement-analyst-agent.service";
import { IntentAgentService } from "./agents/intent-agent.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { PrototypeService } from "./prototype.service";
import { QaService } from "./qa.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeStreamService } from "./vibe-stream.service";
import { ExportService } from "./export.service";
import { PatchService } from "./patch.service";
import {
  projectStatusForCompletedArtifacts,
  projectStatusFromProductDesignState,
} from "./workspace-state-machine";
type OrchestratorInput = {
  context: AgentRunContext;
  userMessageId: string;
  attachments: AttachmentSummary[];
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
  productBuildPlan?: ProductBuildPlan;
  patchPlan?: PatchPlan;
  patchRecord?: PatchRecord;
  patchPreview?: unknown;
  knowledgeCandidates?: Array<KnowledgeCandidate | KnowledgeCandidateDraft>;
  exportArtifact?: ExportArtifactSummary;
  nextAction?: {
    type: "ask_clarification" | "review_prd" | "review_prototype" | "review_qa" | "answer" | "download_export" | "confirm_patch";
    questions?: ProductDesignState["pendingQuestions"];
    risks?: PatchPlan["risks"];
    /** 确认门 A：用户确认 PRD 后是否应继续生成原型（FR-1.3） */
    wantsPrototype?: boolean;
  };
};

@Injectable()
export class AiOrchestratorService {
  constructor(
    private readonly runLog: AgentRunLogService,
    private readonly stream: VibeStreamService,
    private readonly stateService: ProductDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
    private readonly exportService: ExportService,
    private readonly patchService: PatchService,
    private readonly qaService: QaService,
    private readonly messageService: MessageService,
    private readonly prisma: PrismaService,
    private readonly intentAgent: IntentAgentService,
    private readonly knowledgeAgent: KnowledgeAgentService,
    private readonly requirementAnalystAgent: RequirementAnalystAgentService,
    private readonly productPlannerAgent: ProductPlannerAgentService,
    private readonly productDesignerAgent: ProductDesignerAgentService,
    private readonly prdWriterAgent: PrdWriterAgentService,
    private readonly prototypeDesignerAgent: PrototypeDesignerAgentService,
    private readonly prototypeCodeAgent: PrototypeCodeAgentService,
    private readonly qaAgent: QaAgentService,
    private readonly knowledgeExtractorAgent: KnowledgeExtractorAgentService,
  ) {}

  async run(input: OrchestratorInput): Promise<OrchestratorResult> {
    const { context } = input;
    try {
      await this.emit(context, "message_delta", "正在理解你的需求...");
      const intent = await this.runAgentStep(
        context,
        AgentName.intent_agent,
        "intent_detection",
        () =>
          this.intentAgent.run({
            runId: context.runId,
            projectId: context.projectId,
            traceId: context.traceId,
            userId: context.userId,
            input: {
              userInput: context.userInput,
              selectedRegion: context.selectedRegion,
              currentProjectStatus: context.currentProjectStatus,
              previewMode: context.previewMode,
              recentMessages: context.recentMessages,
            },
          }),
      );
      context.intentResult = intent.data;
      await this.runLog.markRunIntent(context.runId, intent.data.intent);

      if (intent.data.intent === UserIntent.general_question) {
        return this.finishGeneralAnswer(context, intent.data);
      }

      if (intent.data.intent === UserIntent.export_word || intent.data.intent === UserIntent.export_html) {
        return this.finishExport(context, intent.data);
      }

      // FR-2.2 意图路由：已存在 PRD 文档且用户要求生成原型时，直接从原型阶段进入，
      // 跳过需求理解与文档生成（propose-then-commit 的"从指定阶段恢复"）。
      const productDesignState = context.productDesignState;
      if (
        intent.data.intent === UserIntent.generate_prototype &&
        productDesignState &&
        hasConfirmedPrdForPrototype(productDesignState)
      ) {
        await this.emit(context, "message_delta", "检测到已确认的需求文档，正在直接生成原型...");
        return this.generatePrototypeForState(
          context,
          input,
          intent.data,
          productDesignState,
        );
      }

      await this.emit(context, "message_delta", "正在检索知识库和附件上下文...");
      const knowledge = await this.runAgentStep(
        context,
        AgentName.knowledge_agent,
        "knowledge_retrieval",
        () =>
          this.knowledgeAgent.run({
            runId: context.runId,
            projectId: context.projectId,
            traceId: context.traceId,
            userId: context.userId,
            input: {
              userInput: context.userInput,
              productDesignState: context.productDesignState,
              intent: intent.data.intent,
              attachments: input.attachments,
            },
          }),
      );
      context.knowledgeContext = knowledge.data;

      await this.emit(context, "message_delta", "正在分析需求完整度...");
      const requirement = await this.runAgentStep(
        context,
        AgentName.requirement_analyst_agent,
        "requirement_analysis",
        () =>
          this.requirementAnalystAgent.run({
            runId: context.runId,
            projectId: context.projectId,
            traceId: context.traceId,
            userId: context.userId,
            input: {
              userInput: context.userInput,
              knowledgeContext: knowledge.data,
              productDesignState: context.productDesignState,
              recentMessages: context.recentMessages,
            },
          }),
      );
      context.requirementAnalysis = requirement.data;

      if (
        requirement.data.shouldAskUser &&
        intent.data.intent !== UserIntent.clarification_answer &&
        intent.data.intent !== UserIntent.patch_document &&
        intent.data.intent !== UserIntent.patch_prototype
      ) {
        return this.finishClarification(context, intent.data, requirement.data);
      }

      const isPatch =
        intent.data.intent === UserIntent.patch_document || intent.data.intent === UserIntent.patch_prototype;
      let productBuildPlan: ProductBuildPlan | undefined;
      let state = context.productDesignState;

      if (isPatch && context.selectedRegion && state) {
        return this.finishPatchCandidate(context, input, intent.data, knowledge.data);
      } else {
        await this.emit(context, "message_delta", "正在规划正式需求执行方案...");
        const plan = await this.runAgentStep(
          context,
          AgentName.product_planner_agent,
          "product_planning",
          () =>
            this.productPlannerAgent.run({
              runId: context.runId,
              projectId: context.projectId,
              traceId: context.traceId,
              userId: context.userId,
              input: {
                userInput: context.userInput,
                intent: intent.data.intent,
                requirementAnalysis: requirement.data,
                knowledgeContext: knowledge.data,
                existingState: context.productDesignState,
              },
            }),
        );
        productBuildPlan = plan.data;
        context.productBuildPlan = productBuildPlan;

        await this.emit(context, "message_delta", "正在把产品计划落到 ProductDesignState...");
        const design = await this.runAgentStep(
          context,
          AgentName.product_designer_agent,
          "product_design",
          () =>
            this.productDesignerAgent.run({
              runId: context.runId,
              projectId: context.projectId,
              traceId: context.traceId,
              userId: context.userId,
              input: {
                userInput: context.userInput,
                requirementAnalysis: requirement.data,
                knowledgeContext: knowledge.data,
                productBuildPlan,
                existingState: context.productDesignState,
              },
            }),
        );
        state = await this.stateService.createDraft(context.projectId, design.data, {
          userId: context.userId,
          runId: context.runId,
          messageId: input.userMessageId,
          reason: "Product Designer Agent 完成结构化设计",
        });
        await this.stream.emit({
          runId: context.runId,
          projectId: context.projectId,
          type: "state_updated",
          step: "product_design",
          data: stateSummary(state),
        });
        await this.stream.emit({
          runId: context.runId,
          projectId: context.projectId,
          type: "state_version_created",
          step: "product_design",
          data: { stateId: state.id, version: state.version },
        });
      }

      if (!state) {
        throw new Error("ProductDesignState 不存在，无法继续生成 PRD 和原型");
      }

      await this.emit(context, "message_delta", "正在生成 PRD 草案...");
      const prdDraft = await this.runAgentStep(context, AgentName.prd_writer_agent, "prd_generation", () =>
        this.prdWriterAgent.run({
          runId: context.runId,
          projectId: context.projectId,
          traceId: context.traceId,
          userId: context.userId,
          input: {
            productDesignState: state!,
            mode: "draft",
          },
        }),
      );
      const prdDocument = await this.documentService.saveGeneratedDocument(state, prdDraft.data, {
        userId: context.userId,
        runId: context.runId,
        reason: "PRD Writer Agent 生成 PRD",
      });
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "prd_updated",
        step: "prd_generation",
        data: prdDocument,
      });

      // 确认门 A（FR-1.2）：PRD 生成后将其落到 ProductDesignState 并暂停于 doc_ready 状态，
      // 等待用户确认。此处不再连跑原型——把"提案"持久化，由 confirm 接口触发"提交"。
      state = await this.stateService.attachGeneratedArtifacts(state.id, {
        prdDocument,
        status: ProductDesignStateStatus.doc_ready,
        userId: context.userId,
        runId: context.runId,
        messageId: input.userMessageId,
        reason: "PRD 生成完成，等待用户确认（确认门 A）",
      });

      // 是否预约生成原型：generate_prd 仅要文档；其余（new_requirement / complete_requirement /
      // generate_prototype 一次性请求）默认接着要原型，但总体交互不变——仍先停在确认门 A。
      const wantsPrototype = intent.data.intent !== UserIntent.generate_prd;
      const gateMessage = wantsPrototype
        ? "已生成 PRD 草案，请确认无误后我再继续生成原型。"
        : "已生成 PRD 草案，请确认无误。确认后你可以选择是否继续生成原型。";

      const result: OrchestratorResult = {
        runId: context.runId,
        projectId: context.projectId,
        intent: intent.data,
        message: gateMessage,
        productDesignState: state,
        prdDocument,
        productBuildPlan,
        nextAction: {
          type: "review_prd",
          wantsPrototype,
        },
      };

      await this.finishRun(
        context,
        result,
        projectStatusFromProductDesignState(state, ProjectStatus.prd_ready),
      );
      return result;
    } catch (error) {
      await this.handleRunFailure(context, error);
      throw error;
    }
  }

  /**
   * 确认门 A 之后的"提交"入口（FR-1.3）：用户确认 PRD 后，从原型阶段继续。
   * 由 confirm 接口在一个新的 run 上调用——暂停状态已持久化于 ProductDesignState，
   * 不依赖原 run 的进程常驻（propose-then-commit / 可恢复）。
   */
  async confirmPrdAndContinue(input: OrchestratorInput): Promise<OrchestratorResult> {
    const { context } = input;
    const state = context.productDesignState;
    if (!state) {
      throw new Error("找不到待确认的 ProductDesignState，无法继续生成原型");
    }
    if (!state.prdDocument) {
      throw new Error("当前 ProductDesignState 尚无 PRD 文档，无法进入原型阶段");
    }
    if (!hasConfirmedPrdForPrototype(state)) {
      throw new Error("当前 PRD 尚未确认，不能生成原型");
    }
    if (state.prototypeSpec) {
      throw new Error("当前项目已生成原型，不能重复触发 PRD 确认门");
    }
    const intent: IntentResult =
      context.intentResult ?? {
        intent: UserIntent.generate_prototype,
        confidence: 1,
        reason: "用户确认 PRD 后继续生成原型。",
        requiresSelection: false,
        isAmbiguous: false,
      };
    try {
      await this.runLog.markRunIntent(context.runId, intent.intent);
      return await this.generatePrototypeForState(context, input, intent, state);
    } catch (error) {
      await this.handleRunFailure(context, error);
      throw error;
    }
  }

  /**
   * Phase B：基于已确认 PRD 的 ProductDesignState 生成原型规格、HTML 原型，跑 QA 与知识抽取，
   * 最终停在确认门 B（prototype_ready / review_prototype）。
   * 既用于"确认 PRD 后继续"，也用于"已有文档直接出原型"（FR-2.2）。
   */
  private async generatePrototypeForState(
    context: AgentRunContext,
    input: OrchestratorInput,
    intent: IntentResult,
    initialState: ProductDesignState,
  ): Promise<OrchestratorResult> {
    let state = initialState;
    const prdDocument = state.prdDocument!;

    await this.emit(context, "message_delta", "正在生成原型规格...");
    const prototypeSpec = await this.runAgentStep(
      context,
      AgentName.prototype_designer_agent,
      "prototype_design",
      () =>
        this.prototypeDesignerAgent.run({
          runId: context.runId,
          projectId: context.projectId,
          traceId: context.traceId,
          userId: context.userId,
          input: {
            productDesignState: state,
            targetView: "both",
          },
        }),
    );

    await this.emit(context, "message_delta", "正在生成 HTML 原型...");
    const prototypeArtifact = await this.runAgentStep(
      context,
      AgentName.prototype_code_agent,
      "prototype_code_generation",
      () =>
        this.prototypeCodeAgent.run({
          runId: context.runId,
          projectId: context.projectId,
          traceId: context.traceId,
          userId: context.userId,
          input: {
            prototypeSpec: prototypeSpec.data,
            mode: "single_html",
          },
        }),
    );

    const savedPrototype = await this.prototypeService.saveGeneratedPrototype(
      state,
      prototypeSpec.data,
      prototypeArtifact.data,
      {
        userId: context.userId,
        runId: context.runId,
        reason: "Prototype Designer 与 Code Agent 生成 HTML 原型",
      },
    );
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "prototype_updated",
      step: "prototype_code_generation",
      data: {
        prototypeSpec: savedPrototype.prototypeSpec,
        prototypeArtifact: savedPrototype.artifact,
      },
    });

    state = await this.stateService.attachGeneratedArtifacts(state.id, {
      prdDocument,
      prototypeSpec: prototypeSpec.data,
      status: ProductDesignStateStatus.prototype_ready,
      userId: context.userId,
      runId: context.runId,
      messageId: input.userMessageId,
      reason: "PRD 与 PrototypeSpec 生成完成",
    });

    await this.emit(context, "message_delta", "正在进行一致性 QA 校验...");
    const qa = await this.runAgentStep(context, AgentName.qa_agent, "qa_check", async () => ({
      data: await this.qaService.runForProject(context.projectId, context.userId, {
        trigger: "initial_generation",
        runId: context.runId,
        traceId: context.traceId,
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        prototypeArtifact: savedPrototype.artifact,
        fallbacks: context.fallbackEvents,
      }),
    }));
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "qa_completed",
      step: "qa_check",
      data: qaCompletedPayload(qa.data),
    });

    const knowledgeCandidates = await this.runAgentStep(
      context,
      AgentName.knowledge_extractor_agent,
      "knowledge_extraction",
      () =>
        this.knowledgeExtractorAgent.run({
          runId: context.runId,
          projectId: context.projectId,
          traceId: context.traceId,
          userId: context.userId,
          input: {
            productDesignState: state,
            prdDocument,
            prototypeSpec: prototypeSpec.data,
            confirmedByUser: false,
          },
        }),
    );

    const finalMessage = qa.data.passed
      ? "已完成产品设计状态、PRD 草案、HTML 原型和 QA 校验。"
      : `已生成 PRD 与原型，QA 发现 ${qa.data.issues.length} 个待确认问题。`;

    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: finalMessage,
      productDesignState: state,
      prdDocument,
      prototypeSpec: prototypeSpec.data,
      prototypeArtifact: savedPrototype.artifact,
      qaReport: qa.data,
      productBuildPlan: context.productBuildPlan,
      knowledgeCandidates: knowledgeCandidates.data.candidates,
      nextAction: {
        type: qa.data.passed ? "review_prototype" : "review_qa",
      },
    };

    await this.finishRun(
      context,
      result,
      projectStatusForCompletedArtifacts({ productDesignState: state, qaReport: qa.data }),
    );
    return result;
  }

  private async handleRunFailure(context: AgentRunContext, error: unknown) {
    const message = errorMessage(error, "AI 执行失败");
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
      this.updateProjectStatus(context.projectId, ProjectStatus.qa_failed),
    ]);
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "run_failed",
      content: message,
      data: { message, errorMessage: message, runId: context.runId, projectId: context.projectId },
    });
  }

  private async runAgentStep<T>(
    context: AgentRunContext,
    agentName: AgentName,
    step: NonNullable<Parameters<VibeStreamService["emit"]>[0]["step"]>,
    handler: () => Promise<AgentOutput<T>>,
  ) {
    const stepLog = await this.runLog.createStep({
      runId: context.runId,
      agentName,
      inputSummary: `${agentName}: ${context.userInput}`,
      status: AgentStepStatus.pending,
    });
    await this.runLog.startStep(stepLog.id);
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type: "step_started",
      step,
      content: stepCopy(step, "started"),
    });

    try {
      const result = await handler();
      await this.runLog.completeStep(stepLog.id, fallbackStepOutput(result.data, result.fallback), {
        modelCallLogId: result.modelCallLogId,
      });
      if (result.fallback) {
        context.fallbackEvents = [...(context.fallbackEvents ?? []), result.fallback];
        await this.stream.emit({
          runId: context.runId,
          projectId: context.projectId,
          type: "fallback_used",
          step,
          content: result.fallback.userMessage,
          data: result.fallback,
        });
      }
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "step_completed",
        step,
        content: stepCopy(step, "completed"),
        data: result.data,
      });
      return result;
    } catch (error) {
      await this.runLog.failStep(stepLog.id, error);
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "step_failed",
        step,
        content: error instanceof Error ? error.message : "Agent 执行失败",
      });
      throw error;
    }
  }

  private async finishGeneralAnswer(context: AgentRunContext, intent: IntentResult) {
    const isCasual = isCasualGeneralInput(context.userInput);
    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: isCasual
        ? "你好，我在。你可以直接描述想做的产品、页面、PRD、原型或要修改的地方；有了具体目标后，我再进入生成流程。"
        : "我会围绕当前项目状态回答问题。复杂生成请直接描述目标需求。",
      nextAction: { type: "answer" },
    };
    await this.finishRun(context, result, ProjectStatus.draft);
    return result;
  }

  private async finishClarification(
    context: AgentRunContext,
    intent: IntentResult,
    requirement: RequirementAnalysis,
  ) {
    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: "我需要先确认几个会影响业务方向的问题，再继续生成 PRD 和原型。",
      nextAction: {
        type: "ask_clarification",
        questions: requirement.clarificationQuestions,
      },
    };
    await this.finishRun(context, result, ProjectStatus.clarifying);
    return result;
  }

  private async finishPatchCandidate(
    context: AgentRunContext,
    input: OrchestratorInput,
    intent: IntentResult,
    knowledgeContext: KnowledgeContext,
  ) {
    await this.emit(context, "message_delta", "正在生成局部修改预览，确认前不会改动当前 PRD 或原型...");
    const candidate = await this.patchService.createPatchCandidateFromRun({
      projectId: context.projectId,
      conversationId: context.conversationId,
      userId: context.userId,
      userInstruction: context.userInput,
      selectedRegion: context.selectedRegion!,
      attachments: input.attachments,
      runId: context.runId,
      traceId: context.traceId,
      instructionMessageId: input.userMessageId,
      knowledgeContext,
    });
    const patchPlan = candidate.patchRecord.patchPlan;
    return {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: "已生成 Patch 候选，请确认后再应用并重新生成 PRD、原型和 QA。",
      productDesignState: context.productDesignState,
      patchPlan,
      patchRecord: candidate.patchRecord,
      patchPreview: candidate.patchPreview,
      nextAction: {
        type: "confirm_patch",
        questions: patchPlan.clarificationQuestions ?? [],
        risks: patchPlan.risks ?? [],
      },
    } satisfies OrchestratorResult;
  }

  private async finishRun(
    context: AgentRunContext,
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
        productDesignState: result.productDesignState,
        prdDocument: result.prdDocument,
        prototypeSpec: result.prototypeSpec,
        prototypeArtifact: result.prototypeArtifact,
        qaReport: result.qaReport,
        productBuildPlan: result.productBuildPlan,
        patchPlan: result.patchPlan,
        patchRecord: result.patchRecord,
        patchPreview: result.patchPreview,
        exportArtifact: result.exportArtifact,
        knowledgeCandidates: result.knowledgeCandidates,
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
    await this.updateProjectStatus(context.projectId, projectStatus);
  }

  private async updateProjectStatus(projectId: string, status: ProjectStatus) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status, lastActivityAt: new Date() },
    });
  }

  private async finishExport(context: AgentRunContext, intent: IntentResult) {
    await this.emit(context, "message_delta", "正在准备导出产物...");
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

  private async emit(context: AgentRunContext, type: "message_delta", content: string) {
    await this.stream.emit({
      runId: context.runId,
      projectId: context.projectId,
      type,
      content,
    });
  }
}

function stepCopy(step: string, status: "started" | "completed") {
  const text: Record<string, [string, string]> = {
    intent_detection: ["正在理解你的需求...", "已识别用户意图"],
    knowledge_retrieval: ["正在检索知识库...", "知识上下文已整理"],
    requirement_analysis: ["正在分析需求完整度...", "需求完整度分析完成"],
    product_planning: ["正在规划正式需求执行方案...", "正式需求执行计划已完成"],
    product_design: ["正在生成产品设计方案...", "产品设计状态已生成"],
    prd_generation: ["正在生成 PRD 草案...", "PRD 草案已完成"],
    prototype_design: ["正在生成原型规格...", "原型规格已完成"],
    prototype_code_generation: ["正在生成 HTML 原型...", "HTML 原型已完成"],
    patch_planning: ["正在分析局部修改...", "局部修改计划已完成"],
    qa_check: ["正在进行一致性校验...", "QA 校验完成"],
    knowledge_extraction: ["正在抽取知识候选...", "知识候选抽取完成"],
  };
  return text[step]?.[status === "started" ? 0 : 1] ?? step;
}

function stateSummary(state: ProductDesignState) {
  return {
    id: state.id,
    projectId: state.projectId,
    version: state.version,
    title: state.title,
    status: state.status,
    counts: {
      pages: state.pages.length,
      backendConfigs: state.backendConfigs.length,
      frontendRules: state.frontendRules.length,
      businessRules: state.businessRules.length,
      stateRules: state.stateRules.length,
      exceptionScenarios: state.exceptionScenarios.length,
      acceptanceCriteria: state.acceptanceCriteria.length,
      assumptions: state.assumptions.length,
      pendingQuestions: state.pendingQuestions.length,
      confirmedFacts: state.confirmedFacts.length,
    },
    updatedAt: state.updatedAt,
  };
}

function hasConfirmedPrdForPrototype(state: ProductDesignState | undefined) {
  if (!state?.prdDocument) return false;
  if (state.prdDocument.status !== RequirementDocumentStatus.confirmed) return false;
  return state.status === ProductDesignStateStatus.doc_confirmed ||
    state.status === ProductDesignStateStatus.prd_ready ||
    state.status === ProductDesignStateStatus.prototype_ready ||
    state.status === ProductDesignStateStatus.confirmed;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return fallback;
}
