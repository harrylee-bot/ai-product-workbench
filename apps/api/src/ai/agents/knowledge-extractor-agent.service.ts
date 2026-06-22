import { Injectable } from "@nestjs/common";
import { AgentName, KnowledgeCandidateSource, KnowledgeType, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { agentSystemPrompt } from "../agent-charter";
import type {
  KnowledgeExtractorOutput,
  PatchPlan,
  ProductDesignState,
  PrototypeSpec,
  RequirementDocument,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type KnowledgeExtractorInput = {
  projectId?: string;
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  patchPlan?: PatchPlan;
  confirmedByUser?: boolean;
  source?: KnowledgeCandidateSource;
  sourceRefId?: string;
  runId?: string;
};

@Injectable()
export class KnowledgeExtractorAgentService extends BaseAgentService<
  KnowledgeExtractorInput,
  KnowledgeExtractorOutput
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
        content: agentSystemPrompt(
          this.agentName,
          "你是 Knowledge Extractor Agent。只从用户确认后的稳定内容抽取可复用知识候选。不要抽取隐私、一次性项目描述或未确认 assumption。只输出 { candidates: KnowledgeCandidateDraft[] } JSON。",
        ),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: KnowledgeExtractorInput): KnowledgeExtractorOutput {
    if (!input.confirmedByUser) return { candidates: [] };
    const source = input.source ?? KnowledgeCandidateSource.product_design_state;
    const sourceRefId = input.sourceRefId ?? input.prdDocument?.id ?? input.productDesignState.id;
    return {
      candidates: input.productDesignState.businessRules.slice(0, 3).map((rule) => ({
        title: String(rule.name ?? rule.id ?? "业务规则候选"),
        content: String(rule.description ?? JSON.stringify(rule)),
        summary: String(rule.title ?? rule.name ?? "从已确认产物抽取的业务规则"),
        suggestedType: KnowledgeType.default_rule,
        suggestedTags: ["AI产品工作台", "待审核"],
        confidence: 0.72,
        source,
        sourceRefId,
        sourcePath: "businessRules",
        reason: "来自用户确认后的 ProductDesignState 业务规则，可复用于后续项目。",
      })),
    };
  }

  protected normalize(output: KnowledgeExtractorOutput, input: KnowledgeExtractorInput): KnowledgeExtractorOutput {
    const fallback = this.fallback(input);
    if (!input.confirmedByUser) return { candidates: [] };
    const candidates = Array.isArray(output.candidates) ? output.candidates : fallback.candidates;
    return {
      candidates: candidates
        .filter((item) => item && typeof item.title === "string" && typeof item.content === "string")
        .map((item) => ({
          title: item.title.trim().slice(0, 120),
          content: item.content.trim(),
          summary: typeof item.summary === "string" ? item.summary.trim() : undefined,
          suggestedType: isKnowledgeType(item.suggestedType) ? item.suggestedType : KnowledgeType.default_rule,
          suggestedCategoryName: item.suggestedCategoryName,
          suggestedCategoryId: item.suggestedCategoryId,
          suggestedTags: Array.isArray(item.suggestedTags) ? item.suggestedTags.map(String) : [],
          confidence: typeof item.confidence === "number" ? item.confidence : 0.7,
          source: item.source ?? input.source ?? KnowledgeCandidateSource.product_design_state,
          sourceRefId: item.sourceRefId ?? input.sourceRefId,
          sourcePath: item.sourcePath,
          reason: typeof item.reason === "string" ? item.reason : "从用户确认产物中抽取为可复用知识。",
        })),
    };
  }
}

function isKnowledgeType(value: unknown): value is KnowledgeType {
  return typeof value === "string" && Object.values(KnowledgeType).includes(value as KnowledgeType);
}
