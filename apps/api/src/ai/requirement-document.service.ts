import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
	import {
	  KnowledgeCandidateSource,
	  KnowledgeType,
	  Prisma,
	  ConversationDesignStateStatus,
  ConversationStatus,
  RequirementDocumentStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeCandidateService } from "../knowledge/knowledge-candidate.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  ConversationDesignState,
  RequirementDocSection,
  RequirementDocument,
  RequirementDocumentDraft,
} from "./ai-vibe.types";
import { ConversationDesignStateService } from "./conversation-design-state.service";
import { QaService } from "./qa.service";
import type { KnowledgeCandidateDraft } from "../knowledge/knowledge.types";

type RequirementDocumentRecord = {
  id: string;
  conversationId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
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
    private readonly stateService: ConversationDesignStateService,
    @Optional()
    private readonly knowledgeCandidateService?: KnowledgeCandidateService,
    @Optional()
    private readonly qaService?: QaService,
  ) {}

	  async saveGeneratedDocument(
	    state: ConversationDesignState,
	    draft: RequirementDocumentDraft,
	    options: { userId: string; runId?: string; reason?: string },
	  ) {
	    return this.prisma.$transaction(async (tx) => {
	      return this.saveGeneratedDocumentInTransaction(tx, state, draft, options);
	    });
	  }

	  async saveGeneratedDocumentInTransaction(
	    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
	    state: ConversationDesignState,
	    draft: RequirementDocumentDraft,
	    options: { userId: string; runId?: string; reason?: string },
	  ) {
	    const document = await tx.requirementDocument.create({
	      data: {
	        conversationId: state.conversationId,
	        conversationDesignStateId: state.id,
	        conversationDesignStateVersion: state.version,
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
	    await tx.conversation.update({
	      where: { id: state.conversationId },
	      data: { currentPrdDocumentId: document.id },
	    });
	    await this.createVersion(item, options.userId, options.reason ?? "PRD 生成完成", tx);
	    return item;
	  }

  async getCurrentForUser(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    return this.getCurrentForConversation(conversationId);
  }

  async getCurrentForConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    const state = await this.stateService.getCurrentState(conversationId);
    if (state?.prdDocument) {
      return { document: state.prdDocument, conversationDesignState: state };
    }

    const document = conversation.currentPrdDocumentId
      ? await this.prisma.requirementDocument.findFirst({
          where: { id: conversation.currentPrdDocumentId, conversationId },
        })
      : await this.prisma.requirementDocument.findFirst({
          where: { conversationId },
          orderBy: { updatedAt: "desc" },
        });
    const item = document ? this.toDocumentItem(document as RequirementDocumentRecord) : null;
    if (state && item && !isDocumentFromCurrentState(item, state)) {
      return { document: null, conversationDesignState: state };
    }
    return { document: item, conversationDesignState: state ?? null };
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
        conversationDesignStateVersion: item.conversationDesignStateVersion,
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
    this.assertOwnerMutation(user, current.conversation.ownerId);
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
      reason: `PRD 段落 ${sectionId} 已回流到 ConversationDesignState`,
    });
    return { document: updatedDocument, version };
  }

  async updateDocumentContentForUser(
    user: AuthenticatedUser,
    documentId: string,
    input: { content: string },
  ) {
    const current = await this.getAccessibleDocument(user, documentId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    const document = this.toDocumentItem(current as RequirementDocumentRecord);
    const edited = applyDocumentContentEdit(document, input.content);

    const updated = await this.prisma.requirementDocument.update({
      where: { id: documentId },
      data: {
        title: edited.title,
        status: RequirementDocumentStatus.ready,
        sections: toInputJson(edited.sections),
        updatedBy: user.id,
      },
    });
    const updatedDocument = this.toDocumentItem(updated as RequirementDocumentRecord);
    const version = await this.createVersion(updatedDocument, user.id, "整文编辑 PRD");
    const conversationDesignState = await this.stateService.attachGeneratedArtifacts(
      updatedDocument.conversationDesignStateId,
      {
        prdDocument: updatedDocument,
        status: ConversationDesignStateStatus.doc_ready,
        userId: user.id,
        reason: "整文编辑 PRD 后回流到 ConversationDesignState",
      },
    );
    return { document: updatedDocument, version, conversationDesignState };
  }

  async confirmForUser(user: AuthenticatedUser, documentId: string, reason?: string) {
    const current = await this.getAccessibleDocument(user, documentId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    const qaGate = this.qaService
      ? await this.qaService.assertGateAllows(user, current.conversationId, "confirm_artifacts")
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
    this.assertOwnerMutation(user, current.conversation.ownerId);
    return this.confirmDocumentAndSyncState(
      current as RequirementDocumentRecord,
      user.id,
      reason ?? "用户确认 PRD，继续生成原型",
    );
  }

	  private async extractKnowledgeCandidatesAfterConfirm(userId: string, document: RequirementDocument) {
	    void userId;
	    if (!this.knowledgeCandidateService) return { items: [] };
	    const drafts = document.sections
	      .map((section) => prdSectionToKnowledgeCandidate(section, document))
	      .filter((draft): draft is KnowledgeCandidateDraft => Boolean(draft));
	    return this.knowledgeCandidateService.createMany(document.conversationId, drafts, {
	      source: KnowledgeCandidateSource.prd,
	      sourceRefId: document.id,
	    });
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
    const state = await this.stateService.getStateByIdForConversation(
      document.conversationDesignStateId,
      document.conversationId,
    );
    const status = state?.prototypeSpec
      ? ConversationDesignStateStatus.prototype_ready
      : ConversationDesignStateStatus.doc_confirmed;
    const conversationDesignState = await this.stateService.attachGeneratedArtifacts(document.conversationDesignStateId, {
      prdDocument: document,
      status,
      userId,
      reason: `${reason}，同步 PRD 确认状态到 ConversationDesignState`,
    });
    return { document, version, conversationDesignState };
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
        conversationId: item.conversationId,
        version: item.version,
        snapshot: item.snapshot,
        reason: item.reason ?? undefined,
        createdBy: item.createdBy,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

	  private async createVersion(
	    document: RequirementDocument,
	    createdBy: string,
	    reason: string,
	    tx?: Prisma.TransactionClient,
	  ) {
	    const client = tx ?? this.prisma;
	    const latest = await client.requirementDocumentVersion.findFirst({
	      where: { documentId: document.id },
	      orderBy: { version: "desc" },
	    });
	    return client.requirementDocumentVersion.create({
	      data: {
	        documentId: document.id,
        conversationId: document.conversationId,
        version: (latest?.version ?? 0) + 1,
        snapshot: toInputJson(document),
        reason,
        createdBy,
      },
    });
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
      throw new ForbiddenException("PRD_DOCUMENT_FORBIDDEN");
    }
    return conversation;
  }

  private async getAccessibleDocument(user: AuthenticatedUser, documentId: string) {
    const document = await this.prisma.requirementDocument.findUnique({
      where: { id: documentId },
      include: { conversation: true },
    });
    if (!document || document.conversation.deletedAt || document.conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("PRD_DOCUMENT_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && document.conversation.ownerId !== user.id) {
      throw new ForbiddenException("PRD_DOCUMENT_FORBIDDEN");
    }
    return document;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户会话 PRD");
    }
  }

  private toDocumentItem(document: RequirementDocumentRecord): RequirementDocument {
    return {
      id: document.id,
      conversationId: document.conversationId,
      conversationDesignStateId: document.conversationDesignStateId,
      conversationDesignStateVersion: document.conversationDesignStateVersion,
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

function isDocumentFromCurrentState(document: RequirementDocument, state: ConversationDesignState) {
  return document.conversationDesignStateId === state.id && document.conversationDesignStateVersion === state.version;
}

function applyDocumentContentEdit(document: RequirementDocument, markdown: string) {
  const parsed = parseDocumentMarkdown(markdown);
  if (parsed.sections.length === 0) {
    throw new BadRequestException("PRD_CONTENT_NO_SECTIONS");
  }
  const usedSectionIds = new Set<string>();
  const now = new Date().toISOString();
  const sections = parsed.sections.map((section, index) => {
    const existing = findMatchingSection(document.sections, section.title, index, usedSectionIds);
    const id = existing?.id ?? manualSectionId(section.title, index, usedSectionIds);
    usedSectionIds.add(id);
    const sourcePaths = existing?.sourcePaths?.length ? existing.sourcePaths : [];
    const sourceStatePaths = existing?.sourceStatePaths;
    const existingBlock = existing?.blocks?.length === 1 ? existing.blocks[0] : undefined;
    const content = section.content.trim();

    return {
      id,
      title: section.title || existing?.title || `章节 ${index + 1}`,
      type: existing?.type ?? "appendix",
      level: existing?.level ?? 1,
      order: index + 1,
      content,
      blocks: content
        ? [
            {
              id: existingBlock?.id ?? `${id}_body`,
              type: existingBlock?.type ?? "paragraph",
              content,
              sourcePaths: existingBlock?.sourcePaths?.length ? existingBlock.sourcePaths : sourcePaths,
              tags: existingBlock?.tags?.length ? existingBlock.tags : existing?.tags,
            },
          ]
        : [],
      sourcePaths,
      tags: existing?.tags,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceStatePaths,
    } satisfies RequirementDocSection;
  });

  return {
    title: parsed.title || document.title,
    sections,
  };
}

type ParsedMarkdownSection = {
  title: string;
  content: string;
};

function parseDocumentMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  const introLines: string[] = [];
  const sections: Array<{ title: string; lines: string[] }> = [];
  let currentSection: { title: string; lines: string[] } | undefined;

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1 && !title && !currentSection && sections.length === 0 && introLines.every((item) => !item.trim())) {
      title = h1[1].trim();
      continue;
    }

    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: h2[1].trim(), lines: [] };
      continue;
    }

    if (currentSection) {
      currentSection.lines.push(line);
    } else {
      introLines.push(line);
    }
  }

  if (currentSection) sections.push(currentSection);

  const intro = introLines.join("\n").trim();
  const parsedSections: ParsedMarkdownSection[] = sections.map((section) => ({
    title: section.title,
    content: section.lines.join("\n").trim(),
  }));
  if (intro) {
    parsedSections.unshift({ title: "概览", content: intro });
  }

  return { title, sections: parsedSections };
}

