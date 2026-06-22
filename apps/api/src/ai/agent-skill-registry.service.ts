import { Injectable } from "@nestjs/common";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { KnowledgeType } from "@prisma/client";
import type { KnowledgeReference } from "./ai-vibe.types";

export type AgentSkillDefinition = {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  contentPreview: string;
  capabilities: string[];
  triggerHints: string[];
};

const OBSIDIAN_SKILL_NAMES = [
  "obsidian-markdown",
  "obsidian-bases",
  "json-canvas",
  "obsidian-cli",
  "defuddle",
];

@Injectable()
export class AgentSkillRegistryService {
  private cache?: {
    loadedAt: number;
    skills: AgentSkillDefinition[];
  };

  async listSkills() {
    const cached = this.cache;
    if (cached && Date.now() - cached.loadedAt < 60_000) return cached.skills;

    const roots = this.skillRoots();
    const skills = new Map<string, AgentSkillDefinition>();
    for (const root of roots) {
      for (const skill of await this.readRoot(root)) {
        if (!skills.has(skill.name)) skills.set(skill.name, skill);
      }
    }

    const ordered = [...skills.values()].sort((a, b) => {
      const aIndex = OBSIDIAN_SKILL_NAMES.indexOf(a.name);
      const bIndex = OBSIDIAN_SKILL_NAMES.indexOf(b.name);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex) || a.name.localeCompare(b.name);
    });
    this.cache = { loadedAt: Date.now(), skills: ordered };
    return ordered;
  }

  async getVibeCodingSkills(userInput: string) {
    const skills = await this.listSkills();
    if (!skills.length) return [];

    const text = userInput.toLowerCase();
    const selected = skills.filter((skill) => {
      if (skill.name === "obsidian-markdown" || skill.name === "obsidian-cli") return true;
      if (skill.name === "obsidian-bases") return /base|数据库|表格|视图|筛选|公式|看板|属性/.test(text);
      if (skill.name === "json-canvas") return /canvas|画布|流程|脑图|关系图|架构图|链路|拓扑/.test(text);
      if (skill.name === "defuddle") return /https?:\/\//.test(text) || /网页|文档|文章|链接|资料/.test(text);
      return true;
    });

    return selected.length ? selected : skills;
  }

  toKnowledgeReferences(skills: AgentSkillDefinition[]): KnowledgeReference[] {
    return skills.map((skill) => ({
      id: `agent_skill_${skill.name}`,
      knowledgeId: `agent-skill:${skill.name}`,
      title: `Vibe Coding 可用技能：${skill.name}`,
      snippet: skill.description,
      content: [
        skill.description,
        skill.capabilities.length ? `核心能力：${skill.capabilities.join("；")}` : "",
        skill.triggerHints.length ? `触发线索：${skill.triggerHints.join("；")}` : "",
        skill.contentPreview,
      ].filter(Boolean).join("\n"),
      type: KnowledgeType.prototype_rule,
      relatedPath: skill.sourcePath,
      usedByAgent: "vibe_coding",
      sourceType: "knowledge_base",
      sourceId: `agent-skill:${skill.name}`,
    }));
  }

  private skillRoots() {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const envRoots = (process.env.AGENT_SKILLS_ROOT ?? "")
      .split(":")
      .map((item) => item.trim())
      .filter(Boolean);

    return unique([
      ...envRoots,
      path.join(repoRoot, "agent-skills/obsidian-skills/skills"),
      path.join(repoRoot, "apps/api/storage/agent-skills/obsidian-skills/skills"),
      "/app/agent-skills/obsidian-skills/skills",
      "/app/apps/api/storage/agent-skills/obsidian-skills/skills",
      "/root/.codex/skills",
      path.join(process.env.HOME ?? "", ".codex/skills"),
    ]).filter((root) => root && existsSync(root));
  }

  private async readRoot(root: string) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const skills: AgentSkillDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!OBSIDIAN_SKILL_NAMES.includes(entry.name)) continue;
      const skillPath = path.join(root, entry.name, "SKILL.md");
      const content = await readFile(skillPath, "utf8").catch(() => "");
      if (!content) continue;
      skills.push(parseSkill(content, skillPath, entry.name));
    }
    return skills;
  }
}

function parseSkill(content: string, sourcePath: string, fallbackName: string): AgentSkillDefinition {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || firstParagraph(content);
  const body = content.replace(/^---\n[\s\S]*?\n---/, "").trim();

  return {
    id: `agent-skill:${name}`,
    name,
    description,
    sourcePath,
    contentPreview: body.slice(0, 1400),
    capabilities: extractCapabilities(body),
    triggerHints: extractTriggerHints(description),
  };
}

function extractCapabilities(body: string) {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1].trim());
  return headings.slice(0, 8);
}

function extractTriggerHints(description: string) {
  const hints = description
    .replace(/^.*?Use when/i, "")
    .split(/,|;|，|；|\bor\b|\band\b/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 2);
  return hints.slice(0, 8);
}

function firstParagraph(content: string) {
  return content
    .replace(/^---\n[\s\S]*?\n---/, "")
    .split(/\n{2,}/)
    .map((item) => item.replace(/^#+\s*/, "").trim())
    .find(Boolean) ?? "Agent skill";
}

function unique(values: string[]) {
  return [...new Set(values)];
}
