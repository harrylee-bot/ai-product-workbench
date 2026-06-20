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
  assertStateOnlyPatchOperations,
  json,
  normalizeIssueType,
  normalizePriority,
  normalizeSeverity,
  text,
} from "./product-evolution.helpers";
import type {
  EvolutionPatchOperation,
  EvolutionPlanItem,
  EvolutionPriority,
  ProductInsightItem,
  ProductReviewReportItem,
} from "./product-evolution.types";

type EvolutionPlanRow = {
  id: string;
  projectId: string;
  reason: string;
  priority: string;
  patchOperations: unknown;
  prdChanges: unknown;
  prototypeChanges: unknown;
  impactedAreas: unknown;
  sourceInsightIds: unknown;
  sourceReviewId: string | null;
  generatedBy: string;
  executedAt: Date | null;
  createdAt: Date;
};

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

type EvolutionModelOutput = {
  reason?: string;
  priority?: string;
  patchOperations?: unknown[];
  prdChanges?: unknown[];
  prototypeChanges?: unknown[];
  impactedAreas?: unknown;
};

@Injectable()
export class EvolutionEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    private readonly modelGateway: ModelGatewayService,
  ) {}

  async runForUser(user: AuthenticatedUser, input: { projectId: string }) {
    const project = await assertProjectAccess(this.prisma, user, input.projectId);
    assertOwnerMutation(user, project.ownerId, "管理员不可直接运行用户项目进化方案");
    const state = await this.stateService.getCurrentState(input.projectId);
    if (!state) throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    const insights = await this.loadInsights(input.projectId);
    if (!insights.length) throw new NotFoundException("PRODUCT_INSIGHTS_NOT_FOUND");
    const review = await this.loadLatestReview(input.projectId);
    if (!review) throw new NotFoundException("PRODUCT_REVIEW_REPORT_NOT_FOUND");

    const modelPlan = await this.tryRunModel(input.projectId, state, insights, review);
    const patchOperations = normalizeEvolutionPatchOperations(modelPlan?.patchOperations, insights);
    assertStateOnlyPatchOperations(patchOperations);
    const priority = modelPlan?.priority
      ? normalizePriority(modelPlan.priority)
      : inferPriority(insights);
    const impactedAreas = arrayOfText(modelPlan?.impactedAreas).length
      ? arrayOfText(modelPlan?.impactedAreas)
      : [...new Set(insights.flatMap((insight) => insight.affectedArea))].slice(0, 8);

    const created = await this.prisma.evolutionPlan.create({
      data: {
        projectId: input.projectId,
        reason: text(modelPlan?.reason, `基于 ${insights.length} 条 ProductInsight 与最近一次多 Agent 评审生成进化方案。`),
        priority,
        patchOperations: json(patchOperations)!,
        prdChanges: json(modelPlan?.prdChanges ?? impactedAreas.map((area) => ({ area, change: "PRD 将由 State 重新生成" })))!,
        prototypeChanges: json(modelPlan?.prototypeChanges ?? impactedAreas.map((area) => ({ area, change: "Prototype 将由 State 重新渲染" })))!,
        impactedAreas: json(impactedAreas)!,
        sourceInsightIds: json(insights.map((insight) => insight.id))!,
        sourceReviewId: review.id,
        generatedBy: user.id,
      },
    });

    return {
      evolutionPlan: this.toItem(created as EvolutionPlanRow),
      input: {
        insightCount: insights.length,
        reviewReportId: review.id,
        stateVersion: state.version,
      },
    };
  }

  async getLatestForUser(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const plan = await this.prisma.evolutionPlan.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    return { evolutionPlan: plan ? this.toItem(plan as EvolutionPlanRow) : null };
  }

  toItem(row: EvolutionPlanRow): EvolutionPlanItem {
    return {
      id: row.id,
      projectId: row.projectId,
      reason: row.reason,
      priority: normalizePriority(row.priority),
      patchOperations: normalizeEvolutionPatchOperations(row.patchOperations),
      prdChanges: Array.isArray(row.prdChanges) ? row.prdChanges : [],
      prototypeChanges: Array.isArray(row.prototypeChanges) ? row.prototypeChanges : [],
      impactedAreas: arrayOfText(row.impactedAreas),
      sourceInsightIds: arrayOfText(row.sourceInsightIds),
      sourceReviewId: row.sourceReviewId ?? undefined,
      generatedBy: row.generatedBy,
      executedAt: row.executedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async loadInsights(projectId: string): Promise<ProductInsightItem[]> {
    const rows = await this.prisma.productInsight.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((row: ProductInsightRow) => ({
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

  private async loadLatestReview(projectId: string): Promise<ProductReviewReportItem | null> {
    const row = await this.prisma.productReviewReport.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      issues: Array.isArray((row as ProductReviewReportRow).issues)
        ? (row as ProductReviewReportRow).issues as ProductReviewReportItem["issues"]
        : [],
      conflicts: arrayOfText(row.conflicts),
      improvements: arrayOfText(row.improvements),
      consensusScore: row.consensusScore,
      agentOutputs: (row as ProductReviewReportRow).agentOutputs as ProductReviewReportItem["agentOutputs"],
      generatedBy: row.generatedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async tryRunModel(projectId: string, state: unknown, insights: ProductInsightItem[], review: ProductReviewReportItem) {
    try {
      const result = await this.modelGateway.generateJson<EvolutionModelOutput>({
        taskType: ModelTaskType.general_chat,
        agentName: "evolution_engine",
        messages: [
          {
            role: "system",
            content: [
              "你是 Product Evolution Engine，只能生成 EvolutionPlan，不得执行修改。",
              "PatchOperation 只能修改 ProductDesignState，字段为 type/add|update|delete、targetPath、value、reason。",
              "禁止直接修改 PRD、Prototype、HTML 或 QA。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              projectId,
              productDesignState: state,
              productInsights: insights,
              productReviewReport: review,
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

function normalizeEvolutionPatchOperations(value: unknown, insights: ProductInsightItem[] = []): EvolutionPatchOperation[] {
  if (Array.isArray(value)) {
    const operations = value.flatMap((item): EvolutionPatchOperation[] => {
      const record = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null;
      if (!record) return [];
      const type = record.type === "delete" ? "delete" : record.type === "update" ? "update" : "add";
      const targetPath = text(record.targetPath ?? record.path);
      if (!targetPath) return [];
      return [{
        type,
        targetPath,
        value: record.value,
        reason: text(record.reason, "EvolutionPlan 生成的 ProductDesignState 修改"),
      }];
    });
    if (operations.length) return operations;
  }

  const primary = insights[0];
  const issueType = primary?.issueType ?? "ux";
  const targetPath = issueType === "logic"
    ? "businessRules"
    : issueType === "flow"
      ? "userScenarios"
      : issueType === "content"
        ? "frontendRules"
        : "acceptanceCriteria";
  return [
    {
      type: "add",
      targetPath,
      value: {
        title: `基于反馈优化 ${targetPath}`,
        description: primary?.suggestion ?? "根据用户显式反馈优化产品设计状态。",
        source: { type: "user_input", confidence: 1 },
        relatedInsightId: primary?.id,
      },
      reason: primary?.rootCause ?? "用户反馈触发产品进化方案。",
    },
  ];
}

function inferPriority(insights: ProductInsightItem[]): EvolutionPriority {
  if (insights.some((insight) => insight.severity === "high")) return "high";
  if (insights.some((insight) => insight.severity === "medium")) return "medium";
  return "low";
}
