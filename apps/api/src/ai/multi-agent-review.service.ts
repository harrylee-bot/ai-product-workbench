import { Injectable, NotFoundException } from "@nestjs/common";
import { ModelTaskType } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { PrismaService } from "../prisma/prisma.service";
import { ProductDesignStateService } from "./product-design-state.service";
import {
  arrayOfText,
  assertOwnerMutation,
  assertProjectAccess,
  json,
  normalizeIssueType,
  normalizeSeverity,
  stateSummary,
  text,
} from "./product-evolution.helpers";
import type {
  ProductInsightItem,
  ProductReviewAgentName,
  ProductReviewAgentOutput,
  ProductReviewReportItem,
} from "./product-evolution.types";

type ProductInsightRow = {
  id: string;
  projectId: string;
  issueType: string;
  severity: string;
  affectedArea: unknown;
  rootCause: string;
  suggestion: string;
  sourceEvents: unknown;
  generatedBy: string;
  createdAt: Date;
};

type ProductReviewReportRow = {
  id: string;
  projectId: string;
  issues: unknown;
  conflicts: unknown;
  improvements: unknown;
  consensusScore: number;
  agentOutputs: unknown;
  generatedBy: string;
  createdAt: Date;
};

type ReviewModelOutput = {
  issues?: unknown[];
  conflicts?: string[];
  improvements?: string[];
  consensusScore?: number;
  agentOutputs?: Partial<Record<ProductReviewAgentName, ProductReviewAgentOutput>>;
};

const AGENTS: ProductReviewAgentName[] = ["ux", "business", "risk", "clarity", "growth"];

@Injectable()
export class MultiAgentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    private readonly modelGateway: ModelGatewayService,
  ) {}

  async runForUser(user: AuthenticatedUser, input: { projectId: string }) {
    const project = await assertProjectAccess(this.prisma, user, input.projectId);
    assertOwnerMutation(user, project.ownerId, "管理员不可直接运行用户项目评审");
    const state = await this.stateService.getCurrentState(input.projectId);
    if (!state) throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    const insights = await this.loadInsights(input.projectId);
    if (!insights.length) throw new NotFoundException("PRODUCT_INSIGHTS_NOT_FOUND");

    const modelReport = await this.tryRunModel(input.projectId, state, insights);
    const agentOutputs = normalizeAgentOutputs(modelReport?.agentOutputs, insights);
    const issues = normalizeIssues(modelReport?.issues, agentOutputs);
    const conflicts = normalizeConflicts(modelReport?.conflicts, agentOutputs);
    const improvements = normalizeImprovements(modelReport?.improvements, agentOutputs);
    const consensusScore =
      typeof modelReport?.consensusScore === "number"
        ? clamp(modelReport.consensusScore, 0, 1)
        : calculateConsensusScore(conflicts, agentOutputs);

    const created = await this.prisma.productReviewReport.create({
      data: {
        projectId: input.projectId,
        issues: json(issues)!,
        conflicts: json(conflicts)!,
        improvements: json(improvements)!,
        consensusScore,
        agentOutputs: json(agentOutputs)!,
        generatedBy: user.id,
      },
    });

    return {
      reviewReport: this.toItem(created as ProductReviewReportRow),
      input: {
        productDesignState: stateSummary(state),
        insights,
      },
    };
  }

  async getLatestForUser(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const report = await this.prisma.productReviewReport.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return { reviewReport: report ? this.toItem(report as ProductReviewReportRow) : null };
  }

  toItem(row: ProductReviewReportRow): ProductReviewReportItem {
    return {
      id: row.id,
      projectId: row.projectId,
      issues: normalizeIssues(row.issues),
      conflicts: arrayOfText(row.conflicts),
      improvements: arrayOfText(row.improvements),
      consensusScore: row.consensusScore,
      agentOutputs: normalizeAgentOutputs(row.agentOutputs),
      generatedBy: row.generatedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async loadInsights(projectId: string): Promise<ProductInsightItem[]> {
    const rows = await this.prisma.productInsight.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      issueType: normalizeIssueType(row.issueType),
      severity: normalizeSeverity(row.severity),
      affectedArea: arrayOfText(row.affectedArea),
      rootCause: row.rootCause,
      suggestion: row.suggestion,
      sourceEvents: arrayOfText(row.sourceEvents),
      generatedBy: row.generatedBy,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async tryRunModel(projectId: string, state: unknown, insights: ProductInsightItem[]) {
    try {
      const result = await this.modelGateway.generateJson<ReviewModelOutput>({
        taskType: ModelTaskType.general_chat,
        agentName: "multi_agent_review_system",
        messages: [
          {
            role: "system",
            content: [
              "你是多 Agent 产品评审系统，只能读取 ProductDesignState 和 ProductInsight。",
              "必须模拟 UX/Business/Risk/Clarity/Growth 五个 Agent 独立评审并聚合。",
              "禁止输出 Patch，禁止修改 State，只输出结构化 JSON。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              projectId,
              productDesignState: state,
              productInsights: insights,
            }),
          },
        ],
      });
      return result.data;
    } catch {
      return null;
    }
  }
}

function normalizeAgentOutputs(
  value: unknown,
  insights: ProductInsightItem[] = [],
): Record<ProductReviewAgentName, ProductReviewAgentOutput> {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<ProductReviewAgentName, ProductReviewAgentOutput>>
    : {};
  return Object.fromEntries(
    AGENTS.map((agent) => {
      const output = record[agent];
      return [
        agent,
        {
          agent,
          issues: normalizeIssues(output?.issues, undefined, agent),
          improvements: Array.isArray(output?.improvements) && output.improvements.length
            ? output.improvements.map(String)
            : fallbackImprovements(agent, insights),
          confidence: typeof output?.confidence === "number" ? clamp(output.confidence, 0, 1) : 0.72,
        },
      ];
    }),
  ) as Record<ProductReviewAgentName, ProductReviewAgentOutput>;
}

function normalizeIssues(
  value: unknown,
  agentOutputs?: Record<ProductReviewAgentName, ProductReviewAgentOutput>,
  fallbackAgent?: ProductReviewAgentName,
) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const issue = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : { title: String(item) };
      return [
        {
          title: text(issue.title, fallbackAgent ? `${agentLabel(fallbackAgent)} 评审问题 ${index + 1}` : `评审问题 ${index + 1}`),
          issueType: normalizeIssueType(issue.issueType),
          severity: normalizeSeverity(issue.severity),
          affectedArea: arrayOfText(issue.affectedArea),
          reason: text(issue.reason, text(issue.rootCause, "基于 ProductInsight 聚合得出的产品问题。")),
        },
      ];
    });
  }
  if (agentOutputs) return Object.values(agentOutputs).flatMap((output) => output.issues);
  return [];
}

