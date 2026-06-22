import { Injectable } from "@nestjs/common";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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

  private async exists(target: string) {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }
}
