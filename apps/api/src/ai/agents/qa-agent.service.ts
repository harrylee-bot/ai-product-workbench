import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type {
  KnowledgeContext,
  PatchPlan,
  ProductDesignState,
  PrototypeSpec,
  QAReport,
  RequirementDocumentDraft,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type QaAgentInput = {
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocumentDraft;
  prototypeSpec?: PrototypeSpec;
  patchPlan?: PatchPlan;
  knowledgeContext?: KnowledgeContext;
};

@Injectable()
export class QaAgentService extends BaseAgentService<QaAgentInput, QAReport> {
  readonly agentName = AgentName.qa_agent;
  readonly taskType = ModelTaskType.qa_check;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: QaAgentInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 QA Agent。校验 ProductDesignState、PRD、PrototypeSpec 一致性，只输出 QAReport JSON。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: QaAgentInput): QAReport {
    const issues: QAReport["issues"] = [];
    if (!input.productDesignState.stateRules.length) {
      issues.push({
        level: "error",
        type: "missing_state",
        message: "ProductDesignState 缺少状态规则。",
        targetPath: "stateRules",
      });
    }
    if (!input.productDesignState.exceptionScenarios.length) {
      issues.push({
        level: "warning",
        type: "missing_exception",
        message: "ProductDesignState 缺少异常场景。",
        targetPath: "exceptionScenarios",
      });
    }
    if (input.prdDocument && input.prototypeSpec) {
      const prdPageText = JSON.stringify(input.prdDocument.sections);
      const prototypePageName = String(input.prototypeSpec.pages[0]?.name ?? "");
      if (prototypePageName && !prdPageText.includes(prototypePageName)) {
        issues.push({
          level: "warning",
          type: "prd_prototype_mismatch",
          message: "PRD 未明确出现原型主页面名称，建议确认页面命名一致。",
          targetPath: "prdDocument.sections",
        });
      }
    }
    if (!input.productDesignState.assumptions.length) {
      issues.push({
        level: "info",
        type: "unmarked_assumption",
        message: "未看到 AI 推断说明，若知识库不足应补充 assumptions。",
        targetPath: "assumptions",
      });
    }

    return {
      passed: !issues.some((issue) => issue.level === "error"),
      issues,
      suggestions: issues.length
        ? ["补齐缺失状态、异常场景，并确保 PRD 与原型页面命名一致。"]
        : ["QA 基础一致性检查通过。"],
      autoFixable: issues.every((issue) => issue.level !== "error"),
    };
  }
}
