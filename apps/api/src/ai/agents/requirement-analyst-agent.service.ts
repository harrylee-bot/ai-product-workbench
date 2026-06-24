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
            [
              "你是 Requirement Analyst Agent。分析需求完整度，不生成 PRD。只输出 RequirementAnalysis JSON。",
              "澄清门策略：默认让链路继续生成，把不确定内容写入 inferredByAI 或 missingOptional；只有缺失项会真正改变业务方向、目标用户或核心页面范围，且无法用常规产品假设推进时，shouldAskUser 才能为 true。",
              "不要因为缺少数据统计口径、权限高级规则、多端细节、文案细节、异常边界就阻断；这些应进入 missingOptional 或 inferredByAI。",
              "如果 shouldAskUser 为 true，clarificationQuestions 只输出 1-3 个阻断问题，每个问题必须可被用户快速选择；推荐项应优先是“按常规最佳实践先生成”。",
            ].join("\n"),
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
    if (!/页面|页|首页|列表|详情|表单|看板|工作台|后台|前台|前端|H5|App|小程序|活动页|配置/i.test(text)) {
      missingCritical.push("页面范围");
    }
    if (!/状态|未开始|进行中|结束|异常|失败/.test(text)) missingCritical.push("关键状态规则");
    const shouldAskUser = shouldBlockForClarification({
      userInput: text,
      completenessScore: 0.76,
      missingCritical,
      conflicts: input.knowledgeContext.conflicts.map((item) => item.description),
      modelRequestedClarification: false,
    });

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
    const completenessScore = numberValue(output.completenessScore, fallback.completenessScore);
    const knownFromUser = stringArray(output.knownFromUser, fallback.knownFromUser);
    const knownFromKnowledge = stringArray(output.knownFromKnowledge, fallback.knownFromKnowledge);
    const inferredByAI = stringArray(output.inferredByAI, fallback.inferredByAI);
    const missingCritical = stringArray(output.missingCritical, fallback.missingCritical);
    const missingOptional = stringArray(output.missingOptional, fallback.missingOptional);
    const conflicts = stringArray(output.conflicts, fallback.conflicts);
    const shouldAskUser = shouldBlockForClarification({
      userInput: input.userInput,
      completenessScore,
      missingCritical,
      conflicts,
      modelRequestedClarification: output.shouldAskUser === true,
    });

    return {
      completenessScore,
      knownFromUser,
      knownFromKnowledge,
      inferredByAI,
      missingCritical,
      missingOptional,
      conflicts,
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

  protected jsonSchema() {
    return {
      completenessScore: "number 0-1",
      knownFromUser: "string[] 用户明确给出的事实",
      knownFromKnowledge: "string[] 知识库或附件提供的事实",
      inferredByAI: "string[] 可以继续推进但必须标记为 AI 假设的内容",
      missingCritical: "string[] 只放真正会阻断业务方向、目标用户或核心页面范围的信息",
      missingOptional: "string[] 不阻断生成的细节缺口",
      conflicts: "string[] 用户输入与强规则或上下文的冲突",
      shouldAskUser: "boolean 仅在缺失项真正阻断时为 true，默认 false",
      clarificationQuestions: "ClarificationQuestion[] shouldAskUser=true 时最多 3 个，默认空数组",
      decisionTrace: "AgentDecisionTrace",
    };
  }
}

function shouldBlockForClarification(input: {
  userInput: string;
  completenessScore: number;
  missingCritical: string[];
  conflicts: string[];
  modelRequestedClarification: boolean;
}) {
  if (input.conflicts.length) return true;

  const text = input.userInput.replace(/\s+/g, "");
  const hasProductSignal = /产品|页面|系统|后台|前台|小程序|App|H5|活动|商城|会员|运营|客服|订单|支付|表单|看板|原型|PRD|需求|文档/i.test(text);
  const hasExecutionSignal = /做|生成|设计|写|创建|搭建|优化|补全|输出|实现|整理|改/.test(text);
  const hasConcreteObject = /活动|商城|会员|订单|支付|表单|看板|工作台|客服|运营|首页|列表|详情|配置|审批|报表|抽奖|优惠券|积分|课程|门店|库存|商品/i.test(text);
  const tooVague = (!hasConcreteObject && text.length < 14) || (!hasProductSignal && !hasExecutionSignal);
  const blockingMissing = input.missingCritical.filter(isBlockingMissing);

  if (input.completenessScore < 0.42 && blockingMissing.length >= 1) return true;
  if (tooVague && blockingMissing.length >= 2) return true;
  if (input.modelRequestedClarification && input.completenessScore < 0.58 && blockingMissing.length >= 2) {
    return true;
  }

  return false;
}

function isBlockingMissing(value: string) {
  return /业务方向|核心目标|目标用户|用户范围|页面范围|核心页面|业务对象|关键流程/.test(value);
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
      const status: RequirementAnalysis["clarificationQuestions"][number]["status"] =
        record.status === "answered" || record.status === "skipped" ? record.status : "pending";
      return {
        id: text(record.id) || `clarify_${index + 1}`,
        title,
        question: text(record.question) || title,
        reason,
        options: stringArray(record.options, ["按常规最佳实践先生成", "我补充具体规则", "暂不纳入一期"]),
        recommendedOption: text(record.recommendedOption),
        recommendation: text(record.recommendation),
        required: Boolean(record.required),
        status,
      };
    })
    .filter((item) => item.title);
  return questions.length ? questions : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
