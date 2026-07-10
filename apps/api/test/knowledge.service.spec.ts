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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KnowledgeCandidateService } from "../src/knowledge/knowledge-candidate.service";
import { KnowledgeItemService } from "../src/knowledge/knowledge-item.service";
import { KnowledgeRetrievalService } from "../src/knowledge/knowledge-retrieval.service";

describe("Knowledge module services", () => {
  const now = new Date("2026-06-21T08:00:00Z");
  const envBackup = { ...process.env };
  const tempPaths: string[] = [];
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
    process.env = { ...envBackup };
    prisma.knowledgeVersion.findFirst.mockResolvedValue(null);
    prisma.knowledgeVersion.create.mockImplementation(async ({ data }) => ({
      id: `version-${data.version}`,
      ...data,
      createdAt: now,
    }));
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-1",
      status: ConversationStatus.active,
      deletedAt: null,
      latestQaReportId: "qa-pass",
    });
    prisma.qAReport.findFirst.mockResolvedValue(qaReportRow());
    prisma.$transaction.mockImplementation(async (input) => {
      if (typeof input === "function") return input(prisma);
      return Promise.all(input);
    });
  });

  afterEach(async () => {
    process.env = { ...envBackup };
    await Promise.all(tempPaths.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

  it("falls back to the local Markdown knowledge vault when database knowledge misses", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-knowledge-vault-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/活动发布与模板配置.md",
      [
        "---",
        "title: 活动发布与模板配置",
        "tags:",
        "  - 活动发布",
        "  - 模板配置",
        "---",
        "# 活动发布与模板配置",
        "签到领积分活动必须放在活动配置、预览审核、发布上线和报表复盘闭环中处理。",
      ].join("\n"),
    );
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/奖品券与资损核销.md",
      [
        "---",
        "title: 奖品券与资损核销",
        "---",
        "# 奖品券与资损核销",
        "积分奖励属于权益履约，需要写库存、重复领取限制、发放失败、核销对账和资损控制。",
      ].join("\n"),
    );
    await writeVaultFile(
      vaultRoot,
      "04-产品文档规范/PRD标准结构.md",
      "# PRD标准结构\n需求说明书必须包含引言、业务需求、业务降级方案和需求安全基线要求。",
    );
    await writeVaultFile(
      vaultRoot,
      "05-原型设计规范/原型生成总规则.md",
      "# 原型生成总规则\n活动原型必须覆盖后台配置页、用户端签到页、审核发布状态和数据报表。",
    );
    await writeVaultFile(
      vaultRoot,
      "05-原型设计规范/签到活动高保真HTML原型框架.md",
      [
        "---",
        "title: 签到活动高保真HTML原型框架",
        "tags:",
        "  - HTML原型",
        "  - Axure",
        "  - RP资产",
        "---",
        "# 签到活动高保真HTML原型框架",
        "签到领积分活动原型必须复用 Axure HTML 原型的信息架构，包含后台配置、banner、海报开关、跳转类型、隐私协议、每日库存、补偿重试和前台预览。",
      ].join("\n"),
    );
    prisma.knowledgeItem.findMany.mockResolvedValue([]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-vault",
      runtimeName: "runtime_generation",
      query: "我想做一个签到领积分的活动，请生成需求文档和原型",
      preferredTypes: [
        KnowledgeType.business_concept,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.prototype_asset_ref,
      ],
      limit: 8,
    });

    expect(result.retrievalSource).toBe("vault_fallback");
    expect(result.selectedCount).toBeGreaterThanOrEqual(3);
    expect(result.references.map((item) => item.title)).toEqual(expect.arrayContaining([
      "活动发布与模板配置",
      "奖品券与资损核销",
      "PRD标准结构",
      "原型生成总规则",
      "签到活动高保真HTML原型框架",
    ]));
    expect(result.references.slice(0, 5).map((item) => item.title)).toEqual([
      "PRD标准结构",
      "原型生成总规则",
      "签到活动高保真HTML原型框架",
      "奖品券与资损核销",
      "活动发布与模板配置",
    ]);
    expect(result.references[0]?.relatedPath).toMatch(/^(02|04|05)-/);
    expect(prisma.knowledgeRetrievalLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchedKnowledgeIds: expect.arrayContaining([
          "vault:02-业务域知识/活动发布与模板配置.md",
        ]),
      }),
    });
  });

  it("continues to repo Markdown vault when explicit production vault is empty", async () => {
    const emptyVaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-empty-production-vault-"));
    tempPaths.push(emptyVaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = emptyVaultRoot;
    prisma.knowledgeItem.findMany.mockResolvedValue([]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-empty-production-vault",
      runtimeName: "runtime_generation",
      query: "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型",
      preferredTypes: [
        KnowledgeType.business_concept,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.prototype_asset_ref,
      ],
      requirementMode: "one_sentence_completion",
      vaultPolicy: "always",
      limit: 10,
    });

    const evidence = result.references
      .map((item) => `${item.title}\n${item.relatedPath}\n${item.snippet}`)
      .join("\n\n");

    expect(result.retrievalSource).toBe("vault_fallback");
    expect(result.selectedCount).toBeGreaterThanOrEqual(4);
    expect(evidence).toMatch(/活动发布与模板配置/);
    expect(evidence).toMatch(/签到与任务积分活动/);
    expect(evidence).toMatch(/奖品券与资损核销/);
    expect(evidence).toMatch(/PRD标准结构|需求说明书/);
    expect(evidence).toMatch(/原型生成总规则|前后台页面框架/);
    expect(evidence).toMatch(/签到活动高保真HTML原型框架|原型转HTML资产索引|RP资产到设计框架映射|前台页面设计框架|后台管理设计框架|HTML原型|Axure|RP资产/);
  });

  it("selects the prototype asset for the current domain instead of a hardcoded sign-in asset", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-domain-prototype-vault-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(
      vaultRoot,
      "04-产品文档规范/PRD标准结构.md",
      "# PRD标准结构\n需求说明书包含引言、业务需求、降级方案和安全基线。",
    );
    await writeVaultFile(
      vaultRoot,
      "05-原型设计规范/原型生成总规则.md",
      "# 原型生成总规则\n原型覆盖前后台页面、状态、异常和数据治理。",
    );
    await writeVaultFile(
      vaultRoot,
      "05-原型设计规范/签到活动高保真HTML原型框架.md",
      "---\ntitle: 签到活动高保真HTML原型框架\ntags:\n  - HTML原型\n---\n# 签到活动高保真HTML原型框架\n签到、积分、连续奖励。",
    );
    await writeVaultFile(
      vaultRoot,
      "05-原型设计规范/门店预约高保真HTML原型框架.md",
      "---\ntitle: 门店预约高保真HTML原型框架\ntags:\n  - HTML原型\n  - 门店预约\n---\n# 门店预约高保真HTML原型框架\n门店配置、预约容量、预约提交、到店状态。",
    );
    prisma.knowledgeItem.findMany.mockResolvedValue([]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      conversationId: "conversation-store-booking",
      runId: "run-store-booking",
      runtimeName: "runtime_generation",
      query: "门店预约功能，请生成需求文档和原型",
      preferredTypes: [KnowledgeType.prd_writing_rule, KnowledgeType.prototype_rule, KnowledgeType.prototype_asset_ref],
      requirementMode: "one_sentence_completion",
      vaultPolicy: "always",
      limit: 6,
    });

    const prototypeAssets = result.references.filter((item) => item.type === KnowledgeType.prototype_asset_ref);
    expect(prototypeAssets[0]?.title).toBe("门店预约高保真HTML原型框架");
    expect(prototypeAssets[0]?.content).toContain("预约容量");

    const unrelated = await retrievalService.search({
      conversationId: "conversation-inspection",
      runId: "run-inspection",
      runtimeName: "runtime_generation",
      query: "设备巡检工单，请生成需求文档和原型",
      preferredTypes: [KnowledgeType.prd_writing_rule, KnowledgeType.prototype_rule, KnowledgeType.prototype_asset_ref],
      requirementMode: "one_sentence_completion",
      vaultPolicy: "always",
      limit: 6,
    });
    expect(unrelated.references.some((item) => item.type === KnowledgeType.prototype_asset_ref)).toBe(false);
  });

  it("can merge database hits with Markdown vault knowledge for runtime generation", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-knowledge-vault-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/活动发布与模板配置.md",
      "# 活动发布与模板配置\n签到领积分活动需要后台配置、预览审核、发布上线和数据报表。",
    );
    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "db-signin-rule",
        title: "每日签到强规则",
        content: "用户每日只能签到一次，重复签到不能重复发积分。",
        type: KnowledgeType.strong_rule,
        status: KnowledgeStatus.active,
        priority: KnowledgePriority.high,
        tags: ["签到", "积分"],
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-merge",
      runtimeName: "runtime_generation",
      query: "签到领积分活动",
      preferredTypes: [KnowledgeType.strong_rule, KnowledgeType.business_concept],
      vaultPolicy: "always",
      limit: 8,
    });

    expect(result.retrievalSource).toBe("database_and_vault");
    expect(result.references.map((item) => item.knowledgeId)).toEqual(expect.arrayContaining([
      "db-signin-rule",
      "vault:02-业务域知识/活动发布与模板配置.md",
    ]));
  });

  it("keeps source archives and inbox entries out of normal generation", async () => {
    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "main-activity-rule",
        title: "活动发布与模板配置",
        content: "签到活动必须经过配置、审核、发布和报表复盘。",
        type: KnowledgeType.business_concept,
        priority: KnowledgePriority.high,
        sourceFileId: "02-业务域知识/活动发布与模板配置.md",
      }),
      itemRow({
        id: "old-source-rule",
        title: "旧版签到活动生成规则",
        content: "旧版签到活动需求文档和原型生成规则。",
        type: KnowledgeType.default_rule,
        priority: KnowledgePriority.low,
        sourceFileId: "07-来源资产索引/旧版整理/签到规则.md",
      }),
      itemRow({
        id: "inbox-draft",
        title: "签到活动待整理记录",
        content: "未经核验的签到活动需求文档和原型记录。",
        type: KnowledgeType.default_rule,
        priority: KnowledgePriority.low,
        sourceFileId: "99-收件箱/签到活动导入记录.md",
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      query: "生成签到活动需求文档和原型",
      vaultPolicy: "never",
      limit: 10,
    });

    expect(result.references.map((item) => item.knowledgeId)).toEqual(["main-activity-rule"]);
    expect(result.references[0]?.relatedPath).toBe("02-业务域知识/活动发布与模板配置.md");
  });

  it("opens source archives only for an explicit source lookup", async () => {
    prisma.knowledgeItem.findMany.mockResolvedValue([
      itemRow({
        id: "main-activity-rule",
        title: "活动发布与模板配置",
        content: "现行活动配置规则。",
        type: KnowledgeType.business_concept,
        priority: KnowledgePriority.high,
        sourceFileId: "02-业务域知识/活动发布与模板配置.md",
      }),
      itemRow({
        id: "source-manual",
        title: "贵州签到活动原始手册",
        content: "原始文件和导入记录位于贵州签到 Axure HTML 资产。",
        type: KnowledgeType.default_rule,
        priority: KnowledgePriority.low,
        sourceFileId: "07-来源资产索引/旧版整理/贵州签到活动原始手册.md",
      }),
    ]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      query: "查找贵州签到活动的原始文件和导入记录",
      vaultPolicy: "never",
      limit: 10,
    });

    expect(result.references.map((item) => item.knowledgeId)).toContain("source-manual");
    expect(result.references.find((item) => item.knowledgeId === "source-manual")?.relatedPath)
      .toBe("07-来源资产索引/旧版整理/贵州签到活动原始手册.md");
  });

  it("applies the same retrieval boundary to Markdown vault fallback", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-tiered-vault-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/签到与任务积分活动.md",
      "# 签到与任务积分活动\n现行签到活动必须处理自然日幂等和积分补偿。",
    );
    await writeVaultFile(
      vaultRoot,
      "07-来源资产索引/旧版签到说明.md",
      "# 旧版签到说明\n这是原始文件和旧版资料，只用于核验来源。",
    );
    await writeVaultFile(
      vaultRoot,
      "99-收件箱/签到待整理.md",
      "# 签到待整理\n这是尚未核验的签到草稿。",
    );
    prisma.knowledgeItem.findMany.mockResolvedValue([]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const generation = await retrievalService.search({
      query: "生成签到积分活动方案",
      vaultPolicy: "always",
      limit: 10,
    });
    expect(generation.references.map((item) => item.relatedPath)).toEqual([
      "02-业务域知识/签到与任务积分活动.md",
    ]);

    const sourceLookup = await retrievalService.search({
      query: "查看签到活动的旧版资料和原始文件",
      vaultPolicy: "always",
      limit: 10,
    });
    expect(sourceLookup.references.map((item) => item.relatedPath)).toContain(
      "07-来源资产索引/旧版签到说明.md",
    );
    expect(sourceLookup.references.map((item) => item.relatedPath)).not.toContain(
      "99-收件箱/签到待整理.md",
    );
  });

  it("hits required real vault knowledge for the sign-in points runtime topic", async () => {
    const vaultRoot = findRepoKnowledgeVaultRoot();
    expect(vaultRoot).toBeTruthy();
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    prisma.knowledgeItem.findMany.mockResolvedValue([]);
    prisma.knowledgeRetrievalLog.create.mockResolvedValue({});

    const result = await retrievalService.search({
      conversationId: "conversation-1",
      runId: "run-real-vault-signin-points",
      runtimeName: "runtime_generation",
      query: "我想做一个签到领积分的活动，请根据知识库内容生成需求文档和原型",
      preferredTypes: [
        KnowledgeType.business_concept,
        KnowledgeType.prd_writing_rule,
        KnowledgeType.prototype_rule,
        KnowledgeType.prototype_asset_ref,
      ],
      requirementMode: "one_sentence_completion",
      vaultPolicy: "always",
      limit: 10,
    });

    const evidence = result.references
      .map((item) => `${item.title}\n${item.relatedPath}\n${item.snippet}`)
      .join("\n\n");

    expect(result.retrievalSource).toBe("vault_fallback");
    expect(result.selectedCount).toBeGreaterThanOrEqual(4);
    expect(evidence).toMatch(/活动发布与模板配置/);
    expect(evidence).toMatch(/奖品券与资损核销/);
    expect(evidence).toMatch(/PRD标准结构|需求说明书/);
    expect(evidence).toMatch(/原型生成总规则|前后台页面框架/);
    expect(evidence).toMatch(/签到活动高保真HTML原型框架|原型转HTML资产索引|RP资产到设计框架映射|前台页面设计框架|后台管理设计框架|HTML原型|Axure|RP资产/);
    expect(result.references.find((item) => /签到活动高保真HTML原型框架/.test(item.title))?.type)
      .toBe(KnowledgeType.prototype_asset_ref);
    expect(result.references[3]?.relatedPath).toBe("02-业务域知识/签到与任务积分活动.md");
    expect(result.references.map((item) => item.relatedPath)).not.toContain(
      "02-业务域知识/号卡OAO与商机预约.md",
    );
    expect(result.references.every((item) => item.knowledgeId.startsWith("vault:"))).toBe(true);
    expect(prisma.knowledgeRetrievalLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "run-real-vault-signin-points",
        selectedKnowledgeIds: expect.arrayContaining([
          "vault:02-业务域知识/签到与任务积分活动.md",
          "vault:02-业务域知识/活动发布与模板配置.md",
        ]),
      }),
    });
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

async function writeVaultFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function findRepoKnowledgeVaultRoot() {
  return [
    path.resolve(process.cwd(), "knowledge-vault"),
    path.resolve(process.cwd(), "..", "..", "knowledge-vault"),
  ].find((candidate) => existsSync(candidate));
}

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
