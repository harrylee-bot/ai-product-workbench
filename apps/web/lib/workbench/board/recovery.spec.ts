import { describe, expect, it } from "vitest";

import {
  boardRecoveryProtocol,
  createBoardRecoveryDocument,
  serializeBoardRecoveryDocument,
} from "./recovery";
import { createBoardStore } from "./store";

describe("Board conflict recovery document", () => {
  it("exports the complete local Board request without React Flow UI state", () => {
    const store = createBoardStore({
      id: "board-1",
      projectId: "project-1",
      revision: 7,
      viewport: { x: 10, y: 20, zoom: 0.75 },
      nodes: [],
      edges: [],
    });
    store.getState().setViewport({ x: 30, y: 40, zoom: 0.5 });

    const document = createBoardRecoveryDocument(
      store.getState(),
      "2026-07-15T00:00:00.000Z",
    );

    expect(document).toEqual({
      protocol: boardRecoveryProtocol,
      exportedAt: "2026-07-15T00:00:00.000Z",
      projectId: "project-1",
      boardId: "board-1",
      baseRevision: 7,
      board: { viewport: { x: 30, y: 40, zoom: 0.5 }, nodes: [], edges: [] },
    });
    expect(JSON.parse(serializeBoardRecoveryDocument(document))).toEqual(document);
  });
});
