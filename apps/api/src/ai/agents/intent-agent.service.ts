import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType, UserIntent } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { BaseAgentService } from "./base-agent.service";
import type { ConversationMessage, IntentResult, SelectedRegion } from "../ai-vibe.types";
import { agentSystemPrompt } from "../agent-charter";
import { isCasualGeneralInput } from "../intent-classifier.helpers";

type IntentInput = {
  userInput: string;
  selectedRegion?: SelectedRegion;
  currentProjectStatus?: string;
  previewMode?: "prd" | "prototype";
  recentMessages: ConversationMessage[];
};

@Injectable()
export class IntentAgentService extends BaseAgentService<IntentInput, IntentResult> {
  readonly agentName = AgentName.intent_agent;
  readonly taskType = ModelTaskType.intent_detection;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: IntentInput) {
    return [
      {
        role: "system" as const,
        content: agentSystemPrompt(
          this.agentName,
          "你是 Intent Agent。只输出 JSON，识别用户在 AI 产品工作台中的意图。纯问候、寒暄、致谢或确认在线状态的短消息必须识别为 general_question，不要识别为 new_requirement；如果问候后面包含具体产品、页面、PRD、原型或修改诉求，再按真实诉求识别。",
        ),
      },
      {
        role: "user" as const,
        content: JSON.stringify(input),
      },
    ];
  }

  protected fallback(input: IntentInput): IntentResult {
    const text = input.userInput.trim();
    const lower = text.toLowerCase();
    const hasSelection = Boolean(input.selectedRegion);
    let intent: UserIntent = UserIntent.new_requirement;

    if (isCasualGeneralInput(text)) intent = UserIntent.general_question;
    else if (/导出.*word|word|docx/i.test(text)) intent = UserIntent.export_word;
    else if (/导出.*html|html|原型包/i.test(text)) intent = UserIntent.export_html;
    else if (/生成|输出|写/.test(text) && /prd|需求文档|文档/i.test(text)) intent = UserIntent.generate_prd;
    else if (/生成|做|输出/.test(text) && /原型|html|页面/i.test(text)) intent = UserIntent.generate_prototype;
    else if (hasSelection && input.selectedRegion?.type === "prototype") intent = UserIntent.patch_prototype;
    else if (hasSelection && input.selectedRegion?.type === "document") intent = UserIntent.patch_document;
    else if (/改|调整|替换|优化|补充/.test(text) && input.previewMode === "prototype") {
      intent = UserIntent.patch_prototype;
    } else if (/改|调整|替换|优化|补充/.test(text) && input.previewMode === "prd") {
      intent = UserIntent.patch_document;
    } else if (/确认|选择|按|就用|采用|回答/.test(text) && input.recentMessages.length > 1) {
      intent = UserIntent.clarification_answer;
    } else if (/知识|规则|沉淀/.test(text)) intent = UserIntent.knowledge_update;
    else if (/吗|怎么|为什么|是什么|\?$/.test(lower)) intent = UserIntent.general_question;

    return {
      intent,
      confidence: intent === UserIntent.new_requirement ? 0.82 : 0.9,
      reason: this.reasonFor(intent, hasSelection),
      requiresSelection: intent === UserIntent.patch_document || intent === UserIntent.patch_prototype,
      isAmbiguous: false,
    };
  }

  protected normalize(output: IntentResult, input: IntentInput): IntentResult {
    if (isCasualGeneralInput(input.userInput)) return this.fallback(input);
    if (!Object.values(UserIntent).includes(output.intent)) return this.fallback(input);
    return {
      intent: output.intent,
      confidence: Number(output.confidence ?? 0.7),
      reason: output.reason || this.reasonFor(output.intent, Boolean(input.selectedRegion)),
      requiresSelection: Boolean(output.requiresSelection),
      isAmbiguous: Boolean(output.isAmbiguous),
    };
  }

  protected jsonSchema() {
    return {
      intent: Object.values(UserIntent),
      confidence: "0-1",
      reason: "string",
      requiresSelection: "boolean",
      isAmbiguous: "boolean",
    };
  }

  private reasonFor(intent: UserIntent, hasSelection: boolean) {
    if (intent === UserIntent.patch_prototype) return "用户正在对原型进行局部修改。";
    if (intent === UserIntent.patch_document) return "用户正在对 PRD 文档进行局部修改。";
    if (intent === UserIntent.generate_prd) return "用户希望生成或刷新 PRD。";
    if (intent === UserIntent.generate_prototype) return "用户希望生成或刷新原型。";
    if (intent === UserIntent.clarification_answer) return "用户正在回答上一轮澄清问题。";
    if (intent === UserIntent.general_question) return "用户只是问候、闲聊或提出一般问题，不应触发需求生成链路。";
    if (hasSelection) return "用户带有选区信息，需要结合选区理解。";
    return "用户正在发起新的产品需求。";
  }
}
