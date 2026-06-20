import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AgentName,
  AgentStepStatus,
  MessageType,
  PatchRecordStatus as PrismaPatchRecordStatus,
  ProductDesignStateStatus,
  ProjectStatus,
  UserIntent,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FileAssetService } from "../files/file-asset.service";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  AttachmentSummary,
  PatchPlan,
  PatchRecord,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeSpec,
  QAReport,
  RequirementDocument,
  SelectedRegion,
} from "./ai-vibe.types";
import { PatchAgentService } from "./agents/patch-agent.service";
import { PrdWriterAgentService } from "./agents/prd-writer-agent.service";
import { PrototypeCodeAgentService } from "./agents/prototype-code-agent.service";
import { PrototypeDesignerAgentService } from "./agents/prototype-designer-agent.service";
import { QaAgentService } from "./agents/qa-agent.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { PrototypeService } from "./prototype.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeStreamService } from "./vibe-stream.service";

type CreatePatchInput = {
  conversationId: string;
  selectedRegion: Record<string, unknown>;
  userInstruction: string;
  attachmentFileIds?: string[];
};

type PatchExecutionInput = {
  projectId: string;
  conversationId: string;
  userId: string;
  userInstruction: string;
  selectedRegion: SelectedRegion;
  attachments: AttachmentSummary[];
  runId: string;
  traceId: string;
  instructionMessageId: string;
};

