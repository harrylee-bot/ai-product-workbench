import type { Board } from "@workbench/workbench-contracts";

import type { Versioned } from "../transport/contracts";
import type { BoardStore } from "./board";
import { flushWorkbenchBoard } from "./workbench-publication-controller";

export type ArtifactVersionPinBoardController = {
  store: BoardStore | null;
  save: () => Promise<Versioned<Board> | null>;
};

export async function pinWorkbenchArtifactVersion(
  controller: ArtifactVersionPinBoardController,
  artifactId: string,
  pinnedArtifactVersionId: string,
  targetArtifactVersionId: string,
): Promise<string[]> {
  const store = controller.store;
  if (!store) throw new Error("The Project Board is not ready");
  if (pinnedArtifactVersionId === targetArtifactVersionId) return [];

  let updatedNodeIds = store.getState().replaceArtifactVersionPins(
    artifactId,
    pinnedArtifactVersionId,
    targetArtifactVersionId,
  );
  if (updatedNodeIds.length === 0) {
    updatedNodeIds = store.getState().nodes.flatMap((node) => (
      node.workbench.artifactId === artifactId
      && node.workbench.artifactVersionId === targetArtifactVersionId
        ? [node.id]
        : []
    ));
    if (updatedNodeIds.length === 0) {
      throw new Error("The selected ArtifactVersion is no longer pinned on the active Board");
    }
  }

  await flushWorkbenchBoard(controller);
  return updatedNodeIds;
}
