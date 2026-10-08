import {
  compareExportBoardNodeIds,
  type ExportSelection,
} from "@workbench/workbench-contracts";
import type { PrdDraftReplacement } from "../prd-editor/draft-store";

export function rebaseSavedPrdSelection(selection: ExportSelection, replacements: readonly PrdDraftReplacement[]): ExportSelection {
  if (selection.kind !== "artifact") return selection;
  const replacement = replacements.find((saved) => saved.artifactId === selection.artifactId
    && saved.artifactVersionId === selection.artifactVersionId);
  return replacement ? { ...selection, artifactVersionId: replacement.savedArtifactVersionId } : selection;
}

export function alignArtifactSelectionWithPins(
  selection: ExportSelection,
  pins: ReadonlyArray<{ artifactId: string | null; artifactVersionId: string | null }>,
): ExportSelection {
  if (selection.kind !== "artifact") return selection;
  const versions = new Set(pins.filter((pin) => pin.artifactId === selection.artifactId)
    .flatMap((pin) => pin.artifactVersionId ? [pin.artifactVersionId] : []));
  if (versions.has(selection.artifactVersionId)) return selection;
  if (versions.size === 0) return selection;
  if (versions.size !== 1) throw new Error("文档选区已变化，请重新选择需要预览或导出的版本。");
  return { ...selection, artifactVersionId: [...versions][0]! };
}

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
