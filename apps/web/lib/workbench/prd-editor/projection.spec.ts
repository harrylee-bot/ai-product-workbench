// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { prdDocumentSchema } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { prdDocument } from "../../../components/workbench/workbench-prd-test-fixture";
import { workbenchPrdExtensions } from "./extensions";
import {
  applyTiptapToPrdDocument,
  prdDocumentToTiptap,
} from "./projection";

describe("PRD Tiptap projection", () => {
  it("round-trips the internal PRD without persisting editor JSON", () => {
    const source = prdDocument();
    const projected = prdDocumentToTiptap(source);
    const result = applyTiptapToPrdDocument(source, projected);

    expect(prdDocumentSchema.parse(result)).toEqual(source);
    expect(result.sections.executiveSummary.blocks[0]).toEqual(
      source.sections.executiveSummary.blocks[0],
    );
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

    const edited = prdDocumentSchema.parse(
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

    const result = prdDocumentSchema.parse(applyTiptapToPrdDocument(source, projected));
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

    const result = prdDocumentSchema.parse(applyTiptapToPrdDocument(source, projected));
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

    const result = prdDocumentSchema.parse(applyTiptapToPrdDocument(source, projected));
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
