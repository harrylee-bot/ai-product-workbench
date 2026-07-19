import type { Board } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { createBoardStore } from "./board";
import { pinWorkbenchArtifactVersion } from "./artifact-version-pin";

describe("ArtifactVersion Board pin command", () => {
  it("replaces immutable pins and persists them through the existing Board CAS save", async () => {
    const initial = board();
    const store = createBoardStore(initial, '"4"');
    const save = vi.fn(async () => {
      const snapshot = store.getState().prepareSave();
      expect(snapshot?.ifMatch).toBe('"4"');
      expect(snapshot?.request.nodes[0]?.artifactVersionId).toBe("version-2");
      const saved = {
        ...initial,
        revision: 5,
        nodes: snapshot!.request.nodes,
        edges: snapshot!.request.edges,
        viewport: snapshot!.request.viewport,
      };
      store.getState().completeSave(snapshot!, saved, '"5"');
      return { value: saved, etag: '"5"' };
    });

    await expect(pinWorkbenchArtifactVersion(
      { store, save },
      "artifact-1",
      "version-1",
      "version-2",
    )).resolves.toEqual(["node-artifact"]);

    expect(save).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      serverRevision: 5,
    });
    expect(store.getState().nodes[0]?.workbench.artifactVersionId).toBe("version-2");
  });

  it("retries the same pin command after its first Board save fails", async () => {
    const initial = board();
    const store = createBoardStore(initial, '"4"');
    let firstSnapshot: ReturnType<typeof store.getState>["retrySaveSnapshot"] = null;
    const save = vi.fn(async () => {
      const snapshot = store.getState().prepareSave();
      expect(snapshot).not.toBeNull();
      expect(snapshot?.request.nodes[0]?.artifactVersionId).toBe("version-2");

      if (save.mock.calls.length === 1) {
        firstSnapshot = snapshot;
        const error = new Error("temporary Board save failure");
        store.getState().failSave(snapshot!, error);
        throw error;
      }

      expect(snapshot).toBe(firstSnapshot);
      const saved = {
        ...initial,
        revision: 5,
        nodes: snapshot!.request.nodes,
        edges: snapshot!.request.edges,
        viewport: snapshot!.request.viewport,
      };
      store.getState().completeSave(snapshot!, saved, '"5"');
      return { value: saved, etag: '"5"' };
    });
    const command = () => pinWorkbenchArtifactVersion(
      { store, save },
      "artifact-1",
      "version-1",
      "version-2",
    );

    await expect(command()).rejects.toThrow("temporary Board save failure");
    expect(store.getState()).toMatchObject({
      dirty: true,
      saveStatus: "error",
      serverRevision: 4,
    });
    expect(store.getState().nodes[0]?.workbench.artifactVersionId).toBe("version-2");

    await expect(command()).resolves.toEqual(["node-artifact"]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      dirty: false,
      saveStatus: "clean",
      serverRevision: 5,
    });
    expect(store.getState().nodes[0]?.workbench.artifactVersionId).toBe("version-2");
  });
});

function board(): Board {
  return {
    id: "board-1",
    projectId: "project-1",
    revision: 4,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node-artifact",
      kind: "artifact",
      parentNodeId: null,
      order: 0,
      position: { x: 10, y: 20 },
      size: null,
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      data: {
        protocol: "workbench.board-node.v1",
        nodeType: "artifact",
        title: "Document",
        artifactKind: "document",
      },
    }],
    edges: [],
  };
}
