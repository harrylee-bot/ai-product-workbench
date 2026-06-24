import { Injectable } from "@nestjs/common";
import { AgentName, KnowledgeType, ModelTaskType, UserIntent } from "@prisma/client";
import { KnowledgeRetrievalService } from "../../knowledge/knowledge-retrieval.service";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { AgentInvocation, AgentOutput } from "../ai-vibe.types";
import { AgentSkillRegistryService } from "../agent-skill-registry.service";
import { agentSystemPrompt } from "../agent-charter";
import { buildAgentSkillRoutes } from "../agent-skill-instructions";
import { BaseAgentService } from "./base-agent.service";
import type { KnowledgeContext, ProductDesignState } from "../ai-vibe.types";

type KnowledgeInput = {
  userInput: string;
  productDesignState?: ProductDesignState;
  businessType?: string;
  relatedSystems?: string[];
  intent: UserIntent;
  attachments?: Array<{ fileId: string; fileName: string; summary?: string; extractedTextPreview?: string }>;
};

@Injectable()
export class KnowledgeAgentService extends BaseAgentService<KnowledgeInput, KnowledgeContext> {
  readonly agentName = AgentName.knowledge_agent;
  readonly taskType = ModelTaskType.knowledge_classification;

  constructor(
    modelGateway: ModelGatewayService,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly skillRegistry: AgentSkillRegistryService,
  ) {
    super(modelGateway);
  }

  async run(invocation: AgentInvocation<KnowledgeInput, KnowledgeContext>): Promise<AgentOutput<KnowledgeContext>> {
    const fallback = this.fallback(invocation.input);
    const taskType = taskTypeFromIntent(invocation.input.intent);
    const preferredTypes = preferredTypesForTask(taskType);
    const output = await this.retrieval.search({
      projectId: invocation.projectId,
      runId: invocation.runId,
      agentName: this.agentName,
      query: buildSearchQuery(invocation.input),
      taskType,
      preferredTypes,
      limit: 8,
    });
    const grouped = groupReferences(output.references, fallback, invocation.input.userInput);
    const agentSkills = await this.skillRegistry.getVibeCodingSkills(invocation.input.userInput);
    const skillReferences = this.skillRegistry.toKnowledgeReferences(agentSkills);
    const skillRouting = buildAgentSkillRoutes(agentSkills);
    const routedAgentCount = routedAgentNames(skillRouting).length;
    const summaryParts = [
      output.references.length ? `命中 ${output.references.length} 条正式知识库规则` : "",
      agentSkills.length ? `已加载 ${agentSkills.length} 个 Obsidian/Vibe Coding 技能` : "",
      skillRouting.length ? `已生成 ${skillRouting.length} 条 skill 路由，覆盖 ${routedAgentCount} 个 Agent` : "",
    ].filter(Boolean);

    return {
      data: {
        ...fallback,
        ...grouped,
        prototypeRules: [...grouped.prototypeRules, ...skillReferences],
        agentSkills,
        skillRouting,
        summary: summaryParts.length
          ? `${summaryParts.join("，")}，已按类型提供给后续 Agent。`
          : fallback.summary,
      },
    };
  }

