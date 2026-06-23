import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AgentName,
  KnowledgeType,
  Prisma,
  ProjectStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  QAReportStatus as PrismaQAReportStatus,
  QAReportTrigger as PrismaQAReportTrigger,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeRetrievalService } from "../knowledge/knowledge-retrieval.service";
import { PrismaService } from "../prisma/prisma.service";
import type { AgentFallbackLevel, AgentFallbackMetadata } from "./agent-fallback-policy";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  KnowledgeContext,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QAGateAction,
  QAGateDecision,
  QACheckType,
  QAIssue,
  QAReport,
  QAReportStatus,
  QAReportTrigger,
  RequirementDocument,
} from "./ai-vibe.types";
import { QaAgentService } from "./agents/qa-agent.service";
import { evaluateQaGate, isQaGateActionAllowed } from "./qa-gate.helpers";
import { DEFAULT_CHECK_TYPES, QaRuleCheckService } from "./qa-rule-check.service";
import { projectStatusAfterQa } from "./workspace-state-machine";

type RunQaOptions = {
  trigger: QAReportTrigger;
  checkTypes?: QACheckType[];
  runId?: string;
  traceId?: string;
  relatedPatchId?: string;
  relatedRollbackId?: string;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  prototypeArtifact?: PrototypeArtifact;
  fallbacks?: AgentFallbackMetadata[];
};

