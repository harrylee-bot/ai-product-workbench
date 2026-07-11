import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  KnowledgeType,
  Prisma,
  ConversationStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  QAReportStatus as PrismaQAReportStatus,
  QAReportTrigger as PrismaQAReportTrigger,
  RequirementDocumentStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeRetrievalService } from "../knowledge/knowledge-retrieval.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  KnowledgeContext,
  ConversationDesignState,
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
import { evaluateQaGate, isQaGateActionAllowed } from "./qa-gate.helpers";
import { DEFAULT_CHECK_TYPES, QaRuleCheckService } from "./qa-rule-check.service";
import { conversationStatusAfterQa } from "./workspace-state-machine";

type RunQaOptions = {
  trigger: QAReportTrigger;
  checkTypes?: QACheckType[];
  runId?: string;
  traceId?: string;
  relatedRollbackId?: string;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  prototypeArtifact?: PrototypeArtifact;
  conversationDesignState?: ConversationDesignState;
  /**
   * Generated artifacts are written in a provisional state. Their QA report is
   * only promoted to the conversation's active gate by the fenced publish
   * transaction after the run lease is checked again.
   */
  deferLatest?: boolean;
};

type ConversationDesignStateRecord = {
  id: string;
  conversationId: string;
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
  conversationId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
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
  conversationId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
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
  conversationId: string;
  prototypeSpecId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
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
  conversationId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
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
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
  ) {}

  async runForUser(user: AuthenticatedUser, conversationId: string, input: { checkTypes?: QACheckType[] }) {
    const conversation = await this.assertConversationAccess(user, conversationId);
    this.assertOwnerMutation(user, conversation.ownerId);
    const qaReport = await this.runForConversation(conversationId, user.id, {
      trigger: "manual",
      checkTypes: input.checkTypes,
      traceId: `manual-qa-${Date.now()}`,
    });
    return { qaReport, qaGate: qaReport.gate };
  }

  async runForConversation(conversationId: string, userId: string, options: RunQaOptions): Promise<QAReport> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }

    const state = options.conversationDesignState
      ?? await this.getCurrentState(conversationId, conversation.currentDesignStateId);
    const prdDocument = options.prdDocument
      ?? state?.prdDocument
      ?? await this.getCurrentPrdForState(conversationId, conversation.currentPrdDocumentId, state);
    const currentArtifact = options.prototypeArtifact
      ?? await this.getCurrentPrototypeArtifactForState(conversationId, conversation.currentPrototypeArtifactId, state);
    const prototypeSpec = options.prototypeSpec
      ?? state?.prototypeSpec
      ?? (currentArtifact ? await this.getPrototypeSpec(currentArtifact.prototypeSpecId) : undefined);

    const checkTypes = options.checkTypes?.length ? options.checkTypes : DEFAULT_CHECK_TYPES;
    const knowledgeContext = await this.getKnowledgeContext(conversationId, state, options);
    const ruleIssues = this.ruleCheck.run({
      conversationDesignState: state,
      prdDocument,
      prototypeSpec,
      prototypeArtifact: currentArtifact,
      knowledgeContext,
      checkTypes,
    });

    const issues = dedupeIssues(ruleIssues);
    const counts = countIssues(issues);
    const status = resolveStatus(issues);
    const summary = issues.length
      ? `QA 完成：${counts.blockingCount} 个阻塞、${counts.majorCount} 个重要、${counts.minorCount} 个轻微、${counts.infoCount} 个提示。`
      : "QA 完成：未发现阻塞或一致性问题。";

    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.qAReport.create({
        data: {
          conversationId,
          conversationDesignStateId: state?.id ?? "missing",
          conversationDesignStateVersion: state?.version ?? 0,
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
          relatedRollbackId: options.relatedRollbackId,
          createdBy: userId,
        },
      });

      if (!options.deferLatest) {
        // QAReport.create + conversation.update stays atomic for manual,
        // rollback and pre-confirm QA. Initial-generation QA is promoted by
        // FinalActionApplierService together with artifact publication.
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            latestQaReportId: created.id,
            status: conversationStatusAfterQa({
              qaStatus: status,
              currentConversationStatus: conversation.status,
              conversationDesignState: state,
            }),
            lastActivityAt: new Date(),
          },
        });
      }

      return created;
    });

    return this.toQaReport(report as QAReportRecord);
  }

  async getLatestForUser(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    const report = conversation.latestQaReportId
      ? await this.prisma.qAReport.findFirst({ where: { id: conversation.latestQaReportId, conversationId } })
      : null;
    const qaReport = report ? this.toQaReport(report as QAReportRecord) : null;
    return { qaReport, qaGate: this.evaluateGate(qaReport) };
  }

  async getForUser(user: AuthenticatedUser, qaReportId: string) {
    const report = await this.getAccessibleReport(user, qaReportId);
    const qaReport = this.toQaReport(report as QAReportRecord);
    return { qaReport, qaGate: qaReport.gate };
  }

  async getGateForUser(user: AuthenticatedUser, conversationId: string) {
    const conversation = await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    const report = conversation.latestQaReportId
      ? await this.prisma.qAReport.findFirst({ where: { id: conversation.latestQaReportId, conversationId } })
      : null;
    const qaReport = report ? this.toQaReport(report as QAReportRecord) : null;
    return { qaGate: this.evaluateGate(qaReport), qaReport };
  }

  async getGateForConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    const report = conversation.latestQaReportId
      ? await this.prisma.qAReport.findFirst({ where: { id: conversation.latestQaReportId, conversationId } })
      : null;
    const qaReport = report ? this.toQaReport(report as QAReportRecord) : null;
    return { qaGate: this.evaluateGate(qaReport), qaReport };
  }

  async assertGateAllows(user: AuthenticatedUser, conversationId: string, action: QAGateAction) {
    const { qaGate } = await this.getGateForUser(user, conversationId);
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

  async assertGateAllowsForConversation(conversationId: string, action: QAGateAction) {
    const { qaGate } = await this.getGateForConversation(conversationId);
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

  async listForConversation(
    user: AuthenticatedUser,
    conversationId: string,
    query: { status?: PrismaQAReportStatus; trigger?: PrismaQAReportTrigger; page?: number; pageSize?: number },
  ) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    return this.listByConversation(conversationId, query);
  }

  async listByConversation(
    conversationId: string,
    query: { status?: PrismaQAReportStatus; trigger?: PrismaQAReportTrigger; page?: number; pageSize?: number },
  ) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where: Prisma.QAReportWhereInput = {
      conversationId,
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
      conversationId: row.conversationId,
      conversationDesignStateId: row.conversationDesignStateId,
      conversationDesignStateVersion: row.conversationDesignStateVersion,
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

  private async getCurrentState(
    conversationId: string,
    currentDesignStateId: string | null | undefined,
  ) {
    if (!currentDesignStateId) return null;
    const row = await this.prisma.conversationDesignState.findFirst({
      where: { id: currentDesignStateId, conversationId },
    });
    return row ? toStateItem(row as ConversationDesignStateRecord) : null;
  }

  private async getCurrentPrdForState(
    conversationId: string,
    currentPrdDocumentId: string | null | undefined,
    state: ConversationDesignState | null,
  ) {
    if (!currentPrdDocumentId) return null;
    const row = await this.prisma.requirementDocument.findFirst({
      where: {
        id: currentPrdDocumentId,
        conversationId,
        status: {
          in: [RequirementDocumentStatus.ready, RequirementDocumentStatus.confirmed],
        },
      },
    });
    const document = row ? toRequirementDocument(row as RequirementDocumentRecord) : null;
    if (!document || !state) return document;
    return document.conversationDesignStateId === state.id && document.conversationDesignStateVersion === state.version
      ? document
      : null;
  }

  private async getCurrentPrototypeArtifactForState(
    conversationId: string,
    currentPrototypeArtifactId: string | null | undefined,
    state: ConversationDesignState | null,
  ) {
    if (!currentPrototypeArtifactId) return null;
    const row = await this.prisma.prototypeArtifact.findFirst({
      where: {
        id: currentPrototypeArtifactId,
        conversationId,
        status: PrototypeArtifactStatus.ready,
      },
    });
    const artifact = row ? toPrototypeArtifact(row as PrototypeArtifactRecord) : null;
    if (!artifact || !state) return artifact;
    if (artifact.conversationDesignStateId !== state.id) return null;
    if (state.prototypeSpec?.id) {
      return artifact.prototypeSpecId === state.prototypeSpec.id ? artifact : null;
    }
    return artifact.conversationDesignStateVersion === state.version ? artifact : null;
  }

  private async getPrototypeSpec(prototypeSpecId: string) {
    const row = await this.prisma.prototypeSpecRecord.findUnique({ where: { id: prototypeSpecId } });
    return row ? toPrototypeSpec(row as PrototypeSpecRecord) : null;
  }

  private async getKnowledgeContext(
    conversationId: string,
    state: ConversationDesignState | null,
    options: RunQaOptions,
  ): Promise<KnowledgeContext> {
    const query = state
      ? `${state.title} ${state.summary ?? ""} ${state.businessGoal} 需求文档 原型`
      : `QA ${conversationId} 需求文档 原型`;
    const search = await this.knowledgeRetrieval.search({
      conversationId,
      runId: options.runId,
      runtimeName: "runtime_qa",
      query,
      taskType: "qa_check",
      preferredTypes: [
        KnowledgeType.strong_rule,
        KnowledgeType.default_rule,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.prototype_asset_ref,
        KnowledgeType.business_concept,
        KnowledgeType.product_architecture,
      ],
      limit: 16,
    });
    return {
      query,
      strongRules: search.references.filter((item) => item.type === KnowledgeType.strong_rule),
      defaultRules: search.references.filter((item) => item.type === KnowledgeType.default_rule),
      referenceCases: search.references.filter((item) => item.type === KnowledgeType.reference_case),
      designPatterns: search.references.filter((item) =>
        item.type === KnowledgeType.design_pattern || item.type === KnowledgeType.product_architecture,
      ),
      prdWritingRules: search.references.filter((item) => item.type === KnowledgeType.prd_writing_rule),
      prototypeRules: search.references.filter((item) =>
        item.type === KnowledgeType.prototype_rule || item.type === KnowledgeType.prototype_asset_ref,
      ),
      businessConcepts: search.references.filter((item) => item.type === KnowledgeType.business_concept),
      conflicts: [],
      unknownAreas: search.retrievalError ? [search.retrievalError] : [],
      summary: search.retrievalError
        ? `QA 知识检索失败，按无知识基线检查：${search.retrievalError}`
        : search.references.length
          ? `QA 命中 ${search.references.length} 条知识规则。`
          : "QA 未命中知识规则。",
    };
  }

  private async getAccessibleReport(user: AuthenticatedUser, qaReportId: string) {
    const report = await this.prisma.qAReport.findUnique({
      where: { id: qaReportId },
      include: { conversation: true },
    });
    if (!report || report.conversation.deletedAt || report.conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("QA_REPORT_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && report.conversation.ownerId !== user.id) {
      throw new ForbiddenException("QA_REPORT_FORBIDDEN");
    }
    return report;
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (!options.allowArchived && conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("会话已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("QA_REPORT_FORBIDDEN");
    }
    return conversation;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户会话 QA");
    }
  }
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

function toStateItem(state: ConversationDesignStateRecord): ConversationDesignState {
  return {
    id: state.id,
    conversationId: state.conversationId,
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
    status: state.status as ConversationDesignState["status"],
    createdBy: state.createdBy,
    updatedBy: state.updatedBy ?? undefined,
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}

function toRequirementDocument(row: RequirementDocumentRecord): RequirementDocument {
  return {
    id: row.id,
    conversationId: row.conversationId,
    conversationDesignStateId: row.conversationDesignStateId,
    conversationDesignStateVersion: row.conversationDesignStateVersion,
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
    conversationId: row.conversationId,
    conversationDesignStateId: row.conversationDesignStateId,
    conversationDesignStateVersion: row.conversationDesignStateVersion,
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
    conversationId: row.conversationId,
    prototypeSpecId: row.prototypeSpecId,
    conversationDesignStateId: row.conversationDesignStateId,
    conversationDesignStateVersion: row.conversationDesignStateVersion,
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
