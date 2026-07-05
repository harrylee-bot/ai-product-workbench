import { Injectable, NotFoundException } from "@nestjs/common";
import { FileAssetStatus, KnowledgeCandidateStatus, ModelCallStatus, Prisma, QAReportStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  ListAdminConversationsQueryDto,
  ListAdminModelCallsQueryDto,
  ListRuntimeRunsQueryDto,
  ListFileParsesQueryDto,
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
      conversationCount,
      todayRuntimeRunCount,
      todayModelCallCount,
      todayFailedModelCallCount,
      pendingKnowledgeCandidateCount,
      failedFileParseCount,
      qaFailedReportCount,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.conversation.count({ where: { deletedAt: null } }),
      this.prisma.runtimeRunLog.count({ where: { startedAt: { gte: todayStart } } }),
      this.prisma.modelCallLog.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.modelCallLog.count({
        where: { status: ModelCallStatus.failed, createdAt: { gte: todayStart } },
      }),
      this.prisma.knowledgeCandidate.count({ where: { status: KnowledgeCandidateStatus.pending } }),
      this.prisma.fileAsset.count({
        where: { status: FileAssetStatus.parse_failed, deletedAt: null },
      }),
      this.prisma.qAReport.count({ where: { status: QAReportStatus.failed } }),
    ]);

    return {
      userCount,
      conversationCount,
      todayRuntimeRunCount,
      todayModelCallCount,
      todayFailedModelCallCount,
      pendingKnowledgeCandidateCount,
      failedFileParseCount,
      qaFailedReportCount,
    };
  }

  async listConversations(query: ListAdminConversationsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const keyword = query.keyword?.trim();
    const owner = query.owner?.trim();
    const where: Prisma.ConversationWhereInput = {
      ...(query.status ? { status: query.status } : { deletedAt: null }),
      ...(keyword
        ? {
            OR: [
              { title: { contains: keyword, mode: "insensitive" } },
              { summary: { contains: keyword, mode: "insensitive" } },
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
      this.prisma.conversation.findMany({
        where,
        include: { owner: true, _count: { select: { messages: true, fileAssets: true, qaReports: true } } },
        orderBy: { lastActivityAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return {
      items: items.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        summary: conversation.summary,
        status: conversation.status,
        ownerId: conversation.ownerId,
        ownerName: conversation.owner.displayName ?? conversation.owner.username ?? conversation.owner.email,
        messageCount: conversation.messageCount,
        fileCount: conversation._count.fileAssets,
        qaReportCount: conversation._count.qaReports,
        lastActivityAt: conversation.lastActivityAt.toISOString(),
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    };
  }

  async getConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        owner: true,
        _count: { select: { messages: true, fileAssets: true, qaReports: true, runtimeRuns: true } },
      },
    });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    return {
      id: conversation.id,
      title: conversation.title,
      summary: conversation.summary,
      status: conversation.status,
      ownerId: conversation.ownerId,
      ownerName: conversation.owner.displayName ?? conversation.owner.username ?? conversation.owner.email,
      currentDesignStateId: conversation.currentDesignStateId,
      currentPrdDocumentId: conversation.currentPrdDocumentId,
      currentPrototypeArtifactId: conversation.currentPrototypeArtifactId,
      latestQaReportId: conversation.latestQaReportId,
      counts: conversation._count,
      lastActivityAt: conversation.lastActivityAt.toISOString(),
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }

  listConversationRuns(conversationId: string, query: ListRuntimeRunsQueryDto) {
    return this.listRuntimeRuns({ ...query, conversationId });
  }

  listConversationFiles(conversationId: string, query: ListFileParsesQueryDto) {
    return this.listFileParses({ ...query, conversationId });
  }

  listConversationQaReports(conversationId: string, query: ListQaReportsQueryDto) {
    return this.listQaReports({ ...query, conversationId });
  }

  async listRuntimeRuns(query: ListRuntimeRunsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.RuntimeRunLogWhereInput = {
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.traceId ? { traceId: query.traceId } : {}),
      ...(query.runtimeName ? { steps: { some: { runtimeName: query.runtimeName } } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.runtimeRunLog.findMany({
        where,
        include: { conversation: true, user: true, _count: { select: { steps: true, streamEvents: true } } },
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.runtimeRunLog.count({ where }),
    ]);
    return {
      items: items.map((run) => ({
        id: run.id,
        conversationId: run.conversationId,
        conversationTitle: run.conversation.title,
        userId: run.userId,
        userName: run.user.displayName ?? run.user.username ?? run.user.email,
        intent: run.intent,
        status: run.status,
        inputSummary: run.inputSummary,
        outputSummary: run.outputSummary,
        errorMessage: run.errorMessage,
        traceId: run.traceId,
        stepCount: run._count.steps,
        streamEventCount: run._count.streamEvents,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString(),
        durationMs: run.durationMs,
      })),
      page,
      pageSize,
      total,
    };
  }

  async getRuntimeRun(runId: string) {
    const run = await this.prisma.runtimeRunLog.findUnique({
      where: { id: runId },
      include: {
        conversation: true,
        user: true,
        steps: { orderBy: { startedAt: "asc" }, include: { modelCallLog: true } },
        streamEvents: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!run) throw new NotFoundException("RUNTIME_RUN_NOT_FOUND");
    return {
      id: run.id,
      conversationId: run.conversationId,
      conversationTitle: run.conversation.title,
      userId: run.userId,
      userName: run.user.displayName ?? run.user.username ?? run.user.email,
      intent: run.intent,
      status: run.status,
      inputSummary: run.inputSummary,
      outputSummary: run.outputSummary,
      result: run.result,
      errorMessage: run.errorMessage,
      traceId: run.traceId,
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString(),
      durationMs: run.durationMs,
      steps: run.steps.map((step) => ({ ...step, startedAt: step.startedAt?.toISOString(), endedAt: step.endedAt?.toISOString() })),
      streamEvents: run.streamEvents.map((event) => ({
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
      ...(query.taskType ? { taskType: query.taskType } : {}),
      ...(query.runtimeName ? { runtimeName: query.runtimeName } : {}),
      ...(query.modelName ? { modelName: { contains: query.modelName, mode: "insensitive" } } : {}),
      ...(query.providerId ? { providerId: query.providerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.traceId ? { traceId: query.traceId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.modelCallLog.findMany({
        where,
        include: { provider: true, modelConfig: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.modelCallLog.count({ where }),
    ]);
    return { items: items.map((item) => this.toModelCallItem(item)), page, pageSize, total };
  }

  async getModelCall(logId: string) {
    const log = await this.prisma.modelCallLog.findUnique({
      where: { id: logId },
      include: { provider: true, modelConfig: true },
    });
    if (!log) throw new NotFoundException("MODEL_CALL_NOT_FOUND");
    return this.toModelCallItem(log);
  }

  async listFileParses(query: ListFileParsesQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.FileAssetWhereInput = {
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.uploadedBy ? { uploadedBy: query.uploadedBy } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.extension ? { extension: query.extension } : {}),
      deletedAt: null,
      ...(query.parserType ? { parseResult: { parserType: query.parserType } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.fileAsset.findMany({
        where,
        include: { conversation: true, uploader: true, parseResult: true, _count: { select: { chunks: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.fileAsset.count({ where }),
    ]);
    return {
      items: items.map((file) => ({
        id: file.id,
        conversationId: file.conversationId,
        conversationTitle: file.conversation.title,
        uploadedBy: file.uploadedBy,
        uploaderName: file.uploader.displayName ?? file.uploader.username ?? file.uploader.email,
        originalName: file.originalName,
        mimeType: file.mimeType,
        extension: file.extension,
        size: file.size,
        status: file.status,
        parseResult: file.parseResult,
        chunkCount: file._count.chunks,
        createdAt: file.createdAt.toISOString(),
        updatedAt: file.updatedAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    };
  }

  async getFileParse(fileId: string) {
    const file = await this.prisma.fileAsset.findUnique({
      where: { id: fileId },
      include: { conversation: true, uploader: true, parseResult: true, chunks: { orderBy: { chunkIndex: "asc" } } },
    });
    if (!file) throw new NotFoundException("FILE_NOT_FOUND");
    return {
      id: file.id,
      conversationId: file.conversationId,
      conversationTitle: file.conversation.title,
      uploadedBy: file.uploadedBy,
      uploaderName: file.uploader.displayName ?? file.uploader.username ?? file.uploader.email,
      originalName: file.originalName,
      mimeType: file.mimeType,
      extension: file.extension,
      size: file.size,
      status: file.status,
      parseResult: file.parseResult,
      chunks: file.chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        sourceType: chunk.sourceType,
        sourceRef: chunk.sourceRef,
        tokenEstimate: chunk.tokenEstimate,
        preview: preview(chunk.content),
      })),
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  async listQaReports(query: ListQaReportsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.QAReportWhereInput = {
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.trigger ? { trigger: query.trigger } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.qAReport.findMany({
        where,
        include: { conversation: true },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.qAReport.count({ where }),
    ]);
    return {
      items: items.map((report) => ({
        id: report.id,
        conversationId: report.conversationId,
        conversationTitle: report.conversation.title,
        status: report.status,
        trigger: report.trigger,
        summary: report.summary,
        blockingCount: report.blockingCount,
        majorCount: report.majorCount,
        minorCount: report.minorCount,
        infoCount: report.infoCount,
        generatedByRunId: report.generatedByRunId,
        createdAt: report.createdAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    };
  }

  async getQaReport(qaReportId: string) {
    const report = await this.prisma.qAReport.findUnique({
      where: { id: qaReportId },
      include: { conversation: true },
    });
    if (!report) throw new NotFoundException("QA_REPORT_NOT_FOUND");
    return {
      id: report.id,
      conversationId: report.conversationId,
      conversationTitle: report.conversation.title,
      conversationDesignStateId: report.conversationDesignStateId,
      conversationDesignStateVersion: report.conversationDesignStateVersion,
      prdDocumentId: report.prdDocumentId,
      prototypeArtifactId: report.prototypeArtifactId,
      prototypeSpecId: report.prototypeSpecId,
      status: report.status,
      trigger: report.trigger,
      checkTypes: report.checkTypes,
      summary: report.summary,
      issues: report.issues,
      blockingCount: report.blockingCount,
      majorCount: report.majorCount,
      minorCount: report.minorCount,
      infoCount: report.infoCount,
      generatedByRunId: report.generatedByRunId,
      createdBy: report.createdBy,
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    };
  }

  private toModelCallItem(log: {
    id: string;
    traceId: string | null;
    runId: string | null;
    runtimeName: string | null;
    taskType: string;
    modelName: string;
    status: string;
    inputSummary: string | null;
    outputSummary: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
    provider: { id: string; name: string; type: string };
    modelConfig: { id: string; displayName: string };
  }) {
    return {
      id: log.id,
      traceId: log.traceId,
      runId: log.runId,
      runtimeName: log.runtimeName,
      taskType: log.taskType,
      providerId: log.provider.id,
      providerName: log.provider.name,
      providerType: log.provider.type,
      modelConfigId: log.modelConfig.id,
      modelDisplayName: log.modelConfig.displayName,
      modelName: log.modelName,
      status: log.status,
      inputSummary: log.inputSummary,
      outputSummary: log.outputSummary,
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
      totalTokens: log.totalTokens,
      durationMs: log.durationMs,
      errorCode: log.errorCode,
      errorMessage: log.errorMessage,
      createdAt: log.createdAt.toISOString(),
      completedAt: log.completedAt?.toISOString(),
    };
  }
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function preview(content: string, length = 200) {
  return content.length > length ? `${content.slice(0, length)}...` : content;
}
