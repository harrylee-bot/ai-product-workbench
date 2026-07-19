import type {
  ArtifactVersionDetail,
  PrototypeDocument,
} from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";

import { prototypeEditorDocumentFixture } from "../prototype-editor/test-fixtures";
import {
  analyzePrototypeScreenRuntime,
  deriveScreenContextState,
  type ScreenContextEnvironment,
  type ScreenContextTarget,
} from "./screen-context";

describe("screen context domain", () => {
  it("returns an explicit empty selection state", () => {
    expect(deriveScreenContextState([], editorEnvironment())).toEqual({
      availability: {},
      kind: "none",
      targets: [],
    });
  });

  it("opens an existing Preview only when the selected screen owns an action", () => {
    const interactive = target({ document: interactiveDocument() });
    const state = deriveScreenContextState([interactive], editorEnvironment());

    expect(analyzePrototypeScreenRuntime(
      interactive.version,
      interactive.reference.screenId,
    )).toMatchObject({ actionCount: 1, kind: "runnable", reason: null });
    expect(state).toMatchObject({
      kind: "single",
      modifyDisposition: { kind: "direct-edit", reason: null },
      previewDisposition: { kind: "open-existing", reason: null },
      availability: {
        generate: { enabled: true, reason: null },
        modify: { enabled: true, reason: null },
        preview: { enabled: true, reason: null },
      },
    });
  });

  it("does not let an action on a sibling screen make the selected screen runnable", () => {
    const document = interactiveDocument();
    const action = document.actions[0]!;
    document.screens.push({
      id: "screen-static",
      name: "Static",
      route: "/static",
      rootNodeId: "node-static-root",
      initialStateId: null,
      viewport: { width: 768, height: 1024 },
    });
    const frame = document.nodes.find((node) => node.kind === "frame")!;
    document.nodes.push({
      ...frame,
      actionIds: [],
      childIds: [],
      id: "node-static-root",
      name: "Static root",
      screenId: "screen-static",
    });
    expect(action.nodeId).not.toBe("node-static-root");

    const selected = target({ document, screenId: "screen-static" });
    const analysis = analyzePrototypeScreenRuntime(selected.version, "screen-static");
    const state = deriveScreenContextState([selected], editorEnvironment());

    expect(analysis).toMatchObject({
      actionCount: 0,
      kind: "non-interactive",
      reason: "screen-has-no-actions",
    });
    expect(state).toMatchObject({
      kind: "single",
      previewDisposition: {
        kind: "generate-required",
        reason: "screen-has-no-actions",
      },
      availability: { preview: { enabled: true, reason: null } },
    });
  });

  it("falls back to an Agent edit only when the edit model and targets are valid", () => {
    const selected = target({ document: interactiveDocument() });
    const agent = deriveScreenContextState([selected], editorEnvironment({
      directEditAvailable: false,
    }));
    const noModel = deriveScreenContextState([selected], editorEnvironment({
      directEditAvailable: false,
      editModelAvailable: false,
    }));
    const invalidTargets = deriveScreenContextState([selected], editorEnvironment({
      directEditAvailable: false,
      editArtifactTargetsValid: false,
    }));

    expect(agent).toMatchObject({ modifyDisposition: { kind: "agent-edit", reason: null } });
    expect(noModel).toMatchObject({
      modifyDisposition: { kind: "blocked", reason: "edit-model-unavailable" },
      availability: { modify: { enabled: false, reason: "edit-model-unavailable" } },
    });
    expect(invalidTargets).toMatchObject({
      modifyDisposition: { kind: "blocked", reason: "edit-targets-invalid" },
    });
  });

  it("allows a viewer to preview a runnable immutable screen but blocks mutations", () => {
    const state = deriveScreenContextState(
      [target({ document: interactiveDocument() })],
      editorEnvironment({
        capabilities: {
          canEdit: false,
          canExport: false,
          canPreview: true,
          canRun: false,
        },
        directEditAvailable: false,
      }),
    );

    expect(state).toMatchObject({
      kind: "single",
      previewDisposition: { kind: "open-existing" },
      availability: {
        delete: { enabled: false, reason: "read-only" },
        duplicate: { enabled: false, reason: "read-only" },
        export: { enabled: false, reason: "export-unavailable" },
        favourite: { enabled: false, reason: "read-only" },
        preview: { enabled: true, reason: null },
        rename: { enabled: false, reason: "read-only" },
        versionHistory: { enabled: true, reason: null },
      },
    });
  });

  it("blocks writes during an active Run while retaining immutable read actions", () => {
    const state = deriveScreenContextState(
      [target({ document: interactiveDocument() })],
      editorEnvironment({ activeRun: true, directEditAvailable: false }),
    );

    expect(state).toMatchObject({
      kind: "single",
      modifyDisposition: { kind: "blocked", reason: "active-run" },
      previewDisposition: { kind: "open-existing" },
      availability: {
        delete: { enabled: false, reason: "active-run" },
        export: { enabled: true, reason: null },
        generate: { enabled: false, reason: "active-run" },
        preview: { enabled: true, reason: null },
        versionHistory: { enabled: true, reason: null },
      },
    });
  });

  it("separates Board-local actions from runtime readiness", () => {
    const document = interactiveDocument();
    const incomplete = deriveScreenContextState(
      [target({ document, phase: "refining" })],
      editorEnvironment(),
    );
    const unpersisted = deriveScreenContextState(
      [target({ document, persisted: false })],
      editorEnvironment(),
    );
    const staging = deriveScreenContextState(
      [target({ document, status: "staging" })],
      editorEnvironment(),
    );

    expect(incomplete).toMatchObject({
      availability: { generate: { enabled: false, reason: "target-not-complete" } },
      previewDisposition: { kind: "blocked", reason: "target-not-complete" },
    });
    expect(unpersisted).toMatchObject({
      availability: { modify: { enabled: false, reason: "target-not-persisted" } },
    });
    expect(staging).toMatchObject({
      availability: {
        delete: { enabled: true, reason: null },
        duplicate: { enabled: true, reason: null },
        export: { enabled: true, reason: null },
        generate: { enabled: false, reason: "artifact-not-ready" },
        rename: { enabled: true, reason: null },
        versionHistory: { enabled: true, reason: null },
      },
      previewDisposition: { kind: "blocked", reason: "artifact-not-ready" },
    });
  });

  it("keeps local commands usable while Artifact content is still hydrating", () => {
    const state = deriveScreenContextState(
      [{ ...target(), version: null }],
      editorEnvironment({ directEditAvailable: false }),
    );

    expect(state).toMatchObject({
      kind: "single",
      availability: {
        delete: { enabled: true, reason: null },
        duplicate: { enabled: true, reason: null },
        export: { enabled: true, reason: null },
        generate: { enabled: false, reason: "artifact-unavailable" },
        modify: { enabled: false, reason: "artifact-unavailable" },
        rename: { enabled: true, reason: null },
        versionHistory: { enabled: true, reason: null },
      },
      previewDisposition: { kind: "blocked", reason: "artifact-unavailable" },
    });
  });

  it("requires three screens for distribute and unique complete valid targets for variants", () => {
    const first = target({ id: "node-1", screenId: "screen-main" });
    const second = target({ id: "node-2", screenId: "screen-main" });
    const two = deriveScreenContextState([first, second], editorEnvironment());
    expect(two).toMatchObject({
      kind: "multiple",
      availability: {
        align: { enabled: true, reason: null },
        distribute: { enabled: false, reason: "insufficient-selection" },
        generateVariants: { enabled: false, reason: "duplicate-screen-targets" },
        preview: { enabled: false, reason: "duplicate-screen-targets" },
      },
      previewDisposition: { kind: "blocked", reason: "duplicate-screen-targets" },
    });

    const third = target({
      artifactId: "artifact-3",
      artifactVersionId: "version-3",
      id: "node-3",
      screenId: "screen-main",
    });
    const distinctSecond = target({
      artifactId: "artifact-2",
      artifactVersionId: "version-2",
      id: "node-2",
      screenId: "screen-main",
    });
    const three = deriveScreenContextState(
      [first, distinctSecond, third],
      editorEnvironment(),
    );
    expect(three).toMatchObject({
      availability: {
        distribute: { enabled: true, reason: null },
        generateVariants: { enabled: true, reason: null },
        preview: { enabled: true, reason: null },
      },
      previewDisposition: {
        kind: "open-existing",
        references: [first.reference, distinctSecond.reference, third.reference],
      },
    });

    const invalidEditTargets = deriveScreenContextState(
      [first, distinctSecond, third],
      editorEnvironment({ editArtifactTargetsValid: false }),
    );
    expect(invalidEditTargets).toMatchObject({
      availability: {
        generateVariants: { enabled: false, reason: "edit-targets-invalid" },
      },
    });

    const staticFirst = target({
      document: prototypeEditorDocumentFixture(),
      id: "static-node-1",
    });
    const staticSecond = target({
      artifactId: "static-artifact-2",
      artifactVersionId: "static-version-2",
      document: prototypeEditorDocumentFixture(),
      id: "static-node-2",
    });
    const invalidGenerateTargets = deriveScreenContextState(
      [staticFirst, staticSecond],
      editorEnvironment({ generatePrototypeTargetsValid: false }),
    );
    expect(invalidGenerateTargets).toMatchObject({
      availability: {
        preview: { enabled: false, reason: "generate-targets-invalid" },
      },
      previewDisposition: { kind: "blocked", reason: "generate-targets-invalid" },
    });
  });

  it("does not require Artifact payloads for multi-selection Board placement commands", () => {
    const first = { ...target({ id: "node-1" }), version: null };
    const second = { ...target({ id: "node-2", screenId: "screen-other" }), version: null };
    const state = deriveScreenContextState([first, second], editorEnvironment());

    expect(state).toMatchObject({
      kind: "multiple",
      availability: {
        align: { enabled: true, reason: null },
        delete: { enabled: true, reason: null },
        duplicate: { enabled: true, reason: null },
        export: { enabled: true, reason: null },
        generateVariants: { enabled: false, reason: "artifact-unavailable" },
        preview: { enabled: false, reason: "artifact-unavailable" },
      },
      previewDisposition: { kind: "blocked", reason: "artifact-unavailable" },
    });
  });
});

