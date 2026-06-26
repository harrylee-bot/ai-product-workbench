import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeSkillRegistryService } from "../src/ai/runtime-skill-registry.service";

describe("RuntimeSkillRegistryService", () => {
  it("loads kepano Obsidian skills and converts them to knowledge references", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-skills-"));
    const skillsRoot = path.join(tempRoot, "skills");
    const skillDir = path.join(skillsRoot, "obsidian-markdown");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: obsidian-markdown
description: Create and edit Obsidian Flavored Markdown with wikilinks.
---

# Obsidian Flavored Markdown Skill

## Internal Links

Use wikilinks for notes inside the vault.
`,
      "utf8",
    );

    const previousRoot = process.env.RUNTIME_SKILLS_ROOT;
    process.env.RUNTIME_SKILLS_ROOT = skillsRoot;
    try {
      const service = new RuntimeSkillRegistryService();
      const skills = await service.listSkills();
      const refs = service.toKnowledgeReferences(skills);
      const markdownSkill = skills.find((skill) => skill.name === "obsidian-markdown");
      const markdownRef = refs.find((ref) => ref.knowledgeId === "runtime-skill:obsidian-markdown");

      expect(markdownSkill).toMatchObject({
        name: "obsidian-markdown",
        capabilities: ["Internal Links"],
      });
      expect(markdownRef).toMatchObject({
        knowledgeId: "runtime-skill:obsidian-markdown",
        title: "Vibe Coding 可用技能：obsidian-markdown",
      });
    } finally {
      if (previousRoot === undefined) delete process.env.RUNTIME_SKILLS_ROOT;
      else process.env.RUNTIME_SKILLS_ROOT = previousRoot;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
