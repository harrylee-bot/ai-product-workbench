import {
  prdDocumentV2Schema,
  businessDocumentSchema,
  resolveExportBoardNodeSelection,
  type ArtifactVersionDetail,
  type ExportSelection,
} from "@workbench/workbench-contracts";

import type { BoardFlowNode } from "./board";

export type DocumentExportReference = {
  artifactId: string;
  artifactVersionId: string;
};

export type DocumentExportSelection = {
  selection: Extract<ExportSelection, { kind: "artifact" }> | null;
  title: string | null;
  reason: string | null;
};

export function documentExportReferences(
  nodes: readonly BoardFlowNode[],
  selection: ExportSelection,
): DocumentExportReference[] {
  if (selection.kind === "artifact") return [{
    artifactId: selection.artifactId,
    artifactVersionId: selection.artifactVersionId,
  }];
  const boardNodes = nodes.map((node) => ({
    ...node,
    kind: node.workbench.kind,
    parentNodeId: node.parentId ?? null,
  }));
  const boardSelection = selection.kind === "board_nodes"
    ? resolveExportBoardNodeSelection(boardNodes, selection.nodeIds)
    : null;
  if (boardSelection?.missingNodeIds.length) return [];
  const selected = boardSelection?.selectedNodes
    ?? boardNodes.filter((node) => node.data.nodeType === "artifact"
      && (node.data.artifactKind === "prd" || node.data.artifactKind === "document"));
  const references = new Map<string, DocumentExportReference>();
  for (const node of selected) {
    const { artifactId, artifactVersionId } = node.workbench;
    if (artifactId && artifactVersionId) {
      references.set(`${artifactId}:${artifactVersionId}`, { artifactId, artifactVersionId });
    }
  }
  return [...references.values()];
}

export function resolveDocumentExportSelection(
  selection: ExportSelection,
  references: readonly DocumentExportReference[],
  versions: ReadonlyArray<{
    value?: ArtifactVersionDetail;
    pending?: boolean;
    error?: boolean;
  }>,
): DocumentExportSelection {
  const unavailable = (reason: string): DocumentExportSelection => ({ selection: null, title: null, reason });
  if (selection.kind === "artifact" && selection.screenId) {
    return unavailable("Word/PDF 支持完整文档，不能导出原型界面");
  }
  if (selection.kind === "board_nodes" && references.length > 1) {
    return unavailable("请只选择一个文档产物");
  }
  if (references.length === 0) return unavailable("请选择一个已完成的文档");
  if (versions.some((version) => version.error)) return unavailable("文档读取失败，请重新打开导出");
  if (versions.length !== references.length || versions.some((version) => version.pending || !version.value)) {
    return unavailable("正在检查文档");
  }
  const documents = references.flatMap((reference, index) => {
    const version = versions[index]?.value;
    if (!version
      || version.artifactId !== reference.artifactId
      || version.artifactVersionId !== reference.artifactVersionId
      || version.status !== "ready"
      || version.contentMode !== "inline"
      || (version.kind !== "prd" && version.kind !== "document")) return [];
    const document = prdDocumentV2Schema.safeParse(version.content);
    if (!document.success && version.kind === "document") {
      const business = businessDocumentSchema.safeParse(version.content);
      if (business.success) return [{ reference, title: business.data.title ?? "业务文档" }];
    }
    if (!document.success) return [];
    return [{ reference, title: document.data.title }];
  });
  if (documents.length === 0) return unavailable("Word/PDF 支持完整 PRD v2 或正文文档");
  if (documents.length !== 1) return unavailable("项目中有多个文档，请先选择一个");
  const { reference, title } = documents[0]!;
  return {
    selection: { kind: "artifact", ...reference },
    title,
    reason: null,
  };
}