function editorEnvironment(
  overrides: Partial<ScreenContextEnvironment> = {},
): ScreenContextEnvironment {
  return {
    activeRun: false,
    capabilities: {
      canEdit: true,
      canExport: true,
      canPreview: true,
      canRun: true,
    },
    directEditAvailable: true,
    editArtifactTargetsValid: true,
    editModelAvailable: true,
    generatePrototypeTargetsValid: true,
    ...overrides,
  };
}

function target({
  artifactId = "artifact-1",
  artifactVersionId = "version-1",
  document = interactiveDocument(),
  id = "node-1",
  persisted = true,
  phase = "complete",
  screenId = "screen-main",
  status = "ready",
}: {
  artifactId?: string;
  artifactVersionId?: string;
  document?: PrototypeDocument;
  id?: string;
  persisted?: boolean;
  phase?: ScreenContextTarget["phase"];
  screenId?: string;
  status?: ArtifactVersionDetail["status"];
} = {}): ScreenContextTarget {
  const screen = document.screens.find((candidate) => candidate.id === screenId)
    ?? document.screens[0]!;
  return {
    id,
    persisted,
    phase,
    reference: {
      artifactId,
      artifactVersionId,
      projectId: "project-1",
      screenId,
    },
    size: { ...screen.viewport },
    title: screen.name,
    version: {
      artifactId,
      artifactVersionId,
      version: 1,
      status,
      checksum: "a".repeat(64),
      citations: [],
      createdByRunId: null,
      knowledgeReleaseId: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      contentMode: "inline",
      kind: "prototype",
      schemaVersion: 1,
      content: document,
    },
  };
}

function interactiveDocument(): PrototypeDocument {
  const document = structuredClone(prototypeEditorDocumentFixture());
  const root = document.nodes.find((node) => node.id === "node-root")!;
  root.actionIds = ["action-open"];
  document.actions = [{
    id: "action-open",
    nodeId: root.id,
    event: "click",
    kind: "openUrl",
    target: "newWindow",
    url: "https://example.com/preview",
  }];
  return document;
}