type ProductDesignStateRecord = {
  id: string;
  projectId: string;
  version: number;
  title: string;
  summary: string | null;
  businessGoal: string;
  background: string | null;
  targetUsers: unknown;
  userScenarios: unknown;
  pages: unknown;
  features: unknown;
  backendConfigs: unknown;
  frontendRules: unknown;
  businessRules: unknown;
  stateRules: unknown;
  exceptionScenarios: unknown;
  acceptanceCriteria: unknown;
  prototypeOutline: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  pendingQuestions: unknown;
  confirmedFacts: unknown;
  prototypeSpec: unknown;
  prdDocument: unknown;
  status: string;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RequirementDocumentRecord = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: string;
  sections: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  pendingQuestions: unknown;
  validationNotes: unknown;
  generatedByRunId: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PrototypeSpecRecord = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  targetDevice: PrototypeTargetDevice;
  styleGuide: unknown;
  pages: unknown;
  navigation: unknown;
  interactions: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  generatedByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PrototypeArtifactRecord = {
  id: string;
  projectId: string;
  prototypeSpecId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: PrototypeArtifactStatus;
  htmlContent: string | null;
  entryFilePath: string | null;
  previewUrl: string | null;
  targetDevice: PrototypeTargetDevice;
  pageCount: number;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type QAReportRecord = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  prdDocumentId: string | null;
  prototypeArtifactId: string | null;
  prototypeSpecId: string | null;
  status: PrismaQAReportStatus;
  trigger: PrismaQAReportTrigger;
  checkTypes: unknown;
  summary: string;
  issues: unknown;
  blockingCount: number;
  majorCount: number;
  minorCount: number;
  infoCount: number;
  generatedByRunId: string | null;
  relatedPatchId: string | null;
  relatedRollbackId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class QaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleCheck: QaRuleCheckService,
    private readonly qaAgent: QaAgentService,
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
  ) {}

  async runForUser(user: AuthenticatedUser, projectId: string, input: { checkTypes?: QACheckType[] }) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    const qaReport = await this.runForProject(projectId, user.id, {
      trigger: "manual",
      checkTypes: input.checkTypes,
      traceId: `manual-qa-${Date.now()}`,
    });
    return { qaReport, qaGate: qaReport.gate };
  }

  async runForProject(projectId: string, userId: string, options: RunQaOptions): Promise<QAReport> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }

    const state = await this.getCurrentState(projectId);
    const prdDocument = options.prdDocument
      ?? state?.prdDocument
      ?? await this.getCurrentPrdForState(projectId, project.currentPrdDocumentId, state);
    const currentArtifact = options.prototypeArtifact
      ?? await this.getCurrentPrototypeArtifactForState(projectId, project.currentPrototypeArtifactId, state);
    const prototypeSpec = options.prototypeSpec
      ?? state?.prototypeSpec
      ?? (currentArtifact ? await this.getPrototypeSpec(currentArtifact.prototypeSpecId) : undefined);

    const checkTypes = options.checkTypes?.length ? options.checkTypes : DEFAULT_CHECK_TYPES;
    const knowledgeContext = await this.getKnowledgeContext(projectId, state, options);
    const ruleIssues = this.ruleCheck.run({
      productDesignState: state,
      prdDocument,
      prototypeSpec,
      prototypeArtifact: currentArtifact,
      knowledgeContext,
      checkTypes,
    });

    const agentResult = state
      ? await this.qaAgent.run({
          runId: options.runId ?? `qa-${Date.now()}`,
          projectId,
          traceId: options.traceId ?? options.runId ?? `qa-${Date.now()}`,
          userId,
          input: {
            productDesignState: state,
            prdDocument: prdDocument ?? undefined,
            prototypeSpec: prototypeSpec ?? undefined,
            knowledgeContext,
          },
        })
      : undefined;

    const issues = dedupeIssues([
      ...ruleIssues,
      ...(agentResult?.data.issues ?? []),
      ...fallbackIssuesFromMetadata(options.fallbacks ?? []),
    ]);
    const counts = countIssues(issues);
    const status = resolveStatus(issues);
    const summary = issues.length
      ? `QA 完成：${counts.blockingCount} 个阻塞、${counts.majorCount} 个重要、${counts.minorCount} 个轻微、${counts.infoCount} 个提示。`
      : agentResult?.data.summary || "QA 完成：未发现阻塞或一致性问题。";

    const report = await this.prisma.qAReport.create({
      data: {
        projectId,
        productDesignStateId: state?.id ?? "missing",
        productDesignStateVersion: state?.version ?? 0,
        prdDocumentId: prdDocument?.id,
        prototypeArtifactId: currentArtifact?.id,
        prototypeSpecId: prototypeSpec?.id,
        status,
        trigger: options.trigger,
        checkTypes: toInputJson(checkTypes),
        summary,
        issues: toInputJson(issues),
        ...counts,
        generatedByRunId: options.runId,
        relatedPatchId: options.relatedPatchId,
        relatedRollbackId: options.relatedRollbackId,
        createdBy: userId,
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        latestQaReportId: report.id,
        status: projectStatusAfterQa({
          qaStatus: status,
          currentProjectStatus: project.status,
          productDesignState: state,
        }),
        lastActivityAt: new Date(),
      },
    });

    return this.toQaReport(report as QAReportRecord);
  }

  async getLatestForUser(user: AuthenticatedUser, projectId: string) {
    const project = await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const report = project.latestQaReportId
      ? await this.prisma.qAReport.findFirst({ where: { id: project.latestQaReportId, projectId } })
      : await this.prisma.qAReport.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } });
    const qaReport = report ? this.toQaReport(report as QAReportRecord) : null;
    return { qaReport, qaGate: this.evaluateGate(qaReport) };
  }

  async getForUser(user: AuthenticatedUser, qaReportId: string) {
    const report = await this.getAccessibleReport(user, qaReportId);
    const qaReport = this.toQaReport(report as QAReportRecord);
    return { qaReport, qaGate: qaReport.gate };
  }

  async getGateForUser(user: AuthenticatedUser, projectId: string) {
    const project = await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const report = project.latestQaReportId
      ? await this.prisma.qAReport.findFirst({ where: { id: project.latestQaReportId, projectId } })
      : await this.prisma.qAReport.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } });
    const qaReport = report ? this.toQaReport(report as QAReportRecord) : null;
    return { qaGate: this.evaluateGate(qaReport), qaReport };
  }

  async getGateForProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    const report = project.latestQaReportId
      ? await this.prisma.qAReport.findFirst({ where: { id: project.latestQaReportId, projectId } })
      : await this.prisma.qAReport.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } });
    const qaReport = report ? this.toQaReport(report as QAReportRecord) : null;
    return { qaGate: this.evaluateGate(qaReport), qaReport };
  }

  async assertGateAllows(user: AuthenticatedUser, projectId: string, action: QAGateAction) {
    const { qaGate } = await this.getGateForUser(user, projectId);
    if (!this.isActionAllowed(qaGate, action)) {
      throw new ForbiddenException({
        code: "QA_GATE_BLOCKED",
        message: "QA_GATE_BLOCKED",
        action,
        qaGate,
      });
    }
    return qaGate;
  }

  async assertGateAllowsForProject(projectId: string, action: QAGateAction) {
    const { qaGate } = await this.getGateForProject(projectId);
    if (!this.isActionAllowed(qaGate, action)) {
      throw new ForbiddenException({
        code: "QA_GATE_BLOCKED",
        message: "QA_GATE_BLOCKED",
        action,
        qaGate,
      });
    }
    return qaGate;
  }

  async listForProject(
    user: AuthenticatedUser,
    projectId: string,
    query: { status?: PrismaQAReportStatus; trigger?: PrismaQAReportTrigger; page?: number; pageSize?: number },
  ) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    return this.listByProject(projectId, query);
  }

  async listByProject(
    projectId: string,
    query: { status?: PrismaQAReportStatus; trigger?: PrismaQAReportTrigger; page?: number; pageSize?: number },
  ) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where: Prisma.QAReportWhereInput = {
      projectId,
      status: query.status,
      trigger: query.trigger,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.qAReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.qAReport.count({ where }),
    ]);
    return { items: items.map((item) => this.toQaReport(item as QAReportRecord)), total, page, pageSize };
  }

  toQaReport(row: QAReportRecord): QAReport {
    const issues = Array.isArray(row.issues) ? row.issues as QAIssue[] : [];
    const checkTypes = Array.isArray(row.checkTypes) ? row.checkTypes as QACheckType[] : [];
    return {
      id: row.id,
      projectId: row.projectId,
      productDesignStateId: row.productDesignStateId,
      productDesignStateVersion: row.productDesignStateVersion,
      prdDocumentId: row.prdDocumentId ?? undefined,
      prototypeArtifactId: row.prototypeArtifactId ?? undefined,
      prototypeSpecId: row.prototypeSpecId ?? undefined,
      status: row.status,
      trigger: row.trigger,
      checkTypes,
      summary: row.summary,
      issues,
      blockingCount: row.blockingCount,
      majorCount: row.majorCount,
      minorCount: row.minorCount,
      infoCount: row.infoCount,
      generatedByRunId: row.generatedByRunId ?? undefined,
      relatedPatchId: row.relatedPatchId ?? undefined,
      relatedRollbackId: row.relatedRollbackId ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      passed: row.status === "passed" || row.status === "warning",
      gate: evaluateQaGate({
        id: row.id,
        status: row.status,
        blockingCount: row.blockingCount,
        majorCount: row.majorCount,
        minorCount: row.minorCount,
        infoCount: row.infoCount,
        issues,
      }),
    };
  }

  evaluateGate(report: QAReport | null | undefined): QAGateDecision {
    return evaluateQaGate(report);
  }

  private isActionAllowed(gate: QAGateDecision, action: QAGateAction) {
    return isQaGateActionAllowed(gate, action);
  }

  private async getCurrentState(projectId: string) {
    const row = await this.prisma.productDesignState.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    return row ? toStateItem(row as ProductDesignStateRecord) : null;
  }

  private async getCurrentPrdForState(
    projectId: string,
    currentPrdDocumentId: string | null | undefined,
    state: ProductDesignState | null,
  ) {
    const row = currentPrdDocumentId
      ? await this.prisma.requirementDocument.findFirst({ where: { id: currentPrdDocumentId, projectId } })
      : await this.prisma.requirementDocument.findFirst({ where: { projectId }, orderBy: { updatedAt: "desc" } });
    const document = row ? toRequirementDocument(row as RequirementDocumentRecord) : null;
    if (!document || !state) return document;
    return document.productDesignStateId === state.id && document.productDesignStateVersion === state.version
      ? document
      : null;
  }

  private async getCurrentPrototypeArtifactForState(
    projectId: string,
    currentPrototypeArtifactId: string | null | undefined,
    state: ProductDesignState | null,
  ) {
    const row = currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findFirst({ where: { id: currentPrototypeArtifactId, projectId } })
      : await this.prisma.prototypeArtifact.findFirst({ where: { projectId }, orderBy: { updatedAt: "desc" } });
    const artifact = row ? toPrototypeArtifact(row as PrototypeArtifactRecord) : null;
    if (!artifact || !state) return artifact;
    if (artifact.productDesignStateId !== state.id) return null;
    if (state.prototypeSpec?.id) {
      return artifact.prototypeSpecId === state.prototypeSpec.id ? artifact : null;
    }
    return artifact.productDesignStateVersion === state.version ? artifact : null;
  }

  private async getPrototypeSpec(prototypeSpecId: string) {
    const row = await this.prisma.prototypeSpecRecord.findUnique({ where: { id: prototypeSpecId } });
    return row ? toPrototypeSpec(row as PrototypeSpecRecord) : null;
  }

  private async getKnowledgeContext(
    projectId: string,
    state: ProductDesignState | null,
    options: RunQaOptions,
  ): Promise<KnowledgeContext> {
    const query = state ? `${state.title} ${state.summary ?? ""} ${state.businessGoal}` : `QA ${projectId}`;
    const search = await this.knowledgeRetrieval.search({
      projectId,
      runId: options.runId,
      agentName: AgentName.qa_agent,
      query,
      taskType: "qa_check",
      preferredTypes: [
        KnowledgeType.strong_rule,
        KnowledgeType.default_rule,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
      ],
      limit: 10,
    });
    return {
      query,
      strongRules: search.references.filter((item) => item.type === KnowledgeType.strong_rule),
      defaultRules: search.references.filter((item) => item.type === KnowledgeType.default_rule),
      referenceCases: search.references.filter((item) => item.type === KnowledgeType.reference_case),
      designPatterns: search.references.filter((item) => item.type === KnowledgeType.design_pattern),
      prdWritingRules: search.references.filter((item) => item.type === KnowledgeType.prd_writing_rule),
      prototypeRules: search.references.filter((item) => item.type === KnowledgeType.prototype_rule),
      businessConcepts: search.references.filter((item) => item.type === KnowledgeType.business_concept),
      conflicts: [],
      unknownAreas: [],
      summary: search.references.length ? `QA 命中 ${search.references.length} 条知识规则。` : "QA 未命中知识规则。",
    };
  }

  private async getAccessibleReport(user: AuthenticatedUser, qaReportId: string) {
    const report = await this.prisma.qAReport.findUnique({
      where: { id: qaReportId },
      include: { project: true },
    });
    if (!report || report.project.deletedAt || report.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("QA_REPORT_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && report.project.ownerId !== user.id) {
      throw new ForbiddenException("QA_REPORT_FORBIDDEN");
    }
    return report;
  }

  private async assertProjectAccess(
    user: AuthenticatedUser,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (!options.allowArchived && project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("QA_REPORT_FORBIDDEN");
    }
    return project;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户项目 QA");
    }
  }
}

