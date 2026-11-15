import {
  prototypeDocumentSchema,
  type PrototypeFeedback,
  type PrototypeFeedbackLocation,
} from "@workbench/workbench-contracts";

export function feedbackAnchorIndex(revision: {
  pages: unknown;
  sourceDocument: unknown;
}) {
  const pages = new Set<string>(
    Array.isArray(revision.pages)
      ? revision.pages.flatMap((page) =>
          page && typeof page.id === "string" ? [page.id] : [],
        )
      : [],
  );
  const parsed = prototypeDocumentSchema.safeParse(revision.sourceDocument);
  return {
    pages,
    nodes: parsed.success
      ? new Map(parsed.data.nodes.map((node) => [node.id, node.screenId]))
      : null,
  };
}

export function resolveFeedbackLocation(
  feedback: PrototypeFeedback,
  targetRevisionId: string,
  index: ReturnType<typeof feedbackAnchorIndex>,
): PrototypeFeedbackLocation {
  const anchor = feedback.anchor;
  const base = { feedback, targetRevisionId };
  if (!anchor)
    return {
      ...base,
      status: "version",
      pageId: null,
      nodeId: null,
      reason: null,
    };
  const missing = (
    reason: NonNullable<PrototypeFeedbackLocation["reason"]>,
  ): PrototypeFeedbackLocation => ({
    ...base,
    status: "missing",
    pageId: null,
    nodeId: null,
    reason,
  });
  if (anchor.scope === "unresolved") return missing("unidentified_node");
  if (!index.pages.has(anchor.pageId)) return missing("page_missing");
  if (anchor.scope === "page")
    return {
      ...base,
      status: "resolved",
      pageId: anchor.pageId,
      nodeId: null,
      reason: null,
    };
  if (!index.nodes) return missing("source_unavailable");
  if (index.nodes.get(anchor.nodeId) !== anchor.pageId)
    return missing("node_missing");
  return {
    ...base,
    status: "resolved",
    pageId: anchor.pageId,
    nodeId: anchor.nodeId,
    reason: null,
  };
}
