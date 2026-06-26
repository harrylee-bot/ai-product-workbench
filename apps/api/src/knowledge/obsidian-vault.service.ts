import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
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
  categoryName: string;
};

type MarkdownMetadata = {
  title?: string;
  tags: string[];
  body: string;
};

const VAULT_FOLDERS = [
  "01-产品知识",
  "02-规则约束",
  "03-案例库",
  "04-原型模式",
  "99-收件箱",
  "_templates",
];

const SEED_FILES: VaultSeedFile[] = [
  {
    path: "README.md",
    content: `# 策划宝产品知识库

这是面向 AI 理解产品架构、业务逻辑、产品进化、PRD 写作和原型生成的统一知识库。

## 维护原则

- 主知识必须面向 AI 推理，不只保存资产清单。
- 历史业务增量先继承原有对象、流程和状态，再表达新增能力。
- 新产品创新必须放回产品能力框架，说明复用和扩展关系。
- PRD 与原型共用同一套业务域知识、状态流转和数据口径。
- 待整理资料先进入 \`99-收件箱\`，整理完成后再进入主知识目录。

## 目录

- \`01-产品知识\`：业务域、需求输入分类、历史资产索引与业务语义框架。
- \`02-规则约束\`：需求文档、PRD、活动与资损、AI 与 Dify 落地约束。
- \`03-案例库\`：历史案例、复用策略、反例与经验沉淀。
- \`04-原型模式\`：页面模式、后台配置、预览/发布与复用模板。
- \`99-收件箱\`：原始导入与待整理内容（后续转入主目录）。
`,
  },
  {
    path: "01-产品知识/README.md",
    content: `# 产品知识

沉淀可复用的业务语义、需求输入分类、历史需求逻辑和产品增长/进化判断框架。
`,
  },
  {
    path: "01-产品知识/需求文档知识库/README.md",
    content: `# 需求文档知识库

按历史需求资产整理的业务输入、案例索引与需求结构化入口。
`,
  },
  {
    path: "01-产品知识/产品架构与能力地图.md",
    content: `# 产品架构与能力地图

先建立业务能力边界与对象模型，统一历史能力、增量能力和创新能力的映射关系。
`,
  },
  {
    path: "01-产品知识/产品进化与创新决策.md",
    content: `# 产品进化与创新决策

用于区分历史业务增量、平台化新增和新产品创新，并给出发布闭环与回滚边界。
`,
  },
  {
    path: "01-产品知识/业务域产品逻辑映射.md",
    content: `# 业务域产品逻辑映射

用于把业务域映射到对象模型、状态链与异常规则。
`,
  },
  {
    path: "01-产品知识/业务逻辑与PRD原型映射.md",
    content: `# 业务逻辑与 PRD 原型映射

把业务域、对象和状态映射到 PRD 章节与原型页面。
`,
  },
  {
    path: "02-规则约束/README.md",
    content: `# 规则约束

沉淀需求分析、需求文档、活动风险、AI 落地与发布前后端约束体系。
`,
  },
  {
    path: "02-规则约束/需求文档沉淀/README.md",
    content: `# 规则沉淀

统一归档从需求、案例、评审资料提炼出的规则：强约束、偏好规则和风险提醒。
`,
  },
  {
    path: "02-规则约束/需求文档沉淀/PRD输出边界与交付规范.md",
    content: `# PRD 输出边界与交付规范

约束 PRD 的交付范围，明确不应包含执行细节与资损表。
`,
  },
  {
    path: "03-案例库/README.md",
    content: `# 案例库

历史需求中的高价值案例、反例和复用经验。
`,
  },
  {
    path: "03-案例库/需求案例库/README.md",
    content: `# 需求案例库

案例按业务域归类，支持新需求生成时快速检索可复用流程与字段体系。
`,
  },
  {
    path: "03-案例库/需求案例库/历史业务增量与创新复用矩阵.md",
    content: `# 历史业务增量与创新复用矩阵

帮助快速判断历史复用与新增创新路径，减少重复建模。
`,
  },
  {
    path: "04-原型模式/README.md",
    content: `# 原型模式

沉淀前后端统一设计、页面模式、配置化流程、预览发布和验收闭环。
`,
  },
  {
    path: "04-原型模式/前后端设计框架.md",
    content: `# 前后端设计框架

用于生成原型时的前后端对齐框架：字段、状态、异常、发布闭环统一输出。

## 统一闭环

1. 用户端页面
2. 配置模型
3. 预览态
4. 审核态
5. 发布态
6. 统计态

## 设计约束

- 更新字段必须带变更原因。
- 发布前必须有预览态验证。
- 审核态/发布态关键字段禁止随意改写。
- 下线与回滚必须能恢复到最近稳定版本。
`,
  },
  {
    path: "99-收件箱/README.md",
    content: `# 收件箱

临时记录未经整理的新知识、灵感、资料摘录和待确认规则。
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

描述这条知识适用在什么产品、页面、Agent 或决策场景。

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

  private readonly root = path.resolve(
    process.env.KNOWLEDGE_VAULT_ROOT?.trim() || path.join(process.cwd(), "storage", "knowledge-vault"),
  );

  async getStatus() {
    const initialized = await this.exists(path.join(this.root, ".obsidian"));
    const rootExists = await this.exists(this.root);

    return {
      initialized,
      rootExists,
      vaultRoot: this.root,
      folderCount: rootExists ? await this.countDirectories(this.root) : 0,
      markdownCount: rootExists ? await this.countMarkdownFiles(this.root) : 0,
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
    await this.initialize();

    const files = (await this.collectMarkdownFiles(this.root)).filter((file) => shouldIndexMarkdown(file.path));
    const categories = await this.ensureCategories(files);
    const chunks = await this.buildChunks(files);
    const activeIds = new Set(chunks.map((chunk) => chunk.id));

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let archived = 0;
    const embeddingStats = this.embeddings?.emptyStats() ?? emptyEmbeddingStats();

    for (const chunk of chunks) {
      const existing = await this.prisma.knowledgeItem.findUnique({ where: { id: chunk.id } });
      const categoryId = categories.get(chunk.categoryName)?.id;
      const data = {
        title: chunk.title,
        content: chunk.content,
        summary: chunk.summary,
        type: chunk.type,
        status: KnowledgeStatus.active,
        scope: "global" as const,
        categoryId,
        tags: toInputJson(chunk.tags),
        priority: chunk.priority,
        source: KnowledgeSource.file_extraction,
        sourceFileId: chunk.filePath,
        updatedBy: user.id,
      };

      if (!existing) {
        const item = await this.prisma.knowledgeItem.create({
          data: {
            id: chunk.id,
            ...data,
            createdBy: user.id,
          },
        });
        await this.createVersionSnapshot(item, user.id, "从知识库 Markdown 导入");
        if (this.embeddings) mergeEmbeddingStats(embeddingStats, await this.embeddings.syncItem(item));
        created += 1;
        continue;
      }

      if (hasKnowledgeChanged(existing, data)) {
        const item = await this.prisma.knowledgeItem.update({
          where: { id: existing.id },
          data,
        });
        await this.createVersionSnapshot(item, user.id, "同步知识库 Markdown 更新");
        if (this.embeddings) mergeEmbeddingStats(embeddingStats, await this.embeddings.syncItem(item));
        updated += 1;
      } else {
        if (this.embeddings) mergeEmbeddingStats(embeddingStats, await this.embeddings.syncItem(existing));
        unchanged += 1;
      }
    }

    const previousItems = await this.prisma.knowledgeItem.findMany({
      where: { source: KnowledgeSource.file_extraction },
    });
    for (const item of previousItems) {
      const tags = jsonArray(item.tags);
      if (!tags.includes("vault-sync") || activeIds.has(item.id) || item.status === KnowledgeStatus.archived) {
        continue;
      }
      const archivedItem = await this.prisma.knowledgeItem.update({
        where: { id: item.id },
        data: {
          status: KnowledgeStatus.archived,
          updatedBy: user.id,
        },
      });
      await this.createVersionSnapshot(archivedItem, user.id, "知识库 Markdown 已移除，归档切片");
      archived += 1;
    }

    return {
      markdownFiles: files.length,
      chunks: chunks.length,
      created,
      updated,
      unchanged,
      archived,
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
      const metadata = parseMarkdown(raw);
      const title = normalizeTitle(metadata.title ?? path.basename(file.path, ".md"));
      const type = inferKnowledgeType(file.path, title, metadata.tags);
      const priority = inferPriority(file.path, title, type);
      const categoryName = inferCategoryName(file.path);
      const tags = normalizeTags([
        "vault-sync",
        "knowledge-vault",
        ...metadata.tags,
        categoryName,
        type,
      ]);
      const fileChunks = splitMarkdownBody(metadata.body);

      for (const [index, body] of fileChunks.entries()) {
        const totalTitle = fileChunks.length > 1 ? `${title} #${index + 1}` : title;
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
          categoryName,
        });
      }
    }

    return chunks;
  }

  private async ensureCategories(files: VaultEntry[]) {
    const names = [...new Set(files.map((file) => inferCategoryName(file.path)))];
    const result = new Map<string, Prisma.KnowledgeCategoryGetPayload<Record<string, never>>>();

    for (const [index, name] of names.entries()) {
      const existing = await this.prisma.knowledgeCategory.findFirst({ where: { name } });
      if (existing) {
        result.set(name, existing);
        continue;
      }
      const created = await this.prisma.knowledgeCategory.create({
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
    item: Prisma.KnowledgeItemGetPayload<Record<string, never>>,
    userId: string,
    changeSummary: string,
  ) {
    const latest = await this.prisma.knowledgeVersion.findFirst({
      where: { knowledgeItemId: item.id },
      orderBy: { version: "desc" },
    });

    await this.prisma.knowledgeVersion.create({
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
  return !relativePath.startsWith("_templates/") && !relativePath.includes("/_templates/");
}

function parseMarkdown(raw: string): MarkdownMetadata {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatter) return { tags: [], body: raw.trim() };

  const metadata = frontmatter[1];
  const title = metadata.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  const tags: string[] = [];
  const tagBlock = metadata.match(/^tags:\s*\n((?:\s+-\s*.+\n?)+)/m)?.[1];
  if (tagBlock) {
    for (const line of tagBlock.split("\n")) {
      const tag = line.match(/^\s+-\s*(.+)$/)?.[1]?.trim();
      if (tag) tags.push(tag);
    }
  }

  return {
    title,
    tags,
    body: raw.slice(frontmatter[0].length).trim(),
  };
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

    const paragraphs = section.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    let current = "";
    for (const paragraph of paragraphs) {
      if ((current + "\n\n" + paragraph).trim().length > 2600 && current) {
        chunks.push(current.trim());
        current = paragraph;
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
  if (/^99-收件箱\//.test(relativePath)) return KnowledgeType.default_rule;
  if (/^04-原型模式\//.test(relativePath)) return KnowledgeType.prototype_rule;
  if (/^03-案例库\//.test(relativePath)) return KnowledgeType.reference_case;
  if (/^02-规则约束\//.test(relativePath)) return KnowledgeType.strong_rule;
  if (/^01-产品知识\//.test(relativePath)) return KnowledgeType.business_concept;
  if (/^05-原型设计规范\//.test(relativePath)) return KnowledgeType.prototype_rule;
  if (/^04-产品文档规范\//.test(relativePath)) return KnowledgeType.prd_writing_rule;
  if (/^06-历史案例库\//.test(relativePath)) return KnowledgeType.reference_case;
  if (/^02-业务域知识\//.test(relativePath)) return KnowledgeType.business_concept;
  if (/^(00-知识库使用规范|01-产品架构|03-产品进化规划)\//.test(relativePath)) return KnowledgeType.default_rule;
  if (/05-原型设计规范|原型规则|前后端设计框架|前台页面设计框架|后台管理设计框架|字段与接口|RP资产|PrototypeSpec|OpenPencil|HTML 原型/i.test(text)) return KnowledgeType.prototype_rule;
  if (/04-产品文档规范|产品文档规范|PRD|需求文档|写作/.test(text)) return KnowledgeType.prd_writing_rule;
  if (/06-历史案例库|案例库|案例/.test(text)) return KnowledgeType.reference_case;
  if (/00-知识库使用规范|01-产品架构|03-产品进化规划|知识库使用规范|产品架构|能力地图|核心对象|产品进化|新产品创新|历史业务增量|Agent|智能体|需求分析/.test(text)) return KnowledgeType.default_rule;
  if (/规则约束|约束|资损|安全|必须遵守|Constraint/i.test(text)) return KnowledgeType.strong_rule;
  if (/原型模式|页面|后台模式|配置化|交互|Prototype/i.test(text)) return KnowledgeType.design_pattern;
  return KnowledgeType.business_concept;
}

function inferPriority(relativePath: string, title: string, type: KnowledgeType) {
  const text = `${relativePath} ${title}`;
  if (relativePath === "README.md") return KnowledgePriority.high;
  if (/07-来源资产索引|99-收件箱|旧版整理|需求文档导入记录/.test(text)) return KnowledgePriority.low;
  if (/01-产品知识|02-规则约束|03-案例库|04-原型模式|05-原型设计规范|06-历史案例库|07-来源资产索引|04-产品文档规范|03-产品进化规划|02-业务域知识|00-知识库使用规范|01-产品架构/.test(text))
    return KnowledgePriority.high;
  if (type === KnowledgeType.strong_rule) return KnowledgePriority.high;
  if (/知识库使用规范|产品架构|能力地图|产品进化|产品逻辑|产品文档规范|原型设计规范|历史业务增量|新产品创新|Agent|AI营销助手|Dify|配置化页面|通用约束|资损/.test(text)) return KnowledgePriority.high;
  if (/清单|README|索引/.test(text)) return KnowledgePriority.low;
  return KnowledgePriority.medium;
}

function inferCategoryName(relativePath: string) {
  const [root] = relativePath.split("/");
  if (!root || root === "README.md") return "知识库总览";
  return root.replace(/^\d+-/, "");
}

function stableKnowledgeId(relativePath: string, chunkIndex: number) {
  return `vault_${createHash("sha1").update(`${relativePath}::${chunkIndex}`).digest("hex").slice(0, 32)}`;
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
