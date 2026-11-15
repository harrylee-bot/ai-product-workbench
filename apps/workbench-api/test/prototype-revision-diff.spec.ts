import { describe, expect, it } from "vitest";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { prototypeRevisionPageDifferences } from "../src/modules/prototypes/prototype-revision-diff.js";

describe("Prototype semantic revision differences", () => {
  it("does not mark unrelated pages changed when a generated package or document revision changes", () => {
    const base = prototypeDocumentFixture(); const next = structuredClone(base);
    next.revision++; next.documentId = "next-generation";
    const node = next.nodes.find(node => node.id === "node-a")!;
    if (node.kind !== "text") throw new Error("fixture"); node.text = "Updated A";
    expect(prototypeRevisionPageDifferences({ sourceDocument: base, pages: [] }, { sourceDocument: next, pages: [] })).toEqual([
      { pageId: "screen-a", change: "changed" }, { pageId: "screen-b", change: "unchanged" },
    ]);
  });
  it("follows binding dependencies but ignores unused shared variables", () => {
    const base = prototypeDocumentFixture();
    base.bindings = [{ id: "binding-a", nodeId: "node-a", property: "text", source: { kind: "variable", path: "shared.first" } }];
    base.nodes.find(node => node.id === "node-a")!.bindingIds = ["binding-a"];
    const next = structuredClone(base); next.variables.find(variable => variable.path === "shared.first")!.initialValue = "changed";
    expect(prototypeRevisionPageDifferences({ sourceDocument: base, pages: [] }, { sourceDocument: next, pages: [] })).toEqual([
      { pageId: "screen-a", change: "changed" }, { pageId: "screen-b", change: "unchanged" },
    ]);
    const unused = structuredClone(base); unused.variables.find(variable => variable.path === "shared.second")!.initialValue = "unused";
    expect(prototypeRevisionPageDifferences({ sourceDocument: base, pages: [] }, { sourceDocument: unused, pages: [] }).every(page => page.change === "unchanged")).toBe(true);
  });
  it("reports added/removed screens and the first version without a base", () => {
    const base = prototypeDocumentFixture(); const next = structuredClone(base);
    next.screens = next.screens.filter(screen => screen.id !== "screen-b"); next.nodes = next.nodes.filter(node => node.screenId !== "screen-b");
    expect(prototypeRevisionPageDifferences({ sourceDocument: base, pages: [] }, { sourceDocument: next, pages: [] })).toEqual([
      { pageId: "screen-a", change: "unchanged" }, { pageId: "screen-b", change: "removed" },
    ]);
    expect(prototypeRevisionPageDifferences(null, { sourceDocument: next, pages: [] })).toEqual([{ pageId: "screen-a", change: "added" }]);
  });
});
