import { boardNodeProtocol, type ArtifactVersionDetail } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import type { BoardFlowNode } from "./board";
import { sourceExportReferences, resolveSourceExportSelection } from "./source-export-selection";

const pin = { artifactId: "artifact-source", artifactVersionId: "version-source" };
const selection = { kind: "artifact" as const, ...pin };
const source = { ...pin, kind: "prototype", schemaVersion: 2, status: "ready" } as ArtifactVersionDetail;

function node(id: string, parentId?: string): BoardFlowNode {
  return {
    id, type: "artifact", parentId, position: { x: 0, y: 0 },
    data: { protocol: boardNodeProtocol, nodeType: "artifact", title: id, artifactKind: "prototype" },
    workbench: { kind: "artifact", order: 0, artifactId: `artifact-${id}`, artifactVersionId: `version-${id}`, size: null },
  };
}

describe("source export selection", () => {
  it("allows a complete source version while preserving legacy format behavior", () => {
    expect(resolveSourceExportSelection(selection, [pin], [{ value: source }])).toEqual({ source: true, reason: null });
    const legacy = { ...source, schemaVersion: 1 } as ArtifactVersionDetail;
    expect(resolveSourceExportSelection(selection, [pin], [{ value: legacy }])).toEqual({ source: false, reason: null });
  });

  it("blocks partial, mixed and board-based source exports before starting a job", () => {
    expect(resolveSourceExportSelection({ ...selection, screenId: "page" }, [pin], [{ value: source }]).reason).toContain("完整应用");
    for (const selected of [{ kind: "board" as const }, { kind: "release" as const }, { kind: "board_nodes" as const, nodeIds: ["source"] }]) {
      expect(resolveSourceExportSelection(selected, [pin], [{ value: source }]).reason).toContain("单独导出");
    }
    const other = { ...source, artifactId: "other", artifactVersionId: "other-version", schemaVersion: 1 } as ArtifactVersionDetail;
    expect(resolveSourceExportSelection({ kind: "board_nodes", nodeIds: ["source", "other"] }, [pin, other], [{ value: source }, { value: other }]).reason).toContain("单独导出");
  });

  it("does not enable formats using pending, failed or stale version data", () => {
    expect(resolveSourceExportSelection(selection, [pin], [{ pending: true }]).reason).toContain("正在检查");
    expect(resolveSourceExportSelection(selection, [pin], [{ error: true }]).reason).toContain("读取失败");
    expect(resolveSourceExportSelection(selection, [pin], [{ value: { ...source, artifactVersionId: "stale" } }]).reason).toContain("已完成");
  });

  it("includes source pins in whole-board checks and follows frame selection", () => {
    const frame: BoardFlowNode = {
      id: "frame", type: "frame", position: { x: 0, y: 0 },
      data: { protocol: boardNodeProtocol, nodeType: "frame", title: "Frame", fill: null, stroke: "#000000" },
      workbench: { kind: "frame", order: 0, artifactId: null, artifactVersionId: null, size: null },
    };
    const nodes = [frame, node("source", "frame"), { ...node("source", "frame"), id: "duplicate" }, node("other")];
    expect(sourceExportReferences(nodes, { kind: "board" })).toHaveLength(2);
    expect(sourceExportReferences(nodes, { kind: "board_nodes", nodeIds: ["frame"] })).toEqual([pin]);
    expect(sourceExportReferences(nodes, { kind: "board_nodes", nodeIds: ["missing"] })).toEqual([]);
  });
});
