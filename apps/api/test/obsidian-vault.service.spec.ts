import {
  KnowledgePriority,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  Prisma,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ObsidianVaultService } from "../src/knowledge/obsidian-vault.service";

describe("ObsidianVaultService", () => {
  const envBackup = { ...process.env };
  const tempPaths: string[] = [];

  afterEach(async () => {
    process.env = { ...envBackup };
    await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
  });

  it("syncs main and source tiers while excluding inbox and templates", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-sync-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;

    await writeVaultFile(vaultRoot, "00-知识库使用规范/规则文档.md", markdown("规则文档", "## 适用场景\n正式生成必须优先使用现行规则。"));
    await writeVaultFile(vaultRoot, "06-历史案例库/活动案例.md", markdown("活动案例", "历史案例只用于补强，不覆盖现行规则。"));
    await writeVaultFile(vaultRoot, "07-来源资产索引/旧版资料.md", markdown("旧版资料", "旧版资料只用于核验来源。"));
    await writeVaultFile(vaultRoot, "99-收件箱/待整理.md", markdown("待整理", "未经核验，不能进入正式生成。"));
    await writeVaultFile(vaultRoot, "_templates/知识条目模板.md", markdown("知识条目模板", "模板不进入线上知识。"));
    await writeVaultFile(vaultRoot, "05-原型设计规范/README.md", markdown("原型设计规范", "现行 HTML 原型总规则。", ["HTML原型"]));
    await writeVaultFile(vaultRoot, "05-原型设计规范/签到活动高保真HTML原型框架.md", markdown("签到活动高保真HTML原型框架", "从 Axure 资产提炼的原型框架。", ["Axure", "RP资产"]));

    const prisma = createPrismaMock();
    const service = new ObsidianVaultService(prisma as never);
    const result = await service.syncToKnowledgeBase({
      id: "system",
      username: "system",
      email: "system@example.local",
      displayName: "系统任务",
      role: UserRole.admin,
      status: UserStatus.active,
    });

    expect(result.markdownFiles).toBeGreaterThanOrEqual(3);
    const created = prisma.knowledgeItem.create.mock.calls.map(([input]) => input.data);
    expect(created.some((item) => item.sourceFileId.startsWith("99-收件箱/"))).toBe(false);
    expect(created.some((item) => item.sourceFileId.startsWith("_templates/"))).toBe(false);

    const strongRule = created.find((item) => item.sourceFileId === "00-知识库使用规范/规则文档.md");
    expect(strongRule).toMatchObject({
      type: KnowledgeType.strong_rule,
      priority: KnowledgePriority.high,
    });
    expect(strongRule.tags).toContain("vault-tier:main");

    const caseItem = created.find((item) => item.sourceFileId === "06-历史案例库/活动案例.md");
    expect(caseItem).toMatchObject({
      type: KnowledgeType.reference_case,
      priority: KnowledgePriority.medium,
    });

    const sourceItem = created.find((item) => item.sourceFileId === "07-来源资产索引/旧版资料.md");
    expect(sourceItem).toMatchObject({ priority: KnowledgePriority.low });
    expect(sourceItem.tags).toContain("vault-tier:source");
    expect(created.find((item) => item.sourceFileId === "05-原型设计规范/README.md")?.type)
      .toBe(KnowledgeType.prototype_rule);
    expect(created.find((item) => item.sourceFileId === "05-原型设计规范/签到活动高保真HTML原型框架.md")?.type)
      .toBe(KnowledgeType.prototype_asset_ref);
    expect(created.map((item) => item.title)).toContain("规则文档 / 适用场景");
  });

  it("parses quoted and inline frontmatter and preserves draft or disabled status", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-status-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/生效规则.md",
      "---\ntitle: \"生效: 规则\"\nstatus: 已生效\ntags: [\"业务:规则\", 正式]\n---\n# 生效: 规则\n这是可以进入正式检索的规则。",
    );
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/草稿规则.md",
      "---\ntitle: 草稿规则\nstatus: 已生效\ndraft: true\ntags: [草稿]\n---\n# 草稿规则\n这条内容仍在起草。",
    );
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/停用规则.md",
      "---\ntitle: 停用规则\nstatus: 停用\ntags: [停用]\n---\n# 停用规则\n这条内容已经停用。",
    );

    const prisma = createPrismaMock();
    const service = new ObsidianVaultService(prisma as never);
    await service.syncToKnowledgeBase(systemUser());
    const created = prisma.knowledgeItem.create.mock.calls.map(([input]) => input.data);

    expect(created.find((item) => item.sourceFileId === "02-业务域知识/生效规则.md")).toMatchObject({
      title: "生效: 规则",
      status: KnowledgeStatus.active,
      tags: expect.arrayContaining(["业务:规则", "正式"]),
    });
    expect(created.find((item) => item.sourceFileId === "02-业务域知识/草稿规则.md")?.status)
      .toBe(KnowledgeStatus.draft);
    expect(created.find((item) => item.sourceFileId === "02-业务域知识/停用规则.md")?.status)
      .toBe(KnowledgeStatus.disabled);
  });

  it("validates every Markdown header before opening the database transaction", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-invalid-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(
      vaultRoot,
      "02-业务域知识/损坏规则.md",
      "---\ntitle: 损坏规则\nmetadata:\n  status: 已生效\n---\n# 损坏规则\n不支持嵌套元数据。",
    );
    const prisma = createPrismaMock();
    const service = new ObsidianVaultService(prisma as never);

    await expect(service.syncToKnowledgeBase(systemUser())).rejects.toThrow(/unsupported nested YAML/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.knowledgeItem.create).not.toHaveBeenCalled();
  });

  it("uses one generation transaction and does not re-embed unchanged items", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-idempotent-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    await writeVaultFile(vaultRoot, "02-业务域知识/稳定规则.md", markdown("稳定规则", "稳定内容不应重复生成向量。"));

    const prisma = createPrismaMock();
    const { itemStore } = makeStateful(prisma);
    const embeddings = {
      emptyStats: vi.fn(() => ({ enabled: true, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 })),
      syncItem: vi.fn(async (item: Record<string, any>) => {
        itemStore.set(item.id, {
          ...itemStore.get(item.id),
          embedding: [0.1, 0.2, 0.3],
          updatedAt: new Date(),
        });
        return { enabled: true, created: 0, updated: 1, unchanged: 0, skipped: 0, failed: 0 };
      }),
    };
    const service = new ObsidianVaultService(prisma as never, embeddings as never);

    const first = await service.syncToKnowledgeBase(systemUser());
    const firstEmbeddingCalls = embeddings.syncItem.mock.calls.length;
    const second = await service.syncToKnowledgeBase(systemUser());

    expect(first.generation).toMatch(/^[a-f0-9]{16}$/);
    expect(second.generation).toBe(first.generation);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBeGreaterThan(0);
    expect(embeddings.syncItem).toHaveBeenCalledTimes(firstEmbeddingCalls);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("clears a changed item's embedding before generation and leaves it null on failure", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-embedding-clear-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    const relativePath = "02-业务域知识/向量刷新.md";
    await writeVaultFile(vaultRoot, relativePath, markdown("向量刷新", "第一版内容。"));

    const prisma = createPrismaMock();
    const { itemStore } = makeStateful(prisma);
    await new ObsidianVaultService(prisma as never).syncToKnowledgeBase(systemUser());
    const existing = [...itemStore.values()].find((item) => item.sourceFileId === relativePath)!;
    itemStore.set(existing.id, { ...existing, embedding: [0.9, 0.8], updatedAt: new Date() });
    await writeVaultFile(vaultRoot, relativePath, markdown("向量刷新", "第二版内容。"));
    const embeddings = {
      emptyStats: vi.fn(() => ({ enabled: true, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 })),
      syncItem: vi.fn(async (item: Record<string, any>) => {
        if (item.id === existing.id) {
          return { enabled: true, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 1 };
        }
        itemStore.set(item.id, {
          ...itemStore.get(item.id),
          embedding: [0.1, 0.2, 0.3],
          updatedAt: new Date(),
        });
        return { enabled: true, created: 0, updated: 1, unchanged: 0, skipped: 0, failed: 0 };
      }),
    };

    const result = await new ObsidianVaultService(prisma as never, embeddings as never)
      .syncToKnowledgeBase(systemUser());

    expect(prisma.knowledgeItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: existing.id },
      data: expect.objectContaining({ embedding: Prisma.JsonNull }),
    }));
    expect(embeddings.syncItem).toHaveBeenCalledWith(expect.objectContaining({
      id: existing.id,
      content: expect.stringContaining("第二版内容"),
      embedding: null,
    }));
    expect(itemStore.get(existing.id)?.embedding).toBeNull();
    expect(result.embeddings.failed).toBe(1);
  });

  it("retries unchanged items whose embedding is null or invalid", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-embedding-retry-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    const relativePath = "02-业务域知识/向量补偿.md";
    await writeVaultFile(vaultRoot, relativePath, markdown("向量补偿", "内容保持不变。"));

    const prisma = createPrismaMock();
    const { itemStore } = makeStateful(prisma);
    await new ObsidianVaultService(prisma as never).syncToKnowledgeBase(systemUser());
    const existing = [...itemStore.values()].find((item) => item.sourceFileId === relativePath)!;
    const embeddings = {
      emptyStats: vi.fn(() => ({ enabled: true, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 })),
      syncItem: vi.fn(async (item: Record<string, any>) => {
        if (item.id === existing.id) {
          return { enabled: true, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 1 };
        }
        itemStore.set(item.id, {
          ...itemStore.get(item.id),
          embedding: [0.1, 0.2, 0.3],
          updatedAt: new Date(),
        });
        return { enabled: true, created: 0, updated: 1, unchanged: 0, skipped: 0, failed: 0 };
      }),
    };
    const service = new ObsidianVaultService(prisma as never, embeddings as never);

    itemStore.set(existing.id, { ...existing, embedding: null, updatedAt: new Date() });
    await service.syncToKnowledgeBase(systemUser());
    itemStore.set(existing.id, { ...itemStore.get(existing.id), embedding: [0.1, "bad"], updatedAt: new Date() });
    await service.syncToKnowledgeBase(systemUser());

    const targetCalls = embeddings.syncItem.mock.calls
      .filter(([item]) => item.id === existing.id);
    expect(targetCalls).toHaveLength(2);
    expect(itemStore.get(existing.id)?.embedding).toBeNull();
  });

  it("does not overwrite a colliding item that is not owned by vault sync", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-origin-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    const relativePath = "02-业务域知识/所有权规则.md";
    await writeVaultFile(vaultRoot, relativePath, markdown("所有权规则", "Vault 初始内容。"));

    const prisma = createPrismaMock();
    const { itemStore } = makeStateful(prisma);
    const service = new ObsidianVaultService(prisma as never);
    await service.syncToKnowledgeBase(systemUser());
    const item = [...itemStore.values()].find((candidate) => candidate.sourceFileId === relativePath);
    itemStore.set(item.id, { ...item, source: KnowledgeSource.manual, content: "管理员维护内容", tags: ["manual"] });
    await writeVaultFile(vaultRoot, relativePath, markdown("所有权规则", "Vault 后续变更。"));

    const result = await service.syncToKnowledgeBase(systemUser());

    expect(result.conflicts).toBe(1);
    expect(itemStore.get(item.id)?.content).toBe("管理员维护内容");
  });

  it("rejects a second process when the database advisory lock is held", async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), "aipw-vault-lock-"));
    tempPaths.push(vaultRoot);
    process.env.KNOWLEDGE_VAULT_ROOT = vaultRoot;
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValue([{ acquired: false }]);
    const service = new ObsidianVaultService(prisma as never);

    await expect(service.syncToKnowledgeBase(systemUser())).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.knowledgeItem.create).not.toHaveBeenCalled();
  });
});

