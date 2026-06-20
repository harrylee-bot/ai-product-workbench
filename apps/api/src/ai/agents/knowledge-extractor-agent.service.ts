import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type {
  KnowledgeCandidate,
  PatchPlan,
  ProductDesignState,
  PrototypeSpec,
  RequirementDocument,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type KnowledgeExtractorInput = {
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  patchPlan?: PatchPlan;
  confirmedByUser?: boolean;
};

@Injectable()
export class KnowledgeExtractorAgentService extends BaseAgentService<
  KnowledgeExtractorInput,
  KnowledgeCandidate[]
> {
  readonly agentName = AgentName.knowledge_extractor_agent;
  readonly taskType = ModelTaskType.knowledge_extraction;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: KnowledgeExtractorInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Knowledge Extractor Agent。只从用户确认后的稳定内容抽取 pending_review 知识候选 JSON 数组。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: KnowledgeExtractorInput): KnowledgeCandidate[] {
    if (!input.confirmedByUser) return [];
    return input.productDesignState.businessRules.slice(0, 3).map((rule) => ({
      id: randomUUID(),
      title: String(rule.name ?? rule.id ?? "业务规则候选"),
      content: String(rule.description ?? JSON.stringify(rule)),
      sourceType: "prd",
      sourceId: input.prdDocument?.id ?? input.productDesignState.id,
      confidence: 0.72,
      suggestedSection: "业务规则",
      tags: ["AI产品工作台", "待审核"],
      status: "pending_review",
    }));
  }
}