export function fallbackIssuesFromMetadata(fallbacks: AgentFallbackMetadata[]): QAIssue[] {
  return fallbacks.map((fallback) => ({
    id: `qa_fallback_${safeIssueId(fallback.agentName)}_${safeIssueId(fallback.taskType)}_${safeIssueId(fallback.level)}`,
    checkType: "assumption_risk",
    severity: fallbackIssueSeverity(fallback.level),
    title: fallbackIssueTitle(fallback),
    description: fallback.reason || fallback.errorMessage,
    relatedStatePaths: [`fallbacks.${fallback.agentName}.${fallback.taskType}`],
    suggestion: fallbackIssueSuggestion(fallback.level),
    autoFixable: false,
    status: "open",
  }));
}

function fallbackIssueSeverity(level: AgentFallbackLevel): QAIssue["severity"] {
  if (level === "acceptable_result") return "info";
  if (level === "degraded_preview") return "minor";
  return "major";
}

function fallbackIssueTitle(fallback: AgentFallbackMetadata) {
  if (fallback.level === "acceptable_result") return `Fallback 可接受结果：${fallback.agentName}`;
  if (fallback.level === "degraded_preview") return `Fallback 降级预览需复核：${fallback.agentName}`;
  return `模型不可用：${fallback.agentName}`;
}

