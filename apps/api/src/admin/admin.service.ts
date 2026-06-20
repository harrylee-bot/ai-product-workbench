import { Injectable, NotFoundException } from "@nestjs/common";
import {
  AgentStepStatus,
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
  ListAgentRunsQueryDto,
  ListFileParsesQueryDto,
  ListPatchesQueryDto,
  ListQaReportsQueryDto,
} from "./admin.dto";
import { normalizePagination } from "./admin-audit.service";

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardStats() {
    const todayStart = startOfToday();
    const [
      userCount,
      projectCount,
      todayAgentRunCount,
      todayModelCallCount,
      todayFailedModelCallCount,
      pendingKnowledgeCandidateCount,
      failedFileParseCount,
      qaFailedProjectCount,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.project.count({ where: { deletedAt: null } }),
      this.prisma.agentRunLog.count({ where: { startedAt: { gte: todayStart } } }),
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
      todayAgentRunCount,
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
          _count: { select: { conversations: true, agentRuns: true, patchRecords: true, fileAssets: true } },
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
        agentRunCount: project._count.agentRuns,
        patchCount: project._count.patchRecords,
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
          select: { conversations: true, messages: true, agentRuns: true, patchRecords: true, fileAssets: true },
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

  async listProjectRuns(projectId: string, query: ListAgentRunsQueryDto) {
    return this.listAgentRuns({ ...query, projectId });
  }

  async listProjectPatches(projectId: string, query: ListPatchesQueryDto) {
    return this.listPatches({ ...query, projectId });
  }

  async listProjectFiles(projectId: string, query: ListFileParsesQueryDto) {
    return this.listFileParses({ ...query, projectId });
  }

  async listProjectQaReports(projectId: string, query: ListQaReportsQueryDto) {
    return this.listQaReports({ ...query, projectId });
  }

  async listAgentRuns(query: ListAgentRunsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.AgentRunLogWhereInput = {
      projectId: query.projectId,
      userId: query.userId,
      status: query.status,
      traceId: query.traceId,
      ...(query.agentName ? { steps: { some: { agentName: query.agentName } } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentRunLog.findMany({
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
      this.prisma.agentRunLog.count({ where }),
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
        currentStep: run.steps[0]?.agentName,
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

  async getAgentRun(runId: string) {
    const run = await this.prisma.agentRunLog.findUnique({
      where: { id: runId },
      include: {
        project: { select: { id: true, title: true } },
        user: { select: { id: true, username: true, displayName: true } },
        conversation: { select: { id: true, title: true } },
        steps: { orderBy: [{ startedAt: "asc" }, { id: "asc" }] },
        streamEvents: { orderBy: { createdAt: "asc" }, take: 100 },
      },
    });
    if (!run) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");

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
      steps: run.steps.map((step) => ({
        id: step.id,
        agentName: step.agentName,
        status: step.status,
        inputSummary: step.inputSummary,
        outputSummary: step.outputSummary ?? undefined,
        modelCallLogId: step.modelCallLogId ?? undefined,
        modelProviderId: step.modelProviderId ?? undefined,
        modelName: step.modelName ?? undefined,
        tokenUsage: step.tokenUsage ?? undefined,
        startedAt: step.startedAt?.toISOString(),
        endedAt: step.endedAt?.toISOString(),
        durationMs: step.durationMs ?? undefined,
        errorMessage: step.errorMessage ?? undefined,
      })),
      events: run.streamEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async listModelCalls(query: ListAdminModelCallsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.ModelCallLogWhereInput = {
      taskType: query.taskType,
      agentName: query.agentName,
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
        agentStepLogs: {
          select: { id: true, runId: true, agentName: true, status: true },
          take: 20,
        },
      },
    });
    if (!log) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");
    return {
      ...this.toModelCallItem(log),
      inputSummary: log.inputSummary ?? undefined,
      outputSummary: log.outputSummary ?? undefined,
      agentStepLogs: log.agentStepLogs,
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

  async listPatches(query: ListPatchesQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.PatchRecordWhereInput = {
      projectId: query.projectId,
      createdBy: query.createdBy,
      status: query.status,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.patchRecord.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          project: { select: { id: true, title: true } },
          conversation: { select: { id: true, title: true } },
        },
      }),
      this.prisma.patchRecord.count({ where }),
    ]);

    return {
      items: items.map((patch) => ({
        id: patch.id,
        patchId: patch.id,
        projectId: patch.projectId,
        projectTitle: patch.project.title,
        conversationId: patch.conversationId,
        conversationTitle: patch.conversation.title,
        createdBy: patch.createdBy,
        targetSummary: selectedRegionSummary(patch.selectedRegion),
        instructionSummary: preview(patch.userInstruction, 120),
        status: patch.status,
        beforeProductDesignStateVersion: patch.beforeProductDesignStateVersion,
        afterProductDesignStateVersion: patch.afterProductDesignStateVersion ?? undefined,
        affectedPrdDocumentId: patch.affectedPrdDocumentId ?? undefined,
        affectedPrototypeArtifactId: patch.affectedPrototypeArtifactId ?? undefined,
        generatedByRunId: patch.generatedByRunId ?? undefined,
        errorMessage: patch.errorMessage ?? undefined,
        createdAt: patch.createdAt.toISOString(),
        updatedAt: patch.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async getPatch(patchId: string) {
    const patch = await this.prisma.patchRecord.findUnique({
      where: { id: patchId },
      include: {
        project: { select: { id: true, title: true } },
        conversation: { select: { id: true, title: true } },
      },
    });
    if (!patch) throw new NotFoundException("ADMIN_LOG_NOT_FOUND");

    return {
      id: patch.id,
      projectId: patch.projectId,
      projectTitle: patch.project.title,
      conversationId: patch.conversationId,
      conversationTitle: patch.conversation.title,
      instructionMessageId: patch.instructionMessageId ?? undefined,
      selectedRegion: patch.selectedRegion,
      userInstruction: patch.userInstruction,
      patchPlan: patch.patchPlan,
      operations: patch.operations,
      status: patch.status,
      beforeProductDesignStateVersion: patch.beforeProductDesignStateVersion,
      afterProductDesignStateVersion: patch.afterProductDesignStateVersion ?? undefined,
      affectedPrdDocumentId: patch.affectedPrdDocumentId ?? undefined,
      affectedPrototypeArtifactId: patch.affectedPrototypeArtifactId ?? undefined,
      generatedByRunId: patch.generatedByRunId ?? undefined,
      errorMessage: patch.errorMessage ?? undefined,
      createdBy: patch.createdBy,
      createdAt: patch.createdAt.toISOString(),
      updatedAt: patch.updatedAt.toISOString(),
    };
  }

  async listQaReports(query: ListQaReportsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.VibeStreamEventLogWhereInput = {
      projectId: query.projectId,
      eventType: "qa_completed",
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.vibeStreamEventLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { project: { select: { id: true, title: true, status: true } } },
      }),
      this.prisma.vibeStreamEventLog.count({ where }),
    ]);

    return {
      items: items.map((event) => {
        const report = extractQaReport(event.payload);
        return {
          id: event.id,
          qaReportId: event.id,
          projectId: event.projectId,
          projectTitle: event.project.title,
          projectStatus: event.project.status,
          runId: event.runId,
          status: report?.passed === false ? "failed" : "passed",
          issueCount: report?.issues.length ?? 0,
          criticalIssueCount: report?.issues.filter((issue) => issue.severity === "critical").length ?? 0,
          summary: report?.summary,
          createdAt: event.createdAt.toISOString(),
        };
      }),
      total,
      page,
      pageSize,
    };
  }

  async getQaReport(qaReportId: string) {
    const event = await this.prisma.vibeStreamEventLog.findUnique({
      where: { id: qaReportId },
      include: { project: { select: { id: true, title: true, status: true } } },
    });
    if (!event || event.eventType !== "qa_completed") throw new NotFoundException("ADMIN_LOG_NOT_FOUND");
    const report = extractQaReport(event.payload);

    return {
      id: event.id,
      qaReportId: event.id,
      projectId: event.projectId,
      projectTitle: event.project.title,
      projectStatus: event.project.status,
      runId: event.runId,
      status: report?.passed === false ? "failed" : "passed",
      issueCount: report?.issues.length ?? 0,
      criticalIssueCount: report?.issues.filter((issue) => issue.severity === "critical").length ?? 0,
      summary: report?.summary,
      report: report ?? event.payload,
      createdAt: event.createdAt.toISOString(),
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
      agentName: log.agentName ?? undefined,
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

function countJsonArray(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function preview(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function selectedRegionSummary(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "ProductDesignState";
  const record = value as Record<string, unknown>;
  return String(record.type ?? record.path ?? record.target ?? "ProductDesignState");
}

type QaIssue = { severity?: string };

function extractQaReport(payload: unknown): { passed?: boolean; summary?: string; issues: QaIssue[] } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const eventPayload = record.payload && typeof record.payload === "object"
    ? (record.payload as Record<string, unknown>)
    : record;
  const data = eventPayload.data && typeof eventPayload.data === "object"
    ? (eventPayload.data as Record<string, unknown>)
    : eventPayload;
  return {
    passed: typeof data.passed === "boolean" ? data.passed : undefined,
    summary: typeof data.summary === "string" ? data.summary : undefined,
    issues: Array.isArray(data.issues) ? (data.issues as QaIssue[]) : [],
  };
}
