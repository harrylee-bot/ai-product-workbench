// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  applyPrototypePatch,
  canonicalJson,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
  runEventSchema,
  type PrototypeDocument,
  type PrototypePatchBatch,
  type RunPrototypePatchCheckpoint,
} from "@workbench/workbench-contracts";
import { sha256 } from "hash-wasm";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useArtifactVersion: vi.fn(),
  useArtifactVersionAsset: vi.fn(),
  useArtifactVersionContent: vi.fn(),
  usePublicArtifactVersion: vi.fn(),
  usePublicArtifactVersionAsset: vi.fn(),
  usePublicArtifactVersionContent: vi.fn(),
}));

vi.mock("@xyflow/react", () => ({
  NodeResizer: () => null,
}));

vi.mock("../../lib/workbench/features", () => ({
  isWorkbenchNodeResizeVisible: () => false,
}));

vi.mock("../../lib/workbench/features/artifacts", () => ({
  useWorkbenchArtifactVersion: mocks.useArtifactVersion,
  useWorkbenchArtifactVersionAsset: mocks.useArtifactVersionAsset,
  useWorkbenchArtifactVersionContent: mocks.useArtifactVersionContent,
}));

vi.mock("../../lib/workbench/features/public-shares", () => ({
  useWorkbenchPublicSharedArtifactAsset: mocks.usePublicArtifactVersionAsset,
  useWorkbenchPublicSharedArtifactContent: mocks.usePublicArtifactVersionContent,
  useWorkbenchPublicSharedArtifactVersion: mocks.usePublicArtifactVersion,
}));

import {
  PrototypePatchProjectionProvider,
  PrototypePatchProjectorStore,
  usePrototypePatchProjection,
} from "../../lib/workbench/features/prototype-patches";
import { prototypeEditorDocumentFixture } from "../../lib/workbench/prototype-editor/test-fixtures";
import { artboardNodeTypes } from "./workbench-board-nodes";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: vi.fn(() => ({ cancel: vi.fn(), finished: Promise.resolve() })),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Workbench Prototype patch Board integration", () => {
  it("renders a live Run projection inside the real generated-screen Board node", async () => {
    const document = prototypeEditorDocumentFixture();
    const label = document.nodes.find((node) => node.id === "node-label");
    if (!label || label.kind !== "text") throw new Error("label fixture missing");
    label.text = "Live Board patch";
    mocks.useArtifactVersion.mockReturnValue(pendingQuery());
    mocks.useArtifactVersionAsset.mockReturnValue(disabledQuery());
    mocks.useArtifactVersionContent.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersion.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersionAsset.mockReturnValue(disabledQuery());
    mocks.usePublicArtifactVersionContent.mockReturnValue(disabledQuery());

    const GeneratedScreen = artboardNodeTypes.generatedScreen;
    const store = await projector(document);
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <PrototypePatchProjectionProvider projector={store}>
          <GeneratedScreen {...generatedScreenProps()} />
        </PrototypePatchProjectionProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Live Board patch")).not.toBeNull();
    expect(screen.queryByText("Loading artifact...")).toBeNull();
  });

  it("updates only the target screen consumer without rerendering its sibling or Board shell", async () => {
    const document = multiScreenDocumentFixture();
    const store = await projector(document);
    const renders = { details: 0, main: 0, shell: 0 };

    function ScreenProjection({ screenId }: { screenId: "screen-main" | "screen-details" }) {
      renders[screenId === "screen-main" ? "main" : "details"] += 1;
      const projection = usePrototypePatchProjection("version-prototype-draft", screenId);
      return <span>{`${screenId}:${projection?.revision ?? "none"}`}</span>;
    }

    function BoardShell() {
      renders.shell += 1;
      return (
        <div>
          <ScreenProjection screenId="screen-main" />
          <ScreenProjection screenId="screen-details" />
        </div>
      );
    }

    render(
      <PrototypePatchProjectionProvider projector={store}>
        <BoardShell />
      </PrototypePatchProjectionProvider>,
    );
    expect(renders).toEqual({ details: 1, main: 1, shell: 1 });

    await act(async () => {
      store.ingest(await patchEvent(document));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (store.getProjectionSnapshot("version-prototype-draft", "screen-main")?.revision === 2) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("Prototype patch did not apply");
    });

    expect(renders.main).toBeGreaterThan(1);
    expect(renders.details).toBe(1);
    expect(renders.shell).toBe(1);
  });
});