function findMatchingSection(
  sections: RequirementDocSection[],
  title: string,
  index: number,
  usedIds: Set<string>,
) {
  const normalizedTitle = normalizeSectionTitle(title);
  const titleMatched = sections.find(
    (section) =>
      !usedIds.has(section.id) &&
      normalizeSectionTitle(section.title) === normalizedTitle,
  );
  if (titleMatched) return titleMatched;

  const positional = sections[index];
  if (positional && !usedIds.has(positional.id)) return positional;
  return sections.find((section) => !usedIds.has(section.id));
}

function normalizeSectionTitle(title: string) {
  return title.replace(/\s+/g, "").trim().toLowerCase();
}

function manualSectionId(title: string, index: number, usedIds: Set<string>) {
  let hash = 0;
  for (const char of title) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  const suffix = Math.abs(hash).toString(36) || "0";
  const base = `manual_section_${index + 1}_${suffix}`;
  let candidate = base;
  let counter = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${counter}`;
    counter += 1;
  }
  return candidate;
}

function prdSectionToKnowledgeCandidate(
  section: RequirementDocSection,
  document: RequirementDocument,
): KnowledgeCandidateDraft | null {
  if (isTemplateOnlySection(section)) return null;
  const content = sectionKnowledgeContent(section);
  if (content.length < 20) return null;
  return {
    title: `${document.title} - ${section.title}`.slice(0, 120),
    content,
    summary: content.slice(0, 180),
    suggestedType: knowledgeTypeForPrdSection(section),
    suggestedTags: ["prd", section.type, ...section.sourcePaths.slice(0, 3)],
    confidence: 0.78,
    sourcePath: `sections.${section.id}`,
    reason: "从用户确认后的 PRD 章节抽取，进入知识候选审核。",
  };
}

function isTemplateOnlySection(section: RequirementDocSection) {
  return [
    "version_history",
    "manual_toc",
    "knowledge_refs",
    "pending_questions",
  ].includes(section.id) || section.type === "knowledge_refs" || section.type === "pending_questions";
}

function sectionKnowledgeContent(section: RequirementDocSection) {
  const blocks = section.blocks
    ?.map((block) => [block.title, block.content].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
  return [`# ${section.title}`, section.content, blocks]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function knowledgeTypeForPrdSection(section: RequirementDocSection) {
  if (["business_rules", "state_rules", "exception_scenarios", "acceptance_criteria"].includes(section.type)) {
    return KnowledgeType.strong_rule;
  }
  if (section.type === "page_requirements") return KnowledgeType.page_inventory;
  if (section.type === "frontend_rules" || section.type === "backend_configs") return KnowledgeType.default_rule;
  return KnowledgeType.business_concept;
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
