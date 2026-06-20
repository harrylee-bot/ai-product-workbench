import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ProjectStatus,
  RollbackRecordStatus,
  RollbackType,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { AgentRunLogService } from "./agent-run-log.service";
import type { ProductDesignState, RollbackRecord } from "./ai-vibe.types";
import { PrdWriterAgentService } from "./agents/prd-writer-agent.service";
import { PrototypeCodeAgentService } from "./agents/prototype-code-agent.service";
import { PrototypeDesignerAgentService } from "./agents/prototype-designer-agent.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { PrototypeService } from "./prototype.service";
import { QaService } from "./qa.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeStreamService } from "./vibe-stream.service";

type RollbackRecordRow = {
  id: string;
  projectId: string;
  rollbackType: RollbackType;
  fromProductDesignStateVersion: number;
  toProductDesignStateVersion: number;
  beforePrdDocumentId: string | null;
  afterPrdDocumentId: string | null;
  beforePrototypeArtifactId: string | null;
  afterPrototypeArtifactId: string | null;
  reason: string | null;
  status: RollbackRecordStatus;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class RollbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
    private readonly qaService: QaService,
    private readonly prdWriterAgent: PrdWriterAgentService,
    private readonly prototypeDesignerAgent: PrototypeDesignerAgentService,
    private readonly prototypeCodeAgent: PrototypeCodeAgentService,
    private readonly runLog: AgentRunLogService,
    private readonly stream: VibeStreamService,
  ) {}

  async rollbackProductDesignStateForUser(
    user: AuthenticatedUser,
    projectId: string,
    input: { targetVersion: number; reason?: string },
  ) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);

    const currentState = await this.stateService.getCurrentState(projectId);
    if (!currentState) throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    if (input.targetVersion >= currentState.version) {
      throw new BadRequestException("ROLLBACK_TARGET_VERSION_INVALID");
    }

    const conversationId = project.currentConversationId ?? await this.ensureConversationId(projectId, project.ownerId);
    const run = await this.runLog.createRun({
      projectId,
      conversationId,
      userId: user.id,
      userInput: `回滚 ProductDesignState 到 v${input.targetVersion}`,
    });

    const record = await this.prisma.rollbackRecord.create({
      data: {
        projectId,
        rollbackType: RollbackType.product_design_state,
        fromProductDesignStateVersion: currentState.version,
        toProductDesignStateVersion: currentState.version + 1,
        beforePrdDocumentId: project.currentPrdDocumentId,
        beforePrototypeArtifactId: project.currentPrototypeArtifactId,
        reason: input.reason,
        status: RollbackRecordStatus.running,
        generatedByRunId: run.id,
        createdBy: user.id,
      },
    });

    await this.stream.emit({
      runId: run.id,
      projectId,
      type: "rollback_started",
      data: { rollbackRecordId: record.id, targetVersion: input.targetVersion },
      content: "正在回滚 ProductDesignState...",
    });

    try {
      const restored = await this.stateService.restoreVersionSnapshotForProject(projectId, input.targetVersion, {
        userId: user.id,
        runId: run.id,
        reason: input.reason ?? `回滚到 ProductDesignState v${input.targetVersion}`,
      });
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "state_updated",
        step: "product_design",
        data: stateSummary(restored.state),
        content: `已恢复为 ProductDesignState v${restored.state.version}`,
      });
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "state_version_created",
        step: "product_design",
        data: { stateId: restored.state.id, version: restored.state.version },
      });

      const prdDraft = await this.prdWriterAgent.run({
        runId: run.id,
        projectId,
        traceId: run.traceId,
        userId: user.id,
        input: { productDesignState: restored.state, mode: "draft", generatedByRunId: run.id },
      });
      const prdDocument = await this.documentService.saveGeneratedDocument(restored.state, prdDraft.data, {
        userId: user.id,
        runId: run.id,
        reason: "回滚后重新生成 PRD",
      });
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "prd_updated",
        step: "prd_generation",
        data: prdDocument,
      });

      const prototypeSpec = await this.prototypeDesignerAgent.run({
        runId: run.id,
        projectId,
        traceId: run.traceId,
        userId: user.id,
        input: { productDesignState: restored.state, targetView: "both", generatedByRunId: run.id },
      });
      const prototypeDraft = await this.prototypeCodeAgent.run({
        runId: run.id,
        projectId,
        traceId: run.traceId,
        userId: user.id,
        input: { prototypeSpec: prototypeSpec.data, mode: "single_html", generatedByRunId: run.id },
      });
      const savedPrototype = await this.prototypeService.saveGeneratedPrototype(
        restored.state,
        prototypeSpec.data,
        prototypeDraft.data,
        {
          userId: user.id,
          runId: run.id,
          reason: "回滚后重新生成 HTML 原型",
        },
      );
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "prototype_updated",
        step: "prototype_code_generation",
        data: {
          prototypeSpec: savedPrototype.prototypeSpec,
          prototypeArtifact: savedPrototype.artifact,
        },
      });

      const stateWithArtifacts = await this.stateService.attachGeneratedArtifacts(restored.state.id, {
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        status: "prototype_ready",
        userId: user.id,
        runId: run.id,
        reason: "回滚后同步 PRD 与 PrototypeSpec",
      });

      const qaReport = await this.qaService.runForProject(projectId, user.id, {
        trigger: "rollback",
        runId: run.id,
        traceId: run.traceId,
        relatedRollbackId: record.id,
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        prototypeArtifact: savedPrototype.artifact,
      });
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "qa_completed",
        step: "qa_check",
        data: qaReport,
      });

      const completed = await this.prisma.rollbackRecord.update({
        where: { id: record.id },
        data: {
          status: RollbackRecordStatus.completed,
          toProductDesignStateVersion: stateWithArtifacts.version,
          afterPrdDocumentId: prdDocument.id,
          afterPrototypeArtifactId: savedPrototype.artifact.id,
        },
      });
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "rollback_completed",
        data: { rollbackRecordId: completed.id },
        content: "回滚、重新生成和 QA 已完成。",
      });

      const result = {
        rollbackRecord: this.toRollbackRecord(completed as RollbackRecordRow),
        productDesignState: stateWithArtifacts,
        prdDocument,
        prototypeArtifact: savedPrototype.artifact,
        qaReport,
      };
      await this.runLog.completeRun(run.id, result, "回滚、重新生成和 QA 已完成。");
      return result;
    } catch (error) {
      const failed = await this.prisma.rollbackRecord.update({
        where: { id: record.id },
        data: {
          status: RollbackRecordStatus.failed,
          errorMessage: error instanceof Error ? error.message : "ROLLBACK_FAILED",
        },
      });
      await this.runLog.failRun(run.id, error);
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "rollback_failed",
        data: {
          rollbackRecordId: failed.id,
          errorMessage: error instanceof Error ? error.message : "ROLLBACK_FAILED",
        },
        content: error instanceof Error ? error.message : "ROLLBACK_FAILED",
      });
      throw error;
    }
  }

  async listProjectRollbackRecords(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const items = await this.prisma.rollbackRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return { items: items.map((item) => this.toRollbackRecord(item as RollbackRecordRow)) };
  }

  toRollbackRecord(row: RollbackRecordRow): RollbackRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      rollbackType: row.rollbackType,
      fromProductDesignStateVersion: row.fromProductDesignStateVersion,
      toProductDesignStateVersion: row.toProductDesignStateVersion,
      beforePrdDocumentId: row.beforePrdDocumentId ?? undefined,
      afterPrdDocumentId: row.afterPrdDocumentId ?? undefined,
      beforePrototypeArtifactId: row.beforePrototypeArtifactId ?? undefined,
      afterPrototypeArtifactId: row.afterPrototypeArtifactId ?? undefined,
      reason: row.reason ?? undefined,
      status: row.status,
      generatedByRunId: row.generatedByRunId ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async ensureConversationId(projectId: string, ownerId: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: { projectId, deletedAt: null, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    if (existing) return existing.id;
    const created = await this.prisma.conversation.create({
      data: { projectId, ownerId, title: "默认会话" },
    });
    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentConversationId: created.id },
    });
    return created.id;
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
      throw new ForbiddenException("ROLLBACK_FORBIDDEN");
    }
    return project;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接回滚用户项目");
    }
  }
}

function stateSummary(state: ProductDesignState) {
  return {
    id: state.id,
    projectId: state.projectId,
    version: state.version,
    title: state.title,
    status: state.status,
    counts: {
      pages: state.pages.length,
      backendConfigs: state.backendConfigs.length,
      frontendRules: state.frontendRules.length,
      businessRules: state.businessRules.length,
      stateRules: state.stateRules.length,
      exceptionScenarios: state.exceptionScenarios.length,
      acceptanceCriteria: state.acceptanceCriteria.length,
      assumptions: state.assumptions.length,
      pendingQuestions: state.pendingQuestions.length,
      confirmedFacts: state.confirmedFacts.length,
    },
    updatedAt: state.updatedAt,
  };
}
