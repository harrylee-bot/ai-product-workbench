import {
  declareCanvasAgentTools,
  type CanvasAgentCapability,
  type CanvasAgentToolProfile,
  type CanvasSnapshot,
} from "@workbench/workbench-contracts";

export type RequestScopedCanvasAgentToolsInput = {
  activeMutation: boolean;
  capabilities: readonly CanvasAgentCapability[];
  editModelAvailable: boolean;
  now?: number;
  selectedScreenEditable: boolean;
  snapshot: CanvasSnapshot | null;
};

export function requestScopedCanvasAgentTools(
  input: RequestScopedCanvasAgentToolsInput,
): CanvasAgentToolProfile[] {
  const now = input.now ?? Date.now();
  const snapshotIsFresh = input.snapshot !== null
    && Number.isFinite(now)
    && Date.parse(input.snapshot.capturedAt) <= now
    && Date.parse(input.snapshot.expiresAt) > now;
  const screenCount = snapshotIsFresh ? input.snapshot!.screens.length : 0;
  const selectedScreenCount = snapshotIsFresh ? input.snapshot!.selectedScreens.length : 0;

  return declareCanvasAgentTools({
    capabilities: [...input.capabilities],
    hasFreshSnapshot: snapshotIsFresh,
    screenCount,
    selectedScreenCount,
    selectedScreenEditable: selectedScreenCount === 1 && input.selectedScreenEditable,
    activeMutation: input.activeMutation,
    editModelAvailable: input.editModelAvailable,
  });
}
