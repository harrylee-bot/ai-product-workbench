import { Injectable } from "@nestjs/common";
import {
  AgentName,
  AgentStepStatus,
  MessageType,
  ProductDesignStateStatus,
  ProjectStatus,
  UserIntent,
} from "@prisma/client";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  AgentRunContext,
  AttachmentSummary,
  IntentResult,
  KnowledgeCandidate,
  KnowledgeCandidateDraft,
  PatchPlan,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QAReport,
  RequirementAnalysis,
  RequirementDocument,
} from "./ai-vibe.types";
import { KnowledgeExtractorAgentService } from "./agents/knowledge-extractor-agent.service";
import { KnowledgeAgentService } from "./agents/knowledge-agent.service";
import { PatchAgentService } from "./agents/patch-agent.service";
import { PrdWriterAgentService } from "./agents/prd-writer-agent.service";
import { ProductDesignerAgentService } from "./agents/product-designer-agent.service";
import { PrototypeCodeAgentService } from "./agents/prototype-code-agent.service";
import { PrototypeDesignerAgentService } from "./agents/prototype-designer-agent.service";
import { QaAgentService } from "./agents/qa-agent.service";
import { RequirementAnalystAgentService } from "./agents/requirement-analyst-agent.service";
import { IntentAgentService } from "./agents/intent-agent.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { PrototypeService } from "./prototype.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeStreamService } from "./vibe-stream.service";

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
  patchPlan?: PatchPlan;
  knowledgeCandidates?: Array<KnowledgeCandidate | KnowledgeCandidateDraft>;
  nextAction?: {
    type: "ask_clarification" | "review_prd" | "review_prototype" | "review_qa" | "answer";
    questions?: ProductDesignState["pendingQuestions"];
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
    private readonly messageService: MessageService,
    private readonly prisma: PrismaService,
    private readonly intentAgent: IntentAgentService,
    private readonly knowledgeAgent: KnowledgeAgentService,
    private readonly requirementAnalystAgent: RequirementAnalystAgentService,
    private readonly productDesignerAgent: ProductDesignerAgentService,
    private readonly prdWriterAgent: PrdWriterAgentService,
    private readonly prototypeDesignerAgent: PrototypeDesignerAgentService,
    private readonly prototypeCodeAgent: PrototypeCodeAgentService,
    private readonly patchAgent: PatchAgentService,
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
              currentProjectStatus: undefined,
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
      let patchPlan: PatchPlan | undefined;
      let state = context.productDesignState;

      if (isPatch && context.selectedRegion && state) {
        await this.emit(context, "message_delta", "正在分析局部修改影响范围...");
        const patch = await this.runAgentStep(
          context,
          AgentName.patch_agent,
          "patch_planning",
          () =>
            this.patchAgent.run({
              runId: context.runId,
              projectId: context.projectId,
              traceId: context.traceId,
              userId: context.userId,
              input: {
                userInput: context.userInput,
                selectedRegion: context.selectedRegion!,
                productDesignState: state!,
                prdDocument: state?.prdDocument,
                prototypeSpec: state?.prototypeSpec,
                knowledgeContext: knowledge.data,
              },
            }),
        );
        patchPlan = patch.data;
        state = await this.stateService.applyPatch(context.projectId, state, patchPlan, {
          userId: context.userId,
          runId: context.runId,
          messageId: input.userMessageId,
        });
        await this.stream.emit({
          runId: context.runId,
          projectId: context.projectId,
          type: "state_updated",
          step: "patch_planning",
          data: stateSummary(state),
        });
      } else {
        await this.emit(context, "message_delta", "正在生成结构化产品设计状态...");
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
              productDesignState: state!,
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
      const qa = await this.runAgentStep(context, AgentName.qa_agent, "qa_check", () =>
        this.qaAgent.run({
          runId: context.runId,
          projectId: context.projectId,
          traceId: context.traceId,
          userId: context.userId,
          input: {
            productDesignState: state!,
            prdDocument,
            prototypeSpec: prototypeSpec.data,
            patchPlan,
            knowledgeContext: knowledge.data,
          },
        }),
      );
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "qa_completed",
        step: "qa_check",
        data: qa.data,
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
              productDesignState: state!,
              prdDocument,
              prototypeSpec: prototypeSpec.data,
              patchPlan,
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
        intent: intent.data,
        message: finalMessage,
        productDesignState: state,
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        prototypeArtifact: savedPrototype.artifact,
        qaReport: qa.data,
        patchPlan,
        knowledgeCandidates: knowledgeCandidates.data.candidates,
        nextAction: {
          type: qa.data.passed ? "review_prototype" : "review_qa",
        },
      };

      await this.finishRun(context, result, qa.data.passed ? ProjectStatus.prototype_ready : ProjectStatus.qa_failed);
      return result;
    } catch (error) {
      await this.runLog.failRun(context.runId, error);
      await this.stream.emit({
        runId: context.runId,
        projectId: context.projectId,
        type: "run_failed",
        content: error instanceof Error ? error.message : "AI 执行失败",
        data: { message: error instanceof Error ? error.message : "AI 执行失败" },
      });
      throw error;
    }
  }

  private async runAgentStep<T>(
    context: AgentRunContext,
    agentName: AgentName,
    step: NonNullable<Parameters<VibeStreamService["emit"]>[0]["step"]>,
    handler: () => Promise<{ data: T; modelCallLogId?: string }>,
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
      await this.runLog.completeStep(stepLog.id, result.data, {
        modelCallLogId: result.modelCallLogId,
      });
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
    const result: OrchestratorResult = {
      runId: context.runId,
      projectId: context.projectId,
      intent,
      message: "我会围绕当前项目状态回答问题。模块 6 已接入多 Agent 编排，复杂生成请直接描述目标需求。",
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
        patchPlan: result.patchPlan,
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
