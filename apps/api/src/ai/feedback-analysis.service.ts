import { Injectable, NotFoundException } from "@nestjs/common";
import { ModelTaskType } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ModelGatewayService } from "../model-gateway/model-gateway.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  arrayOfText,
  assertOwnerMutation,
  assertProjectAccess,
  interactionContentSummary,
  json,
  normalizeIssueType,
  normalizeSeverity,
  text,
} from "./product-evolution.helpers";
import type {
  InsightIssueType,
  InsightSeverity,
  ProductInsightItem,
  ProductInteractionEventItem,
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

type ProductInteractionEventRow = {
  id: string;
  projectId: string;
  type: string;
  targetType: string;
  targetId: string | null;
  content: string | null;
  metadata: unknown;
  createdBy: string;
  createdAt: Date;
};

type AnalyzerOutput = {
  insights?: Array<{
    issueType?: string;
    severity?: string;
    affectedArea?: unknown;
    rootCause?: string;
    suggestion?: string;
    sourceEvents?: unknown;
  }>;
};

@Injectable()
export class FeedbackAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly modelGateway: ModelGatewayService,
  ) {}

  async analyzeForUser(user: AuthenticatedUser, input: { projectId: string; eventIds?: string[] }) {
    const project = await assertProjectAccess(this.prisma, user, input.projectId);
    assertOwnerMutation(user, project.ownerId, "管理员不可直接分析用户项目反馈");

    const rows = await this.prisma.productInteractionEvent.findMany({
      where: {
        projectId: input.projectId,
        ...(input.eventIds?.length ? { id: { in: input.eventIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    if (!rows.length) throw new NotFoundException("INTERACTION_EVENTS_NOT_FOUND");
    const events = rows.map((row) => this.toEventItem(row as ProductInteractionEventRow));

    const modelInsights = await this.tryAnalyzeWithModel(input.projectId, events);
    const normalized = (modelInsights.length ? modelInsights : fallbackInsights(events))
      .map((insight) => ({
        issueType: normalizeIssueType(insight.issueType),
        severity: normalizeSeverity(insight.severity),
        affectedArea: arrayOfText(insight.affectedArea).length
          ? arrayOfText(insight.affectedArea)
          : inferAffectedArea(events),
        rootCause: text(insight.rootCause, "用户显式反馈指出当前设计存在可理解或流程问题。"),
        suggestion: text(insight.suggestion, "将反馈沉淀为 ProductDesignState Patch 候选。"),
        sourceEvents: arrayOfText(insight.sourceEvents).length
          ? arrayOfText(insight.sourceEvents)
          : events.map((event) => event.id),
      }));

    const created = await this.prisma.$transaction(
      normalized.map((insight) =>
        this.prisma.productInsight.create({
          data: {
            projectId: input.projectId,
            issueType: insight.issueType,
            severity: insight.severity,
            affectedArea: json(insight.affectedArea)!,
            rootCause: insight.rootCause,
            suggestion: insight.suggestion,
            sourceEvents: json(insight.sourceEvents)!,
            generatedBy: user.id,
          },
        }),
      ),
    );

    return {
      items: created.map((item) => this.toInsightItem(item as ProductInsightRow)),
      sourceEvents: events,
    };
  }

  async listForProject(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const items = await this.prisma.productInsight.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: items.map((item) => this.toInsightItem(item as ProductInsightRow)),
      total: items.length,
    };
  }

  toInsightItem(row: ProductInsightRow): ProductInsightItem {
    return {
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
    };
  }

  private toEventItem(row: ProductInteractionEventRow): ProductInteractionEventItem {
    return {
      id: row.id,
      projectId: row.projectId,
      type: row.type as ProductInteractionEventItem["type"],
      targetType: row.targetType as ProductInteractionEventItem["targetType"],
      targetId: row.targetId ?? undefined,
      content: row.content ?? undefined,
      metadata: row.metadata ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async tryAnalyzeWithModel(projectId: string, events: ProductInteractionEventItem[]) {
    try {
      const result = await this.modelGateway.generateJson<AnalyzerOutput>({
        taskType: ModelTaskType.general_chat,
        agentName: "semantic_feedback_analyzer",
        messages: [
          {
            role: "system",
            content: [
              "你是 Product Feedback Analyzer，只能消费用户显式反馈事件，不做点击流、漏斗或行为统计分析。",
              "请输出 JSON：{ insights: [{ issueType, severity, affectedArea, rootCause, suggestion, sourceEvents }] }。",
              "issueType 只能是 ux/logic/flow/content，severity 只能是 low/medium/high。",
            ].join("\n"),
          },
          {
            role: "user",
            content: `projectId: ${projectId}\nInteraction Events:\n${interactionContentSummary(events)}`,
          },
        ],
        jsonSchema: {
          insights: [
            {
              issueType: "ux|logic|flow|content",
              severity: "low|medium|high",
              affectedArea: ["string"],
              rootCause: "string",
              suggestion: "string",
              sourceEvents: ["eventId"],
            },
          ],
        },
      });
      return Array.isArray(result.data?.insights) ? result.data.insights : [];
    } catch {
      return [];
    }
  }
}

function fallbackInsights(events: ProductInteractionEventItem[]) {
  const combined = events.map((event) => `${event.content ?? ""} ${JSON.stringify(event.metadata ?? {})}`).join(" ");
  const issueType: InsightIssueType = /流程|卡住|无法|继续|跳转|步骤/.test(combined)
    ? "flow"
    : /逻辑|冲突|规则|条件|状态/.test(combined)
      ? "logic"
      : /文案|信息|描述|标题|内容/.test(combined)
        ? "content"
        : "ux";
  const severity: InsightSeverity = /失败|无法|错误|阻塞|严重/.test(combined)
    ? "high"
    : /不清晰|复杂|困惑|缺少|建议/.test(combined)
      ? "medium"
      : "low";

  return [
    {
      issueType,
      severity,
      affectedArea: inferAffectedArea(events),
      rootCause: combined.slice(0, 180) || "用户提交了显式反馈，需要进一步产品化处理。",
      suggestion: suggestionByType(issueType),
      sourceEvents: events.map((event) => event.id),
    },
  ];
}

function inferAffectedArea(events: ProductInteractionEventItem[]) {
  const areas = events.flatMap((event) => [
    event.targetType,
    event.targetId,
    event.type,
  ]).filter((value): value is string => Boolean(value));
  return [...new Set(areas)].slice(0, 8);
}

function suggestionByType(type: InsightIssueType) {
  if (type === "flow") return "检查 ProductDesignState 中页面、流程和交互状态，补充可继续路径。";
  if (type === "logic") return "检查 ProductDesignState 中业务规则和状态规则，消除冲突条件。";
  if (type === "content") return "更新 ProductDesignState 中页面说明、文案规则或验收标准。";
  return "降低交互理解成本，优化页面结构、说明和关键操作表达。";
}