  protected buildMessages(input: KnowledgeInput) {
    return [
      {
        role: "system" as const,
        content: agentSystemPrompt(
          this.agentName,
          "你是 Knowledge Agent。根据用户需求、附件摘要和已有产品状态检索正式知识，并加载 Vibe Coding skills；你还要把 skill 路由成后续 Agent 可执行的约束。只输出 KnowledgeContext JSON。",
        ),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: KnowledgeInput): KnowledgeContext {
    const attachmentRefs =
      input.attachments?.map((attachment) => ({
        id: attachment.fileId,
        title: attachment.fileName,
        content: attachment.summary || attachment.extractedTextPreview || "用户上传的参考资料。",
        sourceType: "attachment" as const,
        sourceId: attachment.fileId,
      })) ?? [];

    return {
      query: input.userInput,
      strongRules: [],
      defaultRules: [],
      referenceCases: attachmentRefs,
      designPatterns: [
        {
          id: "pattern_reviewable_prototype",
          title: "评审型原型默认规则",
          snippet: "原型应覆盖核心页面、关键状态、异常态和基础点击反馈。",
          content: "原型应覆盖核心页面、关键状态、异常态和基础点击反馈，便于业务评审。",
          type: KnowledgeType.design_pattern,
          sourceType: "ai_assumption",
        },
      ],
      prdWritingRules: [],
      prototypeRules: [],
      businessConcepts: [],
      agentSkills: [],
      conflicts: [],
      unknownAreas: ["业务专属强规则", "已有系统约束", "历史活动差异"],
      summary: attachmentRefs.length
        ? "已使用上传附件作为参考资料，未发现强规则冲突。"
        : "暂无正式知识库命中，本轮将基于通用产品最佳实践补全，并标记为 AI 推断。",
    };
  }
}

function routedAgentNames(routes: NonNullable<KnowledgeContext["skillRouting"]>) {
  return [
    ...new Set(
      routes.flatMap((route) => route.appliesTo.map((target) => target.agentName)),
    ),
  ];
}

function buildSearchQuery(input: KnowledgeInput) {
  const stateText = input.productDesignState
    ? [
        input.productDesignState.title,
        input.productDesignState.summary,
        input.productDesignState.businessGoal,
      ].filter(Boolean).join(" ")
    : "";
  return [input.userInput, input.businessType, stateText].filter(Boolean).join(" ");
}

function taskTypeFromIntent(intent: UserIntent): ModelTaskType {
  if (intent === UserIntent.generate_prd) return ModelTaskType.prd_generation;
  if (intent === UserIntent.generate_prototype) return ModelTaskType.prototype_design;
  if (intent === UserIntent.patch_document || intent === UserIntent.patch_prototype) {
    return ModelTaskType.patch_planning;
  }
  if (intent === UserIntent.new_requirement || intent === UserIntent.complete_requirement) {
    return ModelTaskType.product_planning;
  }
  return ModelTaskType.product_design;
}

export function preferredTypesForTask(taskType: ModelTaskType): KnowledgeType[] {
  if (taskType === ModelTaskType.product_planning) {
    return [
      KnowledgeType.strong_rule,
      KnowledgeType.default_rule,
      KnowledgeType.business_concept,
      KnowledgeType.reference_case,
      KnowledgeType.design_pattern,
      KnowledgeType.prd_writing_rule,
      KnowledgeType.prototype_rule,
    ];
  }
  if (taskType === ModelTaskType.requirement_analysis) {
    return [
      KnowledgeType.strong_rule,
      KnowledgeType.default_rule,
      KnowledgeType.business_concept,
      KnowledgeType.reference_case,
    ];
  }
  if (taskType === ModelTaskType.prd_generation) {
    return [
      KnowledgeType.prd_writing_rule,
      KnowledgeType.strong_rule,
      KnowledgeType.default_rule,
    ];
  }
  if (taskType === ModelTaskType.prototype_design) {
    return [
      KnowledgeType.prototype_rule,
      KnowledgeType.design_pattern,
      KnowledgeType.reference_case,
    ];
  }
  if (taskType === ModelTaskType.patch_planning) {
    return [
      KnowledgeType.strong_rule,
      KnowledgeType.default_rule,
      KnowledgeType.business_concept,
      KnowledgeType.prototype_rule,
      KnowledgeType.design_pattern,
    ];
  }
  if (taskType === ModelTaskType.qa_check) {
    return [
      KnowledgeType.strong_rule,
      KnowledgeType.default_rule,
      KnowledgeType.prd_writing_rule,
      KnowledgeType.prototype_rule,
    ];
  }
  return [
    KnowledgeType.strong_rule,
    KnowledgeType.default_rule,
    KnowledgeType.design_pattern,
    KnowledgeType.business_concept,
    KnowledgeType.reference_case,
  ];
}

function groupReferences(
  references: KnowledgeContext["strongRules"],
  fallback: KnowledgeContext,
  query: string,
): KnowledgeContext {
  return {
    query,
    strongRules: references.filter((item) => item.type === KnowledgeType.strong_rule),
    defaultRules: references.filter((item) => item.type === KnowledgeType.default_rule),
    referenceCases: [
      ...references.filter((item) => item.type === KnowledgeType.reference_case),
      ...fallback.referenceCases,
    ],
    designPatterns: [
      ...references.filter((item) => item.type === KnowledgeType.design_pattern),
      ...fallback.designPatterns,
    ],
    prdWritingRules: references.filter((item) => item.type === KnowledgeType.prd_writing_rule),
    prototypeRules: references.filter((item) => item.type === KnowledgeType.prototype_rule),
    businessConcepts: references.filter((item) => item.type === KnowledgeType.business_concept),
    conflicts: fallback.conflicts,
    unknownAreas: fallback.unknownAreas,
    summary: fallback.summary,
  };
}
