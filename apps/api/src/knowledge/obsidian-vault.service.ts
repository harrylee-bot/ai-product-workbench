import { ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KnowledgePriority,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  Prisma,
} from "@prisma/client";
import { toInputJson } from "../ai/ai-vibe.helpers";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { KnowledgeEmbeddingService, type EmbeddingSyncStats } from "./knowledge-embedding.service";
import { jsonArray } from "./knowledge-item.service";
import {
  frontmatterString,
  frontmatterStringArray,
  parseMarkdownFrontmatter,
  resolveVaultDocumentStatus,
} from "./markdown-frontmatter";

type VaultSeedFile = {
  path: string;
  content: string;
};

type VaultEntry = {
  name: string;
  path: string;
  type: "directory" | "markdown" | "file";
  size?: number;
  updatedAt?: string;
};

type MarkdownChunk = {
  id: string;
  filePath: string;
  title: string;
  content: string;
  summary: string;
  tags: string[];
  type: KnowledgeType;
  priority: KnowledgePriority;
  status: KnowledgeStatus;
  categoryName: string;
};

type KnowledgeRetrievalTier = "main" | "source";

type VaultHealth = {
  state: "missing" | "empty" | "ready";
  message: string;
};

type MarkdownMetadata = {
  title?: string;
  tags: string[];
  body: string;
  status: KnowledgeStatus;
};

function resolveKnowledgeVaultRoot() {
  const explicit = process.env.KNOWLEDGE_VAULT_ROOT?.trim();
  if (explicit) return path.resolve(explicit);

  const cwd = process.cwd();
  const repoVault = isApiWorkspaceCwd(cwd)
    ? path.resolve(cwd, "..", "..", "knowledge-vault")
    : path.resolve(cwd, "knowledge-vault");
  const legacyApiVault = path.resolve(cwd, "storage", "knowledge-vault");

  return [repoVault, legacyApiVault].find((candidate) => existsSync(candidate)) ?? repoVault;
}

function isApiWorkspaceCwd(cwd: string) {
  return path.basename(cwd) === "api" && path.basename(path.dirname(cwd)) === "apps";
}

function getVaultHealth(rootExists: boolean, markdownCount: number): VaultHealth {
  if (!rootExists) {
    return {
      state: "missing",
      message: "知识库路径不存在，请检查 KNOWLEDGE_VAULT_ROOT 或仓库 knowledge-vault 目录。",
    };
  }
  if (markdownCount === 0) {
    return {
      state: "empty",
      message: "知识库路径存在，但没有可同步的 Markdown 文件。",
    };
  }
  return {
    state: "ready",
    message: "知识库路径可用，已发现可同步 Markdown 文件。",
  };
}

const VAULT_FOLDERS = [
  "00-知识库使用规范",
  "01-产品架构",
  "02-业务域知识",
  "03-产品进化规划",
  "04-产品文档规范",
  "05-原型设计规范",
  "06-历史案例库",
  "07-来源资产索引",
  "99-收件箱",
  "_templates",
];

