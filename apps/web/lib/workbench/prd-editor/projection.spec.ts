// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import {
  prdDocumentSchema,
  prdDocumentV1Schema,
  prdDocumentV2Schema,
  prdDocumentV3Schema,
  prdTableOfContentsEntriesForV3,
  prdTableOfContentsEntriesFor,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example, prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import { describe, expect, it } from "vitest";

import { prdDocument } from "../../../components/workbench/workbench-prd-test-fixture";
import { workbenchPrdExtensions } from "./extensions";
import {
  applyTiptapToPrdDocument,
  prdDocumentToTiptap,
} from "./projection";

describe("PRD Tiptap projection", () => {
  it("round-trips v3 functional sections and inline diagrams without losing IDs or citations", () => {
    const source = structuredClone(prdDocumentV3Example);
    const editor = new Editor({ extensions: workbenchPrdExtensions, content: prdDocumentToTiptap(source) });
    expect(prdDocumentV3Schema.parse(applyTiptapToPrdDocument(source, editor.getJSON()))).toEqual(source);
    const functionNode = findJsonNode(editor.getJSON(), (node) => node.attrs?.sectionKey === "v3:function:section-task-state");
    expect(functionNode?.content?.filter((node) => node.type === "prdDiagram")).toHaveLength(2);
    editor.destroy();
  });

  it("edits a single function with embedded acceptance and no diagrams, keeping the TOC and protected data", () => {
    const source = structuredClone(prdDocumentV3Example);
    source.sections.businessRequirements.functionSections = [{
      id: "single-function", title: "2.2 任务提交处理",
      blocks: source.sections.businessRequirements.functionSections.flatMap((section) => section.blocks), diagrams: [],
    }];
    source.tableOfContents.entries = prdTableOfContentsEntriesForV3(["2.2 任务提交处理"]);
    const projected = prdDocumentToTiptap(prdDocumentV3Schema.parse(source));
    replaceNodeText(projected, ["sections", "businessRequirements", "functionSections", 0, "title"], "2.2 任务提交与回执");
    projected.content?.push({ type: "paragraph", attrs: {
      prdPath: JSON.stringify(["sections", "businessRequirements", "functionSections", 0, "id"]), prdValueKind: "string",
    }, content: [{ type: "text", text: "injected-id" }] });
    const result = prdDocumentV3Schema.parse(applyTiptapToPrdDocument(source, projected));
    expect(result.sections.businessRequirements.functionSections[0]!.id).toBe("single-function");
    expect(result.tableOfContents.entries).toContain("2.2 任务提交与回执");
    expect(result.sections.safetyBaseline).toEqual(source.sections.safetyBaseline);
    expect(result.citations).toEqual(source.citations);
    expect(JSON.stringify(projected)).not.toContain('"type":"prdDiagram"');
  });

  it("round-trips the internal PRD without persisting editor JSON", () => {
    const source = prdDocument();
    const projected = prdDocumentToTiptap(source);
    const result = applyTiptapToPrdDocument(source, projected);

    expect(prdDocumentV1Schema.parse(result)).toEqual(source);
    expect(result.sections.executiveSummary.blocks[0]).toEqual(
      source.sections.executiveSummary.blocks[0],
    );
  });

  it("round-trips PRD v2 through Tiptap without changing fixed template data", () => {
    const source = structuredClone(prdDocumentV2Example);
    const editor = new Editor({
      extensions: workbenchPrdExtensions,
      content: prdDocumentToTiptap(source),
    });

    const result = applyTiptapToPrdDocument(source, editor.getJSON());

    expect(prdDocumentV2Schema.parse(result)).toEqual(source);
    expect(editor.getJSON().content?.some((node) => node.type === "prdFixedBlock")).toBe(true);
    editor.destroy();
  });

  it("round-trips and edits PRD v2 additional business sections with a synchronized TOC", () => {
    const source = structuredClone(prdDocumentV2Example);
    source.sections.businessRequirements.additionalSections = [{
      title: "2.5 配置规则",
      blocks: [{
        id: "additional-config-rule",
        type: "paragraph",
        content: [{ type: "text", text: "补充业务配置规则及对应结果。", marks: [] }],
      }],
    }];
    source.tableOfContents.entries = prdTableOfContentsEntriesFor(["2.5 配置规则"]);
    const projected = prdDocumentToTiptap(source);

    expect(findJsonNode(projected, (node) => (
      node.attrs?.sectionKey === "v2:businessRequirements.additionalSections.0"
    ))).not.toBeNull();
    replaceNodeText(
      projected,
      ["sections", "businessRequirements", "additionalSections", 0, "title"],
      "2.5 结果规则",
    );
    replaceNodeText(
      projected,
      ["sections", "businessRequirements", "additionalSections", 0, "blocks", 0, "content"],
      "补充后的业务结果规则。",
    );

    const result = prdDocumentV2Schema.parse(applyTiptapToPrdDocument(source, projected));

    expect(result.sections.businessRequirements.additionalSections[0]).toMatchObject({
      title: "2.5 结果规则",
      blocks: [{ content: [{ type: "text", text: "补充后的业务结果规则。", marks: [] }] }],
    });
    expect(result.tableOfContents.entries[9]).toBe("2.5 结果规则");
  });

  it("edits allowed PRD v2 fields while preserving its fixed template structures", () => {
    const source = structuredClone(prdDocumentV2Example);
    const projected = prdDocumentToTiptap(source);
    replaceNodeText(projected, ["title"], "编辑后工单");
    replaceNodeText(
      projected,
      ["sections", "introduction", "background", "blocks", 0, "content"],
      "编辑后的项目背景。",
    );
    replaceNodeText(
      projected,
      ["sections", "businessRequirements", "summary"],
      "编辑后的业务需求总览。",
    );
    replaceNodeText(
      projected,
      ["sections", "degradation", "content"],
      "依赖异常时保留用户输入和可信状态，暂停重复提交并展示具体原因、影响范围、恢复入口和最近更新时间；系统恢复后复用既有任务结果，校验权限、状态和数据一致性，完整记录异常发生、恢复与最终处理过程，供业务、研发和测试共同复核。".repeat(2),
    );
    removeFixedBlocks(projected);

    const result = prdDocumentV2Schema.parse(applyTiptapToPrdDocument(source, projected));

    expect(result.protocol).toBe("workbench.prd.v2");
    if (result.protocol !== "workbench.prd.v2") throw new Error("expected PRD v2");
    expect(result.title).toBe("编辑后工单需求说明书");
    expect(result.cover).toEqual({
      workOrderName: "编辑后工单",
      title: "编辑后工单需求说明书",
    });
    expect(result.sections.introduction.background.blocks[0]).toMatchObject({
      content: [{ type: "text", text: "编辑后的项目背景。", marks: [] }],
    });
    expect(result.sections.introduction.usageScenarios.channelTable)
      .toEqual(source.sections.introduction.usageScenarios.channelTable);
    expect(result.sections.businessRequirements.flowAndPages.diagrams)
      .toEqual(source.sections.businessRequirements.flowAndPages.diagrams);
    expect(result.sections.safetyBaseline).toEqual(source.sections.safetyBaseline);
    expect(result.tableOfContents).toEqual(source.tableOfContents);
  });

  it("uses Tiptap transactions and undo while preserving semantic references", () => {
    const source = prdDocument();
    const editor = new Editor({
      extensions: workbenchPrdExtensions,
      content: prdDocumentToTiptap(source),
    });
    let titleRange: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, position) => {
      if (node.attrs.prdPath === JSON.stringify(["title"])) {
        titleRange = { from: position + 1, to: position + node.nodeSize - 1 };
        return false;
      }
      return true;
    });
    expect(titleRange).not.toBeNull();
    editor.chain().setTextSelection(titleRange!).insertContent("Edited PRD").run();

    const edited = prdDocumentV1Schema.parse(
      applyTiptapToPrdDocument(source, editor.getJSON()),
    );
    expect(edited.title).toBe("Edited PRD");
    expect(edited.sections.executiveSummary.blocks[0]).toEqual(
      source.sections.executiveSummary.blocks[0],
    );

    expect(editor.commands.undo()).toBe(true);
    expect(applyTiptapToPrdDocument(source, editor.getJSON()).title).toBe(source.title);
    editor.destroy();
  });

  it("lets the PRD contract reject an empty required field before save", () => {
    const source = prdDocument();
    const projected = prdDocumentToTiptap(source);
    const title = findJsonNode(projected, (node) => node.attrs?.prdPath === JSON.stringify(["title"]));
    expect(title).not.toBeNull();
    title!.content = [];

    expect(prdDocumentSchema.safeParse(
      applyTiptapToPrdDocument(source, projected),
    ).success).toBe(false);
  });

  it("rebuilds section block order so insert, delete, and move are durable", () => {
    const source = prdDocument();
    const projected = prdDocumentToTiptap(source);
    const executive = findJsonNode(projected, (node) => node.attrs?.sectionKey === "executiveSummary");
    const problem = findJsonNode(projected, (node) => node.attrs?.sectionKey === "problem");
    const movedProblem = problem?.content?.find((node) => node.attrs?.dataId === "problem");
    expect(executive).not.toBeNull();
    expect(problem).not.toBeNull();
    expect(movedProblem).toBeDefined();

    executive!.content = [executive!.content![0]!, movedProblem!];
    problem!.content = [problem!.content![0]!, {
      type: "paragraph",
      attrs: { dataId: "new-problem", prdRole: "body" },
      content: [{ type: "text", text: "Replacement problem" }],
    }];

    const result = prdDocumentV1Schema.parse(applyTiptapToPrdDocument(source, projected));
    expect(result.sections.executiveSummary.blocks.map((block) => block.id)).toEqual(["problem"]);
    expect(result.sections.problem.blocks).toEqual([{
      id: "new-problem",
      type: "paragraph",
      content: [{ type: "text", text: "Replacement problem", marks: [] }],
    }]);
  });

  it("rebuilds list items instead of retaining deleted source items", () => {
    const source = prdDocument();
    const projected = prdDocumentToTiptap(source);
    const list = findJsonNode(projected, (node) => node.attrs?.dataId === "scope-list");
    expect(list).not.toBeNull();
    list!.content = [{
      type: "listItem",
      content: [{
        type: "paragraph",
        attrs: { dataId: "scope-item-2", prdRole: "body" },
        content: [{ type: "text", text: "Replacement scope" }],
      }],
    }];

    const result = prdDocumentV1Schema.parse(applyTiptapToPrdDocument(source, projected));
    expect(result.sections.scope.blocks[0]).toEqual({
      id: "scope-list",
      type: "bulletList",
      items: [{
        id: "scope-item-2",
        content: [{ type: "text", text: "Replacement scope", marks: [] }],
      }],
    });
  });

  it("rebuilds table column order and new rows with stable IR ids", () => {
    const source = prdDocument();
    source.sections.executiveSummary.blocks.push({
      id: "summary-table",
      type: "table",
      columns: [
        { id: "column-a", label: "A" },
        { id: "column-b", label: "B" },
      ],
      rows: [{
        id: "row-a",
        cells: [
          { columnId: "column-a", content: [{ type: "text", text: "A1", marks: [] }] },
          { columnId: "column-b", content: [{ type: "text", text: "B1", marks: [] }] },
        ],
      }],
    });
    const projected = prdDocumentToTiptap(source);
    const table = findJsonNode(projected, (node) => node.attrs?.dataId === "summary-table");
    expect(table?.content?.[0]?.content).toHaveLength(2);
    table!.content = [{
      ...table!.content![0]!,
      content: [...table!.content![0]!.content!].reverse(),
    }, {
      type: "tableRow",
      content: ["B2", "A2"].map((text, index) => ({
        type: "tableCell",
        content: [{
          type: "paragraph",
          attrs: { dataId: `new-table-cell-${index + 1}` },
          content: [{ type: "text", text }],
        }],
      })),
    }];

    const result = prdDocumentV1Schema.parse(applyTiptapToPrdDocument(source, projected));
    const rebuilt = result.sections.executiveSummary.blocks[1];
    expect(rebuilt).toMatchObject({
      id: "summary-table",
      type: "table",
      columns: [{ id: "column-b", label: "B" }, { id: "column-a", label: "A" }],
      rows: [{
        id: "editor-summary-table-row-1",
        cells: [
          { columnId: "column-b", content: [{ type: "text", text: "B2", marks: [] }] },
          { columnId: "column-a", content: [{ type: "text", text: "A2", marks: [] }] },
        ],
      }],
    });
  });

  it("does not silently restore a deleted required card field", () => {
    const source = prdDocument();
    const projected = prdDocumentToTiptap(source);
    const goal = findJsonNode(projected, (node) => node.attrs?.dataId === "goal-1");
    expect(goal).not.toBeNull();
    goal!.content = goal!.content?.filter((node) => (
      node.attrs?.prdPath !== JSON.stringify(["sections", "goals", "blocks", 0, "successMetric"])
    ));

    const result = applyTiptapToPrdDocument(source, projected);
    expect(result.sections.goals.blocks[0]).toMatchObject({ successMetric: "" });
    expect(prdDocumentSchema.safeParse(result).success).toBe(false);
  });
});

function findJsonNode(
  node: JSONContent,
  predicate: (node: JSONContent) => boolean,
): JSONContent | null {
  if (predicate(node)) return node;
  for (const child of node.content ?? []) {
    const found = findJsonNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function replaceNodeText(node: JSONContent, path: Array<string | number>, text: string) {
  const target = findJsonNode(node, (candidate) => (
    candidate.attrs?.prdPath === JSON.stringify(path)
  ));
  expect(target).not.toBeNull();
  target!.content = [{ type: "text", text }];
}

function removeFixedBlocks(node: JSONContent) {
  node.content = (node.content ?? []).filter((child) => child.type !== "prdFixedBlock");
  for (const child of node.content) removeFixedBlocks(child);
}