function fallbackIssueSuggestion(level: AgentFallbackLevel) {
  if (level === "acceptable_result") return "继续评审即可；该 fallback 不阻止确认、知识沉淀或导出。";
  if (level === "degraded_preview") return "确认前复核该步骤输出；重新运行 QA 后才能沉淀知识或导出发布。";
  return "检查模型配置或重试；不要确认、导出或沉淀知识。";
}

function safeIssueId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function countIssues(issues: QAIssue[]) {
  return {
    blockingCount: issues.filter((issue) => issue.severity === "blocking").length,
    majorCount: issues.filter((issue) => issue.severity === "major").length,
    minorCount: issues.filter((issue) => issue.severity === "minor").length,
    infoCount: issues.filter((issue) => issue.severity === "info").length,
  };
}

function resolveStatus(issues: QAIssue[]): QAReportStatus {
  if (issues.some((issue) => issue.severity === "blocking" || issue.severity === "major")) return "failed";
  if (issues.length) return "warning";
  return "passed";
}

function dedupeIssues(issues: QAIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.checkType}:${issue.severity}:${issue.title}:${issue.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toStateItem(state: ProductDesignStateRecord): ProductDesignState {
  return {
    id: state.id,
    projectId: state.projectId,
    version: state.version,
    title: state.title,
    summary: state.summary ?? undefined,
    businessGoal: state.businessGoal,
    background: state.background ?? undefined,
    targetUsers: arrayOfRecords(state.targetUsers),
    userScenarios: arrayOfRecords(state.userScenarios),
    pages: arrayOfRecords(state.pages),
    features: arrayOfRecords(state.features),
    backendConfigs: arrayOfRecords(state.backendConfigs),
    frontendRules: arrayOfRecords(state.frontendRules),
    businessRules: arrayOfRecords(state.businessRules),
    stateRules: arrayOfRecords(state.stateRules),
    exceptionScenarios: arrayOfRecords(state.exceptionScenarios),
    acceptanceCriteria: arrayOfRecords(state.acceptanceCriteria),
    prototypeOutline: recordOrUndefined(state.prototypeOutline),
    assumptions: arrayOfRecords(state.assumptions),
    knowledgeRefs: arrayOfRecords(state.knowledgeRefs),
    pendingQuestions: arrayOfRecords(state.pendingQuestions),
    confirmedFacts: arrayOfRecords(state.confirmedFacts),
    prototypeSpec: recordOrUndefined(state.prototypeSpec) as PrototypeSpec | undefined,
    prdDocument: recordOrUndefined(state.prdDocument) as RequirementDocument | undefined,
    status: state.status as ProductDesignState["status"],
    createdBy: state.createdBy,
    updatedBy: state.updatedBy ?? undefined,
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}

function toRequirementDocument(row: RequirementDocumentRecord): RequirementDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    productDesignStateId: row.productDesignStateId,
    productDesignStateVersion: row.productDesignStateVersion,
    title: row.title,
    status: row.status as RequirementDocument["status"],
    sections: Array.isArray(row.sections) ? row.sections as RequirementDocument["sections"] : [],
    assumptions: Array.isArray(row.assumptions) ? row.assumptions as RequirementDocument["assumptions"] : [],
    knowledgeRefs: arrayOfRecords(row.knowledgeRefs),
    pendingQuestions: Array.isArray(row.pendingQuestions) ? row.pendingQuestions as RequirementDocument["pendingQuestions"] : [],
    validationNotes: Array.isArray(row.validationNotes) ? row.validationNotes.map(String) : [],
    generatedByRunId: row.generatedByRunId ?? undefined,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPrototypeSpec(row: PrototypeSpecRecord): PrototypeSpec {
  return {
    id: row.id,
    projectId: row.projectId,
    productDesignStateId: row.productDesignStateId,
    productDesignStateVersion: row.productDesignStateVersion,
    title: row.title,
    targetDevice: row.targetDevice,
    styleGuide: recordOrUndefined(row.styleGuide) as PrototypeSpec["styleGuide"] ?? {
      tone: "clean",
      layoutDensity: "comfortable",
      borderRadius: "small",
    },
    pages: Array.isArray(row.pages) ? row.pages as PrototypeSpec["pages"] : [],
    navigation: Array.isArray(row.navigation) ? row.navigation as PrototypeSpec["navigation"] : [],
    interactions: Array.isArray(row.interactions) ? row.interactions as PrototypeSpec["interactions"] : [],
    assumptions: Array.isArray(row.assumptions) ? row.assumptions as PrototypeSpec["assumptions"] : [],
    knowledgeRefs: arrayOfRecords(row.knowledgeRefs),
    generatedByRunId: row.generatedByRunId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPrototypeArtifact(row: PrototypeArtifactRecord): PrototypeArtifact {
  return {
    id: row.id,
    projectId: row.projectId,
    prototypeSpecId: row.prototypeSpecId,
    productDesignStateId: row.productDesignStateId,
    productDesignStateVersion: row.productDesignStateVersion,
    title: row.title,
    status: row.status,
    htmlContent: row.htmlContent ?? undefined,
    entryFilePath: row.entryFilePath ?? undefined,
    previewUrl: row.previewUrl ?? undefined,
    targetDevice: row.targetDevice,
    pageCount: row.pageCount,
    generatedByRunId: row.generatedByRunId ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    html: row.htmlContent ?? undefined,
    entryFile: row.entryFilePath ?? undefined,
    assets: [],
  };
}

function recordOrUndefined(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}