const SEED_FILES: VaultSeedFile[] = [
  {
    path: "README.md",
    content: `---
title: 策划宝产品知识库
description: 面向 AI 理解产品架构、业务逻辑、产品进化、PRD 写作和原型生成的统一知识库。
date: 2026-06-25
status: 已重构
tags:
  - 知识库/首页
  - 产品架构
  - 业务逻辑
aliases:
  - 知识库首页
  - 策划宝知识库
  - AI产品知识库
---

# 策划宝产品知识库

本知识库服务 AI 生成产品方案、PRD 和原型。它的核心不是保存原始文件，而是把历史需求、操作手册、原型资产和案例沉淀成一套可推理的产品知识体系。

## AI 默认阅读路径

- [[00-知识库使用规范/README|知识库使用规范]]
- [[00-知识库使用规范/Agent任务分类与补全规则|Agent任务分类与补全规则]]
- [[01-产品架构/README|产品架构]]
- [[02-业务域知识/README|业务域知识]]
- [[03-产品进化规划/README|产品进化规划]]
- [[04-产品文档规范/README|产品文档规范]]
- [[05-原型设计规范/README|原型设计规范]]
- [[06-历史案例库/README|历史案例库]]
- [[07-来源资产索引/README|来源资产索引]]

## 维护原则

- 主知识文件必须面向 AI 推理，不能只堆资产清单。
- 来源资产保留在 [[07-来源资产索引/README|来源资产索引]]，不作为第一召回层。
- 历史业务新增要先继承原有对象、流程和状态，再表达增量。
- 新产品创新要放回产品能力框架。
`,
  },
  {
    path: "00-知识库使用规范/README.md",
    content: `# 知识库使用规范

规定 AI 在不同任务下如何调用产品架构、业务域、文档规范、原型规范和来源资产。

## 执行模式

Agent 在执行前必须先按 [[00-知识库使用规范/Agent任务分类与补全规则|Agent任务分类与补全规则]] 判断需求模式：既有对话增量、全新功能或一句话需求补全。

## 执行过程可见边界

Workbench 对话区可以展示 Agent 过程、执行清单、工具调用与事件、产物变化，但只沉淀步骤级、工具级、授权/确认、产物级和错误级事件。

不得把 token chunk、模型流式碎片、message_delta、checkpoint、runtime 内部状态、隐藏推理或调试元数据当作用户可见步骤、工具事件、产物变化或高优先知识沉淀。
`,
  },
  {
    path: "00-知识库使用规范/Agent任务分类与补全规则.md",
    content: `---
title: Agent任务分类与补全规则
description: 规定 agent 在既有对话增量、全新功能和一句话需求场景下如何调用知识、保持原型一致性和补全缺失信息。
date: 2026-06-27
status: 已生效
tags:
  - 知识库使用规范
  - Agent执行规则
  - 需求补全
---

# Agent任务分类与补全规则

Agent 在生成 PRD、产品状态或原型前，必须先判断本轮需求属于哪一种执行模式。

| 模式 | 识别信号 | 知识调用 | 输出原则 |
| --- | --- | --- | --- |
| 既有对话增量 | 用户说新增、优化、调整、支持、补充，且当前对话已有 PRD、原型、产品状态或历史页面。 | 当前产物优先，再读历史业务增量规则、对应业务域、历史增量原型规则和案例复用索引。 | 不重构历史主流程，延续原导航、布局、字段分组、状态表达和交互习惯。 |
| 全新功能 | 用户提出新模块、新工作台、新 AI 能力、新闭环、新角色或跨模块能力。 | 先读产品能力地图、新产品创新规则、前后台页面框架，再补业务域和案例。 | 可以重组页面框架，但必须落回产品能力层并复用平台通用能力。 |
| 一句话需求补全 | 用户只给一句简短目标，缺少角色、流程、字段或验收细节。 | 先读产品架构、业务域知识、案例复用索引，再按任务类型读取 PRD 或原型规范。 | 先用知识库补全常规字段、流程、状态、异常和验收，高风险事实才追问。 |

## Final Action建议字段

DeerFlow final action 可以携带 requirementMode、knowledgeRefsUsed、assumptions 和 consistencyStrategy，便于后续审计和 UI 展示。
`,
  },
  {
    path: "01-产品架构/README.md",
    content: `# 产品架构

描述产品能力层、核心对象、状态流转和横切能力。
`,
  },
  {
    path: "02-业务域知识/README.md",
    content: `# 业务域知识

按业务域沉淀对象、流程、字段、状态、数据、异常和风险。
`,
  },
  {
    path: "03-产品进化规划/README.md",
    content: `# 产品进化规划

判断需求是历史业务增量、能力平台化、风险治理补齐还是新产品创新。
`,
  },
  {
    path: "04-产品文档规范/README.md",
    content: `# 产品文档规范

规定 PRD、需求说明书、验收标准和风险清单的写法。
`,
  },
  {
    path: "05-原型设计规范/README.md",
    content: `# 原型设计规范

规定 PrototypeSpec、HTML 原型和 OpenPencil 原型的页面、字段、状态和交互表达。
`,
  },
  {
    path: "06-历史案例库/README.md",
    content: `# 历史案例库

提供历史案例、复用策略和风险经验。
`,
  },
  {
    path: "07-来源资产索引/README.md",
    content: `# 来源资产索引

保存旧版整理和原始来源线索，只用于核验来源，不作为 AI 生成的第一召回层。
`,
  },
  {
    path: "99-收件箱/README.md",
    content: `# 收件箱

临时记录未经整理的新知识、灵感、资料摘录和待确认规则，不作为 AI 正式生成 PRD 或原型的第一召回入口。

可推理知识应迁移到 01-06 主知识目录；原始文件清单、导入记录和旧版路径应迁移到 [[07-来源资产索引/README|来源资产索引]]。
`,
  },
  {
    path: "_templates/知识条目模板.md",
    content: `---
类型: 默认规则
状态: 草稿
标签:
  - 待整理
优先级: 中
---

# 知识标题

## 适用场景

描述这条知识适用在什么产品、页面、runtime 或决策场景。

## 知识内容

写清楚规则、案例或模式。

## 触发条件

什么情况下系统应该使用这条知识。

## 预期影响

说明它对约束、决策、原型或 QA 的影响。
`,
  },
  {
    path: ".obsidian/app.json",
    content: JSON.stringify(
      {
        alwaysUpdateLinks: true,
        newFileLocation: "folder",
        newFileFolderPath: "99-收件箱",
        attachmentFolderPath: "assets",
      },
      null,
      2,
    ),
  },
  {
    path: ".obsidian/core-plugins.json",
    content: JSON.stringify(
      [
        "file-explorer",
        "global-search",
        "switcher",
        "graph",
        "backlink",
        "canvas",
        "outgoing-link",
        "tag-pane",
        "page-preview",
        "daily-notes",
        "templates",
      ],
      null,
      2,
    ),
  },
  {
    path: ".obsidian/templates.json",
    content: JSON.stringify(
      {
        folder: "_templates",
        dateFormat: "YYYY-MM-DD",
        timeFormat: "HH:mm",
      },
      null,
      2,
    ),
  },
];

