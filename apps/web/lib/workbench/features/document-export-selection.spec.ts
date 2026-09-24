import { boardNodeProtocol, type ArtifactVersionDetail } from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { describe, expect, it } from "vitest";

import type { BoardFlowNode } from "./board";
import { documentExportReferences, resolveDocumentExportSelection } from "./document-export-selection";

const reference = { artifactId: "artifact-prd", artifactVersionId: "version-prd" };
const selected = { kind: "artifact" as const, ...reference };

function prdVersion() {
  return {
    artifactVersionId: reference.artifactVersionId,
    artifactId: reference.artifactId,
    kind: "document" as const,
    version: 1,
    schemaVersion: 2,
    status: "ready" as const,
    checksum: "a".repeat(64),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    contentMode: "inline" as const,
    content: structuredClone(prdDocumentV2Example),
  };
}

function node(id: string, kind: "prd" | "document" | "prototype", parentId?: string): BoardFlowNode {
  return {
    id,
    type: "artifact",
    parentId,
    position: { x: 0, y: 0 },
    data: { protocol: boardNodeProtocol, nodeType: "artifact", title: id, artifactKind: kind },
    workbench: { kind: "artifact", order: 0, artifactId: `artifact-${id}`, artifactVersionId: `version-${id}`, size: null },
  };
}

describe("document export selection", () => {
  it("requires a choice when both a PRD and a business document can be exported", () => {
    const selection = { kind: "board" as const };
    const references = documentExportReferences([node("short", "document"), node("prd", "document"), node("ui", "prototype")], selection);
    const short = { ...prdVersion(), artifactVersionId: "version-short", artifactId: "artifact-short", content: { text: "Short note" } };
    const result = resolveDocumentExportSelection(selection, references, [{ value: short }, { value: prdVersion() }]);
    expect(references).toHaveLength(2);
    expect(result).toEqual({ selection: null, title: null, reason: "项目中有多个文档，请先选择一个" });
    expect(resolveDocumentExportSelection(
      { kind: "artifact", artifactId: short.artifactId, artifactVersionId: short.artifactVersionId },
      [references[0]!], [{ value: short }],
    ).selection).toEqual({ kind: "artifact", artifactId: short.artifactId, artifactVersionId: short.artifactVersionId });
  });

  it("accepts both PRD artifact kinds using the actual version protocol", () => {
    for (const kind of ["prd", "document"] as const) {
      const value = { ...prdVersion(), kind } as ArtifactVersionDetail;
      expect(resolveDocumentExportSelection(selected, [reference], [{ value }]).selection).toEqual(selected);
    }
  });

  it("does not silently export one document from a mixed explicit selection", () => {
    const selection = { kind: "board_nodes" as const, nodeIds: ["prd", "ui"] };
    const references = documentExportReferences([node("prd", "prd"), node("ui", "prototype")], selection);
    expect(resolveDocumentExportSelection(selection, references, []).reason).toBe("请只选择一个文档产物");
    expect(documentExportReferences([node("prd", "prd")], { kind: "board_nodes", nodeIds: ["prd", "missing"] })).toEqual([]);
  });

  it("resolves a selected frame and deduplicates repeated artifact pins", () => {
    const frame: BoardFlowNode = {
      id: "frame",
      type: "frame",
      position: { x: 0, y: 0 },
      data: { protocol: boardNodeProtocol, nodeType: "frame", title: "Frame", fill: null, stroke: "#000000" },
      workbench: { kind: "frame", order: 0, artifactId: null, artifactVersionId: null, size: null },
    };
    const duplicate = { ...node("prd", "prd", "frame"), id: "duplicate" };
    const references = documentExportReferences([frame, node("prd", "prd", "frame"), duplicate], { kind: "board_nodes", nodeIds: ["frame"] });
    expect(references).toEqual([reference]);
  });

  it("requires an explicit choice when a project has more than one valid PRD", () => {
    const second = { artifactId: "artifact-second", artifactVersionId: "version-second" };
    const value = { ...prdVersion(), artifactVersionId: second.artifactVersionId, artifactId: second.artifactId };
    expect(resolveDocumentExportSelection({ kind: "board" }, [reference, second], [{ value: prdVersion() }, { value }]).reason)
      .toBe("项目中有多个文档，请先选择一个");
  });

  it("keeps non-PRD, invalid PRD, pending and failed versions unavailable", () => {
    const invalid = { ...prdVersion(), content: { protocol: "workbench.prd.v2" } };
    expect(resolveDocumentExportSelection(selected, [reference], [{ value: invalid }]).selection).toBeNull();
    expect(resolveDocumentExportSelection(selected, [reference], [{ pending: true }]).reason).toBe("正在检查文档");
    expect(resolveDocumentExportSelection(selected, [reference], [{ error: true }]).reason).toContain("读取失败");
    expect(resolveDocumentExportSelection({ ...selected, screenId: "screen-1" }, [reference], [{ value: prdVersion() }]).reason)
      .toContain("不能导出原型界面");
  });
});
