export type WorkbenchCanvasPermissions = {
  canDragNodes: boolean;
  canResizeNodes: boolean;
  canSelectNodes: true;
  canWriteBoard: boolean;
};

export function workbenchCanvasPermissions(
  canEdit: boolean,
  activeRun = false,
): WorkbenchCanvasPermissions {
  const canWriteBoard = canEdit && !activeRun;
  return {
    canDragNodes: canWriteBoard,
    canResizeNodes: canWriteBoard,
    canSelectNodes: true,
    canWriteBoard,
  };
}

export function isWorkbenchNodeResizeVisible(
  canResizeNodes: boolean,
  selected: boolean,
  ready = true,
): boolean {
  return canResizeNodes && selected && ready;
}

export function visibleWorkbenchNodeChanges<TChange extends { type: string }>(
  canWriteBoard: boolean,
  changes: readonly TChange[],
): TChange[] {
  if (canWriteBoard) return [...changes];
  return changes.filter((change) => change.type === "select" || change.type === "dimensions");
}