function normalizeConflicts(value: unknown, agentOutputs: Record<ProductReviewAgentName, ProductReviewAgentOutput>) {
  const conflicts = arrayOfText(value);
  if (conflicts.length) return conflicts;
  const highCount = Object.values(agentOutputs).flatMap((output) => output.issues).filter((issue) => issue.severity === "high").length;
  return highCount > 2 ? ["多个 Agent 对问题严重度给出高优先级，需优先确认影响范围。"] : [];
}

function normalizeImprovements(value: unknown, agentOutputs: Record<ProductReviewAgentName, ProductReviewAgentOutput>) {
  const improvements = arrayOfText(value);
  if (improvements.length) return improvements;
  return [...new Set(Object.values(agentOutputs).flatMap((output) => output.improvements))].slice(0, 10);
}

function fallbackImprovements(agent: ProductReviewAgentName, insights: ProductInsightItem[]) {
  const first = insights[0];
  const area = first?.affectedArea?.[0] ?? "核心流程";
  const map: Record<ProductReviewAgentName, string> = {
    ux: `降低 ${area} 的理解成本，补充更明确的操作反馈。`,
    business: `让 ${area} 与业务目标和转化动作保持一致。`,
    risk: `补齐 ${area} 的异常、禁用和误操作保护。`,
    clarity: `让 PRD 中 ${area} 的规则、边界和来源路径更清晰。`,
    growth: `围绕 ${area} 增加更顺畅的下一步引导。`,
  };
  return [map[agent]];
}

function calculateConsensusScore(conflicts: string[], agentOutputs: Record<ProductReviewAgentName, ProductReviewAgentOutput>) {
  const confidenceAverage =
    Object.values(agentOutputs).reduce((sum, output) => sum + output.confidence, 0) / AGENTS.length;
  return clamp(confidenceAverage - conflicts.length * 0.08, 0.3, 0.98);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function agentLabel(agent: ProductReviewAgentName) {
  const labels: Record<ProductReviewAgentName, string> = {
    ux: "UX",
    business: "Business",
    risk: "Risk",
    clarity: "Clarity",
    growth: "Growth",
  };
  return labels[agent];
}
