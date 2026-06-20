import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  AdminAuditTargetType,
  KnowledgeSource,
  KnowledgeStatus,
  Prisma,
} from "@prisma/client";
import { AdminAuditService } from "../admin/admin-audit.service";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { toInputJson } from "../ai/ai-vibe.helpers";
import { PrismaService } from "../prisma/prisma.service";
import type {
  CreateKnowledgeCategoryDto,
  CreateKnowledgeItemDto,
  ListKnowledgeItemsQueryDto,
  UpdateKnowledgeItemDto,
} from "./knowledge.dto";

type KnowledgeItemRow = Prisma.KnowledgeItemGetPayload<Record<string, never>>;
type KnowledgeCategoryRow = Prisma.KnowledgeCategoryGetPayload<Record<string, never>>;

@Injectable()
export class KnowledgeItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit?: AdminAuditService,
  ) {}

  async createItem(user: AuthenticatedUser, dto: CreateKnowledgeItemDto, meta?: RequestMeta) {
    await this.assertCategory(dto.categoryId);
    const item = await this.prisma.knowledgeItem.create({
      data: {
        title: dto.title.trim(),
        content: dto.content.trim(),
        summary: normalizeOptionalText(dto.summary),
        type: dto.type,
        status: dto.status ?? KnowledgeStatus.draft,
        scope: dto.scope ?? "global",
        categoryId: normalizeOptionalText(dto.categoryId),
        tags: toInputJson(normalizeTags(dto.tags)),
        priority: dto.priority ?? "medium",
        source: KnowledgeSource.manual,
        createdBy: user.id,
        updatedBy: user.id,
      },
    });
    await this.createVersionSnapshot(item, user.id, "创建知识");
    await this.recordAudit(user, "knowledge_item.create", item.id, meta, {
      title: item.title,
      type: item.type,
      status: item.status,
    });
    return this.toItem(item);
  }

  async updateItem(
    user: AuthenticatedUser,
    knowledgeId: string,
    dto: UpdateKnowledgeItemDto,
    meta?: RequestMeta,
  ) {
    const current = await this.getItemRow(knowledgeId);
    await this.assertCategory(dto.categoryId);

    const updateData = compactObject<Prisma.KnowledgeItemUpdateInput>({
      title: dto.title?.trim(),
      content: dto.content?.trim(),
      summary: dto.summary === undefined ? undefined : normalizeOptionalText(dto.summary),
      type: dto.type,
      status: dto.status,
      scope: dto.scope,
      category: dto.categoryId === undefined
        ? undefined
        : dto.categoryId
          ? { connect: { id: dto.categoryId } }
          : { disconnect: true },
      tags: dto.tags === undefined ? undefined : toInputJson(normalizeTags(dto.tags)),
      priority: dto.priority,
      updatedBy: user.id,
    });
    if (Object.keys(updateData).length <= 1) {
      throw new BadRequestException("KNOWLEDGE_UPDATE_FAILED");
    }

    const updated = await this.prisma.knowledgeItem.update({
      where: { id: current.id },
      data: updateData,
    });
    await this.createVersionSnapshot(updated, user.id, dto.changeSummary ?? "更新知识");
    await this.recordAudit(user, "knowledge_item.update", updated.id, meta, {
      title: updated.title,
      type: updated.type,
      status: updated.status,
    });
    return this.toItem(updated);
  }

  async getItem(knowledgeId: string) {
    return this.toItem(await this.getItemRow(knowledgeId));
  }

  async listItems(query: ListKnowledgeItemsQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const keyword = query.keyword?.trim();
    const where: Prisma.KnowledgeItemWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(keyword
        ? {
            OR: [
              { title: { contains: keyword, mode: "insensitive" } },
              { content: { contains: keyword, mode: "insensitive" } },
              { summary: { contains: keyword, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.knowledgeItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    const filtered = query.tag
      ? rows.filter((item) => jsonArray(item.tags).includes(query.tag!))
      : rows;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: items.map((item) => this.toItem(item)),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  async enableItem(user: AuthenticatedUser, knowledgeId: string, meta?: RequestMeta) {
    return this.updateItemStatus(user, knowledgeId, KnowledgeStatus.active, "启用知识", meta);
  }

  async disableItem(user: AuthenticatedUser, knowledgeId: string, meta?: RequestMeta) {
    return this.updateItemStatus(user, knowledgeId, KnowledgeStatus.disabled, "禁用知识", meta);
  }

  async createCategory(dto: CreateKnowledgeCategoryDto) {
    await this.assertCategory(dto.parentId);
    const category = await this.prisma.knowledgeCategory.create({
      data: {
        name: dto.name.trim(),
        description: normalizeOptionalText(dto.description),
        parentId: normalizeOptionalText(dto.parentId),
        order: dto.order ?? 0,
      },
    });
    return this.toCategory(category);
  }

  async listCategories() {
    const items = await this.prisma.knowledgeCategory.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return { items: items.map((item) => this.toCategory(item)) };
  }

  async createVersionSnapshot(
    item: KnowledgeItemRow,
    userId: string,
    changeSummary?: string,
    tx: Pick<PrismaService, "knowledgeVersion"> = this.prisma,
  ) {
    const latest = await tx.knowledgeVersion.findFirst({
      where: { knowledgeItemId: item.id },
      orderBy: { version: "desc" },
    });
    return tx.knowledgeVersion.create({
      data: {
        knowledgeItemId: item.id,
        version: (latest?.version ?? 0) + 1,
        snapshot: toInputJson(this.toItem(item)),
        changeSummary: changeSummary ?? "知识版本快照",
        createdBy: userId,
      },
    });
  }

  toItem(item: KnowledgeItemRow) {
    return {
      id: item.id,
      title: item.title,
      content: item.content,
      summary: item.summary ?? undefined,
      type: item.type,
      status: item.status,
      scope: item.scope,
      categoryId: item.categoryId ?? undefined,
      tags: jsonArray(item.tags),
      priority: item.priority,
      source: item.source,
      sourceProjectId: item.sourceProjectId ?? undefined,
      sourceFileId: item.sourceFileId ?? undefined,
      sourcePrdDocumentId: item.sourcePrdDocumentId ?? undefined,
      sourcePrototypeArtifactId: item.sourcePrototypeArtifactId ?? undefined,
      createdBy: item.createdBy,
      updatedBy: item.updatedBy ?? undefined,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private async updateItemStatus(
    user: AuthenticatedUser,
    knowledgeId: string,
    status: KnowledgeStatus,
    changeSummary: string,
    meta?: RequestMeta,
  ) {
    await this.getItemRow(knowledgeId);
    const updated = await this.prisma.knowledgeItem.update({
      where: { id: knowledgeId },
      data: { status, updatedBy: user.id },
    });
    await this.createVersionSnapshot(updated, user.id, changeSummary);
    await this.recordAudit(
      user,
      status === KnowledgeStatus.active ? "knowledge_item.enable" : "knowledge_item.disable",
      updated.id,
      meta,
      { title: updated.title, status: updated.status },
    );
    return { success: true, item: this.toItem(updated) };
  }

  private async getItemRow(knowledgeId: string) {
    const item = await this.prisma.knowledgeItem.findUnique({ where: { id: knowledgeId } });
    if (!item) throw new NotFoundException("KNOWLEDGE_ITEM_NOT_FOUND");
    return item;
  }

  private async assertCategory(categoryId?: string) {
    if (!categoryId) return;
    const category = await this.prisma.knowledgeCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException("KNOWLEDGE_CATEGORY_NOT_FOUND");
  }

  private toCategory(category: KnowledgeCategoryRow) {
    return {
      id: category.id,
      name: category.name,
      description: category.description ?? undefined,
      parentId: category.parentId ?? undefined,
      order: category.order,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString(),
    };
  }

  private async recordAudit(
    admin: AuthenticatedUser,
    action: string,
    targetId: string,
    meta?: RequestMeta,
    detail?: Record<string, unknown>,
  ) {
    await this.audit?.record({
      admin,
      action,
      targetType: AdminAuditTargetType.knowledge_item,
      targetId,
      detail,
      meta,
    });
  }
}

export function normalizeTags(tags?: string[]) {
  return [...new Set((tags ?? []).map((item) => item.trim()).filter(Boolean))];
}

export function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function normalizeOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
