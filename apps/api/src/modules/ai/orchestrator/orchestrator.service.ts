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
import { StateService } from "../../state/state.service";
import type { Phase1Prd, Phase1ProductStateInput, Phase1Prototype } from "../../state/state.types";
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
    private readonly stateService: StateService,
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
    const artifactInput = buildPreviewArtifacts({
      userInput: content,
      projectTitle: conversation.project.title,
      selectedStrategy,
      decisionPlan,
      constraintContext,
      companyRuntime,
      previewSession,
    });
    const artifactResult = await this.stateService.saveFromMessage({
      projectId: conversation.projectId,
      userId: input.user.id,
      productState: artifactInput.productState,
      prd: artifactInput.prd,
      prototype: artifactInput.prototype,
    });
    const prdPreview = {
      id: artifactResult.prd.id,
      title: artifactResult.prd.title,
      sections: artifactInput.prd.sections,
    };
    const prototypePreview = {
      id: artifactResult.prototype.id,
      title: artifactResult.prototype.title,
      html: artifactResult.prototype.htmlContent ?? artifactInput.prototype.html,
      entryFilePath: artifactResult.prototype.entryFilePath ?? "index.html",
    };

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
        prdPreview,
        prototypePreview,
      },
      relatedPrdDocumentId: artifactResult.prd.id,
      relatedPrototypeArtifactId: artifactResult.prototype.id,
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
      productDesignState: artifactResult.productDesignState,
      prdPreview,
      prototypePreview,
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

function buildPreviewArtifacts(input: {
  userInput: string;
  projectTitle: string;
  selectedStrategy: { id: string; name: string; description: string };
  decisionPlan: {
    strategies: Array<{ id: string; name: string; description: string; impact: string }>;
    reasoning?: string[];
  };
  constraintContext: {
    mustFollow: Array<{ effect: string; scope: string }>;
    prefer: Array<{ effect: string; scope: string }>;
    avoid: Array<{ effect: string; scope: string }>;
    warn: Array<{ effect: string; scope: string }>;
  };
  companyRuntime: {
    productInitiative: {
      name: string;
      goal: string;
      features: string[];
    };
    qaReport: {
      riskLevel: string;
      recommendations: string[];
    };
  };
  previewSession: {
    id: string;
    status: string;
    message: string;
  };
}): {
  productState: Phase1ProductStateInput;
  prd: Phase1Prd;
  prototype: Phase1Prototype;
} {
  const title = derivePreviewTitle(input.projectTitle, input.userInput, input.companyRuntime.productInitiative.name);
  const goal = input.companyRuntime.productInitiative.goal || `围绕「${input.userInput}」形成可评审的产品方案。`;
  const rules = [
    ...input.constraintContext.mustFollow.map((constraint) => ({ type: "必须遵守", content: constraint.effect, scope: constraint.scope })),
    ...input.constraintContext.prefer.map((constraint) => ({ type: "优先考虑", content: constraint.effect, scope: constraint.scope })),
    ...input.constraintContext.avoid.map((constraint) => ({ type: "避免", content: constraint.effect, scope: constraint.scope })),
  ];
  const pages = [
    {
      name: "产品概览",
      purpose: "展示目标、核心功能和当前策略选择。",
      keyBlocks: ["目标摘要", "核心功能", "策略说明", "下一步行动"],
    },
  ];
  const sections = [
    {
      title: "需求背景",
      content: `用户输入：「${input.userInput}」。系统已通过约束系统、决策系统和进化系统生成一版可评审方案。`,
    },
    {
      title: "产品目标",
      content: goal,
    },
    {
      title: "核心功能",
      content: input.companyRuntime.productInitiative.features.length
        ? input.companyRuntime.productInitiative.features.join("；")
        : "沉淀需求、展示策略、生成可预览原型，并保留完整决策记录。",
    },
    {
      title: "策略与规则",
      content: `当前选中策略：${strategyName(input.selectedStrategy.name)}。${input.selectedStrategy.description} 关键约束：${rules.map((rule) => rule.content).slice(0, 4).join("；") || "所有输出必须经过三系统融合流程。"}`,
    },
    {
      title: "验收标准",
      content: [
        "可以在右侧需求文档标签查看结构化需求。",
        "可以在右侧原型标签查看网页原型。",
        "可以在决策标签追踪策略、评审、补丁预览和进化结果。",
        `补丁预览状态为「${input.previewSession.status}」，确认前不会直接应用变更。`,
      ].join("；"),
    },
  ];

  return {
    productState: {
      title,
      businessGoal: goal,
      pages,
      rules,
    },
    prd: { sections },
    prototype: {
      html: renderPreviewHtml({
        title,
        goal,
        userInput: input.userInput,
        strategy: strategyName(input.selectedStrategy.name),
        strategyDescription: input.selectedStrategy.description,
        features: input.companyRuntime.productInitiative.features,
        riskLevel: input.companyRuntime.qaReport.riskLevel,
        recommendations: input.companyRuntime.qaReport.recommendations,
        reasoning: input.decisionPlan.reasoning ?? [],
      }),
    },
  };
}

