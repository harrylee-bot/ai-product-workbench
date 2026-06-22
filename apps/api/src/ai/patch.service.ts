import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AgentName,
  AgentStepStatus,
  KnowledgeType,
  MessageType,
  PatchRecordStatus as PrismaPatchRecordStatus,
  ProductDesignStateStatus,
  ProjectStatus,
  UserIntent,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FileAssetService } from "../files/file-asset.service";
import { KnowledgeRetrievalService } from "../knowledge/knowledge-retrieval.service";
import { MessageService } from "../projects/message.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { fallbackStepOutput } from "./agent-fallback-policy";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  AgentOutput,
  AttachmentSummary,
  KnowledgeContext,
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
import {
  assertStateOnlyPatchOperations,
  toPatchPlanOperation,
} from "./product-evolution.helpers";
import type { EvolutionPatchOperation } from "./product-evolution.types";
import { PrototypeService } from "./prototype.service";
import { QaService } from "./qa.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeStreamService } from "./vibe-stream.service";

type CreatePatchInput = {
  conversationId: string;
  selectedRegion: Record<string, unknown>;
  userInstruction: string;
  attachmentFileIds?: string[];
};

type CreatePatchCandidateInput = CreatePatchInput & {
  source?: "prd_edit" | "prd_rewrite" | "prd_diff" | "prototype_edit" | "prototype_restructure" | "prototype_flow_update" | "inline_edit";
  interactionEvent?: Record<string, unknown>;
};

