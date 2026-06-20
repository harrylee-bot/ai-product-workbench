import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType, UserIntent } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
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

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: KnowledgeInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Knowledge Agent。根据用户需求和附件摘要，分类可复用知识。只输出 KnowledgeContext JSON。",
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
          content: "原型应覆盖核心页面、关键状态、异常态和基础点击反馈，便于业务评审。",
          sourceType: "ai_assumption",
        },
      ],
      conflicts: [],
      unknownAreas: ["业务专属强规则", "已有系统约束", "历史活动差异"],
      summary: attachmentRefs.length
        ? "已使用上传附件作为参考资料，未发现强规则冲突。"
        : "暂无正式知识库命中，本轮将基于通用产品最佳实践补全，并标记为 AI 推断。",
    };
  }
}