type PatchRecordRow = {
  id: string;
  projectId: string;
  conversationId: string;
  instructionMessageId: string | null;
  selectedRegion: unknown;
  userInstruction: string;
  patchPlan: unknown;
  operations: unknown;
  status: PrismaPatchRecordStatus;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion: number | null;
  affectedPrdDocumentId: string | null;
  affectedPrototypeArtifactId: string | null;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messageService: MessageService,
    private readonly fileAssetService: FileAssetService,
    private readonly runLog: AgentRunLogService,
    private readonly stream: VibeStreamService,
    private readonly stateService: ProductDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
    private readonly patchAgent: PatchAgentService,
    private readonly prdWriterAgent: PrdWriterAgentService,
    private readonly prototypeDesignerAgent: PrototypeDesignerAgentService,
    private readonly prototypeCodeAgent: PrototypeCodeAgentService,
    private readonly qaAgent: QaAgentService,
  ) {}

  async createPatchForUser(user: AuthenticatedUser, projectId: string, input: CreatePatchInput) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    await this.assertConversation(projectId, input.conversationId);
    const selectedRegion = normalizeSelectedRegion(input.selectedRegion);
    const instruction = input.userInstruction.trim();
    if (!instruction) throw new BadRequestException("PATCH_INSTRUCTION_EMPTY");

    const attachmentFileIds = [...new Set(input.attachmentFileIds ?? [])];
    const attachments = await this.fileAssetService.getAttachmentSummaries(attachmentFileIds, projectId);
    if (attachmentFileIds.length !== attachments.length) {
      throw new ForbiddenException("附件不存在或无权访问");
    }

    const userMessage = await this.messageService.createUserMessage({
      projectId,
      conversationId: input.conversationId,
      userId: user.id,
      content: instruction,
      attachments: attachments.length ? toInputJson(attachments) : undefined,
      metadata: toInputJson({ selectedRegion, patchMode: true }),
    });
    await this.fileAssetService.attachFilesToMessage(
      attachmentFileIds,
      userMessage.id,
      projectId,
      input.conversationId,
    );

    const run = await this.runLog.createRun({
      projectId,
      conversationId: input.conversationId,
      userId: user.id,
      userInput: instruction,
    });
    await this.runLog.markRunIntent(
      run.id,
      selectedRegion.type === "prototype" ? UserIntent.patch_prototype : UserIntent.patch_document,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.designing, lastActivityAt: new Date() },
    });

    const result = await this.executePatch({
      projectId,
      conversationId: input.conversationId,
      userId: user.id,
      userInstruction: instruction,
      selectedRegion,
      attachments,
      runId: run.id,
      traceId: run.traceId,
      instructionMessageId: userMessage.id,
    });

    return {
      projectId,
      conversationId: input.conversationId,
      userMessage,
      assistantMessage: result.assistantMessage,
      runId: run.id,
      status: "completed",
      patchRecord: result.patchRecord,
      result: result.result,
    };
  }

  async listForProject(
    user: AuthenticatedUser,
    projectId: string,
    query: { status?: PrismaPatchRecordStatus; page?: number; pageSize?: number },
  ) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where = {
      projectId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.patchRecord.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.patchRecord.count({ where }),
    ]);
    return {
      items: items.map((item) => this.toPatchRecord(item as PatchRecordRow)),
      total,
      page,
      pageSize,
    };
  }

  async getPatchForUser(user: AuthenticatedUser, patchId: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    return { patchRecord: this.toPatchRecord(row as PatchRecordRow) };
  }

  async cancelForUser(user: AuthenticatedUser, patchId: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    this.assertOwnerMutation(user, row.project.ownerId);
    if (row.status !== PrismaPatchRecordStatus.planned && row.status !== PrismaPatchRecordStatus.needs_confirmation) {
      throw new BadRequestException("PATCH_CANNOT_CANCEL");
    }
    const updated = await this.prisma.patchRecord.update({
      where: { id: patchId },
      data: { status: PrismaPatchRecordStatus.cancelled },
    });
    return { patchRecord: this.toPatchRecord(updated as PatchRecordRow) };
  }

  async confirmForUser(user: AuthenticatedUser, patchId: string, confirmation: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    this.assertOwnerMutation(user, row.project.ownerId);
    if (row.status !== PrismaPatchRecordStatus.needs_confirmation) {
      throw new BadRequestException("PATCH_CONFIRMATION_NOT_REQUIRED");
    }
    const confirmationText = confirmation.trim();
    if (!confirmationText) throw new BadRequestException("PATCH_CONFIRMATION_EMPTY");
    const selectedRegion = normalizeSelectedRegion(recordFromJson(row.selectedRegion));
    const userMessage = await this.messageService.createUserMessage({
      projectId: row.projectId,
      conversationId: row.conversationId,
      userId: user.id,
      content: `确认局部修改：${confirmationText}`,
      metadata: toInputJson({ patchId, patchConfirmation: true }),
    });
    const run = await this.runLog.createRun({
      projectId: row.projectId,
      conversationId: row.conversationId,
      userId: user.id,
      userInput: `${row.userInstruction}\n\n用户确认：${confirmationText}`,
    });
    await this.runLog.markRunIntent(
      run.id,
      selectedRegion.type === "prototype" ? UserIntent.patch_prototype : UserIntent.patch_document,
    );
    await this.prisma.project.update({
      where: { id: row.projectId },
      data: { status: ProjectStatus.designing, lastActivityAt: new Date() },
    });

    const result = await this.executeConfirmedPatch(
      {
        projectId: row.projectId,
        conversationId: row.conversationId,
        userId: user.id,
        userInstruction: `${row.userInstruction}\n\n用户确认：${confirmationText}`,
        selectedRegion,
        attachments: [],
        runId: run.id,
        traceId: run.traceId,
        instructionMessageId: userMessage.id,
      },
      row as PatchRecordRow,
      confirmationText,
    );

    return {
      projectId: row.projectId,
      conversationId: row.conversationId,
      userMessage,
      assistantMessage: result.assistantMessage,
      runId: run.id,
      status: "completed",
      patchRecord: result.patchRecord,
      result: result.result,
    };
  }

  private async executePatch(input: PatchExecutionInput) {
    let patchRecord: PatchRecord | undefined;
    try {
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_started",
        content: "正在准备局部修改...",
      });

      const state = await this.stateService.getCurrentState(input.projectId);
      if (!state) throw new NotFoundException("PATCH_STATE_NOT_FOUND");

      const patch = await this.runAgentStep(
        input,
        AgentName.patch_agent,
        "patch_planning",
        () => this.patchAgent.run({
          runId: input.runId,
          projectId: input.projectId,
          traceId: input.traceId,
          userId: input.userId,
          input: {
            userInput: input.userInstruction,
            selectedRegion: input.selectedRegion,
            productDesignState: state,
            prdDocument: state.prdDocument,
            prototypeSpec: state.prototypeSpec,
          },
        }),
      );
      const plan = patch.data;
      const initialStatus = plan.needUserConfirm || plan.needsUserConfirmation
        ? PrismaPatchRecordStatus.needs_confirmation
        : PrismaPatchRecordStatus.planned;
      const createdRecord = await this.prisma.patchRecord.create({
        data: {
          projectId: input.projectId,
          conversationId: input.conversationId,
          instructionMessageId: input.instructionMessageId,
          selectedRegion: toInputJson(input.selectedRegion),
          userInstruction: input.userInstruction,
          patchPlan: toInputJson(plan),
          operations: toInputJson(plan.operations),
          status: initialStatus,
          beforeProductDesignStateVersion: state.version,
          generatedByRunId: input.runId,
          createdBy: input.userId,
        },
      });
      patchRecord = this.toPatchRecord(createdRecord as PatchRecordRow);
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_plan_created",
        step: "patch_planning",
        data: { patchId: patchRecord.id, patchPlan: plan },
        content: "局部修改计划已生成",
      });

      if (initialStatus === PrismaPatchRecordStatus.needs_confirmation) {
        const message = "局部修改需要进一步确认后再应用。";
        const assistantMessage = await this.messageService.createAssistantMessage({
          projectId: input.projectId,
          conversationId: input.conversationId,
          content: message,
          type: MessageType.agent_summary,
          metadata: toInputJson({ patchRecord, patchPlan: plan }),
          relatedRunId: input.runId,
        });
        await this.runLog.completeRun(input.runId, { patchRecord, patchPlan: plan }, message);
        await this.prisma.project.update({
          where: { id: input.projectId },
          data: { status: ProjectStatus.clarifying },
        });
        return {
          patchRecord,
          assistantMessage,
          result: patchConfirmationResult(patchRecord, plan),
        };
      }

      return await this.applyPatchPlan(input, patchRecord, plan, state);
    } catch (error) {
      await this.handlePatchFailure(input, patchRecord, error);
      throw error;
    }
  }

  private async executeConfirmedPatch(
    input: PatchExecutionInput,
    row: PatchRecordRow,
    confirmation: string,
  ) {
    let patchRecord: PatchRecord | undefined = this.toPatchRecord(row);
    try {
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_started",
        content: "正在根据确认继续局部修改...",
      });

      const state = await this.stateService.getCurrentState(input.projectId);
      if (!state) throw new NotFoundException("PATCH_STATE_NOT_FOUND");
      if (state.version !== row.beforeProductDesignStateVersion) {
        throw new BadRequestException("PATCH_STATE_VERSION_CHANGED");
      }

      const patch = await this.runAgentStep(
        input,
        AgentName.patch_agent,
        "patch_planning",
        () => this.patchAgent.run({
          runId: input.runId,
          projectId: input.projectId,
          traceId: input.traceId,
          userId: input.userId,
          input: {
            userInput: input.userInstruction,
            selectedRegion: input.selectedRegion,
            productDesignState: state,
            prdDocument: state.prdDocument,
            prototypeSpec: state.prototypeSpec,
          },
        }),
      );
      const plan: PatchPlan = {
        ...patch.data,
        needUserConfirm: Boolean(patch.data.needUserConfirm || patch.data.needsUserConfirmation),
        needsUserConfirmation: Boolean(patch.data.needUserConfirm || patch.data.needsUserConfirmation),
      };
      const needsConfirmation = plan.needUserConfirm || plan.needsUserConfirmation;
      const updatedRecord = await this.prisma.patchRecord.update({
        where: { id: row.id },
        data: {
          patchPlan: toInputJson({
            ...plan,
            userConfirmation: confirmation,
          }),
          operations: toInputJson(plan.operations),
          status: needsConfirmation ? PrismaPatchRecordStatus.needs_confirmation : PrismaPatchRecordStatus.planned,
          generatedByRunId: input.runId,
        },
      });
      patchRecord = this.toPatchRecord(updatedRecord as PatchRecordRow);
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_plan_created",
        step: "patch_planning",
        data: { patchId: patchRecord.id, patchPlan: plan },
        content: "局部修改计划已根据确认更新",
      });

      if (needsConfirmation) {
        const message = "局部修改仍需要进一步确认后再应用。";
        const assistantMessage = await this.messageService.createAssistantMessage({
          projectId: input.projectId,
          conversationId: input.conversationId,
          content: message,
          type: MessageType.agent_summary,
          metadata: toInputJson({ patchRecord, patchPlan: plan }),
          relatedRunId: input.runId,
        });
        await this.runLog.completeRun(input.runId, { patchRecord, patchPlan: plan }, message);
        await this.prisma.project.update({
          where: { id: input.projectId },
          data: { status: ProjectStatus.clarifying },
        });
        return {
          patchRecord,
          assistantMessage,
          result: patchConfirmationResult(patchRecord, plan),
        };
      }

      return await this.applyPatchPlan(input, patchRecord, plan, state);
    } catch (error) {
      await this.handlePatchFailure(input, patchRecord, error);
      throw error;
    }
  }

  private async applyPatchPlan(
    input: PatchExecutionInput,
    patchRecord: PatchRecord,
    plan: PatchPlan,
    beforeState: ProductDesignState,
  ) {
    let statePatchApplied = false;
    const projectSnapshot = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: {
        currentPrdDocumentId: true,
        currentPrototypeArtifactId: true,
        latestQaReportId: true,
      },
    });
    try {
      await this.prisma.patchRecord.update({
        where: { id: patchRecord.id },
        data: { status: PrismaPatchRecordStatus.applying },
      });
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_applying",
        step: "patch_planning",
        data: { patchId: patchRecord.id },
        content: "正在应用 ProductDesignState Patch...",
      });

      const patchedState = await this.stateService.applyPatch(input.projectId, beforeState, plan, {
        userId: input.userId,
        runId: input.runId,
        messageId: input.instructionMessageId,
      });
      statePatchApplied = true;
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "state_updated",
        step: "patch_planning",
        data: stateSummary(patchedState, patchRecord.id),
        content: `ProductDesignState v${patchedState.version} 已更新`,
      });
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "state_version_created",
        step: "patch_planning",
        data: { patchId: patchRecord.id, stateId: patchedState.id, version: patchedState.version },
      });

      const prdDraft = await this.runAgentStep(input, AgentName.prd_writer_agent, "prd_generation", () =>
        this.prdWriterAgent.run({
          runId: input.runId,
          projectId: input.projectId,
          traceId: input.traceId,
          userId: input.userId,
          input: { productDesignState: patchedState, mode: "draft" },
        }),
      );
      const prdDocument = await this.documentService.saveGeneratedDocument(patchedState, prdDraft.data, {
        userId: input.userId,
        runId: input.runId,
        reason: "Patch 后重新生成 PRD",
      });
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "prd_updated",
        step: "prd_generation",
        data: prdDocument,
      });

      const prototypeSpec = await this.runAgentStep(
        input,
        AgentName.prototype_designer_agent,
        "prototype_design",
        () => this.prototypeDesignerAgent.run({
          runId: input.runId,
          projectId: input.projectId,
          traceId: input.traceId,
          userId: input.userId,
          input: { productDesignState: patchedState, targetView: "both" },
        }),
      );
      const prototypeDraft = await this.runAgentStep(
        input,
        AgentName.prototype_code_agent,
        "prototype_code_generation",
        () => this.prototypeCodeAgent.run({
          runId: input.runId,
          projectId: input.projectId,
          traceId: input.traceId,
          userId: input.userId,
          input: { prototypeSpec: prototypeSpec.data, mode: "single_html" },
        }),
      );
      const savedPrototype = await this.prototypeService.saveGeneratedPrototype(
        patchedState,
        prototypeSpec.data,
        prototypeDraft.data,
        {
          userId: input.userId,
          runId: input.runId,
          reason: "Patch 后重新生成 HTML 原型",
        },
      );
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "prototype_updated",
        step: "prototype_code_generation",
        data: {
          prototypeSpec: savedPrototype.prototypeSpec,
          prototypeArtifact: savedPrototype.artifact,
        },
      });

      const stateWithArtifacts = await this.stateService.attachGeneratedArtifacts(patchedState.id, {
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        status: ProductDesignStateStatus.prototype_ready,
        userId: input.userId,
        runId: input.runId,
        messageId: input.instructionMessageId,
        reason: "Patch 后同步 PRD 与 PrototypeSpec",
      });

      const qa = await this.runAgentStep(input, AgentName.qa_agent, "qa_check", () =>
        this.qaAgent.run({
          runId: input.runId,
          projectId: input.projectId,
          traceId: input.traceId,
          userId: input.userId,
          input: {
            productDesignState: stateWithArtifacts,
            prdDocument,
            prototypeSpec: prototypeSpec.data,
            patchPlan: plan,
          },
        }),
      );
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "qa_completed",
        step: "qa_check",
        data: qa.data,
      });

      const finalRecord = await this.prisma.patchRecord.update({
        where: { id: patchRecord.id },
        data: {
          status: PrismaPatchRecordStatus.applied,
          afterProductDesignStateVersion: stateWithArtifacts.version,
          affectedPrdDocumentId: prdDocument.id,
          affectedPrototypeArtifactId: savedPrototype.artifact.id,
        },
      });
      patchRecord = this.toPatchRecord(finalRecord as PatchRecordRow);

      const message = qa.data.passed
        ? "局部修改已应用，PRD、HTML 原型和 QA 已同步更新。"
        : `局部修改已应用，QA 发现 ${qa.data.issues.length} 个待确认问题。`;
      const result = {
        productDesignState: stateWithArtifacts,
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        prototypeArtifact: savedPrototype.artifact,
        qaReport: qa.data,
        patchRecord,
        patchPlan: plan,
      };
      const assistantMessage = await this.messageService.createAssistantMessage({
        projectId: input.projectId,
        conversationId: input.conversationId,
        content: message,
        type: MessageType.agent_summary,
        metadata: toInputJson(result),
        relatedRunId: input.runId,
        relatedPrdDocumentId: prdDocument.id,
        relatedPrototypeArtifactId: savedPrototype.artifact.id,
      });
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_completed",
        step: "qa_check",
        data: { patchRecord, result },
        content: message,
      });
      await this.runLog.completeRun(input.runId, result, message);
      await this.prisma.project.update({
        where: { id: input.projectId },
        data: { status: qa.data.passed ? ProjectStatus.prototype_ready : ProjectStatus.qa_failed },
      });
      return { patchRecord, assistantMessage, result };
    } catch (error) {
      if (statePatchApplied) {
        const rollback = await this.stateService.restoreStateAfterPatchFailure(input.projectId, beforeState, {
          userId: input.userId,
          runId: input.runId,
          messageId: input.instructionMessageId,
          reason: "Patch 执行失败，恢复到修改前版本",
        });
        await this.prisma.patchRecord.update({
          where: { id: patchRecord.id },
          data: {
            afterProductDesignStateVersion: rollback.state.version,
          },
        });
        await this.prisma.project.update({
          where: { id: input.projectId },
          data: {
            currentPrdDocumentId: projectSnapshot?.currentPrdDocumentId ?? null,
            currentPrototypeArtifactId: projectSnapshot?.currentPrototypeArtifactId ?? null,
            latestQaReportId: projectSnapshot?.latestQaReportId ?? null,
          },
        });
        await this.stream.emit({
          runId: input.runId,
          projectId: input.projectId,
          type: "state_updated",
          data: {
            ...stateSummary(rollback.state, patchRecord.id),
            rollback: true,
          },
          content: `Patch 失败，已恢复到修改前状态 v${beforeState.version}`,
        });
      }
      throw error;
    }
  }

  private async handlePatchFailure(
    input: Pick<PatchExecutionInput, "runId" | "projectId">,
    patchRecord: PatchRecord | undefined,
    error: unknown,
  ) {
    let failedRecord = patchRecord;
    if (patchRecord) {
      const failed = await this.prisma.patchRecord.update({
        where: { id: patchRecord.id },
        data: {
          status: PrismaPatchRecordStatus.failed,
          errorMessage: error instanceof Error ? error.message : "PATCH_FAILED",
        },
      });
      failedRecord = this.toPatchRecord(failed as PatchRecordRow);
    }
    await this.runLog.failRun(input.runId, error);
    await this.prisma.project.update({
      where: { id: input.projectId },
      data: { status: ProjectStatus.qa_failed },
    });
    await this.stream.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "patch_failed",
      data: {
        patchId: failedRecord?.id,
        errorMessage: error instanceof Error ? error.message : "PATCH_FAILED",
      },
      content: error instanceof Error ? error.message : "PATCH_FAILED",
    });
  }

  private async runAgentStep<T>(
    input: { runId: string; projectId: string; userInstruction: string },
    agentName: AgentName,
    step: NonNullable<Parameters<VibeStreamService["emit"]>[0]["step"]>,
    handler: () => Promise<{ data: T; modelCallLogId?: string }>,
  ) {
    const stepLog = await this.runLog.createStep({
      runId: input.runId,
      agentName,
      inputSummary: `${agentName}: ${input.userInstruction}`,
      status: AgentStepStatus.pending,
    });
    await this.runLog.startStep(stepLog.id);
    await this.stream.emit({
      runId: input.runId,
      projectId: input.projectId,
      type: "step_started",
      step,
      content: stepCopy(step, "started"),
    });
    try {
      const result = await handler();
      await this.runLog.completeStep(stepLog.id, result.data, {
        modelCallLogId: result.modelCallLogId,
      });
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "step_completed",
        step,
        content: stepCopy(step, "completed"),
        data: result.data,
      });
      return result;
    } catch (error) {
      await this.runLog.failStep(stepLog.id, error);
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "step_failed",
        step,
        content: error instanceof Error ? error.message : "Agent 执行失败",
      });
      throw error;
    }
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
      throw new ForbiddenException("PATCH_FORBIDDEN");
    }
    return project;
  }

  private async assertConversation(projectId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, projectId, deletedAt: null },
    });
    if (!conversation) throw new NotFoundException("PATCH_CONVERSATION_NOT_FOUND");
    return conversation;
  }

  private async getAccessiblePatch(user: AuthenticatedUser, patchId: string) {
    const patch = await this.prisma.patchRecord.findUnique({
      where: { id: patchId },
      include: { project: true },
    });
    if (!patch || patch.project.deletedAt || patch.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("PATCH_RECORD_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && patch.project.ownerId !== user.id) {
      throw new ForbiddenException("PATCH_FORBIDDEN");
    }
    return patch;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户项目 Patch");
    }
  }

  private toPatchRecord(row: PatchRecordRow): PatchRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      conversationId: row.conversationId,
      instructionMessageId: row.instructionMessageId ?? undefined,
      selectedRegion: row.selectedRegion as SelectedRegion,
      userInstruction: row.userInstruction,
      patchPlan: row.patchPlan as PatchPlan,
      operations: Array.isArray(row.operations) ? row.operations as PatchPlan["operations"] : [],
      status: row.status,
      beforeProductDesignStateVersion: row.beforeProductDesignStateVersion,
      afterProductDesignStateVersion: row.afterProductDesignStateVersion ?? undefined,
      affectedPrdDocumentId: row.affectedPrdDocumentId ?? undefined,
      affectedPrototypeArtifactId: row.affectedPrototypeArtifactId ?? undefined,
      generatedByRunId: row.generatedByRunId ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function normalizeSelectedRegion(value: Record<string, unknown>): SelectedRegion {
  const type = value.type === "prototype" ? "prototype" : "document";
  const targetId = text(value.targetId) || text(value.documentId) || text(value.artifactId);
  if (!targetId) throw new BadRequestException("PATCH_SELECTED_REGION_INVALID");
  return {
    type,
    targetId,
    documentId: text(value.documentId) || (type === "document" ? targetId : undefined),
    artifactId: text(value.artifactId) || (type === "prototype" ? targetId : undefined),
    sectionId: text(value.sectionId) || undefined,
    blockId: text(value.blockId) || undefined,
    pageId: text(value.pageId) || undefined,
    componentId: text(value.componentId) || undefined,
    domSelector: text(value.domSelector) || undefined,
    label: text(value.label) || undefined,
    selectedText: text(value.selectedText) || undefined,
    sourcePaths: arrayOfText(value.sourcePaths),
    bbox: normalizeBox(value.bbox),
    boundingBox: normalizeBox(value.boundingBox),
    screenshotUrl: text(value.screenshotUrl) || undefined,
  };
}