type ApplyEvolutionPlanInput = {
  evolutionPlanId: string;
  conversationId?: string;
  reason: string;
  operations: EvolutionPatchOperation[];
  impactedAreas?: string[];
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
  relatedQaReportId: string | null;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type PatchPreviewRow = {
  id: string;
  projectId: string;
  patchRecordId: string;
  status: string;
  beforeProductDesignStateVersion: number;
  afterProductDesignStateVersion: number | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  diff: unknown;
  riskPanel: unknown;
  patchPlan: unknown;
  operations: unknown;
  message: string | null;
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
    private readonly knowledgeRetrieval: KnowledgeRetrievalService,
    private readonly stateService: ProductDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
    private readonly qaService: QaService,
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

    const result = await this.createCandidatePatch({
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
      status: "candidate_created",
      patchRecord: result.patchRecord,
      patchPreview: result.patchPreview,
      result: result.result,
    };
  }

  async createPatchCandidateForUser(
    user: AuthenticatedUser,
    projectId: string,
    input: CreatePatchCandidateInput,
  ) {
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
      metadata: toInputJson({
        selectedRegion,
        patchMode: true,
        patchCandidateOnly: true,
        source: input.source ?? "inline_edit",
        interactionEvent: input.interactionEvent,
      }),
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
    await this.recordInteractionEvent(run.id, projectId, input.source ?? "inline_edit", {
      selectedRegion,
      instruction,
      ...input.interactionEvent,
      userId: user.id,
    });

    const result = await this.createCandidatePatch({
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
      status: "candidate_created",
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

  async previewForUser(user: AuthenticatedUser, patchId: string) {
    const row = await this.getAccessiblePatch(user, patchId);
    const patchRecord = this.toPatchRecord(row as PatchRecordRow);
    const preview = await this.ensurePatchPreview(row as PatchRecordRow, patchRecord.patchPlan);
    return {
      patchPreview: this.toPatchPreview(preview as PatchPreviewRow, patchRecord),
    };
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
    const confirmationText = confirmation.trim() || "用户确认应用 Patch 候选";
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
      patchPreview: result.patchPreview,
      result: result.result,
    };
  }

  async applyEvolutionPlanForUser(
    user: AuthenticatedUser,
    projectId: string,
    input: ApplyEvolutionPlanInput,
  ) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    assertStateOnlyPatchOperations(input.operations);
    const conversationId = input.conversationId
      ? (await this.assertConversation(projectId, input.conversationId)).id
      : await this.ensureConversationId(projectId, project.ownerId);
    const userInstruction = input.reason.trim() || "执行进化方案";
    const selectedRegion: SelectedRegion = {
      type: "document",
      targetId: input.evolutionPlanId,
      label: "进化方案",
      sourcePaths: input.operations.map((operation) => operation.targetPath),
    };

    const userMessage = await this.messageService.createUserMessage({
      projectId,
      conversationId,
      userId: user.id,
      content: `执行进化方案：${userInstruction}`,
      metadata: toInputJson({
        patchExecutionEngine: true,
        evolutionPlanId: input.evolutionPlanId,
        selectedRegion,
      }),
    });
    const run = await this.runLog.createRun({
      projectId,
      conversationId,
      userId: user.id,
      userInput: userInstruction,
    });
    await this.runLog.markRunIntent(run.id, UserIntent.global_adjustment);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.designing, lastActivityAt: new Date() },
    });

    const executionInput: PatchExecutionInput = {
      projectId,
      conversationId,
      userId: user.id,
      userInstruction,
      selectedRegion,
      attachments: [],
      runId: run.id,
      traceId: run.traceId,
      instructionMessageId: userMessage.id,
    };
    let patchRecord: PatchRecord | undefined;
    let patchPreview: PatchPreviewRow | undefined;
    try {
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "patch_started",
        content: "正在执行进化方案补丁...",
      });
      const state = await this.stateService.getCurrentState(projectId);
      if (!state) throw new NotFoundException("PATCH_STATE_NOT_FOUND");
      const plan: PatchPlan = {
        id: input.evolutionPlanId,
        projectId,
        patchType: "state",
        targetNodes: input.operations.map((operation) => operation.targetPath),
        impactScope: input.impactedAreas?.length ? input.impactedAreas : input.operations.map((operation) => operation.targetPath),
        operations: input.operations.map(toPatchPlanOperation),
        regenerationPlan: {
          prd: "full",
          prototypeSpec: "full",
          htmlPrototype: "full",
          qa: "full",
        },
        risks: [],
        needUserConfirm: false,
        needsUserConfirmation: false,
        reason: userInstruction,
        summary: "补丁执行引擎执行进化方案",
      };
      const createdRecord = await this.prisma.patchRecord.create({
        data: {
          projectId,
          conversationId,
          instructionMessageId: userMessage.id,
          selectedRegion: toInputJson(selectedRegion),
          userInstruction,
          patchPlan: toInputJson({
            ...plan,
            source: "evolution_plan",
            evolutionPlanId: input.evolutionPlanId,
          }),
          operations: toInputJson(plan.operations),
          status: PrismaPatchRecordStatus.planned,
          beforeProductDesignStateVersion: state.version,
          generatedByRunId: run.id,
          createdBy: user.id,
        },
      });
      patchRecord = this.toPatchRecord(createdRecord as PatchRecordRow);
      const preview = await this.ensurePatchPreview(createdRecord as PatchRecordRow, patchRecord.patchPlan);
      patchPreview = preview as PatchPreviewRow;
      await this.prisma.patchPreview.update({
        where: { id: preview.id },
        data: {
          status: "applying",
          message: "进化计划补丁预览已生成，正在应用同一份计划。",
        },
      });
      await this.stream.emit({
        runId: run.id,
        projectId,
        type: "patch_plan_created",
        step: "patch_planning",
        data: {
          patchId: patchRecord.id,
          patchPreview: this.toPatchPreview(patchPreview, patchRecord),
          patchPlan: plan,
          evolutionPlanId: input.evolutionPlanId,
        },
        content: "进化计划补丁已创建",
      });

      const result = await this.applyPatchPlan(
        executionInput,
        patchRecord,
        plan,
        state,
        undefined,
        patchPreview,
      );
      return {
        ...result,
        patchPreview: result.patchPreview,
        userMessage,
        runId: run.id,
        conversationId,
        projectId,
      };
    } catch (error) {
      if (patchPreview) {
        await this.prisma.patchPreview.update({
          where: { id: patchPreview.id },
          data: {
            status: "failed",
            message: error instanceof Error ? error.message : "EVOLUTION_PATCH_PREVIEW_APPLY_FAILED",
          },
        });
      }
      await this.handlePatchFailure(executionInput, patchRecord, error);
      throw error;
    }
  }

  private async createCandidatePatch(input: PatchExecutionInput) {
    let patchRecord: PatchRecord | undefined;
    try {
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_started",
        content: "正在生成 Patch 候选...",
      });

      const state = await this.stateService.getCurrentState(input.projectId);
      if (!state) throw new NotFoundException("PATCH_STATE_NOT_FOUND");
      const knowledgeContext = await this.getPatchKnowledgeContext(input);
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
            knowledgeContext,
          },
        }),
      );
      const plan: PatchPlan = {
        ...patch.data,
        needUserConfirm: true,
        needsUserConfirmation: true,
      };
      const createdRecord = await this.prisma.patchRecord.create({
        data: {
          projectId: input.projectId,
          conversationId: input.conversationId,
          instructionMessageId: input.instructionMessageId,
          selectedRegion: toInputJson(input.selectedRegion),
          userInstruction: input.userInstruction,
          patchPlan: toInputJson({
            ...plan,
            candidateOnly: true,
            confirmationRequiredReason: "二期编辑体验要求用户确认后才能执行。",
          }),
          operations: toInputJson(plan.operations),
          status: PrismaPatchRecordStatus.needs_confirmation,
          beforeProductDesignStateVersion: state.version,
          generatedByRunId: input.runId,
          createdBy: input.userId,
        },
      });
      patchRecord = this.toPatchRecord(createdRecord as PatchRecordRow);
      const preview = await this.ensurePatchPreview(createdRecord as PatchRecordRow, patchRecord.patchPlan);
      const patchPreview = this.toPatchPreview(preview as PatchPreviewRow, patchRecord);
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_plan_created",
        step: "patch_planning",
        data: { patchId: patchRecord.id, patchPlan: plan, patchPreview, candidateOnly: true },
        content: "Patch 候选已生成，等待用户确认",
      });

      const message = "已生成 Patch 候选，请在修改历史中确认后再应用。";
      const assistantMessage = await this.messageService.createAssistantMessage({
        projectId: input.projectId,
        conversationId: input.conversationId,
        content: message,
        type: MessageType.agent_summary,
        metadata: toInputJson({ patchRecord, patchPlan: plan, patchPreview, candidateOnly: true }),
        relatedRunId: input.runId,
      });
      const result = patchConfirmationResult(patchRecord, plan, patchPreview);
      await this.runLog.completeRun(input.runId, { patchRecord, patchPlan: plan, patchPreview, candidateOnly: true }, message);
      await this.prisma.project.update({
        where: { id: input.projectId },
        data: { status: ProjectStatus.clarifying, lastActivityAt: new Date() },
      });
      return { patchRecord, patchPreview, assistantMessage, result };
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
    let patchPreview: PatchPreviewRow | undefined;
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
      const preview = await this.ensurePatchPreview(row, patchRecord.patchPlan);
      patchPreview = preview as PatchPreviewRow;
      const plan: PatchPlan = {
        ...patchRecord.patchPlan,
        needUserConfirm: false,
        needsUserConfirmation: false,
      };
      const updatedRecord = await this.prisma.patchRecord.update({
        where: { id: row.id },
        data: {
          patchPlan: toInputJson({
            ...plan,
            userConfirmation: confirmation,
            appliedPreviewId: preview.id,
          }),
          operations: toInputJson(plan.operations),
          status: PrismaPatchRecordStatus.planned,
          generatedByRunId: input.runId,
        },
      });
      patchRecord = this.toPatchRecord(updatedRecord as PatchRecordRow);
      await this.prisma.patchPreview.update({
        where: { id: preview.id },
        data: {
          status: "applying",
          message: "用户已确认，正在应用同一份补丁预览。",
        },
      });
      await this.stream.emit({
        runId: input.runId,
        projectId: input.projectId,
        type: "patch_plan_created",
        step: "patch_planning",
        data: { patchId: patchRecord.id, patchPreviewId: preview.id, patchPlan: plan },
        content: "局部修改计划已确认，准备应用补丁预览",
      });

      const result = await this.applyPatchPlan(input, patchRecord, plan, state, undefined, patchPreview);
      return result;
    } catch (error) {
      if (patchPreview) {
        await this.prisma.patchPreview.update({
          where: { id: patchPreview.id },
          data: {
            status: "failed",
            message: error instanceof Error ? error.message : "PATCH_PREVIEW_APPLY_FAILED",
          },
        });
      }
      await this.handlePatchFailure(input, patchRecord, error);
      throw error;
    }
  }

  private async applyPatchPlan(
    input: PatchExecutionInput,
    patchRecord: PatchRecord,
    plan: PatchPlan,
    beforeState: ProductDesignState,
    knowledgeContext?: KnowledgeContext,
    activePatchPreview?: PatchPreviewRow,
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
        content: "正在应用产品设计状态补丁...",
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
        content: `产品设计状态 v${patchedState.version} 已更新`,
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
        reason: "补丁应用后重新生成需求文档",
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
          reason: "补丁应用后重新生成网页原型",
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
        reason: "补丁应用后同步需求文档与原型规格",
      });

      const qa = await this.runAgentStep(input, AgentName.qa_agent, "qa_check", async () => ({
        data: await this.qaService.runForProject(input.projectId, input.userId, {
          trigger: "patch",
          runId: input.runId,
          traceId: input.traceId,
          relatedPatchId: patchRecord.id,
          prdDocument,
          prototypeSpec: prototypeSpec.data,
          prototypeArtifact: savedPrototype.artifact,
        }),
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
          relatedQaReportId: qa.data.id,
        },
      });
      patchRecord = this.toPatchRecord(finalRecord as PatchRecordRow);
      const completedPatchPreview = activePatchPreview
        ? this.toPatchPreview(
            await this.prisma.patchPreview.update({
              where: { id: activePatchPreview.id },
              data: {
                status: "applied",
                afterProductDesignStateVersion: stateWithArtifacts.version,
                message: "补丁预览已应用并生成新版本。",
              },
            }) as PatchPreviewRow,
            patchRecord,
          )
        : undefined;

      const message = qa.data.passed
        ? "局部修改已应用，需求文档、网页原型和质检结果已同步更新。"
        : `局部修改已应用，质检发现 ${qa.data.issues.length} 个待确认问题。`;
      const result = {
        productDesignState: stateWithArtifacts,
        prdDocument,
        prototypeSpec: prototypeSpec.data,
        prototypeArtifact: savedPrototype.artifact,
        qaReport: qa.data,
        patchRecord,
        patchPlan: plan,
        patchPreview: completedPatchPreview,
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
        data: { patchRecord, patchPreview: completedPatchPreview, result },
        content: message,
      });
      await this.runLog.completeRun(input.runId, result, message);
      await this.prisma.project.update({
        where: { id: input.projectId },
        data: { status: qa.data.passed ? ProjectStatus.prototype_ready : ProjectStatus.qa_failed },
      });
      return { patchRecord, patchPreview: completedPatchPreview, assistantMessage, result };
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

  private async recordInteractionEvent(
    runId: string,
    projectId: string,
    source: NonNullable<CreatePatchCandidateInput["source"]>,
    payload: Record<string, unknown>,
  ) {
    if (!payload.userId) throw new BadRequestException("PATCH_INTERACTION_USER_REQUIRED");
    const selectedRegion = payload.selectedRegion && typeof payload.selectedRegion === "object" && !Array.isArray(payload.selectedRegion)
      ? payload.selectedRegion as SelectedRegion
      : undefined;
    const targetId = selectedRegion?.type === "prototype"
      ? selectedRegion.targetId || selectedRegion.artifactId
      : selectedRegion?.targetId || selectedRegion?.documentId;
    await this.prisma.productInteractionEvent.create({
      data: {
        projectId,
        type: payload.selectedText ? "selection" : "patch",
        targetType: selectedRegion?.type === "prototype" ? "prototype" : "prd",
        targetId,
        content: typeof payload.instruction === "string" ? payload.instruction : undefined,
        metadata: toInputJson({
          runId,
          source,
          action: payload.action ?? "inline_patch_candidate",
          selectedRegion,
          selectedText: payload.selectedText,
          replacementText: payload.replacementText,
          diffBaseText: payload.diffBaseText,
          diffTargetText: payload.diffTargetText,
        }),
        createdBy: String(payload.userId),
      },
    });
    await this.stream.emit({
      runId,
      projectId,
      type: "patch_plan_created",
      step: "patch_planning",
      data: {
        interactionEvent: {
          source,
          action: payload.action ?? "inline_patch_candidate",
          timestamp: new Date().toISOString(),
          payload,
        },
      },
      content: "已记录局部编辑交互事件",
    });
  }

  private async ensurePatchPreview(row: PatchRecordRow, plan: PatchPlan) {
    const existing = await this.prisma.patchPreview.findUnique({
      where: { patchRecordId: row.id },
    });
    if (existing) return existing;

    const operations = Array.isArray(row.operations)
      ? row.operations as PatchPlan["operations"]
      : plan.operations ?? [];
    return this.prisma.patchPreview.create({
      data: {
        projectId: row.projectId,
        patchRecordId: row.id,
        status: "ready",
        beforeProductDesignStateVersion: row.beforeProductDesignStateVersion,
        afterProductDesignStateVersion: row.afterProductDesignStateVersion,
        beforeSnapshot: toInputJson({
          productDesignStateVersion: row.beforeProductDesignStateVersion,
          immutable: true,
        }),
        afterSnapshot: toInputJson({
          productDesignStateVersion: row.afterProductDesignStateVersion,
          projectedOperations: operations,
          requiresApply: true,
        }),
        diff: toInputJson(buildPatchPreviewDiff(plan, operations)),
        riskPanel: toInputJson(buildPatchPreviewRiskPanel(plan)),
        patchPlan: toInputJson(plan),
        operations: toInputJson(operations),
        message:
          "补丁预览已生成。确认前不会修改产品设计状态、需求文档或原型。",
        createdBy: row.createdBy,
      },
    });
  }

  private async getPatchKnowledgeContext(input: PatchExecutionInput): Promise<KnowledgeContext> {
    const search = await this.knowledgeRetrieval.search({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      agentName: AgentName.patch_agent,
      query: input.userInstruction,
      taskType: "patch_planning",
      preferredTypes: [
        KnowledgeType.strong_rule,
        KnowledgeType.default_rule,
        KnowledgeType.business_concept,
      ],
      limit: 8,
    });
    return {
      query: input.userInstruction,
      strongRules: search.references.filter((item) => item.type === KnowledgeType.strong_rule),
      defaultRules: search.references.filter((item) => item.type === KnowledgeType.default_rule),
      referenceCases: [],
      designPatterns: [],
      prdWritingRules: [],
      prototypeRules: [],
      businessConcepts: search.references.filter((item) => item.type === KnowledgeType.business_concept),
      conflicts: [],
      unknownAreas: [],
      summary: search.references.length
        ? `Patch 命中 ${search.references.length} 条知识库规则。`
        : "Patch 未命中正式知识库规则。",
    };
  }

  private async runAgentStep<T>(
    input: { runId: string; projectId: string; userInstruction: string },
    agentName: AgentName,
    step: NonNullable<Parameters<VibeStreamService["emit"]>[0]["step"]>,
    handler: () => Promise<AgentOutput<T>>,
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
      await this.runLog.completeStep(stepLog.id, fallbackStepOutput(result.data, result.fallback), {
        modelCallLogId: result.modelCallLogId,
      });
      if (result.fallback) {
        await this.stream.emit({
          runId: input.runId,
          projectId: input.projectId,
          type: "fallback_used",
          step,
          content: result.fallback.userMessage,
          data: result.fallback,
        });
      }
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
      relatedQaReportId: row.relatedQaReportId ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toPatchPreview(row: PatchPreviewRow, patchRecord: PatchRecord) {
    const plan = row.patchPlan as PatchPlan;
    const operations = Array.isArray(row.operations)
      ? row.operations as PatchPlan["operations"]
      : patchRecord.operations;
    return {
      id: row.id,
      patchId: row.patchRecordId,
      status: patchRecord.status,
      previewStatus: row.status,
      selectedRegion: patchRecord.selectedRegion,
      patchPlan: plan,
      operations,
      targetNodes: plan.targetNodes ?? [],
      impactScope: plan.impactScope ?? [],
      risks: plan.risks ?? [],
      regenerationPlan: plan.regenerationPlan,
      diff: row.diff,
      before: row.beforeSnapshot,
      after: row.afterSnapshot,
      riskPanel: row.riskPanel,
      beforeProductDesignStateVersion: row.beforeProductDesignStateVersion,
      afterProductDesignStateVersion: row.afterProductDesignStateVersion ?? undefined,
      previewOnly: patchRecord.status === PrismaPatchRecordStatus.needs_confirmation,
      requiresConfirmation: patchRecord.status === PrismaPatchRecordStatus.needs_confirmation,
      message: row.message ?? (
        patchRecord.status === PrismaPatchRecordStatus.needs_confirmation
          ? "补丁候选已生成，确认后才会应用到产品设计状态。"
          : "补丁预览已生成。"
      ),
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

function patchConfirmationResult(
  patchRecord: PatchRecord,
  plan: PatchPlan,
  patchPreview?: unknown,
) {
  return {
    patchRecord,
    patchPreview,
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

function buildPatchPreviewDiff(plan: PatchPlan, operations: PatchPlan["operations"]) {
  return {
    mode: "product_design_state",
    summary: plan.summary,
    reason: plan.reason,
    operations: operations.map((operation) => ({
      op: operation.op,
      path: operation.path,
      before: null,
      after: operation.value ?? null,
      reason: operation.reason,
    })),
    impacted: {
      targetNodes: plan.targetNodes ?? [],
      impactScope: plan.impactScope ?? [],
      affectedStatePaths: plan.impactAnalysis?.affectedStatePaths ?? operations.map((operation) => operation.path),
      affectedPrdSectionIds: plan.impactAnalysis?.affectedPrdSectionIds ?? [],
      affectedPrototypePageIds: plan.impactAnalysis?.affectedPrototypePageIds ?? [],
      affectedPrototypeComponentIds: plan.impactAnalysis?.affectedPrototypeComponentIds ?? [],
    },
  };
}

function buildPatchPreviewRiskPanel(plan: PatchPlan) {
  const risks = plan.risks ?? [];
  const regenerationPlan = plan.regenerationPlan;
  const touchesPrototype = regenerationPlan?.prototypeSpec !== "none" || regenerationPlan?.htmlPrototype !== "none";
  const touchesPrd = regenerationPlan?.prd !== "none";
  const level = risks.some((risk) => risk.level === "high")
    ? "high"
    : risks.some((risk) => risk.level === "medium")
      ? "medium"
      : touchesPrototype && touchesPrd
        ? "medium"
        : "low";
  return {
    level,
    requiresConfirmation: true,
    versionedApply: true,
    items: risks,
    checks: {
      stateOnlyOperations: true,
      requiresPrdRegeneration: touchesPrd,
      requiresPrototypeRegeneration: touchesPrototype,
      requiresQaCheck: regenerationPlan?.qa !== "none",
    },
  };
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
    prd_generation: ["正在重新生成需求文档...", "需求文档已更新"],
    prototype_design: ["正在重新生成原型规格...", "原型规格已更新"],
    prototype_code_generation: ["正在重新生成网页原型...", "网页原型已更新"],
    qa_check: ["正在执行补丁应用后质检...", "质检校验完成"],
  };
  return textMap[step]?.[status === "started" ? 0 : 1] ?? step;
}
