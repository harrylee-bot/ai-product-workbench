import { Injectable, NotFoundException } from "@nestjs/common";
import {
  RuntimeStepStatus,
  FileAssetStatus,
  KnowledgeCandidateStatus,
  ModelCallStatus,
  Prisma,
  ProjectStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  ListAdminModelCallsQueryDto,
  ListAdminProjectsQueryDto,
  ListRuntimeRunsQueryDto,
  ListFileParsesQueryDto,
  ListQaReportsQueryDto,
} from "./admin.dto";
import { normalizePagination } from "./admin-audit.service";

type RuntimeDebugStep = {
  id: string;
  runtimeName: string;
  status: string;
  outputSummary?: string;
  modelCallLogId?: string;
  modelCall?: unknown;
  errorMessage?: string;
};

type RuntimeDebugEvent = {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
};

type NormalizedRuntimeDebugEvent = {
  id: string;
  type: string;
  step?: string;
  content?: string;
  data?: unknown;
  raw?: unknown;
  createdAt: string;
};

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardStats() {
    const todayStart = startOfToday();
    const [
      userCount,
      projectCount,
      todayRuntimeRunCount,
      todayModelCallCount,
      todayFailedModelCallCount,
      pendingKnowledgeCandidateCount,
      failedFileParseCount,
      qaFailedProjectCount,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.project.count({ where: { deletedAt: null } }),
      this.prisma.runtimeRunLog.count({ where: { startedAt: { gte: todayStart } } }),
      this.prisma.modelCallLog.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.modelCallLog.count({
        where: { status: ModelCallStatus.failed, createdAt: { gte: todayStart } },
      }),
      this.prisma.knowledgeCandidate.count({
        where: { status: KnowledgeCandidateStatus.pending },
      }),
      this.prisma.fileAsset.count({
        where: { status: FileAssetStatus.parse_failed, deletedAt: null },
      }),
      this.prisma.project.count({
        where: { status: ProjectStatus.qa_failed, deletedAt: null },
      }),
    ]);

    return {
      userCount,
      projectCount,
      todayRuntimeRunCount,
      todayModelCallCount,
      todayFailedModelCallCount,
      pendingKnowledgeCandidateCount,
      failedFileParseCount,
      qaFailedProjectCount,
    };
  }

  async listProjects(query: ListAdminProjectsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const keyword = query.keyword?.trim();
    const owner = query.owner?.trim();
    const where: Prisma.ProjectWhereInput = {
      ...(query.status ? { status: query.status } : { deletedAt: null }),
      ...(keyword
        ? {
            OR: [
              { title: { contains: keyword, mode: "insensitive" } },
              { description: { contains: keyword, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(owner
        ? {
            owner: {
              OR: [
                { username: { contains: owner, mode: "insensitive" } },
                { email: { contains: owner, mode: "insensitive" } },
                { displayName: { contains: owner, mode: "insensitive" } },
              ],
            },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        orderBy: { lastActivityAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          owner: { select: { id: true, username: true, displayName: true, email: true } },
          _count: { select: { conversations: true, runtimeRuns: true, fileAssets: true } },
        },
      }),
      this.prisma.project.count({ where }),
    ]);

    return {
      items: items.map((project) => ({
        id: project.id,
        title: project.title,
        description: project.description ?? undefined,
        status: project.status,
        ownerId: project.ownerId,
        ownerUsername: project.owner.username,
        ownerDisplayName: project.owner.displayName,
        ownerEmail: project.owner.email ?? undefined,
        conversationCount: project._count.conversations,
        runtimeRunCount: project._count.runtimeRuns,
        agentRunCount: project._count.runtimeRuns,
        fileCount: project._count.fileAssets,
        currentConversationId: project.currentConversationId ?? undefined,
        currentProductDesignStateId: project.currentProductDesignStateId ?? undefined,
        currentPrdDocumentId: project.currentPrdDocumentId ?? undefined,
        currentPrototypeArtifactId: project.currentPrototypeArtifactId ?? undefined,
        latestQaReportId: project.latestQaReportId ?? undefined,
        lastActivityAt: project.lastActivityAt.toISOString(),
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        owner: { select: { id: true, username: true, displayName: true, email: true } },
        conversations: {
          where: { deletedAt: null },
          orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
          take: 20,
        },
        productDesignStates: {
          orderBy: { version: "desc" },
          take: 1,
        },
        requirementDocuments: {
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        prototypeArtifacts: {
          orderBy: { updatedAt: "desc" },
          take: 1,
        },
        _count: {
          select: { conversations: true, messages: true, runtimeRuns: true, fileAssets: true },
        },
      },
    });

    if (!project || project.deletedAt) throw new NotFoundException("ADMIN_PROJECT_NOT_FOUND");

    const state = project.productDesignStates[0];
    const prd = project.requirementDocuments[0];
    const prototype = project.prototypeArtifacts[0];

    return {
      project: {
        id: project.id,
        title: project.title,
        description: project.description ?? undefined,
        status: project.status,
        ownerId: project.ownerId,
        ownerUsername: project.owner.username,
        ownerDisplayName: project.owner.displayName,
        ownerEmail: project.owner.email ?? undefined,
        currentConversationId: project.currentConversationId ?? undefined,
        currentProductDesignStateId: project.currentProductDesignStateId ?? undefined,
        currentPrdDocumentId: project.currentPrdDocumentId ?? undefined,
        currentPrototypeArtifactId: project.currentPrototypeArtifactId ?? undefined,
        latestQaReportId: project.latestQaReportId ?? undefined,
        lastActivityAt: project.lastActivityAt.toISOString(),
        archivedAt: project.archivedAt?.toISOString(),
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        counts: project._count,
      },
      conversations: project.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        summary: conversation.summary ?? undefined,
        messageCount: conversation.messageCount,
        status: conversation.status,
        lastMessageAt: conversation.lastMessageAt?.toISOString(),
        createdAt: conversation.createdAt.toISOString(),
      })),
      productDesignState: state
        ? {
            id: state.id,
            version: state.version,
            title: state.title,
            summary: state.summary ?? undefined,
            status: state.status,
            businessGoal: state.businessGoal,
            pendingQuestionCount: countJsonArray(state.pendingQuestions),
            assumptionCount: countJsonArray(state.assumptions),
            knowledgeRefCount: countJsonArray(state.knowledgeRefs),
            updatedAt: state.updatedAt.toISOString(),
          }
        : undefined,
      prd: prd
        ? {
            id: prd.id,
            title: prd.title,
            status: prd.status,
            productDesignStateVersion: prd.productDesignStateVersion,
            generatedByRunId: prd.generatedByRunId ?? undefined,
            updatedAt: prd.updatedAt.toISOString(),
          }
        : undefined,
      prototype: prototype
        ? {
            id: prototype.id,
            title: prototype.title,
            status: prototype.status,
            targetDevice: prototype.targetDevice,
            pageCount: prototype.pageCount,
            previewUrl: prototype.previewUrl ?? undefined,
            generatedByRunId: prototype.generatedByRunId ?? undefined,
            updatedAt: prototype.updatedAt.toISOString(),
          }
        : undefined,
    };
  }

  async listProjectRuns(projectId: string, query: ListRuntimeRunsQueryDto) {
    return this.listRuntimeRuns({ ...query, projectId });
  }

  async listProjectFiles(projectId: string, query: ListFileParsesQueryDto) {
    return this.listFileParses({ ...query, projectId });
  }

  async listProjectQaReports(projectId: string, query: ListQaReportsQueryDto) {
    return this.listQaReports({ ...query, projectId });
  }

  async listRuntimeRuns(query: ListRuntimeRunsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.RuntimeRunLogWhereInput = {
      projectId: query.projectId,
      userId: query.userId,
      conversationId: query.conversationId,
      status: query.status,
      traceId: query.traceId,
      ...(query.runtimeName ? { steps: { some: { runtimeName: query.runtimeName } } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.runtimeRunLog.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          project: { select: { id: true, title: true } },
          user: { select: { id: true, username: true, displayName: true } },
          conversation: { select: { id: true, title: true } },
          steps: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1 },
        },
      }),
      this.prisma.runtimeRunLog.count({ where }),
    ]);

    return {
      items: items.map((run) => ({
        id: run.id,
        runId: run.id,
        projectId: run.projectId,
        projectTitle: run.project.title,
        conversationId: run.conversationId,
        conversationTitle: run.conversation.title,
        userId: run.userId,
        username: run.user.username,
        userDisplayName: run.user.displayName,
        intent: run.intent ?? undefined,
        status: run.status,
        currentStep: run.steps[0]?.runtimeName,
        currentStepStatus: run.steps[0]?.status,
        traceId: run.traceId,
        inputSummary: run.inputSummary,
        outputSummary: run.outputSummary ?? undefined,
        errorMessage: run.errorMessage ?? undefined,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString(),
        durationMs: run.durationMs ?? undefined,
      })),
      total,
      page,
      pageSize,
    };
  }

  async getRuntimeRun(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      include: {
        project: { select: { id: true, title: true } },
        user: { select: { id: true, username: true, displayName: true } },
        conversation: { select: { id: true, title: true } },
        steps: {
          orderBy: [{ startedAt: "asc" }, { id: "asc" }],
          include: {
            modelCallLog: {
              include: {
                provider: { select: { id: true, name: true } },
                modelConfig: { select: { id: true, displayName: true } },
              },
            },
          },
        },
        streamEvents: { orderBy: { createdAt: "asc" }, take: 100 },
      },
    });
    if (!run) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");
    const steps = run.steps.map((step) => ({
      id: step.id,
      runtimeName: step.runtimeName,
      status: step.status,
      inputSummary: step.inputSummary,
      outputSummary: step.outputSummary ?? undefined,
      modelCallLogId: step.modelCallLogId ?? undefined,
      modelCall: step.modelCallLog
        ? {
            ...this.toModelCallItem(step.modelCallLog),
            inputSummary: step.modelCallLog.inputSummary ?? undefined,
            outputSummary: step.modelCallLog.outputSummary ?? undefined,
          }
        : undefined,
      modelProviderId: step.modelProviderId ?? undefined,
      modelName: step.modelName ?? undefined,
      tokenUsage: step.tokenUsage ?? undefined,
      startedAt: step.startedAt?.toISOString(),
      endedAt: step.endedAt?.toISOString(),
      durationMs: step.durationMs ?? undefined,
      errorMessage: step.errorMessage ?? undefined,
    }));
    const events = run.streamEvents.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    }));
    const debugSummary = buildRuntimeRunDebugSummary({
      status: run.status,
      result: run.result,
      steps,
      events,
    });

    return {
      id: run.id,
      projectId: run.projectId,
      projectTitle: run.project.title,
      conversationId: run.conversationId,
      conversationTitle: run.conversation.title,
      userId: run.userId,
      username: run.user.username,
      userDisplayName: run.user.displayName,
      intent: run.intent ?? undefined,
      status: run.status,
      inputSummary: run.inputSummary,
      outputSummary: run.outputSummary ?? undefined,
      result: run.result ?? undefined,
      errorMessage: run.errorMessage ?? undefined,
      traceId: run.traceId,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString(),
      durationMs: run.durationMs ?? undefined,
      debugSummary,
      steps,
      events,
    };
  }

  async listModelCalls(query: ListAdminModelCallsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.ModelCallLogWhereInput = {
      taskType: query.taskType,
      runtimeName: query.runtimeName,
      modelName: query.modelName,
      providerId: query.providerId,
      status: query.status,
      runId: query.runId,
      traceId: query.traceId,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.modelCallLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          provider: { select: { id: true, name: true } },
          modelConfig: { select: { id: true, displayName: true } },
        },
      }),
      this.prisma.modelCallLog.count({ where }),
    ]);

    return {
      items: items.map((log) => this.toModelCallItem(log)),
      total,
      page,
      pageSize,
    };
  }

  async getModelCall(logId: string) {
    const log = await this.prisma.modelCallLog.findUnique({
      where: { id: logId },
      include: {
        provider: { select: { id: true, name: true } },
        modelConfig: { select: { id: true, displayName: true } },
        runtimeStepLogs: {
          select: { id: true, runId: true, runtimeName: true, status: true },
          take: 20,
        },
      },
    });
    if (!log) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");
    return {
      ...this.toModelCallItem(log),
      inputSummary: log.inputSummary ?? undefined,
      outputSummary: log.outputSummary ?? undefined,
      runtimeStepLogs: log.runtimeStepLogs,
    };
  }

  async listFileParses(query: ListFileParsesQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const extension = query.extension?.trim().toLowerCase().replace(/^\./, "");
    const where: Prisma.FileAssetWhereInput = {
      projectId: query.projectId,
      uploadedBy: query.uploadedBy,
      status: query.status ?? { not: FileAssetStatus.deleted },
      deletedAt: null,
      ...(extension ? { extension } : {}),
      ...(query.parserType ? { parseResult: { parserType: query.parserType } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fileAsset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          project: { select: { id: true, title: true } },
          uploader: { select: { id: true, username: true, displayName: true } },
          parseResult: true,
          _count: { select: { chunks: true } },
        },
      }),
      this.prisma.fileAsset.count({ where }),
    ]);

    return {
      items: items.map((file) => ({
        id: file.id,
        fileId: file.id,
        projectId: file.projectId,
        projectTitle: file.project.title,
        uploadedBy: file.uploadedBy,
        uploaderUsername: file.uploader.username,
        uploaderDisplayName: file.uploader.displayName,
        originalName: file.originalName,
        mimeType: file.mimeType,
        extension: file.extension,
        size: file.size,
        status: file.status,
        parserType: file.parseResult?.parserType,
        parseStatus: file.parseResult?.status,
        parseError: file.parseError ?? file.parseResult?.errorMessage ?? undefined,
        chunkCount: file._count.chunks,
        createdAt: file.createdAt.toISOString(),
        updatedAt: file.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getFileParse(fileId: string) {
    const file = await this.prisma.fileAsset.findUnique({
      where: { id: fileId },
      include: {
        project: { select: { id: true, title: true } },
        uploader: { select: { id: true, username: true, displayName: true } },
        parseResult: true,
        chunks: {
          orderBy: { chunkIndex: "asc" },
          take: 50,
        },
      },
    });
    if (!file || file.deletedAt) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");

    return {
      file: {
        id: file.id,
        projectId: file.projectId,
        projectTitle: file.project.title,
        uploadedBy: file.uploadedBy,
        uploaderUsername: file.uploader.username,
        uploaderDisplayName: file.uploader.displayName,
        originalName: file.originalName,
        storedName: file.storedName,
        mimeType: file.mimeType,
        extension: file.extension,
        size: file.size,
        storageProvider: file.storageProvider,
        status: file.status,
        parseError: file.parseError ?? undefined,
        createdAt: file.createdAt.toISOString(),
        updatedAt: file.updatedAt.toISOString(),
      },
      parseResult: file.parseResult
        ? {
            id: file.parseResult.id,
            status: file.parseResult.status,
            parserType: file.parseResult.parserType,
            title: file.parseResult.title ?? undefined,
            summary: file.parseResult.summary ?? undefined,
            wordCount: file.parseResult.wordCount ?? undefined,
            sections: file.parseResult.sections ?? undefined,
            pages: file.parseResult.pages ?? undefined,
            images: file.parseResult.images ?? undefined,
            visualContexts: file.parseResult.visualContexts ?? undefined,
            axureInfo: file.parseResult.axureInfo ?? undefined,
            errorMessage: file.parseResult.errorMessage ?? undefined,
            warnings: file.parseResult.warnings ?? undefined,
            createdAt: file.parseResult.createdAt.toISOString(),
            updatedAt: file.parseResult.updatedAt.toISOString(),
          }
        : undefined,
      chunks: file.chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        contentPreview: preview(chunk.content, 500),
        tokenEstimate: chunk.tokenEstimate ?? undefined,
        sourceType: chunk.sourceType,
        sourceRef: chunk.sourceRef ?? undefined,
        createdAt: chunk.createdAt.toISOString(),
      })),
      chunkCount: file.chunks.length,
    };
  }

  async listQaReports(query: ListQaReportsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.QAReportWhereInput = {
      projectId: query.projectId,
      status: query.status,
      trigger: query.trigger,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.qAReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { project: { select: { id: true, title: true, status: true } } },
      }),
      this.prisma.qAReport.count({ where }),
    ]);

    return {
      items: items.map((report) => ({
        id: report.id,
        qaReportId: report.id,
        projectId: report.projectId,
        projectTitle: report.project.title,
        projectStatus: report.project.status,
        productDesignStateVersion: report.productDesignStateVersion,
        trigger: report.trigger,
        runId: report.generatedByRunId ?? "-",
        status: report.status,
        issueCount: report.blockingCount + report.majorCount + report.minorCount + report.infoCount,
        criticalIssueCount: report.blockingCount + report.majorCount,
        summary: report.summary,
        createdAt: report.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getQaReport(qaReportId: string) {
    const report = await this.prisma.qAReport.findUnique({
      where: { id: qaReportId },
      include: { project: { select: { id: true, title: true, status: true } } },
    });
    if (!report) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");

    return {
      id: report.id,
      qaReportId: report.id,
      projectId: report.projectId,
      projectTitle: report.project.title,
      projectStatus: report.project.status,
      productDesignStateId: report.productDesignStateId,
      productDesignStateVersion: report.productDesignStateVersion,
      prdDocumentId: report.prdDocumentId ?? undefined,
      prototypeArtifactId: report.prototypeArtifactId ?? undefined,
      prototypeSpecId: report.prototypeSpecId ?? undefined,
      trigger: report.trigger,
      runId: report.generatedByRunId ?? undefined,
      status: report.status,
      issueCount: report.blockingCount + report.majorCount + report.minorCount + report.infoCount,
      criticalIssueCount: report.blockingCount + report.majorCount,
      blockingCount: report.blockingCount,
      majorCount: report.majorCount,
      minorCount: report.minorCount,
      infoCount: report.infoCount,
      summary: report.summary,
      issues: report.issues,
      checkTypes: report.checkTypes,
      relatedRollbackId: report.relatedRollbackId ?? undefined,
      createdBy: report.createdBy,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    };
  }

  private toModelCallItem(
    log: Prisma.ModelCallLogGetPayload<{
      include: {
        provider: { select: { id: true; name: true } };
        modelConfig: { select: { id: true; displayName: true } };
      };
    }>,
  ) {
    return {
      id: log.id,
      traceId: log.traceId ?? undefined,
      runId: log.runId ?? undefined,
      runtimeName: log.runtimeName ?? undefined,
      taskType: log.taskType,
      providerId: log.providerId,
      providerName: log.provider.name,
      modelConfigId: log.modelConfigId,
      modelDisplayName: log.modelConfig.displayName,
      modelName: log.modelName,
      status: log.status,
      promptTokens: log.promptTokens ?? undefined,
      completionTokens: log.completionTokens ?? undefined,
      totalTokens: log.totalTokens ?? undefined,
      durationMs: log.durationMs ?? undefined,
      errorCode: log.errorCode ?? undefined,
      errorMessage: log.errorMessage ?? undefined,
      createdAt: log.createdAt.toISOString(),
      completedAt: log.completedAt?.toISOString(),
    };
  }
}

function startOfToday() {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
}

function buildRuntimeRunDebugSummary(input: {
  status: string;
  result: unknown;
  steps: RuntimeDebugStep[];
  events: RuntimeDebugEvent[];
}) {
  const normalizedEvents = input.events.map(normalizeRuntimeDebugEvent);
  const knowledgeHits: Record<string, unknown>[] = [];
  const qaGates: Record<string, unknown>[] = [];
  const qaIssues: Record<string, unknown>[] = [];

  for (const event of normalizedEvents) {
    const data = asRecord(event.data);
    if (!data) continue;

    if (event.step === "knowledge_retrieval" || event.type === "knowledge_candidate_created") {
      knowledgeHits.push(...extractKnowledgeHits(data));
    }

    if (event.type === "qa_completed" || event.step === "qa_check") {
      const qaGate = extractQaGate(data);
      if (qaGate) qaGates.push(qaGate);
      qaIssues.push(...extractQaIssues(data));
    }

  }

  const result = asRecord(input.result);
  if (result) {
    const resultQaGate = extractQaGate(result);
    if (resultQaGate) qaGates.push(resultQaGate);
    qaIssues.push(...extractQaIssues(result));
    knowledgeHits.push(...arrayOfRecords(result.knowledgeCandidates));
  }

  const uniqueQaGates = uniqueRecords(qaGates, "reportId", "status");
  const uniqueQaIssues = uniqueRecords(qaIssues, "id", "title");
  const uniqueKnowledgeHits = uniqueRecords(knowledgeHits, "knowledgeId", "sourceId", "id", "title");
  const latestQaGate = uniqueQaGates.at(-1);
  const qaGateStatus = latestQaGate ? text(latestQaGate.status) || undefined : undefined;
  const blockingIssueCount = uniqueQaIssues.filter((issue) => text(issue.severity) === "blocking").length;
  const majorIssueCount = uniqueQaIssues.filter((issue) => text(issue.severity) === "major").length;
  const minorIssueCount = uniqueQaIssues.filter((issue) => text(issue.severity) === "minor").length;
  const riskLevel = resolveDebugRiskLevel({
    runStatus: input.status,
    qaGateStatus,
    blockingIssueCount,
    majorIssueCount,
    minorIssueCount,
  });

  return {
    riskLevel,
    stepCount: input.steps.length,
    eventCount: input.events.length,
    modelCallCount: input.steps.filter((step) => step.modelCallLogId || step.modelCall).length,
    failedStepCount: input.steps.filter((step) => step.status === "failed").length,
    qaGateStatus,
    qaIssueCount: uniqueQaIssues.length,
    blockingIssueCount,
    majorIssueCount,
    minorIssueCount,
    knowledgeHitCount: uniqueKnowledgeHits.length,
    lastEventType: normalizedEvents.at(-1)?.type,
  };
}

function normalizeRuntimeDebugEvent(event: RuntimeDebugEvent): NormalizedRuntimeDebugEvent {
  const outer = asRecord(event.payload);
  const payload = asRecord(outer?.payload) ?? outer;
  return {
    id: event.id,
    type: text(payload?.eventType ?? payload?.type ?? outer?.eventType ?? event.eventType, event.eventType),
    step: optionalText(payload?.step),
    content: optionalText(payload?.content),
    data: payload?.payload ?? payload?.data,
    raw: event.payload,
    createdAt: text(payload?.createdAt ?? event.createdAt, event.createdAt),
  };
}

function extractKnowledgeHits(data: Record<string, unknown>) {
  const buckets = [
    "strongRules",
    "defaultRules",
    "referenceCases",
    "designPatterns",
    "prdWritingRules",
    "prototypeRules",
    "businessConcepts",
  ];
  return buckets.flatMap((key) => arrayOfRecords(data[key]));
}

function extractQaIssues(data: Record<string, unknown>) {
  const direct = arrayOfRecords(data.issues);
  if (direct.length) return direct;
  const qaReport = asRecord(data.qaReport) ?? asRecord(data.report);
  return qaReport ? arrayOfRecords(qaReport.issues) : [];
}

function extractQaGate(data: Record<string, unknown>) {
  return asRecord(data.qaGate) ?? asRecord(asRecord(data.qaReport)?.gate) ?? asRecord(asRecord(data.report)?.gate);
}

function resolveDebugRiskLevel(input: {
  runStatus: string;
  qaGateStatus?: string;
  blockingIssueCount: number;
  majorIssueCount: number;
  minorIssueCount: number;
}) {
  if (
    input.runStatus === "failed"
    || input.qaGateStatus === "blocked"
    || input.blockingIssueCount > 0
    || input.majorIssueCount > 0
  ) {
    return "blocked";
  }
  if (
    input.qaGateStatus === "warning"
    || input.minorIssueCount > 0
  ) {
    return "warning";
  }
  return "healthy";
}

function uniqueRecords(items: Array<Record<string, unknown>>, ...keys: string[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keys.map((name) => text(item[name])).find(Boolean) ?? JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function arrayOfRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function countJsonArray(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function preview(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