@Injectable()
export class ObsidianVaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings?: KnowledgeEmbeddingService,
  ) {}

  private readonly root = resolveKnowledgeVaultRoot();
  private syncInFlight: Promise<Awaited<ReturnType<ObsidianVaultService["runVaultSync"]>>> | undefined;

  async getStatus() {
    const initialized = await this.exists(path.join(this.root, ".obsidian"));
    const rootExists = await this.exists(this.root);
    const markdownCount = rootExists ? await this.countMarkdownFiles(this.root) : 0;
    const health = getVaultHealth(rootExists, markdownCount);

    return {
      health: health.state,
      message: health.message,
      initialized,
      rootExists,
      vaultRoot: this.root,
      folderCount: rootExists ? await this.countDirectories(this.root) : 0,
      markdownCount,
      folders: rootExists ? await this.listRootFolders() : [],
      recentFiles: rootExists ? await this.listRecentMarkdownFiles() : [],
    };
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    await Promise.all(VAULT_FOLDERS.map((folder) => mkdir(path.join(this.root, folder), { recursive: true })));
    await mkdir(path.join(this.root, ".obsidian"), { recursive: true });
    await mkdir(path.join(this.root, "assets"), { recursive: true });

    for (const file of SEED_FILES) {
      const target = path.join(this.root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      if (!(await this.exists(target))) {
        await writeFile(target, file.content, "utf8");
      }
    }

    return this.getStatus();
  }

  async syncToKnowledgeBase(user: AuthenticatedUser) {
    if (this.syncInFlight) return this.syncInFlight;
    const operation = this.runVaultSync(user);
    this.syncInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.syncInFlight === operation) this.syncInFlight = undefined;
    }
  }

  private async runVaultSync(user: AuthenticatedUser) {
    await this.initialize();

    const files = (await this.collectMarkdownFiles(this.root))
      .filter((file) => shouldIndexMarkdown(file.path))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    const chunks = await this.buildChunks(files);
    const currentIds = new Set(chunks.map((chunk) => chunk.id));
    const generation = buildVaultGeneration(chunks);
    const verificationFiles = (await this.collectMarkdownFiles(this.root))
      .filter((file) => shouldIndexMarkdown(file.path))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    const verificationGeneration = buildVaultGeneration(await this.buildChunks(verificationFiles));
    if (generation !== verificationGeneration
      || files.some((file, index) => file.path !== verificationFiles[index]?.path)) {
      throw new ConflictException("知识库文件在同步读取期间发生变化，请重试。");
    }
    const embeddingStats = this.embeddings?.emptyStats() ?? emptyEmbeddingStats();
    const embeddingEnabled = Boolean(this.embeddings && embeddingStats.enabled);
    const transactionResult = await this.prisma.$transaction(async (transaction) => {
      const lockRows = await transaction.$queryRaw<Array<{ acquired: boolean }>>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(1095784523, 1263945812) AS acquired`,
      );
      if (!lockRows[0]?.acquired) {
        throw new ConflictException("知识库正在同步，请稍后重试。");
      }

      const categories = await this.ensureCategories(files, transaction);
      const embeddingItems: Prisma.KnowledgeItemGetPayload<Record<string, never>>[] = [];
      let created = 0;
      let updated = 0;
      let unchanged = 0;
      let archived = 0;
      let conflicts = 0;
      let embeddingUnchanged = 0;

      for (const chunk of chunks) {
        const existing = await transaction.knowledgeItem.findUnique({ where: { id: chunk.id } });
        const categoryId = categories.get(chunk.categoryName)?.id;
        const data = {
          title: chunk.title,
          content: chunk.content,
          summary: chunk.summary,
          type: chunk.type,
          status: chunk.status,
          scope: "global" as const,
          categoryId,
          tags: toInputJson(chunk.tags),
          priority: chunk.priority,
          source: KnowledgeSource.file_extraction,
          sourceFileId: chunk.filePath,
          updatedBy: user.id,
        };

        if (!existing) {
          const item = await transaction.knowledgeItem.create({
            data: {
              id: chunk.id,
              ...data,
              createdBy: user.id,
            },
          });
          await this.createVersionSnapshot(transaction, item, user.id, "从知识库 Markdown 导入");
          if (embeddingEnabled) embeddingItems.push(item);
          created += 1;
          continue;
        }

        if (!isVaultManagedItem(existing, chunk.filePath)) {
          conflicts += 1;
          continue;
        }

        if (hasKnowledgeChanged(existing, data)) {
          const shouldRefreshEmbedding = hasEmbeddingContentChanged(existing, data);
          const hasValidEmbedding = isValidKnowledgeEmbedding(existing.embedding);
          const item = await transaction.knowledgeItem.update({
            where: { id: existing.id },
            data: {
              ...data,
              embedding: shouldRefreshEmbedding || (embeddingEnabled && !hasValidEmbedding)
                ? Prisma.JsonNull
                : undefined,
            },
          });
          await this.createVersionSnapshot(transaction, item, user.id, "同步知识库 Markdown 更新");
          if (embeddingEnabled) {
            if (shouldRefreshEmbedding || !hasValidEmbedding) embeddingItems.push(item);
            else embeddingUnchanged += 1;
          }
          updated += 1;
        } else {
          if (embeddingEnabled) {
            if (isValidKnowledgeEmbedding(existing.embedding)) {
              embeddingUnchanged += 1;
            } else {
              const item = existing.embedding === null || existing.embedding === undefined
                ? existing
                : await transaction.knowledgeItem.update({
                    where: { id: existing.id },
                    data: { embedding: Prisma.JsonNull },
                  });
              embeddingItems.push(item);
            }
          }
          unchanged += 1;
        }
      }

      const previousItems = await transaction.knowledgeItem.findMany({
        where: { source: KnowledgeSource.file_extraction },
      });
      for (const item of previousItems) {
        if (!isVaultManagedItem(item, item.sourceFileId) || currentIds.has(item.id) || item.status === KnowledgeStatus.archived) {
          continue;
        }
        const archivedItem = await transaction.knowledgeItem.update({
          where: { id: item.id },
          data: {
            status: KnowledgeStatus.archived,
            updatedBy: user.id,
          },
        });
        await this.createVersionSnapshot(transaction, archivedItem, user.id, "知识库 Markdown 已移除，归档切片");
        archived += 1;
      }

      return {
        created,
        updated,
        unchanged,
        archived,
        conflicts,
        embeddingItems,
        embeddingUnchanged,
      };
    }, { maxWait: 5_000, timeout: 60_000 });

    if (this.embeddings) {
      embeddingStats.unchanged += transactionResult.embeddingUnchanged;
      for (const item of transactionResult.embeddingItems) {
        mergeEmbeddingStats(embeddingStats, await this.embeddings.syncItem(item));
      }
    }

    return {
      generation,
      markdownFiles: files.length,
      chunks: chunks.length,
      created: transactionResult.created,
      updated: transactionResult.updated,
      unchanged: transactionResult.unchanged,
      archived: transactionResult.archived,
      conflicts: transactionResult.conflicts,
      categories: [...new Set(chunks.map((chunk) => chunk.categoryName))],
      embeddings: embeddingStats,
    };
  }

  private async listRootFolders(): Promise<VaultEntry[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const result: VaultEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const fullPath = path.join(this.root, entry.name);
      const itemStat = await stat(fullPath);
      result.push({
        name: entry.name,
        path: entry.name,
        type: "directory",
        updatedAt: itemStat.mtime.toISOString(),
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  private async listRecentMarkdownFiles(): Promise<VaultEntry[]> {
    const files = await this.collectMarkdownFiles(this.root);
    files.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return files.slice(0, 20);
  }

  private async collectMarkdownFiles(directory: string, base = ""): Promise<VaultEntry[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: VaultEntry[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = path.join(base, entry.name);
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        result.push(...(await this.collectMarkdownFiles(fullPath, relativePath)));
        continue;
      }

      if (!entry.name.endsWith(".md")) continue;
      const itemStat = await stat(fullPath);
      result.push({
        name: entry.name,
        path: relativePath,
        type: "markdown",
        size: itemStat.size,
        updatedAt: itemStat.mtime.toISOString(),
      });
    }

    return result;
  }

  private async countDirectories(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
  }

  private async countMarkdownFiles(directory: string) {
    return (await this.collectMarkdownFiles(directory)).length;
  }

  private async buildChunks(files: VaultEntry[]): Promise<MarkdownChunk[]> {
    const chunks: MarkdownChunk[] = [];

    for (const file of files) {
      const fullPath = path.join(this.root, file.path);
      const raw = await readFile(fullPath, "utf8");
      const metadata = parseMarkdown(raw, file.path);
      const title = normalizeTitle(metadata.title ?? path.basename(file.path, ".md"));
      const type = inferKnowledgeType(file.path, title, metadata.tags);
      const priority = inferPriority(file.path, title, type);
      const categoryName = inferCategoryName(file.path);
      const retrievalTier = inferRetrievalTier(file.path);
      const tags = normalizeTags([
        "vault-sync",
        "knowledge-vault",
        `vault-tier:${retrievalTier}`,
        ...metadata.tags,
        categoryName,
        type,
      ]);
      const fileChunks = splitMarkdownBody(metadata.body);
      const chunkTitleCounts = new Map<string, number>();

      for (const [index, body] of fileChunks.entries()) {
        const baseChunkTitle = buildChunkTitle(title, body);
        const occurrence = (chunkTitleCounts.get(baseChunkTitle) ?? 0) + 1;
        chunkTitleCounts.set(baseChunkTitle, occurrence);
        const totalTitle = occurrence > 1 ? `${baseChunkTitle} (${occurrence})` : baseChunkTitle;
        const chunkContent = [
          `来源文件：${file.path}`,
          `切片序号：${index + 1}`,
          "",
          body.trim(),
        ].join("\n");

        chunks.push({
          id: stableKnowledgeId(file.path, index),
          filePath: file.path,
          title: truncate(totalTitle, 110),
          content: chunkContent,
          summary: buildSummary(body),
          tags,
          type,
          priority,
          status: metadata.status,
          categoryName,
        });
      }
    }

    return chunks;
  }

  private async ensureCategories(files: VaultEntry[], database: Prisma.TransactionClient) {
    const names = [...new Set(files.map((file) => inferCategoryName(file.path)))];
    const result = new Map<string, Prisma.KnowledgeCategoryGetPayload<Record<string, never>>>();

    for (const [index, name] of names.entries()) {
      const existing = await database.knowledgeCategory.findFirst({ where: { name } });
      if (existing) {
        result.set(name, existing);
        continue;
      }
      const created = await database.knowledgeCategory.create({
        data: {
          name,
          description: `由 Markdown Vault 知识库目录 ${name} 自动同步`,
          order: index + 100,
        },
      });
      result.set(name, created);
    }

    return result;
  }

  private async createVersionSnapshot(
    database: Prisma.TransactionClient,
    item: Prisma.KnowledgeItemGetPayload<Record<string, never>>,
    userId: string,
    changeSummary: string,
  ) {
    const latest = await database.knowledgeVersion.findFirst({
      where: { knowledgeItemId: item.id },
      orderBy: { version: "desc" },
    });

    await database.knowledgeVersion.create({
      data: {
        knowledgeItemId: item.id,
        version: (latest?.version ?? 0) + 1,
        snapshot: toInputJson({
          id: item.id,
          title: item.title,
          content: item.content,
          summary: item.summary,
          type: item.type,
          status: item.status,
          scope: item.scope,
          categoryId: item.categoryId,
          tags: jsonArray(item.tags),
          priority: item.priority,
          source: item.source,
          sourceFileId: item.sourceFileId,
        }),
        changeSummary,
        createdBy: userId,
      },
    });
  }

  private async exists(target: string) {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }
}

function shouldIndexMarkdown(relativePath: string) {
  return !relativePath.startsWith("_templates/")
    && !relativePath.includes("/_templates/")
    && !relativePath.startsWith("99-收件箱/");
}

function parseMarkdown(raw: string, sourceName = "Markdown document"): MarkdownMetadata {
  const parsed = parseMarkdownFrontmatter(raw, sourceName);
  return {
    title: frontmatterString(parsed.attributes, "title", "标题"),
    tags: frontmatterStringArray(parsed.attributes, "tags", "标签"),
    body: parsed.body,
    status: toKnowledgeStatus(resolveVaultDocumentStatus(parsed.attributes)),
  };
}

function toKnowledgeStatus(status: ReturnType<typeof resolveVaultDocumentStatus>) {
  if (status === "draft") return KnowledgeStatus.draft;
  if (status === "disabled") return KnowledgeStatus.disabled;
  if (status === "archived") return KnowledgeStatus.archived;
  return KnowledgeStatus.active;
}

function splitMarkdownBody(body: string) {
  const normalized = body.trim();
  if (!normalized) return ["空白知识条目"];

  const sections = normalized
    .split(/\n(?=#{1,3}\s+)/)
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = sections.length ? sections : [normalized];
  const chunks: string[] = [];

  for (const section of candidates) {
    if (section.length <= 2600) {
      chunks.push(section);
      continue;
    }

    const sectionHeading = section.match(/^#{1,3}\s+.+$/m)?.[0]?.trim();
    const paragraphs = section.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    let current = "";
    for (const paragraph of paragraphs) {
      if ((current + "\n\n" + paragraph).trim().length > 2600 && current) {
        chunks.push(current.trim());
        current = sectionHeading && paragraph !== sectionHeading
          ? `${sectionHeading}\n\n${paragraph}`
          : paragraph;
      } else {
        current = (current ? `${current}\n\n${paragraph}` : paragraph).trim();
      }
    }
    if (current) chunks.push(current.trim());
  }

  return chunks.length ? chunks : [normalized.slice(0, 2600)];
}

function inferKnowledgeType(relativePath: string, title: string, tags: string[]) {
  const text = `${relativePath} ${title} ${tags.join(" ")}`;
  if (relativePath === "README.md") return KnowledgeType.default_rule;
  if (/^00-知识库使用规范\//.test(relativePath)) return KnowledgeType.strong_rule;
  if (/^01-产品架构\//.test(relativePath)) return KnowledgeType.product_architecture;
  if (/^02-业务域知识\//.test(relativePath)) return KnowledgeType.business_concept;
  if (/^03-产品进化规划\//.test(relativePath)) return KnowledgeType.design_pattern;
  if (/^04-产品文档规范\//.test(relativePath)) return KnowledgeType.prd_writing_rule;
  if (/^05-原型设计规范\//.test(relativePath)) {
    return isPrototypeAssetKnowledge(relativePath, `${title}\n${tags.join(" ")}`)
      ? KnowledgeType.prototype_asset_ref
      : KnowledgeType.prototype_rule;
  }
  if (/^06-历史案例库\//.test(relativePath)) return KnowledgeType.reference_case;
  if (/^07-来源资产索引\//.test(relativePath)) {
    if (/案例库|案例/.test(text)) return KnowledgeType.reference_case;
    if (/原型模式|页面|后台模式|配置化|交互|Prototype|OpenPencil|HTML 原型/i.test(text)) {
      return KnowledgeType.design_pattern;
    }
    return KnowledgeType.default_rule;
  }
  if (/^08-产品架构\/|产品架构|能力地图|核心对象/.test(text)) return KnowledgeType.product_architecture;
  if (/^09-页面清单\/|页面清单|信息架构|导航结构|tab栏|Tab栏|Tab Bar/i.test(text)) return KnowledgeType.page_inventory;
  if (/^10-UI样式规范\/|UI样式|样式规范|组件样式|tab栏样式|Tab栏样式|Tab Bar Style/i.test(text)) return KnowledgeType.ui_style_guide;
  if (/^11-原型资产\/|原型资产|prototype asset|prototype_asset|页面原型|历史原型/i.test(text)) return KnowledgeType.prototype_asset_ref;
  if (/^04-原型模式\//.test(relativePath)) return KnowledgeType.prototype_rule;
  if (/^03-案例库\//.test(relativePath)) return KnowledgeType.reference_case;
  if (/^02-规则约束\//.test(relativePath)) return KnowledgeType.strong_rule;
  if (/^01-产品知识\//.test(relativePath)) return KnowledgeType.business_concept;
  if (/05-原型设计规范|原型规则|前后端设计框架|前台页面设计框架|后台管理设计框架|字段与接口|RP资产|PrototypeSpec|OpenPencil|HTML 原型/i.test(text)) return KnowledgeType.prototype_rule;
  if (/04-产品文档规范|产品文档规范|PRD|需求文档|写作/.test(text)) return KnowledgeType.prd_writing_rule;
  if (/06-历史案例库|案例库|案例/.test(text)) return KnowledgeType.reference_case;
  if (/00-知识库使用规范|01-产品架构|03-产品进化规划|知识库使用规范|产品架构|能力地图|核心对象|产品进化|新产品创新|历史业务增量|runtime|智能体|需求分析/.test(text)) return KnowledgeType.default_rule;
  if (/规则约束|约束|资损|安全|必须遵守|Constraint/i.test(text)) return KnowledgeType.strong_rule;
  if (/原型模式|页面|后台模式|配置化|交互|Prototype/i.test(text)) return KnowledgeType.design_pattern;
  return KnowledgeType.business_concept;
}

function inferPriority(relativePath: string, title: string, type: KnowledgeType) {
  const text = `${relativePath} ${title}`;
  if (relativePath === "README.md") return KnowledgePriority.medium;
  if (isSourceOrInboxPath(relativePath) || /旧版整理|需求文档导入记录|需求资产清单|业务域索引|导入清单|来源台账/.test(text)) {
    return KnowledgePriority.low;
  }
  if (/^06-历史案例库\//.test(relativePath)) return KnowledgePriority.medium;
  if (/01-产品知识|02-规则约束|03-案例库|04-原型模式|05-原型设计规范|04-产品文档规范|03-产品进化规划|02-业务域知识|00-知识库使用规范|01-产品架构|08-产品架构|09-页面清单|10-UI样式规范|11-原型资产/.test(text))
    return KnowledgePriority.high;
  if (type === KnowledgeType.strong_rule) return KnowledgePriority.high;
  if (/知识库使用规范|产品架构|能力地图|产品进化|产品逻辑|产品文档规范|原型设计规范|历史业务增量|新产品创新|runtime|AI营销助手|Dify|配置化页面|通用约束|资损/.test(text)) return KnowledgePriority.high;
  if (/需求资产清单|业务域索引|导入记录|来源台账/.test(text)) return KnowledgePriority.low;
  return KnowledgePriority.medium;
}

function isPrototypeAssetKnowledge(relativePath: string, metadataText: string) {
  if (/原型生成总规则|字段接口状态表达|前后台页面框架/.test(relativePath)) return false;
  return /签到活动高保真HTML原型框架|签到打卡高保真原型|签到积分活动原型框架|贵州签到打卡HTML原型|原型转HTML资产|RP资产到设计框架映射|prototype_asset_ref/i
    .test(`${relativePath}\n${metadataText}`);
}

function isSourceOrInboxPath(relativePath: string) {
  return /^07-来源资产索引(\/|$)/.test(relativePath) || /^99-收件箱(\/|$)/.test(relativePath);
}

function inferRetrievalTier(relativePath: string): KnowledgeRetrievalTier {
  return relativePath.startsWith("07-来源资产索引/") ? "source" : "main";
}

function buildChunkTitle(documentTitle: string, body: string) {
  const heading = body.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  if (!heading || normalizeTitle(heading) === documentTitle) return documentTitle;
  return truncate(`${documentTitle} / ${normalizeTitle(heading)}`, 110);
}

function inferCategoryName(relativePath: string) {
  const [root] = relativePath.split("/");
  if (!root || root === "README.md") return "知识库总览";
  return root.replace(/^\d+-/, "");
}

function stableKnowledgeId(relativePath: string, chunkIndex: number) {
  return `vault_${createHash("sha1").update(`${relativePath}::${chunkIndex}`).digest("hex").slice(0, 32)}`;
}

function buildVaultGeneration(chunks: MarkdownChunk[]) {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(JSON.stringify([
      chunk.id,
      chunk.filePath,
      chunk.title,
      chunk.content,
      chunk.summary,
      chunk.tags,
      chunk.type,
      chunk.priority,
      chunk.status,
      chunk.categoryName,
    ]));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

function normalizeTitle(value: string) {
  return value.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
}

function buildSummary(value: string) {
  const firstMeaningfulLine =
    value
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").replace(/^\s*[-*]\s*/, "").trim())
      .find((line) => line && !line.startsWith("---")) ?? value.trim();
  return truncate(firstMeaningfulLine.replace(/\s+/g, " "), 300);
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((item) => item.trim()).filter(Boolean))];
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function hasKnowledgeChanged(
  existing: Prisma.KnowledgeItemGetPayload<Record<string, never>>,
  data: {
    title: string;
    content: string;
    summary: string;
    type: KnowledgeType;
    status: KnowledgeStatus;
    scope: "global";
    categoryId?: string;
    tags: Prisma.InputJsonValue;
    priority: KnowledgePriority;
    source: KnowledgeSource;
    sourceFileId: string;
  },
) {
  return (
    existing.title !== data.title ||
    existing.content !== data.content ||
    existing.summary !== data.summary ||
    existing.type !== data.type ||
    existing.status !== data.status ||
    existing.scope !== data.scope ||
    (existing.categoryId ?? undefined) !== data.categoryId ||
    JSON.stringify(jsonArray(existing.tags)) !== JSON.stringify(jsonArray(data.tags)) ||
    existing.priority !== data.priority ||
    existing.source !== data.source ||
    existing.sourceFileId !== data.sourceFileId
  );
}

function hasEmbeddingContentChanged(
  existing: Prisma.KnowledgeItemGetPayload<Record<string, never>>,
  data: { title: string; content: string; summary: string },
) {
  return existing.title !== data.title
    || existing.content !== data.content
    || existing.summary !== data.summary;
}

function isValidKnowledgeEmbedding(value: unknown) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isVaultManagedItem(
  item: Prisma.KnowledgeItemGetPayload<Record<string, never>>,
  expectedSourceFileId: string | null | undefined,
) {
  // Vault is authoritative only for rows previously created from the same vault path.
  return item.source === KnowledgeSource.file_extraction
    && Boolean(expectedSourceFileId)
    && item.sourceFileId === expectedSourceFileId
    && jsonArray(item.tags).includes("vault-sync");
}

function emptyEmbeddingStats(): EmbeddingSyncStats {
  return {
    enabled: false,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };
}

function mergeEmbeddingStats(target: EmbeddingSyncStats, source: EmbeddingSyncStats) {
  target.created += source.created;
  target.updated += source.updated;
  target.unchanged += source.unchanged;
  target.skipped += source.skipped;
  target.failed += source.failed;
}
