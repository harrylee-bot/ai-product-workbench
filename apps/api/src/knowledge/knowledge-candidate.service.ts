import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  KnowledgeCandidateSource,
  KnowledgeCandidateStatus,
  KnowledgeSource,
  KnowledgeStatus,
  Prisma,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { toInputJson } from "../ai/ai-vibe.helpers";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ApproveKnowledgeCandidateDto,
  ListKnowledgeCandidatesQueryDto,
  MergeKnowledgeCandidateDto,
  RejectKnowledgeCandidateDto,
} from "./knowledge.dto";
import {
  jsonArray,
  normalizeOptionalText,
  normalizeTags,
  KnowledgeItemService,
} from "./knowledge-item.service";
import type { KnowledgeCandidateDraft } from "./knowledge.types";

type KnowledgeCandidateRow = Prisma.KnowledgeCandidateGetPayload<Record<string, never>>;

@Injectable()
export class KnowledgeCandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itemService: KnowledgeItemService,
  ) {}

  async createMany(
    projectId: string,
    drafts: KnowledgeCandidateDraft[],
    options: {
      source?: KnowledgeCandidateSource;
      sourceRefId?: string;
      runId?: string;
    } = {},
  ) {
    const normalized = drafts.map((draft) => this.normalizeDraft(draft, options));
    if (!normalized.length) return { items: [] };

    const rows = await this.prisma.$transaction(
      normalized.map((draft) =>
        this.prisma.knowledgeCandidate.create({
          data: {
            projectId,
            title: draft.title,
            content: draft.content,
            summary: draft.summary,
            suggestedType: draft.suggestedType,
            suggestedCategoryId: draft.suggestedCategoryId,
            suggestedTags: toInputJson(draft.suggestedTags),
            confidence: draft.confidence,
            source: draft.source ?? options.source ?? KnowledgeCandidateSource.product_design_state,
            sourceRefId: draft.sourceRefId ?? options.sourceRefId,
            sourcePath: draft.sourcePath,
            reason: draft.reason,
            createdByRunId: options.runId,
          },
        }),
      ),
    );

    return { items: rows.map((row) => this.toCandidate(row)) };
  }

  async listCandidates(query: ListKnowledgeCandidatesQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where: Prisma.KnowledgeCandidateWhereInput = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.suggestedType ? { suggestedType: query.suggestedType } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.knowledgeCandidate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.knowledgeCandidate.count({ where }),
    ]);

    return {
      items: items.map((item) => this.toCandidate(item)),
      total,
      page,
      pageSize,
    };
  }

  async approveCandidate(
    user: AuthenticatedUser,
    candidateId: string,
    dto: ApproveKnowledgeCandidateDto,
  ) {
    const candidate = await this.getPendingCandidate(candidateId);
    if (dto.categoryId) await this.assertCategory(dto.categoryId);

    const { item, reviewed } = await this.prisma.$transaction(async (tx) => {
      const item = await tx.knowledgeItem.create({
        data: {
          title: dto.title?.trim() || candidate.title,
          content: dto.content?.trim() || candidate.content,
          summary: dto.summary === undefined ? candidate.summary : normalizeOptionalText(dto.summary),
          type: dto.type ?? candidate.suggestedType,
          status: KnowledgeStatus.active,
          scope: "global",
          categoryId: normalizeOptionalText(dto.categoryId ?? candidate.suggestedCategoryId),
          tags: toInputJson(normalizeTags(dto.tags ?? jsonArray(candidate.suggestedTags))),
          priority: dto.priority ?? "medium",
          source: sourceFromCandidate(candidate.source),
          sourceProjectId: candidate.projectId,
          sourceFileId: candidate.source === KnowledgeCandidateSource.uploaded_file ? candidate.sourceRefId : null,
          sourcePrdDocumentId: candidate.source === KnowledgeCandidateSource.prd ? candidate.sourceRefId : null,
          sourcePrototypeArtifactId:
            candidate.source === KnowledgeCandidateSource.prototype ? candidate.sourceRefId : null,
          createdBy: user.id,
          updatedBy: user.id,
        },
      });
      await this.itemService.createVersionSnapshot(item, user.id, "知识候选通过", tx as never);
      const reviewed = await tx.knowledgeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: KnowledgeCandidateStatus.approved,
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewComment: "审核通过",
        },
      });
      return { item, reviewed };
    });

    return {
      candidate: this.toCandidate(reviewed),
      item: this.itemService.toItem(item),
    };
  }

  async rejectCandidate(
    user: AuthenticatedUser,
    candidateId: string,
    dto: RejectKnowledgeCandidateDto,
  ) {
    const candidate = await this.getPendingCandidate(candidateId);
    const reviewed = await this.prisma.knowledgeCandidate.update({
      where: { id: candidate.id },
      data: {
        status: KnowledgeCandidateStatus.rejected,
        reviewedBy: user.id,
        reviewedAt: new Date(),
        reviewComment: dto.reviewComment.trim(),
      },
    });
    return { candidate: this.toCandidate(reviewed) };
  }

  async mergeCandidate(
    user: AuthenticatedUser,
    candidateId: string,
    dto: MergeKnowledgeCandidateDto,
  ) {
    const candidate = await this.getPendingCandidate(candidateId);
    const target = await this.prisma.knowledgeItem.findUnique({
      where: { id: dto.targetKnowledgeItemId },
    });
    if (!target) throw new NotFoundException("KNOWLEDGE_ITEM_NOT_FOUND");

    const { item, reviewed } = await this.prisma.$transaction(async (tx) => {
      const mergedTags = normalizeTags([
        ...jsonArray(target.tags),
        ...jsonArray(candidate.suggestedTags),
      ]);
      const item = await tx.knowledgeItem.update({
        where: { id: target.id },
        data: {
          content: dto.mergedContent?.trim() || appendCandidateContent(target.content, candidate.content),
          summary: target.summary ?? candidate.summary,
          tags: toInputJson(mergedTags),
          updatedBy: user.id,
        },
      });
      await this.itemService.createVersionSnapshot(item, user.id, "合并知识候选", tx as never);
      const reviewed = await tx.knowledgeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: KnowledgeCandidateStatus.merged,
          reviewedBy: user.id,
          reviewedAt: new Date(),
          reviewComment: dto.reviewComment?.trim() || `合并到知识 ${target.id}`,
        },
      });
      return { item, reviewed };
    });

    return {
      candidate: this.toCandidate(reviewed),
      item: this.itemService.toItem(item),
    };
  }

  toCandidate(candidate: KnowledgeCandidateRow) {
    return {
      id: candidate.id,
      projectId: candidate.projectId,
      title: candidate.title,
      content: candidate.content,
      summary: candidate.summary ?? undefined,
      suggestedType: candidate.suggestedType,
      suggestedCategoryId: candidate.suggestedCategoryId ?? undefined,
      suggestedTags: jsonArray(candidate.suggestedTags),
      confidence: candidate.confidence,
      source: candidate.source,
      sourceRefId: candidate.sourceRefId ?? undefined,
      sourcePath: candidate.sourcePath ?? undefined,
      reason: candidate.reason,
      status: candidate.status,
      reviewedBy: candidate.reviewedBy ?? undefined,
      reviewedAt: candidate.reviewedAt?.toISOString(),
      reviewComment: candidate.reviewComment ?? undefined,
      createdByRunId: candidate.createdByRunId ?? undefined,
      createdAt: candidate.createdAt.toISOString(),
      updatedAt: candidate.updatedAt.toISOString(),
    };
  }

  private normalizeDraft(
    draft: KnowledgeCandidateDraft,
    options: { source?: KnowledgeCandidateSource; sourceRefId?: string },
  ): KnowledgeCandidateDraft {
    return {
      title: draft.title.trim().slice(0, 120) || "知识候选",
      content: draft.content.trim(),
      summary: normalizeOptionalText(draft.summary) ?? undefined,
      suggestedType: draft.suggestedType,
      suggestedCategoryId: normalizeOptionalText(draft.suggestedCategoryId) ?? undefined,
      suggestedTags: normalizeTags(draft.suggestedTags),
      confidence: clamp(draft.confidence, 0, 1),
      source: draft.source ?? options.source,
      sourceRefId: normalizeOptionalText(draft.sourceRefId ?? options.sourceRefId) ?? undefined,
      sourcePath: normalizeOptionalText(draft.sourcePath) ?? undefined,
      reason: draft.reason.trim() || "AI 从已确认内容中抽取为可复用知识候选。",
    };
  }

  private async getPendingCandidate(candidateId: string) {
    const candidate = await this.prisma.knowledgeCandidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new NotFoundException("KNOWLEDGE_CANDIDATE_NOT_FOUND");
    if (candidate.status !== KnowledgeCandidateStatus.pending) {
      throw new BadRequestException("KNOWLEDGE_CANDIDATE_ALREADY_REVIEWED");
    }
    return candidate;
  }

  private async assertCategory(categoryId: string) {
    const category = await this.prisma.knowledgeCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException("KNOWLEDGE_CATEGORY_NOT_FOUND");
  }
}

function sourceFromCandidate(source: KnowledgeCandidateSource) {
  if (source === KnowledgeCandidateSource.prd) return KnowledgeSource.prd_confirmation;
  if (source === KnowledgeCandidateSource.prototype) return KnowledgeSource.prototype_confirmation;
  if (source === KnowledgeCandidateSource.uploaded_file) return KnowledgeSource.file_extraction;
  return KnowledgeSource.project_extraction;
}

function appendCandidateContent(current: string, candidate: string) {
  if (current.includes(candidate)) return current;
  return `${current.trim()}\n\n${candidate.trim()}`.trim();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}