function recordFromJson(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("PATCH_SELECTED_REGION_INVALID");
  }
  return value as Record<string, unknown>;
}

function patchConfirmationResult(patchRecord: PatchRecord, plan: PatchPlan) {
  return {
    patchRecord,
    patchPlan: plan,
    nextAction: {
      type: "confirm_patch",
      questions: plan.clarificationQuestions ?? [],
      risks: plan.risks ?? [],
    },
  };
}

function normalizeBox(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if ([x, y, width, height].some((number) => !Number.isFinite(number))) return undefined;
  return { x, y, width, height };
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function stateSummary(state: ProductDesignState, patchId: string) {
  return {
    patchId,
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

function stepCopy(step: string, status: "started" | "completed") {
  const textMap: Record<string, [string, string]> = {
    patch_planning: ["正在分析局部修改...", "局部修改计划已完成"],
    prd_generation: ["正在重新生成 PRD...", "PRD 已更新"],
    prototype_design: ["正在重新生成原型规格...", "原型规格已更新"],
    prototype_code_generation: ["正在重新生成 HTML 原型...", "HTML 原型已更新"],
    qa_check: ["正在执行 Patch 后 QA...", "QA 校验完成"],
  };
  return textMap[step]?.[status === "started" ? 0 : 1] ?? step;
}
