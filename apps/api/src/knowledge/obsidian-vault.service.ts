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
  "00-系统说明",
  "01-产品知识",
  "02-规则约束",
  "03-案例库",
  "04-原型模式",
  "05-Agent知识",
  "99-收件箱",
  "_templates",
];

const SEED_FILES: VaultSeedFile[] = [
  {
    path: "README.md",
    content: `# AI Product Workbench 知识库

这是 AI Product Workbench 的 Obsidian 兼容知识库。

## 维护原则

- 用中文维护所有知识。
- 一条知识只表达一个清晰规则、案例或模式。
- 重要约束优先放入 \`02-规则约束\`。
- 待整理内容先放入 \`99-收件箱\`。

## 目录

- \`01-产品知识\`：业务、产品、行业和用户知识。
- \`02-规则约束\`：必须遵守、偏好、避免、警告类规则。
- \`03-案例库\`：可复用案例、参考方案和失败教训。
- \`04-原型模式\`：页面结构、交互模式和组件模式。
- \`05-Agent知识\`：Agent 角色、输入输出和协作规则。
`,
  },
  {
    path: "00-系统说明/README.md",
    content: `# 系统说明

记录系统目标、架构边界、阶段计划和运行约束。
`,
  },
  {
    path: "01-产品知识/README.md",
    content: `# 产品知识

沉淀业务目标、用户画像、场景、产品策略和行业知识。
`,
  },
  {
    path: "02-规则约束/README.md",
    content: `# 规则约束

用于维护约束系统可参考的规则知识。

建议按以下类型记录：

- 必须遵守
- 优先偏好
- 避免事项
- 风险警告
`,
  },
  {
    path: "03-案例库/README.md",
    content: `# 案例库

沉淀优秀案例、反例、复盘结论和可复用策略。
`,
  },
  {
    path: "04-原型模式/README.md",
    content: `# 原型模式

记录页面布局、交互模式、信息架构和视觉规范。
`,
  },
  {
    path: "05-Agent知识/README.md",
    content: `# Agent 知识

记录 Agent 角色职责、协作流程、输入输出格式和评审规则。
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
  constructor(private readonly prisma: PrismaService) {}

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
        created += 1;
        continue;
      }

      if (hasKnowledgeChanged(existing, data)) {
        const item = await this.prisma.knowledgeItem.update({
          where: { id: existing.id },
          data,
        });
        await this.createVersionSnapshot(item, user.id, "同步知识库 Markdown 更新");
        updated += 1;
      } else {
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
          description: `由 Obsidian/SilverBullet 知识库目录 ${name} 自动同步`,
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
  if (/规则约束|约束|资损|安全|必须遵守|Constraint/i.test(text)) return KnowledgeType.strong_rule;
  if (/案例库|案例/.test(text)) return KnowledgeType.reference_case;
  if (/原型模式|页面|后台模式|配置化|交互|Prototype/i.test(text)) return KnowledgeType.design_pattern;
  if (/Agent|智能体|需求分析/.test(text)) return KnowledgeType.default_rule;
  if (/PRD|需求文档|写作/.test(text)) return KnowledgeType.prd_writing_rule;
  return KnowledgeType.business_concept;
}

function inferPriority(relativePath: string, title: string, type: KnowledgeType) {
  const text = `${relativePath} ${title}`;
  if (type === KnowledgeType.strong_rule) return KnowledgePriority.high;
  if (/Agent|AI营销助手|Dify|配置化页面|通用约束|资损/.test(text)) return KnowledgePriority.high;
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
