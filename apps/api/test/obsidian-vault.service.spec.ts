import { KnowledgePriority, KnowledgeType, UserRole, UserStatus } from "@prisma/client";
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
});

function createPrismaMock() {
  let categoryIndex = 0;
  return {
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
