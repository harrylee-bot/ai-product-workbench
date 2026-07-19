import type { ReplaceBoardRequest } from "@workbench/workbench-contracts";

import { flowToBoardRequest } from "./adapter";
import type { BoardStoreState } from "./store";

export const boardRecoveryProtocol = "workbench.board-recovery.v1" as const;

export type BoardRecoveryDocument = {
  protocol: typeof boardRecoveryProtocol;
  exportedAt: string;
  projectId: string;
  boardId: string;
  baseRevision: number;
  board: ReplaceBoardRequest;
};

export function createBoardRecoveryDocument(
  state: Pick<
    BoardStoreState,
    "boardId" | "projectId" | "serverRevision" | "viewport" | "nodes" | "edges"
  >,
  exportedAt = new Date().toISOString(),
): BoardRecoveryDocument {
  return {
    protocol: boardRecoveryProtocol,
    exportedAt,
    projectId: state.projectId,
    boardId: state.boardId,
    baseRevision: state.serverRevision,
    board: flowToBoardRequest(state.viewport, state.nodes, state.edges),
  };
}

export function serializeBoardRecoveryDocument(document: BoardRecoveryDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
