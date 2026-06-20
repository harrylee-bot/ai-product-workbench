import {
  KnowledgeCandidateSource,
  KnowledgeCandidateStatus,
  KnowledgePriority,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeCandidateService } from "../src/knowledge/knowledge-candidate.service";
import { KnowledgeItemService } from "../src/knowledge/knowledge-item.service";
import { KnowledgeRetrievalService } from "../src/knowledge/knowledge-retrieval.service";

describe("Knowledge module services", () => {
  const now = new Date("2026-06-21T08:00:00Z");
  const prisma = {
    knowledgeItem: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    knowledgeCategory: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    knowledgeVersion: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    knowledgeCandidate: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    knowledgeRetrievalLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const user = {
    id: "admin-1",
    username: "admin",
    displayName: "管理员",
    role: UserRole.admin,
    status: UserStatus.active,
  };
  const itemService = new KnowledgeItemService(prisma as never);
  const candidateService = new KnowledgeCandidateService(prisma as never, itemService);
  const retrievalService = new KnowledgeRetrievalService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.knowledgeVersion.findFirst.mockResolvedValue(null);
    prisma.knowledgeVersion.create.mockImplementation(async ({ data }) => ({
      id: `version-${data.version}`,
      ...data,
      createdAt: now,
    }));
    prisma.$transaction.mockImplementation(async (input) => {
      if (typeof input === "function") return input(prisma);
      return Promise.all(input);
    });
  });

  it("creates knowledge items and writes version snapshots", async () => {
    prisma.knowledgeItem.create.mockImplementation(async ({ data }) => itemRow({ id: "knowledge-1", ...data }));

    const item = await itemService.createItem(user, {
      title: "活动时间强规则",
      content: "活动未开始和已结束时不可参与。",
      type: KnowledgeType.strong_rule,
      status: KnowledgeStatus.active,
      tags: ["活动", "时间"],
    });

    expect(item).toMatchObject({
      id: "knowledge-1",
      type: KnowledgeType.strong_rule,
      status: KnowledgeStatus.active,
      tags: ["活动", "时间"],
    });
    expect(prisma.knowledgeVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        knowledgeItemId: "knowledge-1",
        version: 1,
        createdBy: "admin-1",
      }),
    });
  });

  it("retrieves active knowledge by query and records retrieval logs", async () => {
    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "active-1",
        title: "每日签到强规则",
        content: "用户每日只能签到一次。",
        type: KnowledgeType.strong_rule,
        status: KnowledgeStatus.active,
        priority: KnowledgePriority.high,
        tags: ["签到"],
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      projectId: "project-1",
      runId: "run-1",
      agentName: "knowledge_agent",
      query: "签到 每日一次",
      preferredTypes: [KnowledgeType.strong_rule],
      limit: 5,
    });

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        itemId: "active-1",
        type: KnowledgeType.strong_rule,
        score: expect.any(Number),
      }),
    );
    expect(result.references[0]).toEqual(
      expect.objectContaining({
        knowledgeId: "active-1",
        snippet: expect.any(String),
        sourceType: "knowledge_base",
      }),
    );
    expect(prisma.knowledgeItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: KnowledgeStatus.active,
          type: { in: [KnowledgeType.strong_rule] },
        }),
      }),
    );
    expect(prisma.knowledgeRetrievalLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project-1",
        runId: "run-1",
        matchedKnowledgeIds: ["active-1"],
        selectedKnowledgeIds: ["active-1"],
      }),
    });
  });

  it("approves candidates into active knowledge items and blocks double review", async () => {
    const candidate = candidateRow();
    prisma.knowledgeCandidate.findUnique.mockResolvedValue(candidate);
    prisma.knowledgeItem.create.mockImplementation(async ({ data }) => itemRow({ id: "knowledge-approved", ...data }));
    prisma.knowledgeCandidate.update.mockImplementation(async ({ data }) => ({
      ...candidate,
      ...data,
      updatedAt: now,
    }));

    const result = await candidateService.approveCandidate(user, "candidate-1", {
      priority: KnowledgePriority.high,
    });

    expect(result.item).toMatchObject({
      id: "knowledge-approved",
      status: KnowledgeStatus.active,
      source: KnowledgeSource.prd_confirmation,
      priority: KnowledgePriority.high,
    });
    expect(result.candidate.status).toBe(KnowledgeCandidateStatus.approved);

    prisma.knowledgeCandidate.findUnique.mockResolvedValue({
      ...candidate,
      status: KnowledgeCandidateStatus.approved,
    });
    await expect(candidateService.rejectCandidate(user, "candidate-1", {
      reviewComment: "重复审核",
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});

function itemRow(input: Record<string, unknown>) {
  return {
    id: String(input.id ?? "knowledge-1"),
    title: String(input.title ?? "知识标题"),
    content: String(input.content ?? "知识内容"),
    summary: input.summary ? String(input.summary) : null,
    type: input.type ?? KnowledgeType.default_rule,
    status: input.status ?? KnowledgeStatus.draft,
    scope: input.scope ?? KnowledgeScope.global,
    categoryId: input.categoryId ? String(input.categoryId) : null,
    tags: input.tags ?? [],
    priority: input.priority ?? KnowledgePriority.medium,
    source: input.source ?? KnowledgeSource.manual,
    sourceProjectId: input.sourceProjectId ? String(input.sourceProjectId) : null,
    sourceFileId: input.sourceFileId ? String(input.sourceFileId) : null,
    sourcePrdDocumentId: input.sourcePrdDocumentId ? String(input.sourcePrdDocumentId) : null,
    sourcePrototypeArtifactId: input.sourcePrototypeArtifactId ? String(input.sourcePrototypeArtifactId) : null,
    category: input.category ?? null,
    createdBy: String(input.createdBy ?? "admin-1"),
    updatedBy: input.updatedBy ? String(input.updatedBy) : null,
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-21T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-21T08:00:00Z"),
  };
}

function candidateRow(input: Record<string, unknown> = {}) {
  return {
    id: String(input.id ?? "candidate-1"),
    projectId: String(input.projectId ?? "project-1"),
    title: String(input.title ?? "每日签到规则候选"),
    content: String(input.content ?? "用户每日只能签到一次。"),
    summary: input.summary ? String(input.summary) : null,
    suggestedType: input.suggestedType ?? KnowledgeType.strong_rule,
    suggestedCategoryId: input.suggestedCategoryId ? String(input.suggestedCategoryId) : null,
    suggestedTags: input.suggestedTags ?? ["签到"],
    confidence: Number(input.confidence ?? 0.82),
    source: input.source ?? KnowledgeCandidateSource.prd,
    sourceRefId: input.sourceRefId ? String(input.sourceRefId) : "prd-1",
    sourcePath: input.sourcePath ? String(input.sourcePath) : "businessRules",
    reason: String(input.reason ?? "从确认 PRD 中抽取。"),
    status: input.status ?? KnowledgeCandidateStatus.pending,
    reviewedBy: input.reviewedBy ? String(input.reviewedBy) : null,
    reviewedAt: input.reviewedAt instanceof Date ? input.reviewedAt : null,
    reviewComment: input.reviewComment ? String(input.reviewComment) : null,
    createdByRunId: input.createdByRunId ? String(input.createdByRunId) : "run-1",
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-21T08:00:00Z"),
    updatedAt: input.updatedAt instanceof Date ? input.updatedAt : new Date("2026-06-21T08:00:00Z"),
  };
}
