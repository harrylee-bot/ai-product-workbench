import {
  resolveExportBoardNodeSelection,
  type ArtifactVersionDetail,
  type ExportSelection,
} from "@workbench/workbench-contracts";

import type { BoardFlowNode } from "./board";
import type { DocumentExportReference } from "./document-export-selection";

export type SourceExportSelection = { source: boolean; reason: string | null };

export function sourceExportReferences(
  nodes: readonly BoardFlowNode[],
  selection: ExportSelection,
): DocumentExportReference[] {
  if (selection.kind === "artifact") return [{
    artifactId: selection.artifactId,
    artifactVersionId: selection.artifactVersionId,
  }];
  const boardNodes = nodes.map((node) => ({
    ...node, kind: node.workbench.kind, parentNodeId: node.parentId ?? null,
  }));
  const resolved = selection.kind === "board_nodes"
    ? resolveExportBoardNodeSelection(boardNodes, selection.nodeIds)
    : null;
  if (resolved?.missingNodeIds.length) return [];
  const references = new Map<string, DocumentExportReference>();
  for (const node of resolved?.selectedNodes ?? boardNodes) {
    const { artifactId, artifactVersionId } = node.workbench;
    if (artifactId && artifactVersionId) {
      references.set(`${artifactId}:${artifactVersionId}`, { artifactId, artifactVersionId });
    }
  }
  return [...references.values()];
}

export function resolveSourceExportSelection(
  selection: ExportSelection,
  references: readonly DocumentExportReference[],
  versions: ReadonlyArray<{ value?: ArtifactVersionDetail; pending?: boolean; error?: boolean }>,
): SourceExportSelection {
  if (references.length === 0) return { source: false, reason: null };
  if (versions.some((version) => version.error)) {
    return { source: false, reason: "产物读取失败，请重新打开导出" };
  }
  if (versions.length !== references.length || versions.some((version) => version.pending || !version.value)) {
    return { source: false, reason: "正在检查产物支持的导出格式" };
  }
  if (versions.some(({ value }, index) => value?.artifactId !== references[index]?.artifactId
    || value?.artifactVersionId !== references[index]?.artifactVersionId || value?.status !== "ready")) {
    return { source: false, reason: "请选择已完成的产物版本" };
  }
  const source = versions.some(({ value }) => value?.kind === "prototype" && value.schemaVersion === 2);
  if (!source) return { source: false, reason: null };
  if (selection.kind !== "artifact" || references.length !== 1) {
    return { source: true, reason: "源码原型需单独导出，请只选择一个源码原型" };
  }
  if (selection.screenId) {
    return { source: true, reason: "源码原型需导出完整应用，请选择整个原型" };
  }
  return { source: true, reason: null };
}
