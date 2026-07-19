import type { ArtifactVersionDetail, PrototypeDocument } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import {
  canvasDirectEditAvailability,
  canvasInteractionAvailability,
  canvasMainCommands,
  canvasMoreCommands,
  canvasPanelAccess,
  createCanvasToolsState,
  normalizeCanvasToolsState,
  reduceCanvasToolsState,
  transitionCanvasTools,
  type CanvasToolEnvironment,
  type CanvasSelectionTarget,
} from ".";

describe("canvas tools domain", () => {
  it("exposes the canonical primary rail and More tools order", () => {
    expect(canvasMainCommands).toEqual([
      "select",
      "marquee",
      "direct-edit",
      "pan",
      "media",
      "design-system",
      "favourites",
    ]);
    expect(canvasMoreCommands).toEqual(["frame-create", "freehand"]);
  });

  it("keeps interaction modes and panels orthogonal while switching commands", () => {
    const environment = editorEnvironment();
    const initial = createCanvasToolsState("project-1");

    const opened = transitionCanvasTools(initial, { type: "main-command", command: "media" }, environment);
    expect(opened.state).toEqual({
      interactionMode: "select",
      panel: "media",
      projectId: "project-1",
    });

    const panned = transitionCanvasTools(opened.state, { type: "main-command", command: "pan" }, environment);
    expect(panned.state).toEqual({
      interactionMode: "pan",
      panel: null,
      projectId: "project-1",
    });
    expect(panned.selectionEffect).toBe("preserve");

    const drawn = transitionCanvasTools(panned.state, { type: "more-command", command: "freehand" }, environment);
    expect(drawn.state.interactionMode).toBe("freehand");
    expect(drawn.state.panel).toBeNull();
    expect(drawn.selectionEffect).toBe("preserve");
  });

  it("toggles a panel without changing the current interaction mode", () => {
    const environment = editorEnvironment();
    const pan = {
      ...createCanvasToolsState("project-1"),
      interactionMode: "pan" as const,
    };

    const opened = transitionCanvasTools(pan, { type: "main-command", command: "favourites" }, environment);
    expect(opened.state).toMatchObject({ interactionMode: "pan", panel: "favourites" });
    const closed = transitionCanvasTools(opened.state, { type: "main-command", command: "favourites" }, environment);
    expect(closed.state).toMatchObject({ interactionMode: "pan", panel: null });
  });

  it("supports reducer-shaped command and environment events", () => {
    const environment = editorEnvironment();
    const initial = createCanvasToolsState("project-1");
    const withPanel = reduceCanvasToolsState(initial, {
      type: "main-command",
      command: "favourites",
      environment,
    });
    expect(withPanel).toMatchObject({ panel: "favourites", interactionMode: "select" });
    expect(reduceCanvasToolsState(withPanel, {
      type: "environment-changed",
      environment: { ...environment, projectId: "project-2" },
    })).toEqual({ interactionMode: "select", panel: null, projectId: "project-2" });
  });

  it.each([
    ["active run", { activeRun: true }],
    ["viewer", { canEdit: false }],
  ] as const)("normalizes an illegal mode to Select on %s", (_label, overrides) => {
    const environment = { ...editorEnvironment(), ...overrides };
    const state = { ...createCanvasToolsState("project-1"), interactionMode: "frame-create" as const };
    expect(normalizeCanvasToolsState(state, environment).interactionMode).toBe("select");
  });

  it("resets presentation when the project changes, including an open panel", () => {
    const state = {
      interactionMode: "freehand" as const,
      panel: "design-system" as const,
      projectId: "project-1",
    };
    const next = normalizeCanvasToolsState(state, { ...editorEnvironment(), projectId: "project-2" });
    expect(next).toEqual({ interactionMode: "select", panel: null, projectId: "project-2" });
  });

  it("requires exactly one persisted, complete, ready inline Prototype screen for Direct edit", () => {
    const valid = directEditTarget();
    const environment = { ...editorEnvironment(), selection: [valid] };
    expect(canvasDirectEditAvailability(environment)).toEqual({ enabled: true, reason: null });
    expect(canvasInteractionAvailability("direct-edit", environment)).toEqual({ enabled: true, reason: null });

    expect(canvasDirectEditAvailability({ ...environment, selection: [valid, valid] }).reason)
      .toBe("selection-count");
    expect(canvasDirectEditAvailability({ ...environment, selection: [{ ...valid, persisted: false }] }).reason)
      .toBe("target-not-persisted");
    expect(canvasDirectEditAvailability({ ...environment, selection: [{ ...valid, phase: "refining" }] }).reason)
      .toBe("target-not-complete");
    expect(canvasDirectEditAvailability({ ...environment, selection: [{ ...valid, artifactVersion: null }] }).reason)
      .toBe("artifact-unavailable");
    expect(canvasDirectEditAvailability({
      ...environment,
      selection: [{ ...valid, artifactVersion: { ...valid.artifactVersion!, status: "staging" } }],
    }).reason).toBe("artifact-not-ready");
    expect(canvasDirectEditAvailability({
      ...environment,
      selection: [{
        ...valid,
        artifactVersion: { ...valid.artifactVersion!, contentMode: "blob" } as ArtifactVersionDetail,
      }],
    }).reason).toBe("artifact-not-inline-prototype");
    expect(canvasDirectEditAvailability({
      ...environment,
      selection: [{ ...valid, screenId: "screen-missing" }],
    }).reason).toBe("screen-unavailable");
  });

  it("blocks write-oriented modes and Media for viewers, while keeping view panels available", () => {
    const viewer = { ...editorEnvironment(), canEdit: false };
    expect(canvasInteractionAvailability("select", viewer)).toEqual({ enabled: true, reason: null });
    expect(canvasInteractionAvailability("pan", viewer)).toEqual({ enabled: true, reason: null });
    expect(canvasInteractionAvailability("marquee", viewer)).toEqual({ enabled: false, reason: "read-only" });
    expect(canvasInteractionAvailability("frame-create", viewer)).toEqual({ enabled: false, reason: "read-only" });
    expect(canvasInteractionAvailability("freehand", viewer)).toEqual({ enabled: false, reason: "read-only" });
    expect(canvasInteractionAvailability("direct-edit", viewer).enabled).toBe(false);
    expect(canvasPanelAccess("media", viewer)).toEqual({ enabled: false, mode: "disabled", reason: "read-only" });
    expect(canvasPanelAccess("design-system", viewer)).toEqual({ enabled: true, mode: "read-only", reason: null });
    expect(canvasPanelAccess("favourites", viewer)).toEqual({ enabled: true, mode: "read-only", reason: null });
  });

  it("keeps browse panels visible but read-only during an active Run", () => {
    const activeRun = { ...editorEnvironment(), activeRun: true };

    expect(canvasPanelAccess("media", activeRun))
      .toEqual({ enabled: false, mode: "disabled", reason: "active-run" });
    expect(canvasPanelAccess("design-system", activeRun))
      .toEqual({ enabled: true, mode: "read-only", reason: null });
    expect(canvasPanelAccess("favourites", activeRun))
      .toEqual({ enabled: true, mode: "read-only", reason: null });
  });

  it("normalizes Direct edit after its target is deleted and rejects blocked commands", () => {
    const environment = { ...editorEnvironment(), selection: [directEditTarget()] };
    const direct = transitionCanvasTools(
      createCanvasToolsState("project-1"),
      { type: "main-command", command: "direct-edit" },
      environment,
    );
    expect(direct.state.interactionMode).toBe("direct-edit");

    const deleted = { ...environment, selection: [] };
    expect(normalizeCanvasToolsState(direct.state, deleted).interactionMode).toBe("select");
    const blocked = transitionCanvasTools(
      createCanvasToolsState("project-1"),
      { type: "more-command", command: "frame-create" },
      { ...editorEnvironment(), canEdit: false },
    );
    expect(blocked.state.interactionMode).toBe("select");
    expect(blocked.blockedReason).toBe("read-only");
  });
});

function editorEnvironment(overrides: Partial<CanvasToolEnvironment> = {}): CanvasToolEnvironment {
  return {
    activeRun: false,
    canEdit: true,
    projectId: "project-1",
    selection: [],
    ...overrides,
  };
}

function directEditTarget(): CanvasSelectionTarget {
  const document: PrototypeDocument = {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-doc",
    title: "Prototype",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "node-root",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
  const artifactVersion: ArtifactVersionDetail = {
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    version: 1,
    status: "ready",
    checksum: "a".repeat(64),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    contentMode: "inline",
    kind: "prototype",
    schemaVersion: 1,
    content: document,
  };
  return {
    nodeId: "node-screen",
    persisted: true,
    phase: "complete",
    screenId: "screen-home",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactVersion,
  };
}
