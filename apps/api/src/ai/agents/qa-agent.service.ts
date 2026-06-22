import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import { agentSystemPrompt } from "../agent-charter";
import type {
  KnowledgeContext,
  PatchPlan,
  ProductDesignState,
  PrototypeSpec,
  QAAgentOutput,
  QAIssue,
  RequirementDocument,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type QaAgentInput = {
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  patchPlan?: PatchPlan;
  knowledgeContext?: KnowledgeContext;
};

@Injectable()
export class QaAgentService extends BaseAgentService<QaAgentInput, QAAgentOutput> {
  readonly agentName = AgentName.qa_agent;
  readonly taskType = ModelTaskType.qa_check;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: QaAgentInput) {
    return [
      {
        role: "system" as const,
        content: agentSystemPrompt(
          this.agentName,
          "你是 QA Agent。校验 ProductDesignState、PRD、PrototypeSpec、HTML 原型和知识库规则一致性。只能输出 QAAgentOutput JSON，不得重写 PRD、HTML 或 ProductDesignState。issue 必须包含 id、checkType、severity、title、description、status；severity 只能是 blocking、major、minor、info；checkType 只能是 state_schema、prd_completeness、prototype_completeness、state_prd_consistency、state_prototype_consistency、prd_prototype_consistency、knowledge_rule_compliance、assumption_risk、patch_regression。",
        ),
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: QaAgentInput): QAAgentOutput {
    const issues: QAIssue[] = [];
    if (!input.productDesignState.stateRules.length) {
      issues.push({
        id: "qa_agent_missing_state_rules",
        checkType: "state_schema",
        severity: "major",
        title: "缺少状态规则",
        description: "ProductDesignState 缺少状态规则，可能导致 PRD 与原型无法表达关键状态。",
        relatedStatePaths: ["stateRules"],
        suggestion: "补齐关键状态、状态触发条件和用户可见反馈。",
        autoFixable: false,
        status: "open",
      });
    }
    if (!input.productDesignState.exceptionScenarios.length) {
      issues.push({
        id: "qa_agent_missing_exceptions",
        checkType: "state_schema",
        severity: "minor",
        title: "缺少异常场景",
        description: "ProductDesignState 缺少异常场景，评审时可能遗漏失败态和兜底反馈。",
        relatedStatePaths: ["exceptionScenarios"],
        suggestion: "补充至少一个异常场景及对应用户提示。",
        autoFixable: false,
        status: "open",
      });
    }
    if (input.prdDocument && input.prototypeSpec) {
      const prdPageText = JSON.stringify(input.prdDocument.sections);
      const prototypePageName = String(input.prototypeSpec.pages[0]?.name ?? "");
      if (prototypePageName && !prdPageText.includes(prototypePageName)) {
        issues.push({
          id: "qa_agent_prd_prototype_name_mismatch",
          checkType: "prd_prototype_consistency",
          severity: "minor",
          title: "PRD 与原型页面命名不一致",
          description: "PRD 未明确出现原型主页面名称，建议确认页面命名一致。",
          relatedPrdSectionIds: input.prdDocument.sections.map((section) => section.id).slice(0, 3),
          relatedPrototypePageIds: input.prototypeSpec.pages[0]?.id ? [input.prototypeSpec.pages[0].id] : [],
          suggestion: "统一 PRD 页面章节和原型页面名称。",
          autoFixable: false,
          status: "open",
        });
      }
    }
    for (const rule of input.knowledgeContext?.strongRules ?? []) {
      const text = `${JSON.stringify(input.productDesignState)} ${JSON.stringify(input.prdDocument ?? {})} ${JSON.stringify(input.prototypeSpec ?? {})}`;
      if (rule.content && !text.includes(rule.content.slice(0, 12))) {
        issues.push({
          id: `qa_agent_strong_rule_${rule.knowledgeId ?? rule.id}`,
          checkType: "knowledge_rule_compliance",
          severity: "major",
          title: `强规则待确认：${rule.title}`,
          description: "知识库 strong_rule 未在当前 ProductDesignState/PRD/PrototypeSpec 中明确体现。",
          relatedKnowledgeIds: [rule.knowledgeId ?? rule.id],
          suggestion: "将该强规则补入 ProductDesignState 的 businessRules、stateRules 或 acceptanceCriteria。",
          autoFixable: false,
          status: "open",
        });
      }
    }

    return {
      status: issues.some((issue) => issue.severity === "blocking" || issue.severity === "major")
        ? "failed"
        : issues.length
          ? "warning"
          : "passed",
      summary: issues.length ? `QA Agent 发现 ${issues.length} 个风险点。` : "QA Agent 未发现明显一致性风险。",
      issues,
    };
  }

  protected normalize(output: QAAgentOutput, input: QaAgentInput): QAAgentOutput {
    const fallback = this.fallback(input);
    const rawIssues = Array.isArray(output.issues) ? output.issues : [];
    const issues = rawIssues
      .map((issue, index) => normalizeIssue(issue, index))
      .filter((issue): issue is QAIssue => Boolean(issue));
    const normalizedIssues = issues.length ? issues : fallback.issues;
    return {
      status: normalizeStatus(output.status, normalizedIssues),
      summary: text(output.summary) || fallback.summary,
      issues: normalizedIssues,
    };
  }
}

function normalizeIssue(value: unknown, index: number): QAIssue | null {
  const issue = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<QAIssue> & Record<string, unknown>
    : null;
  if (!issue) return null;
  const checkType = normalizeCheckType(issue.checkType);
  const severity = normalizeSeverity(issue.severity);
  const title = text(issue.title);
  const description = text(issue.description);
  if (!checkType || !severity || !title || !description) return null;
  return {
    id: text(issue.id) || `qa_agent_issue_${index + 1}`,
    checkType,
    severity,
    title,
    description,
    relatedStatePaths: arrayOfText(issue.relatedStatePaths),
    relatedPrdSectionIds: arrayOfText(issue.relatedPrdSectionIds),
    relatedPrototypePageIds: arrayOfText(issue.relatedPrototypePageIds),
    relatedPrototypeComponentIds: arrayOfText(issue.relatedPrototypeComponentIds),
    relatedKnowledgeIds: arrayOfText(issue.relatedKnowledgeIds),
    suggestion: text(issue.suggestion) || undefined,
    autoFixable: typeof issue.autoFixable === "boolean" ? issue.autoFixable : false,
    status: issue.status === "resolved" || issue.status === "ignored" ? issue.status : "open",
  };
}

function normalizeStatus(status: unknown, issues: QAIssue[]): QAAgentOutput["status"] {
  if (status === "running" || status === "passed" || status === "failed" || status === "warning") return status;
  if (issues.some((issue) => issue.severity === "blocking" || issue.severity === "major")) return "failed";
  if (issues.length) return "warning";
  return "passed";
}

function normalizeCheckType(value: unknown): QAIssue["checkType"] | null {
  const allowed = [
    "state_schema",
    "prd_completeness",
    "prototype_completeness",
    "state_prd_consistency",
    "state_prototype_consistency",
    "prd_prototype_consistency",
    "knowledge_rule_compliance",
    "assumption_risk",
    "patch_regression",
  ] as const;
  return allowed.find((item) => item === value) ?? null;
}

function normalizeSeverity(value: unknown): QAIssue["severity"] | null {
  const allowed = ["blocking", "major", "minor", "info"] as const;
  return allowed.find((item) => item === value) ?? null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : undefined;
}
