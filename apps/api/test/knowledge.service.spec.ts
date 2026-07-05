import {
  KnowledgeCandidateSource,
  KnowledgeCandidateStatus,
  KnowledgePriority,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  ConversationStatus,
  QAReportStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
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
    conversation: {
      findUnique: vi.fn(),
    },
    qAReport: {
      findFirst: vi.fn(),
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
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      status: ConversationStatus.prototype_ready,
      deletedAt: null,
      latestQaReportId: "qa-pass",
    });
    prisma.qAReport.findFirst.mockResolvedValue(qaReportRow());
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
      conversationId: "conversation-1",
      runId: "run-1",
      runtimeName: "deerflow_runtime",
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
        }),
      }),
    );
    expect(prisma.knowledgeItem.findMany.mock.calls.at(-1)?.[0].where.type).toBeUndefined();
    expect(prisma.knowledgeRetrievalLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: "conversation-1",
        runId: "run-1",
        matchedKnowledgeIds: ["active-1"],
        selectedKnowledgeIds: ["active-1"],
      }),
    });
  });

  it("retrieves Chinese knowledge from natural-language long input", async () => {
    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "crm-strong-rule",
        title: "企业客户线索强规则",
        content: "线索必须包含来源渠道、客户联系人、跟进状态和下一步动作。",
        type: KnowledgeType.strong_rule,
        status: KnowledgeStatus.active,
        priority: KnowledgePriority.high,
        tags: ["客户", "线索", "企业"],
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-1",
      runtimeName: "deerflow_runtime",
      query: "帮我生成一个企业客户线索管理系统，包含需求文档和原型",
      preferredTypes: [KnowledgeType.strong_rule],
      limit: 5,
    });

    expect(result.results[0]).toEqual(
      expect.objectContaining({
        itemId: "crm-strong-rule",
        title: "企业客户线索强规则",
      }),
    );
    expect(result.references[0]?.content).toContain("线索必须包含来源渠道");
  });

  it("keeps preferredTypes as ranking hints unless strict filtering is requested", async () => {
    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "design-pattern",
        title: "工作台画布设计模式",
        content: "复杂需求可用画布表达章节、状态和验收关系。",
        type: KnowledgeType.design_pattern,
        status: KnowledgeStatus.active,
        priority: KnowledgePriority.medium,
        tags: ["画布", "工作台"],
      }),
      itemRow({
        id: "safety-rule",
        title: "变更安全强规则",
        content: "所有高影响变更必须先经过 final action 复核门。",
        type: KnowledgeType.strong_rule,
        status: KnowledgeStatus.active,
        priority: KnowledgePriority.high,
        tags: ["变更", "安全"],
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const broad = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-2",
      runtimeName: "deerflow_runtime",
      query: "工作台画布变更安全",
      preferredTypes: [KnowledgeType.design_pattern],
      limit: 5,
    });

    expect(broad.results.map((item) => item.itemId)).toEqual(expect.arrayContaining([
      "design-pattern",
      "safety-rule",
    ]));
    expect(prisma.knowledgeItem.findMany.mock.calls.at(-1)?.[0].where.type).toBeUndefined();

    await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-3",
      runtimeName: "deerflow_runtime",
      query: "工作台画布变更安全",
      preferredTypes: [KnowledgeType.design_pattern],
      strictPreferredTypes: true,
      limit: 5,
    });

    expect(prisma.knowledgeItem.findMany.mock.calls.at(-1)?.[0].where.type).toEqual({
      in: [KnowledgeType.design_pattern],
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

  it("blocks knowledge persistence when the latest QA gate rejects persist_knowledge", async () => {
    const candidate = candidateRow();
    prisma.knowledgeCandidate.findUnique.mockResolvedValue(candidate);
    prisma.qAReport.findFirst.mockResolvedValue(qaReportRow({
      status: QAReportStatus.failed,
      majorCount: 1,
      issues: [{
        id: "qa-major",
        checkType: "knowledge_rule_compliance",
        severity: "major",
        title: "知识规则未体现",
        description: "ConversationDesignState 未体现强规则。",
        status: "open",
      }],
    }));

    await expect(candidateService.approveCandidate(user, "candidate-1", {
      priority: KnowledgePriority.high,
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.knowledgeItem.create).not.toHaveBeenCalled();

    await expect(candidateService.mergeCandidate(user, "candidate-1", {
      targetKnowledgeItemId: "knowledge-target",
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.knowledgeItem.findUnique).not.toHaveBeenCalled();
  });

  it("skips duplicate candidates from the same confirmed artifact", async () => {
    prisma.knowledgeCandidate.findMany.mockResolvedValue([
      candidateRow({
        id: "candidate-existing",
        title: "每日签到规则候选",
        content: "用户每日只能签到一次。",
        source: KnowledgeCandidateSource.prd,
        sourceRefId: "prd-1",
        sourcePath: "businessRules",
      }),
    ]);

    const result = await candidateService.createMany(
      "conversation-1",
      [
        {
          title: "每日签到规则候选",
          content: "用户每日只能签到一次。",
          suggestedType: KnowledgeType.strong_rule,
          suggestedTags: ["签到"],
          confidence: 0.9,
          sourcePath: "businessRules",
          reason: "从确认 PRD 中抽取。",
        },
        {
          title: "每日签到规则候选",
          content: "用户每日只能签到一次。",
          suggestedType: KnowledgeType.strong_rule,
          suggestedTags: ["签到"],
          confidence: 0.9,
          sourcePath: "businessRules",
          reason: "重复候选。",
        },
      ],
      { source: KnowledgeCandidateSource.prd, sourceRefId: "prd-1", runId: "run-1" },
    );

    expect(result).toEqual({ items: [], skippedDuplicates: 1 });
    expect(prisma.knowledgeCandidate.create).not.toHaveBeenCalled();
  });

  it("closes the loop from confirmed artifact candidate to next retrieval hit", async () => {
    prisma.knowledgeCandidate.findMany.mockResolvedValueOnce([]);
    prisma.knowledgeCandidate.create.mockImplementation(async ({ data }) =>
      candidateRow({ id: "candidate-closed-loop", ...data }),
    );

    const created = await candidateService.createMany(
      "conversation-1",
      [{
        title: "每日签到强规则",
        content: "用户每日只能签到一次。",
        suggestedType: KnowledgeType.strong_rule,
        suggestedTags: ["签到", "活动"],
        confidence: 0.95,
        sourcePath: "businessRules[0]",
        reason: "从用户确认后的 PRD 抽取为可复用强规则。",
      }],
      { source: KnowledgeCandidateSource.prd, sourceRefId: "prd-1", runId: "run-1" },
    );
    expect(created.items[0]).toEqual(expect.objectContaining({
      id: "candidate-closed-loop",
      source: KnowledgeCandidateSource.prd,
      sourceRefId: "prd-1",
    }));

    const candidate = candidateRow({
      id: "candidate-closed-loop",
      title: "每日签到强规则",
      content: "用户每日只能签到一次。",
      source: KnowledgeCandidateSource.prd,
      sourceRefId: "prd-1",
      sourcePath: "businessRules[0]",
      suggestedType: KnowledgeType.strong_rule,
      suggestedTags: ["签到", "活动"],
    });
    prisma.knowledgeCandidate.findUnique.mockResolvedValue(candidate);
    prisma.knowledgeItem.create.mockImplementation(async ({ data }) => itemRow({ id: "knowledge-closed-loop", ...data }));
    prisma.knowledgeCandidate.update.mockImplementation(async ({ data }) => ({
      ...candidate,
      ...data,
      updatedAt: now,
    }));

    const approved = await candidateService.approveCandidate(user, "candidate-closed-loop", {
      priority: KnowledgePriority.high,
    });
    expect(approved.item).toEqual(expect.objectContaining({
      id: "knowledge-closed-loop",
      status: KnowledgeStatus.active,
      source: KnowledgeSource.prd_confirmation,
      sourceConversationId: "conversation-1",
      sourcePrdDocumentId: "prd-1",
    }));

    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "knowledge-closed-loop",
        title: approved.item.title,
        content: approved.item.content,
        type: KnowledgeType.strong_rule,
        status: KnowledgeStatus.active,
        priority: KnowledgePriority.high,
        tags: approved.item.tags,
        source: KnowledgeSource.prd_confirmation,
        sourceConversationId: "conversation-1",
        sourcePrdDocumentId: "prd-1",
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const nextHit = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-next",
      runtimeName: "deerflow_runtime",
      query: "做一个每日签到活动",
      preferredTypes: [KnowledgeType.strong_rule],
      limit: 5,
    });

    expect(nextHit.references[0]).toEqual(expect.objectContaining({
      knowledgeId: "knowledge-closed-loop",
      title: "每日签到强规则",
      sourceType: "knowledge_base",
    }));
    expect(prisma.knowledgeRetrievalLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run-next",
        selectedKnowledgeIds: ["knowledge-closed-loop"],
      }),
    });
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
    sourceConversationId: input.sourceConversationId ? String(input.sourceConversationId) : null,
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
    conversationId: String(input.conversationId ?? "conversation-1"),
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

function qaReportRow(input: Record<string, unknown> = {}) {
  return {
    id: String(input.id ?? "qa-pass"),
    conversationId: String(input.conversationId ?? "conversation-1"),
    status: input.status ?? QAReportStatus.passed,
    blockingCount: Number(input.blockingCount ?? 0),
    majorCount: Number(input.majorCount ?? 0),
    minorCount: Number(input.minorCount ?? 0),
    infoCount: Number(input.infoCount ?? 0),
    issues: input.issues ?? [],
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date("2026-06-21T08:00:00Z"),
  };
}
