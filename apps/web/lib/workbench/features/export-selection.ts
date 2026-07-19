import {
  compareExportBoardNodeIds,
  type ExportSelection,
} from "@workbench/workbench-contracts";

export function canonicalizeExportSelection(selection: ExportSelection): ExportSelection {
  if (selection.kind !== "board_nodes") return selection;
  return {
    kind: "board_nodes",
    nodeIds: canonicalBoardNodeIds(selection.nodeIds),
  };
}

export function exportSelectionIdentityKey(selection: ExportSelection): string {
  if (selection.kind === "artifact") {
    return JSON.stringify({
      kind: selection.kind,
      artifactId: selection.artifactId,
      artifactVersionId: selection.artifactVersionId,
      screenId: selection.screenId ?? null,
    });
  }
  if (selection.kind === "board_nodes") {
    return JSON.stringify({
      kind: selection.kind,
      nodeIds: canonicalBoardNodeIds(selection.nodeIds),
    });
  }
  return JSON.stringify({ kind: selection.kind });
}

export function exportSelectionsEqual(
  left: ExportSelection | null,
  right: ExportSelection,
): boolean {
  return left !== null
    && exportSelectionIdentityKey(left) === exportSelectionIdentityKey(right);
}

function canonicalBoardNodeIds(nodeIds: readonly string[]): string[] {
  return [...new Set(nodeIds)].sort(compareExportBoardNodeIds);
}
