import {
  orderFlowNodesByHierarchy,
  type BoardFlowEdge,
  type BoardFlowNode,
} from "./adapter";

const DUPLICATE_OFFSET = 32;
const MAX_BOARD_NODE_ID_LENGTH = 128;
const MAX_BOARD_NODE_TITLE_LENGTH = 160;

export type BoardNodeActionAvailability = {
  canCopyLink: boolean;
  canDelete: boolean;
  canDuplicate: boolean;
  canRename: boolean;
};

export type DuplicateBoardNodesResult = {
  changed: boolean;
  createdNodeIds: string[];
  edges: BoardFlowEdge[];
  nodes: BoardFlowNode[];
};

export type RemoveBoardNodesResult = {
  changed: boolean;
  edges: BoardFlowEdge[];
  nodes: BoardFlowNode[];
  removedNodeIds: string[];
};

export function boardNodeActionAvailability(
  canEdit: boolean,
  selectedNodeCount: number,
): BoardNodeActionAvailability {
  const hasSelection = Number.isSafeInteger(selectedNodeCount) && selectedNodeCount > 0;
  const hasSingleSelection = selectedNodeCount === 1;
  return {
    canCopyLink: hasSingleSelection,
    canDelete: canEdit && hasSelection,
    canDuplicate: canEdit && hasSelection,
    canRename: canEdit && hasSingleSelection,
  };
}

export function duplicateBoardNodes(
  nodes: readonly BoardFlowNode[],
  edges: readonly BoardFlowEdge[],
  nodeIds: readonly string[],
): DuplicateBoardNodesResult {
  const requested = new Set(nodeIds);
  const requestedSources = nodes.filter((node) => requested.has(node.id));
  if (requestedSources.length === 0) {
    return { changed: false, createdNodeIds: [], nodes: [...nodes], edges: [...edges] };
  }

  const sourceIds = new Set(requestedSources.map((node) => node.id));
  let addedDescendant = true;
  while (addedDescendant) {
    addedDescendant = false;
    for (const node of nodes) {
      if (node.parentId && sourceIds.has(node.parentId) && !sourceIds.has(node.id)) {
        sourceIds.add(node.id);
        addedDescendant = true;
      }
    }
  }
  const sources = nodes.filter((node) => sourceIds.has(node.id));

  const nodeIdsInUse = new Set(nodes.map((node) => node.id));
  const edgeIdsInUse = new Set(edges.map((edge) => edge.id));
  const duplicateIdBySource = new Map<string, string>();
  for (const source of sources) {
    const id = nextCopyId(source.id, nodeIdsInUse);
    nodeIdsInUse.add(id);
    duplicateIdBySource.set(source.id, id);
  }
  const nextOrderByParent = nextSiblingOrders(nodes);
  const duplicates = sources.map((source) => {
    const id = duplicateIdBySource.get(source.id)!;
    const duplicate = structuredClone(source);
    duplicate.id = id;
    const duplicatedParentId = source.parentId ? duplicateIdBySource.get(source.parentId) : undefined;
    if (duplicatedParentId) duplicate.parentId = duplicatedParentId;
    if (!duplicatedParentId) {
      const parentId = source.parentId ?? null;
      const order = nextOrderByParent.get(parentId) ?? 0;
      duplicate.workbench.order = order;
      nextOrderByParent.set(parentId, order + 1);
    }
    duplicate.position = duplicatedParentId
      ? { ...source.position }
      : {
          x: source.position.x + DUPLICATE_OFFSET,
          y: source.position.y + DUPLICATE_OFFSET,
        };
    delete duplicate.selected;
    delete duplicate.dragging;
    return duplicate;
  });
  const duplicatedEdges = edges.flatMap((edge) => {
    const source = duplicateIdBySource.get(edge.source);
    const target = duplicateIdBySource.get(edge.target);
    if (!source || !target) return [];
    const duplicate = structuredClone(edge);
    duplicate.id = nextCopyId(edge.id, edgeIdsInUse);
    edgeIdsInUse.add(duplicate.id);
    duplicate.source = source;
    duplicate.target = target;
    duplicate.selected = false;
    return [duplicate];
  });

  return {
    changed: true,
    createdNodeIds: requestedSources.map((node) => duplicateIdBySource.get(node.id)!),
    nodes: orderFlowNodesByHierarchy([...nodes, ...duplicates]),
    edges: [...edges, ...duplicatedEdges],
  };
}

export function renameBoardNode(
  nodes: readonly BoardFlowNode[],
  nodeId: string,
  title: string,
): { changed: boolean; nodes: BoardFlowNode[] } {
  const normalized = normalizeBoardNodeTitle(title);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.data.title === normalized) return { changed: false, nodes: [...nodes] };
  return {
    changed: true,
    nodes: nodes.map((candidate) => candidate.id === nodeId
      ? { ...candidate, data: { ...candidate.data, title: normalized } }
      : candidate),
  };
}

export function removeBoardNodes(
  nodes: readonly BoardFlowNode[],
  edges: readonly BoardFlowEdge[],
  nodeIds: readonly string[],
): RemoveBoardNodesResult {
  const existing = new Set(nodes.filter((node) => nodeIds.includes(node.id)).map((node) => node.id));
  if (existing.size === 0) {
    return { changed: false, removedNodeIds: [], nodes: [...nodes], edges: [...edges] };
  }
  let addedDescendant = true;
  while (addedDescendant) {
    addedDescendant = false;
    for (const node of nodes) {
      if (node.parentId && existing.has(node.parentId) && !existing.has(node.id)) {
        existing.add(node.id);
        addedDescendant = true;
      }
    }
  }
  return {
    changed: true,
    removedNodeIds: nodes.filter((node) => existing.has(node.id)).map((node) => node.id),
    nodes: nodes.filter((node) => !existing.has(node.id)),
    edges: edges.filter((edge) => !existing.has(edge.source) && !existing.has(edge.target)),
  };
}

function normalizeBoardNodeTitle(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Board node title is required");
  if (normalized.length > MAX_BOARD_NODE_TITLE_LENGTH) {
    throw new Error(`Board node title exceeds ${MAX_BOARD_NODE_TITLE_LENGTH} characters`);
  }
  return normalized;
}

function nextCopyId(sourceId: string, idsInUse: ReadonlySet<string>): string {
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const suffix = index === 1 ? "-copy" : `-copy-${index}`;
    const base = sourceId.slice(0, MAX_BOARD_NODE_ID_LENGTH - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!idsInUse.has(candidate)) return candidate;
  }
  throw new Error(`Unable to allocate a copy id for ${sourceId}`);
}

function nextSiblingOrders(nodes: readonly BoardFlowNode[]): Map<string | null, number> {
  const next = new Map<string | null, number>();
  for (const node of nodes) {
    const parentId = node.parentId ?? null;
    next.set(parentId, Math.max(next.get(parentId) ?? 0, node.workbench.order + 1));
  }
  return next;
}