function createPrismaMock() {
  let categoryIndex = 0;
  const prisma = {
    knowledgeItem: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ ...data })),
      update: vi.fn(async ({ data, where }) => ({ id: where.id, ...data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    knowledgeCategory: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ id: `category-${++categoryIndex}`, ...data })),
    },
    knowledgeVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ id: `version-${data.knowledgeItemId}`, ...data })),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (operation) => operation(prisma));
  return prisma;
}

function makeStateful(prisma: ReturnType<typeof createPrismaMock>) {
  const itemStore = new Map<string, Record<string, any>>();
  const categoryStore = new Map<string, Record<string, any>>();

  prisma.knowledgeItem.findUnique.mockImplementation(async ({ where }) => itemStore.get(where.id) ?? null);
  prisma.knowledgeItem.create.mockImplementation(async ({ data }) => {
    const now = new Date();
    const item = { ...data, embedding: data.embedding ?? null, createdAt: now, updatedAt: now };
    itemStore.set(item.id, item);
    return item;
  });
  prisma.knowledgeItem.update.mockImplementation(async ({ data, where }) => {
    const normalizedData = data.embedding === Prisma.JsonNull
      ? { ...data, embedding: null }
      : data;
    const item = {
      ...itemStore.get(where.id),
      ...normalizedData,
      id: where.id,
      updatedAt: new Date(),
    };
    itemStore.set(where.id, item);
    return item;
  });
  prisma.knowledgeItem.findMany.mockImplementation(async () => [...itemStore.values()]);
  prisma.knowledgeCategory.findFirst.mockImplementation(async ({ where }) => categoryStore.get(where.name) ?? null);
  prisma.knowledgeCategory.create.mockImplementation(async ({ data }) => {
    const category = { id: `category-${categoryStore.size + 1}`, ...data };
    categoryStore.set(data.name, category);
    return category;
  });

  return { itemStore, categoryStore };
}

function systemUser() {
  return {
    id: "system",
    username: "system",
    email: "system@example.local",
    displayName: "系统任务",
    role: UserRole.admin,
    status: UserStatus.active,
  };
}

function markdown(title: string, body: string, tags = ["测试"]) {
  return [
    "---",
    `title: ${title}`,
    `description: ${title}说明。`,
    "status: 已生效",
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    "---",
    `# ${title}`,
    body,
  ].join("\n");
}

async function writeVaultFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
