import { ForbiddenException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  ProductDesignStateStatus,
  ProjectStatus,
  RequirementDocumentStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeCandidateService } from "../knowledge/knowledge-candidate.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  ProductDesignState,
  RequirementDocSection,
  RequirementDocument,
  RequirementDocumentDraft,
} from "./ai-vibe.types";
import { ProductDesignStateService } from "./product-design-state.service";
import { QaService } from "./qa.service";
import { ProductRuntimeService } from "./runtime/product-runtime.service";

type RequirementDocumentRecord = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: RequirementDocumentStatus;
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

@Injectable()
export class RequirementDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    private readonly productRuntime: ProductRuntimeService,
    @Optional()
    private readonly knowledgeCandidateService?: KnowledgeCandidateService,
    @Optional()
    private readonly qaService?: QaService,
  ) {}

  async generateForUser(
    user: AuthenticatedUser,
    projectId: string,
    input: { productDesignStateId?: string; mode?: "draft" | "formal" },
  ) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    const state = input.productDesignStateId
      ? await this.getStateForProject(input.productDesignStateId, projectId)
      : await this.stateService.getCurrentState(projectId);
    if (!state) throw new NotFoundException("PRD_STATE_NOT_FOUND");

    const runId = `manual-prd-${Date.now()}`;
    const prd = await this.productRuntime.generatePrd({
      runId,
      projectId,
      traceId: runId,
      userId: user.id,
      productDesignState: state,
      mode: input.mode ?? "draft",
    });

    const document = await this.saveGeneratedDocument(state, prd.data, {
      userId: user.id,
      reason: "手动生成 PRD",
    });
    const productDesignState = await this.stateService.attachGeneratedArtifacts(state.id, {
      prdDocument: document,
      status: state.prototypeSpec
        ? ProductDesignStateStatus.prototype_ready
        : ProductDesignStateStatus.prd_ready,
      userId: user.id,
      reason: "手动生成 PRD 后同步 ProductDesignState",
    });
    return { document, productDesignState };
  }

  async saveGeneratedDocument(
    state: ProductDesignState,
    draft: RequirementDocumentDraft,
    options: { userId: string; runId?: string; reason?: string },
  ) {
    const document = await this.prisma.requirementDocument.create({
      data: {
        projectId: state.projectId,
        productDesignStateId: state.id,
        productDesignStateVersion: state.version,
        title: draft.title,
        status: RequirementDocumentStatus.ready,
        sections: toInputJson(draft.sections),
        assumptions: toInputJson(draft.assumptions),
        knowledgeRefs: toInputJson(draft.knowledgeRefs),
        pendingQuestions: toInputJson(draft.pendingQuestions),
        validationNotes: toInputJson(draft.validationNotes),
        generatedByRunId: options.runId,
        createdBy: options.userId,
        updatedBy: options.userId,
      },
    });

    const item = this.toDocumentItem(document as RequirementDocumentRecord);
    await this.prisma.project.update({
      where: { id: state.projectId },
      data: { currentPrdDocumentId: document.id },
    });
    await this.createVersion(item, options.userId, options.reason ?? "PRD 生成完成");
    return item;
  }

  async getCurrentForUser(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    return this.getCurrentForProject(projectId);
  }

  async getCurrentForProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    const state = await this.stateService.getCurrentState(projectId);
    if (state?.prdDocument) {
      return { document: state.prdDocument, productDesignState: state };
    }

    const document = project.currentPrdDocumentId
      ? await this.prisma.requirementDocument.findFirst({
          where: { id: project.currentPrdDocumentId, projectId },
        })
      : await this.prisma.requirementDocument.findFirst({
          where: { projectId },
          orderBy: { updatedAt: "desc" },
        });
    const item = document ? this.toDocumentItem(document as RequirementDocumentRecord) : null;
    if (state && item && !isDocumentFromCurrentState(item, state)) {
      return { document: null, productDesignState: state };
    }
    return { document: item, productDesignState: state ?? null };
  }

  async getDocumentForUser(user: AuthenticatedUser, documentId: string) {
    const document = await this.getAccessibleDocument(user, documentId);
    return { document: this.toDocumentItem(document as RequirementDocumentRecord) };
  }

  async getPreviewForUser(user: AuthenticatedUser, documentId: string) {
    const document = await this.getAccessibleDocument(user, documentId);
    const item = this.toDocumentItem(document as RequirementDocumentRecord);
    return {
      title: item.title,
      sections: item.sections,
      meta: {
        status: item.status,
        productDesignStateVersion: item.productDesignStateVersion,
        assumptionCount: item.assumptions.length,
        knowledgeRefCount: item.knowledgeRefs.length,
        pendingQuestionCount: item.pendingQuestions.length,
        updatedAt: item.updatedAt,
      },
    };
  }

  async updateSectionForUser(
    user: AuthenticatedUser,
    documentId: string,
    sectionId: string,
    input: { content: string; title?: string },
  ) {
    const current = await this.getAccessibleDocument(user, documentId);
    this.assertOwnerMutation(user, current.project.ownerId);
    const document = this.toDocumentItem(current as RequirementDocumentRecord);
    let matched = false;
    const sections = document.sections.map((section) => {
      if (section.id !== sectionId) return section;
      matched = true;
      return applySectionContentEdit(section, input);
    });
    if (!matched) throw new NotFoundException("PRD_SECTION_NOT_FOUND");

    const updated = await this.prisma.requirementDocument.update({
      where: { id: documentId },
      data: {
        status: RequirementDocumentStatus.ready,
        sections: toInputJson(sections),
        updatedBy: user.id,
      },
    });
    const updatedDocument = this.toDocumentItem(updated as RequirementDocumentRecord);
    const version = await this.createVersion(updatedDocument, user.id, `局部编辑 PRD 段落：${sectionId}`);
    await this.stateService.syncRequirementDocumentEdit({
      document: updatedDocument,
      section: sections.find((section) => section.id === sectionId) ?? updatedDocument.sections.find((section) => section.id === sectionId)!,
      userId: user.id,
      reason: `PRD 段落 ${sectionId} 已回流到 ProductDesignState`,
    });
    return { document: updatedDocument, version };
  }

  async confirmForUser(user: AuthenticatedUser, documentId: string, reason?: string) {
    const current = await this.getAccessibleDocument(user, documentId);
    this.assertOwnerMutation(user, current.project.ownerId);
    const qaGate = this.qaService
      ? await this.qaService.assertGateAllows(user, current.projectId, "confirm_artifacts")
      : undefined;
    const { document, version } = await this.confirmDocumentAndSyncState(
      current as RequirementDocumentRecord,
      user.id,
      reason ?? "用户确认 PRD",
    );
    const knowledgeCandidates = qaGate && !qaGate.allowPersistKnowledge
      ? { items: [], qaGate }
      : await this.extractKnowledgeCandidatesAfterConfirm(user.id, document);
    return { document, version, knowledgeCandidates, qaGate };
  }

  async confirmForPrototypeGate(user: AuthenticatedUser, documentId: string, reason?: string) {
    const current = await this.getAccessibleDocument(user, documentId);
    this.assertOwnerMutation(user, current.project.ownerId);
    return this.confirmDocumentAndSyncState(
      current as RequirementDocumentRecord,
      user.id,
      reason ?? "用户确认 PRD，继续生成原型",
    );
  }

  private async extractKnowledgeCandidatesAfterConfirm(userId: string, document: RequirementDocument) {
    void userId;
    void document;
    return { items: [] };
  }

  private async confirmDocumentAndSyncState(
    current: RequirementDocumentRecord,
    userId: string,
    reason: string,
  ) {
    const updated = current.status === RequirementDocumentStatus.confirmed
      ? current
      : await this.prisma.requirementDocument.update({
          where: { id: current.id },
          data: {
            status: RequirementDocumentStatus.confirmed,
            updatedBy: userId,
          },
        });
    const document = this.toDocumentItem(updated as RequirementDocumentRecord);
    const version = await this.createVersion(document, userId, reason);
    const state = await this.stateService.getStateByIdForProject(
      document.productDesignStateId,
      document.projectId,
    );
    const status = state?.prototypeSpec
      ? ProductDesignStateStatus.prototype_ready
      : ProductDesignStateStatus.doc_confirmed;
    const productDesignState = await this.stateService.attachGeneratedArtifacts(document.productDesignStateId, {
      prdDocument: document,
      status,
      userId,
      reason: `${reason}，同步 PRD 确认状态到 ProductDesignState`,
    });
    return { document, version, productDesignState };
  }

  async listVersionsForUser(user: AuthenticatedUser, documentId: string) {
    await this.getAccessibleDocument(user, documentId);
    const items = await this.prisma.requirementDocumentVersion.findMany({
      where: { documentId },
      orderBy: { version: "desc" },
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        documentId: item.documentId,
        projectId: item.projectId,
        version: item.version,
        snapshot: item.snapshot,
        reason: item.reason ?? undefined,
        createdBy: item.createdBy,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  private async createVersion(document: RequirementDocument, createdBy: string, reason: string) {
    const latest = await this.prisma.requirementDocumentVersion.findFirst({
      where: { documentId: document.id },
      orderBy: { version: "desc" },
    });
    return this.prisma.requirementDocumentVersion.create({
      data: {
        documentId: document.id,
        projectId: document.projectId,
        version: (latest?.version ?? 0) + 1,
        snapshot: toInputJson(document),
        reason,
        createdBy,
      },
    });
  }

  private async getStateForProject(stateId: string, projectId: string) {
    return this.stateService.getStateByIdForProject(stateId, projectId);
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
      throw new ForbiddenException("PRD_DOCUMENT_FORBIDDEN");
    }
    return project;
  }

  private async getAccessibleDocument(user: AuthenticatedUser, documentId: string) {
    const document = await this.prisma.requirementDocument.findUnique({
      where: { id: documentId },
      include: { project: true },
    });
    if (!document || document.project.deletedAt || document.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("PRD_DOCUMENT_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && document.project.ownerId !== user.id) {
      throw new ForbiddenException("PRD_DOCUMENT_FORBIDDEN");
    }
    return document;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户项目 PRD");
    }
  }

  private toDocumentItem(document: RequirementDocumentRecord): RequirementDocument {
    return {
      id: document.id,
      projectId: document.projectId,
      productDesignStateId: document.productDesignStateId,
      productDesignStateVersion: document.productDesignStateVersion,
      title: document.title,
      status: document.status,
      sections: Array.isArray(document.sections) ? document.sections as RequirementDocument["sections"] : [],
      assumptions: Array.isArray(document.assumptions) ? document.assumptions as RequirementDocument["assumptions"] : [],
      knowledgeRefs: Array.isArray(document.knowledgeRefs) ? document.knowledgeRefs as Array<Record<string, unknown>> : [],
      pendingQuestions: Array.isArray(document.pendingQuestions) ? document.pendingQuestions as RequirementDocument["pendingQuestions"] : [],
      validationNotes: Array.isArray(document.validationNotes) ? document.validationNotes.map(String) : [],
      generatedByRunId: document.generatedByRunId ?? undefined,
      createdBy: document.createdBy,
      updatedBy: document.updatedBy ?? undefined,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  }
}

function isDocumentFromCurrentState(document: RequirementDocument, state: ProductDesignState) {
  return document.productDesignStateId === state.id && document.productDesignStateVersion === state.version;
}

function applySectionContentEdit(
  section: RequirementDocSection,
  input: { content: string; title?: string },
): RequirementDocSection {
  const content = input.content.trim();
  const sourcePaths = section.sourcePaths?.length
    ? section.sourcePaths
    : section.sourceStatePaths ?? [];
  const block = section.blocks?.length === 1
    ? {
        ...section.blocks[0],
        content,
        sourcePaths: section.blocks[0].sourcePaths?.length ? section.blocks[0].sourcePaths : sourcePaths,
        tags: section.blocks[0].tags?.length ? section.blocks[0].tags : section.tags,
      }
    : {
        id: `${section.id}_body`,
        type: "paragraph" as const,
        content,
        sourcePaths,
        tags: section.tags,
      };

  return {
    ...section,
    title: input.title?.trim() || section.title,
    content,
    blocks: [block],
    sourcePaths,
    updatedAt: new Date().toISOString(),
  };
}
