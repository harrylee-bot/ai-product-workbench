import { canonicalJson, projectPrototypeSourceScreens, prototypeDocumentSchema, type PrototypePage } from "@workbench/workbench-contracts";

type RevisionContent = { sourceDocument: unknown; pages: PrototypePage[] };
export type PrototypePageDifference = { pageId: string; change: "added" | "removed" | "changed" | "unchanged" };

/** Compare screen semantics rather than the executable package, which includes
 * every screen and shared runtime. The shared projection follows referenced
 * nodes, bindings, actions, tokens/assets and navigation destinations. */
export function prototypeRevisionPageDifferences(base: RevisionContent | null, current: RevisionContent): PrototypePageDifference[] {
  const previous = signatures(base);
  const next = signatures(current);
  return [...new Set([...previous.keys(), ...next.keys()])].map(pageId => ({
    pageId,
    change: !previous.has(pageId) ? "added" : !next.has(pageId) ? "removed"
      : previous.get(pageId) === next.get(pageId) ? "unchanged" : "changed",
  }));
}

function signatures(value: RevisionContent | null): Map<string, string> {
  if (!value) return new Map();
  const parsed = prototypeDocumentSchema.safeParse(value.sourceDocument);
  if (!parsed.success) return new Map(value.pages.map(page => [page.id, canonicalJson({ title: page.title, route: page.route, order: page.order, content: page.content })]));
  return new Map(parsed.data.screens.map((screen, order) => {
    const projection = projectPrototypeSourceScreens(parsed.data, [screen.id], "0".repeat(64));
    const semantics = Object.fromEntries(Object.entries(projection).filter(([key]) => !["source", "title", "revision"].includes(key)));
    return [screen.id, canonicalJson({ order, ...semantics })];
  }));
}