function derivePreviewTitle(projectTitle: string, userInput: string, initiativeName: string) {
  const cleanedInput = userInput.replace(/\s+/g, " ").trim();
  if (initiativeName && !initiativeName.includes("未命名")) return initiativeName;
  if (projectTitle && !projectTitle.includes("未命名")) return projectTitle;
  return `${cleanedInput.slice(0, 18) || "产品方案"}预览`;
}

function strategyName(name: string) {
  const labels: Record<string, string> = {
    conservative: "保守策略",
    balanced: "平衡策略",
    aggressive: "进取策略",
    full_rewrite: "完整重写",
    conservative_fix: "保守修正",
    ux_improve: "体验优化",
    structure_rewrite: "结构重写",
    full_regenerate: "完整重建",
  };
  return labels[name] ?? name;
}

function renderPreviewHtml(input: {
  title: string;
  goal: string;
  userInput: string;
  strategy: string;
  strategyDescription: string;
  features: string[];
  riskLevel: string;
  recommendations: string[];
  reasoning: string[];
}) {
  const features = input.features.length ? input.features : ["需求梳理", "策略评审", "原型预览"];
  const recommendations = input.recommendations.length ? input.recommendations : ["保持补丁预览门禁", "持续记录决策链路"];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f6f7f9; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
    aside { background: #0f172a; color: white; padding: 24px 18px; }
    aside h1 { margin: 0 0 8px; font-size: 20px; }
    aside p { margin: 0; color: #cbd5e1; line-height: 1.7; font-size: 13px; }
    nav { margin-top: 28px; display: grid; gap: 8px; }
    nav span { border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 10px 12px; color: #e5e7eb; font-size: 13px; }
    main { padding: 28px; display: grid; gap: 18px; }
    .hero { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 24px; box-shadow: 0 10px 28px rgba(15,23,42,.06); }
    .eyebrow { color: #2563eb; font-weight: 700; font-size: 12px; }
    h2 { margin: 8px 0 10px; font-size: 28px; letter-spacing: 0; }
    .goal { color: #4b5563; line-height: 1.7; max-width: 760px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
    .card { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; min-height: 130px; }
    .card h3 { margin: 0 0 8px; font-size: 15px; }
    .card p, li { color: #4b5563; font-size: 13px; line-height: 1.7; }
    ul { margin: 8px 0 0; padding-left: 18px; }
    .pill { display: inline-flex; align-items: center; height: 26px; border-radius: 999px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1d4ed8; padding: 0 10px; font-size: 12px; font-weight: 700; }
    @media (max-width: 760px) { .shell { grid-template-columns: 1fr; } aside { min-height: auto; } .grid { grid-template-columns: 1fr; } main { padding: 18px; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>${escapeHtml(input.title)}</h1>
      <p>由智能产品工作台生成的原型预览，已通过约束、决策、进化链路。</p>
      <nav>
        <span>产品概览</span>
        <span>功能模块</span>
        <span>策略与风险</span>
      </nav>
    </aside>
    <main>
      <section class="hero">
        <div class="eyebrow">产品目标</div>
        <h2>${escapeHtml(input.title)}</h2>
        <p class="goal">${escapeHtml(input.goal)}</p>
      </section>
      <section class="grid">
        <div class="card">
          <h3>核心功能</h3>
          <ul>${features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul>
        </div>
        <div class="card">
          <h3>当前策略</h3>
          <span class="pill">${escapeHtml(input.strategy)}</span>
          <p>${escapeHtml(input.strategyDescription)}</p>
        </div>
        <div class="card">
          <h3>质量提示</h3>
          <p>风险等级：${escapeHtml(riskName(input.riskLevel))}</p>
          <ul>${recommendations.slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>
      </section>
      <section class="card">
        <h3>决策依据</h3>
        <p>${escapeHtml(input.reasoning[0] ?? "系统已按加权评分选择当前策略。")}</p>
      </section>
    </main>
  </div>
</body>
</html>`;
}

function riskName(riskLevel: string) {
  if (riskLevel === "high") return "高";
  if (riskLevel === "medium") return "中";
  if (riskLevel === "low") return "低";
  return riskLevel;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
