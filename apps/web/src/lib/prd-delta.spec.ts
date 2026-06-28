import { describe, expect, it } from "vitest";
import { mergePrdSectionDelta } from "@/app/workspace/phase1-workspace-client";
import type { Phase1PrdPreview } from "@/components/workspace-preview/types";

describe("mergePrdSectionDelta", () => {
  it("builds a preview from the first section delta", () => {
    const result = mergePrdSectionDelta(null, {
      documentId: "prd-1",
      documentTitle: "签到 PRD",
      section: { id: "sec-1", title: "背景", order: 1, content: "活动背景。", sourcePaths: [] },
      index: 0,
      total: 2,
      isLast: false,
    });

    expect(result).toEqual({
      id: "prd-1",
      title: "签到 PRD",
      sections: [expect.objectContaining({ id: "sec-1", title: "背景", order: 1 })],
    });
  });

  it("appends subsequent sections of the same document without resetting", () => {
    const first = mergePrdSectionDelta(null, {
      documentId: "prd-1",
      documentTitle: "签到 PRD",
      section: { id: "sec-1", title: "背景", order: 1, content: "a", sourcePaths: [] },
      index: 0,
      total: 2,
      isLast: false,
    }) as Phase1PrdPreview;

    const second = mergePrdSectionDelta(first, {
      documentId: "prd-1",
      documentTitle: "签到 PRD",
      section: { id: "sec-2", title: "目标", order: 2, content: "b", sourcePaths: [] },
      index: 1,
      total: 2,
      isLast: true,
    });

    expect(second?.sections.map((s) => s.id)).toEqual(["sec-1", "sec-2"]);
    expect(second?.sections.map((s) => s.order)).toEqual([1, 2]);
  });

  it("updates an existing section by id instead of duplicating", () => {
    const first = mergePrdSectionDelta(null, {
      documentId: "prd-1",
      documentTitle: "签到 PRD",
      section: { id: "sec-1", title: "背景", order: 1, content: "旧", sourcePaths: [] },
      index: 0,
      total: 1,
      isLast: true,
    }) as Phase1PrdPreview;

    const updated = mergePrdSectionDelta(first, {
      documentId: "prd-1",
      documentTitle: "签到 PRD",
      section: { id: "sec-1", title: "背景", order: 1, content: "新内容", sourcePaths: [] },
      index: 0,
      total: 1,
      isLast: true,
    });

    expect(updated?.sections).toHaveLength(1);
    expect(updated?.sections[0].content).toBe("新内容");
  });

  it("rebuilds when the document id changes", () => {
    const first = mergePrdSectionDelta(null, {
      documentId: "prd-1",
      documentTitle: "旧 PRD",
      section: { id: "sec-1", title: "背景", order: 1, content: "a", sourcePaths: [] },
      index: 0,
      total: 1,
      isLast: true,
    }) as Phase1PrdPreview;

    const rebuilt = mergePrdSectionDelta(first, {
      documentId: "prd-2",
      documentTitle: "新 PRD",
      section: { id: "sec-x", title: "新背景", order: 1, content: "b", sourcePaths: [] },
      index: 0,
      total: 1,
      isLast: true,
    });

    expect(rebuilt?.id).toBe("prd-2");
    expect(rebuilt?.title).toBe("新 PRD");
    expect(rebuilt?.sections.map((s) => s.id)).toEqual(["sec-x"]);
  });
});