async function projector(document: PrototypeDocument): Promise<PrototypePatchProjectorStore> {
  const checkpoint = await checkpointFixture(document);
  const store = new PrototypePatchProjectorStore({
    transport: { getCheckpoint: vi.fn(async () => checkpoint) },
  });
  store.setScope({
    attempt: 1,
    projectId: "project-real",
    requestId: "request-1",
    runId: "run-1",
  });
  store.ingest(runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: "event-1",
    projectId: "project-real",
    threadId: "thread-1",
    runId: "run-1",
    requestId: "request-1",
    sequence: 1,
    occurredAt: "2026-07-18T00:00:00.000Z",
    traceId: "trace-1",
    type: "artifact.draft.created",
    payload: {
      attempt: 1,
      artifactIndex: 0,
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype-draft",
      kind: "prototype",
      checksum: checkpoint.documentChecksum,
      draftChecksum: "d".repeat(64),
      screens: checkpoint.screens.map((screen) => ({
        id: screen.screenId,
        name: document.screens.find((candidate) => candidate.id === screen.screenId)!.name,
        route: document.screens.find((candidate) => candidate.id === screen.screenId)!.route,
        viewport: document.screens.find((candidate) => candidate.id === screen.screenId)!.viewport,
        revision: screen.revision,
        checksum: screen.checksum,
      })),
    },
  }));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.getProjectionSnapshot("version-prototype-draft", "screen-main")?.phase === "live") {
      return store;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Prototype projection did not load");
}

async function checkpointFixture(
  document: PrototypeDocument,
): Promise<RunPrototypePatchCheckpoint> {
  const revision = 1;
  return {
    protocol: "workbench.prototype-patch-checkpoint.v1",
    projectId: "project-real",
    runId: "run-1",
    requestId: "request-1",
    attempt: 1,
    runtimeAttemptId: "runtime-attempt-1",
    artifactIndex: 0,
    artifactId: "artifact-prototype",
    artifactVersionId: "version-prototype-draft",
    status: "staging",
    document,
    documentChecksum: await sha256(canonicalJson(document)),
    screens: await Promise.all(document.screens.map(async (screen) => ({
      screenId: screen.id,
      revision,
      checksum: await computePrototypeScreenProjectionChecksum(
        projectPrototypeScreen(document, screen.id, revision),
        sha256,
      ),
    }))),
    lastSequence: 1,
  };
}

async function patchEvent(document: PrototypeDocument) {
  const label = document.nodes.find((node) => node.id === "node-label");
  if (!label || label.kind !== "text") throw new Error("label fixture missing");
  const batch: PrototypePatchBatch = {
    screenId: "screen-main",
    baseRevision: 1,
    nextRevision: 2,
    operations: [{
      kind: "replace_node",
      nodeId: label.id,
      node: { ...label, text: "Target screen patch" },
    }],
    resultingChecksum: "0".repeat(64),
  };
  batch.resultingChecksum = await computePrototypeScreenProjectionChecksum(
    applyPrototypePatch(document, batch).projection,
    sha256,
  );
  return runEventSchema.parse({
    protocol: "workbench.run.v1",
    id: "event-2",
    projectId: "project-real",
    threadId: "thread-1",
    runId: "run-1",
    requestId: "request-1",
    sequence: 2,
    occurredAt: "2026-07-18T00:00:01.000Z",
    traceId: "trace-1",
    type: "artifact.prototype.patch.created",
    payload: {
      attempt: 1,
      runtimeAttemptId: "runtime-attempt-1",
      artifactIndex: 0,
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype-draft",
      sourceEventId: "source-2",
      requestSha256: "e".repeat(64),
      ...batch,
    },
  });
}

function multiScreenDocumentFixture(): PrototypeDocument {
  const document = prototypeEditorDocumentFixture();
  const mainRoot = document.nodes.find((node) => node.id === "node-root");
  if (!mainRoot || mainRoot.kind !== "frame") throw new Error("root fixture missing");
  document.screens.push({
    id: "screen-details",
    name: "Details",
    route: "/details",
    rootNodeId: "node-root-details",
    initialStateId: null,
    viewport: { width: 390, height: 844 },
  });
  document.nodes.push({
    ...structuredClone(mainRoot),
    id: "node-root-details",
    screenId: "screen-details",
    name: "Details root",
    childIds: [],
  });
  return document;
}

function generatedScreenProps() {
  const _GeneratedScreen = artboardNodeTypes.generatedScreen;
  return {
    data: {
      artifact: {
        artifactId: "artifact-prototype",
        artifactVersionId: "version-prototype-draft",
        projectId: "project-real",
        screenId: "screen-main",
      },
      index: 0,
      phase: "refining" as const,
      title: "Main",
    },
    deletable: false,
    draggable: false,
    dragging: false,
    id: "run-draft:artifact-prototype:screen-main",
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    selectable: false,
    selected: false,
    type: "generatedScreen" as const,
    zIndex: 0,
  } satisfies ComponentProps<typeof _GeneratedScreen>;
}

function pendingQuery() {
  return { data: undefined, isError: false, isPending: true };
}

function disabledQuery() {
  return { data: undefined, isError: false, isPending: false };
}
