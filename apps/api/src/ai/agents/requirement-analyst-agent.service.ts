import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { agentSystemPrompt } from "../agent-charter";
import { agentSkillSystemPrompt } from "../agent-skill-instructions";
import { BaseAgentService } from "./base-agent.service";
import type {
  ConversationMessage,
  KnowledgeContext,
  ProductDesignState,
  RequirementAnalysis,
} from "../ai-vibe.types";

type RequirementAnalystInput = {
  userInput: string;
  knowledgeContext: KnowledgeContext;
  productDesignState?: ProductDesignState;
  recentMessages: ConversationMessage[];
};

@Injectable()
export class RequirementAnalystAgentService extends BaseAgentService<
  RequirementAnalystInput,
  RequirementAnalysis
> {
  readonly agentName = AgentName.requirement_analyst_agent;
  readonly taskType = ModelTaskType.requirement_analysis;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: RequirementAnalystInput) {
    return [
      {
        role: "system" as const,
        content: [
          agentSystemPrompt(
            this.agentName,
            "你是 Requirement Analyst Agent。分析需求完整度，不生成 PRD。只输出 RequirementAnalysis JSON。",
          ),
          agentSkillSystemPrompt(this.agentName, this.taskType, input.knowledgeContext),
        ].filter(Boolean).join("\n\n"),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: RequirementAnalystInput): RequirementAnalysis {
    const text = input.userInput;
    const knownFromUser = [
      text.includes("原型") ? "用户希望生成原型" : "",
      /prd|需求|文档/i.test(text) ? "用户希望生成需求文档" : "",
      text.length > 8 ? `用户原始需求：${text}` : "",
    ].filter(Boolean);
    const missingCritical = [];
    if (!/用户|会员|运营|后台|客服|商家/.test(text)) missingCritical.push("目标用户范围");
    if (!/页面|后台|前端|活动页|配置/.test(text)) missingCritical.push("页面范围");
    if (!/状态|未开始|进行中|结束|异常|失败/.test(text)) missingCritical.push("关键状态规则");
    const shouldAskUser = missingCritical.length >= 3 && text.length < 20;

    return {
      completenessScore: shouldAskUser ? 0.45 : 0.76,
      knownFromUser,
      knownFromKnowledge: [
        ...input.knowledgeContext.strongRules,
        ...input.knowledgeContext.defaultRules,
        ...input.knowledgeContext.referenceCases,
        ...input.knowledgeContext.businessConcepts,
      ].map((item) => item.title),
      inferredByAI: [
        "页面需覆盖默认态、成功态、异常态。",
        "PRD 与原型需共享同一套状态和验收口径。",
      ],
      missingCritical,
      missingOptional: ["数据统计口径", "运营后台高级权限", "多端适配细节"],
      conflicts: input.knowledgeContext.conflicts.map((item) => item.description),
      shouldAskUser,
      clarificationQuestions: shouldAskUser
        ? missingCritical.slice(0, 3).map((item, index) => ({
            id: `clarify_${index + 1}`,
            title: `请确认${item}`,
            reason: `${item}会影响 PRD 和原型范围。`,
            options: ["按常规最佳实践先生成", "我补充具体规则", "暂不纳入一期"],
            recommendedOption: "按常规最佳实践先生成",
          }))
        : [],
    };
  }

  protected normalize(output: RequirementAnalysis, input: RequirementAnalystInput): RequirementAnalysis {
    const fallback = this.fallback(input);
    const shouldAskUser = typeof output.shouldAskUser === "boolean"
      ? output.shouldAskUser
      : fallback.shouldAskUser;

    return {
      completenessScore: numberValue(output.completenessScore, fallback.completenessScore),
      knownFromUser: stringArray(output.knownFromUser, fallback.knownFromUser),
      knownFromKnowledge: stringArray(output.knownFromKnowledge, fallback.knownFromKnowledge),
      inferredByAI: stringArray(output.inferredByAI, fallback.inferredByAI),
      missingCritical: stringArray(output.missingCritical, fallback.missingCritical),
      missingOptional: stringArray(output.missingOptional, fallback.missingOptional),
      conflicts: stringArray(output.conflicts, fallback.conflicts),
      shouldAskUser,
      clarificationQuestions: normalizeClarificationQuestions(
        output.clarificationQuestions,
        shouldAskUser ? fallback.clarificationQuestions : [],
      ),
    };
  }

  protected fallbackMode() {
    return "heuristic_requirement_analysis";
  }

  protected fallbackUserMessage() {
    return "Requirement Analyst 模型暂时不可用，已使用规则分析需求完整度并继续。";
  }
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return String(record.title ?? record.content ?? record.description ?? record.reason ?? "").trim();
      }
      return String(item ?? "").trim();
    })
    .filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : fallback;
}

function normalizeClarificationQuestions(value: unknown, fallback: RequirementAnalysis["clarificationQuestions"]) {
  if (!Array.isArray(value)) return fallback;
  const questions = value
    .map((item, index) => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const title = text(record.title) || text(record.question) || `请确认问题 ${index + 1}`;
      const reason = text(record.reason) || "该问题会影响 PRD 和原型范围。";
      return {
        id: text(record.id) || `clarify_${index + 1}`,
        title,
        question: text(record.question) || title,
        reason,
        options: stringArray(record.options, ["按常规最佳实践先生成", "我补充具体规则", "暂不纳入一期"]),
        recommendedOption: text(record.recommendedOption),
      };
    })
    .filter((item) => item.title);
  return questions.length ? questions : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
