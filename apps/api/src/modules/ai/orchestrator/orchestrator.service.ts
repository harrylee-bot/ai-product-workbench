import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConversationStatus, Message, MessageRole, MessageType, ProjectStatus, UserRole } from "@prisma/client";
import { CompanyRuntimeService } from "../../../company/company-runtime.service";
import { PatchBuilderService } from "../../../ai/patch-builder/patch-builder.service";
import { PatchPreviewService } from "../../../ai/patch-builder/patch-preview.service";
import { SelfGenerationEngine } from "../../../ai/self-generation/self-generation.engine";
import { SystemGraphService } from "../../../ai/self-generation/system.graph.service";
import { ConstraintService } from "../../../constraint/constraint.service";
import { FusionDecisionService } from "../../../decision/decision.service";
import { FusionEvolutionService } from "../../../evolution/evolution.service";
import { PrismaService } from "../../../prisma/prisma.service";
import type { Phase1User } from "../../auth/auth.types";
import { IntentAgent } from "../agents/intent/intent.agent";

@Injectable()
export class OrchestratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intentAgent: IntentAgent,
    private readonly patchBuilder: PatchBuilderService,
    private readonly patchPreview: PatchPreviewService,
    private readonly selfGeneration: SelfGenerationEngine,
    private readonly systemGraph: SystemGraphService,
    private readonly companyRuntime: CompanyRuntimeService,
    private readonly constraints: ConstraintService,
    private readonly decisions: FusionDecisionService,
    private readonly evolutionSystem: FusionEvolutionService,
  ) {}

  async handleUserMessage(input: {
    user: Phase1User;
    projectId: string;
    conversationId: string;
    content: string;
  }) {
    const startedAt = Date.now();
    const content = input.content.trim();
    const conversation = await this.assertConversationAccess(
      input.user,
      input.projectId,
      input.conversationId,
    );

    const userMessage = await this.createMessage({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      userId: input.user.id,
      role: MessageRole.user,
      type: MessageType.text,
      content,
    });

    const constraintContext = await this.constraints.build({
      projectId: conversation.projectId,
      userInput: content,
      createdBy: input.user.id,
    });
    const decisionResult = await this.decisions.generate({
      projectId: conversation.projectId,
      userInput: content,
      intent: "new_requirement",
      constraintContext,
      createdBy: input.user.id,
    });
    const agentInput = {
      userInput: content,
      constraintContext,
      decisionContext: decisionResult.decisionPlan,
    };
    const intent = this.intentAgent.run(agentInput);
    const executionPlan = await this.systemGraph.ensureGraph(conversation.projectId, input.user.id);
    const companyRuntime = await this.companyRuntime.run({
      projectId: conversation.projectId,
      marketSignal: content,
      createdBy: input.user.id,
      sourceType: "message",
      sourceId: userMessage.id,
    });
    const { decisionPlan, reviewBoard, selection, selectedStrategy } = decisionResult;

    const patchDraft = this.patchBuilder.build(selectedStrategy, constraintContext);
    const previewSession = await this.patchPreview.createPreview({
      user: input.user,
      projectId: conversation.projectId,
      conversationId: conversation.id,
      draft: patchDraft,
      sourceMessageId: userMessage.id,
      userInstruction: content,
    });

    const fusionMetrics = {
      qaPassed: previewSession.status === "ready",
      userSatisfaction: previewSession.riskPanel?.level === "high" ? 0.62 : 0.82,
      executionTime: Date.now() - startedAt,
    };
    const evolution = await this.evolutionSystem.run({
      projectId: conversation.projectId,
      sourceType: "message",
      sourceId: userMessage.id,
      userInput: content,
      decisionPlan,
      outcome: this.evolutionSystem.resolveOutcome(fusionMetrics),
      metrics: fusionMetrics,
      createdBy: input.user.id,
    });
    const selfGeneration = await this.selfGeneration.run({
      projectId: conversation.projectId,
      createdBy: input.user.id,
      traceId: evolution.traceId,
      finalOutcome: evolution.finalOutcome,
      riskLevel: previewSession.riskPanel?.level,
    });

    const assistantContent = "三系统融合已完成：约束系统、决策系统、进化系统均已参与并记录。";
    const assistantMessage = await this.createMessage({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      role: MessageRole.assistant,
      type: MessageType.agent_summary,
      content: assistantContent,
      metadata: {
        intent,
        constraintContext,
        agentInput,
        decisionTraceId: evolution.traceId,
        decisionPlan,
        reviewBoard,
        selection,
        selectedStrategy,
        patchDraft,
        previewSession,
        evolution,
        selfGeneration,
        companyRuntime,
      },
    });

    return {
      userMessage,
      assistantMessage,
      intent,
      constraintContext,
      agentInput,
      decisionPlan,
      reviewBoard,
      selection,
      selectedStrategy,
      patchDraft,
      previewSession,
      evolution,
      selfGeneration,
      companyRuntime,
      executionPlan,
      decisionTrace: {
        id: evolution.traceId,
        selectedStrategy: selectedStrategy.id,
      },
    };
  }

  private async assertConversationAccess(user: Phase1User, projectId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    });
    if (!conversation || conversation.projectId !== projectId || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }
    if (
      conversation.status !== ConversationStatus.active ||
      conversation.project.status === ProjectStatus.deleted ||
      conversation.project.deletedAt
    ) {
      throw new ForbiddenException("当前项目或会话不可用");
    }
    if (user.role !== UserRole.admin && conversation.project.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该会话");
    }
    return conversation;
  }

  private async createMessage(input: {
    projectId: string;
    conversationId: string;
    userId?: string;
    role: MessageRole;
    type: MessageType;
    content: string;
    metadata?: object;
    relatedPrdDocumentId?: string;
    relatedPrototypeArtifactId?: string;
  }) {
    const now = new Date();
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          projectId: input.projectId,
          conversationId: input.conversationId,
          userId: input.userId,
          role: input.role,
          type: input.type,
          content: input.content,
          metadata: input.metadata,
          relatedPrdDocumentId: input.relatedPrdDocumentId,
          relatedPrototypeArtifactId: input.relatedPrototypeArtifactId,
          createdAt: now,
        },
      });
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: {
          messageCount: { increment: 1 },
          lastMessageAt: now,
        },
      });
      await tx.project.update({
        where: { id: input.projectId },
        data: { lastActivityAt: now },
      });
      return created;
    });
    return toMessage(message);
  }
}

export function toMessage(message: Message) {
  return {
    id: message.id,
    projectId: message.projectId,
    conversationId: message.conversationId,
    userId: message.userId,
    role: message.role,
    type: message.type,
    content: message.content,
    metadata: message.metadata,
    relatedPrdDocumentId: message.relatedPrdDocumentId,
    relatedPrototypeArtifactId: message.relatedPrototypeArtifactId,
    createdAt: message.createdAt.toISOString(),
  };
}
