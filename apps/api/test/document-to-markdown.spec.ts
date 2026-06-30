import { describe, expect, it } from "vitest";
import { documentToMarkdown } from "../src/ai/aichat/document-to-markdown";
import type { RequirementDocument } from "../src/ai/ai-vibe.types";

describe("documentToMarkdown", () => {
  it("normalizes literal newline escapes and keeps markdown tables for the canvas editor", () => {
    const markdown = documentToMarkdown({
      id: "prd-1",
      projectId: "project-1",
      title: "连续打开 5 天达成奖励活动需求说明书",
      status: "ready",
      version: 1,
      sections: [
        {
          id: "version",
          title: "版本历史",
          type: "overview",
          level: 1,
          order: 1,
          content:
            "| 版本 | 日期 | 说明 | 作者 |\\n| --- | --- | --- | --- |\\n| V1.0 | 2026-06-30 | 新建《连续打开 5 天达成奖励活动需求说明书》 | 产品 |",
          sourcePaths: [],
        },
        {
          id: "background",
          title: "项目背景",
          type: "background",
          level: 2,
          order: 2,
          content: "第一段。\\n\\n第二段。",
          sourcePaths: [],
        },
      ],
      assumptions: [],
      knowledgeRefs: [],
      pendingQuestions: [],
      validationNotes: [],
      createdAt: new Date("2026-06-30T00:00:00Z").toISOString(),
      updatedAt: new Date("2026-06-30T00:00:00Z").toISOString(),
    } as RequirementDocument);

    expect(markdown).not.toContain("\\n");
    expect(markdown).toContain("| 版本 | 日期 | 说明 | 作者 |");
    expect(markdown).toContain("| --- | --- | --- | --- |");
    expect(markdown).toContain("| V1.0 | 2026-06-30 | 新建《连续打开 5 天达成奖励活动需求说明书》 | 产品 |");
    expect(markdown).toContain("第一段。\n\n第二段。");
  });
});
