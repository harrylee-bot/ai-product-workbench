import type { CanvasSnapshot } from "@workbench/workbench-contracts";
import {
  canonicalCanvasSnapshotSha256,
  PrismaCanvasToolGrantIssuer,
  type CanvasToolGrantScope,
} from "../src/runtime/canvas-tool-grant.service.js";

const firstReference = {
  boardNodeId: "screen-node-home",
  artifactId: "artifact-home",
  artifactVersionId: "version-home",
  screenId: "screen-home",
};
const secondReference = {
  boardNodeId: "screen-node-settings",
  artifactId: "artifact-settings",
  artifactVersionId: "version-settings",
  screenId: "screen-settings",
};

function snapshot(): CanvasSnapshot {
  const now = Date.now();
  return {
    protocol: "workbench.canvas-snapshot.v1",
    projectId: "project-1",
    threadId: "thread-1",
    runId: null,
    boardId: "board-1",
    clientSessionId: "canvas-client-1",
    projectSessionGeneration: 1,
    boardRevision: 7,
    canvasStateRevision: 3,
    capturedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    viewport: { x: 10, y: 20, zoom: 1.25 },
    screens: [
      {
        reference: firstReference,
        name: "Home",
        route: "/",
        phase: "complete",
        viewport: { width: 390, height: 844 },
      },
      {
        reference: secondReference,
        name: "Settings",
        route: "/settings",
        phase: "complete",
        viewport: { width: 390, height: 844 },
      },
    ],
    visibleScreens: [firstReference],
    selectedScreens: [firstReference],
  };
}

function scope(canvasSnapshot = snapshot()): CanvasToolGrantScope {
  return {
    runId: "run-1",
    runtimeAttemptId: "runtime-attempt-1",
    attempt: 1,
    principalId: "principal-1",
    projectId: "project-1",
    threadId: "thread-1",
    modelId: "quality",
    workflow: "generate",
    artifactTargets: [],
    snapshot: canvasSnapshot,
  };
}

function grantHarness() {
  let currentScope = scope();
  let storedSession: Record<string, any> | null = null;
  let storedGrant: Record<string, any> | null = null;
  const sessionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    storedSession = {
      invocationSequence: 0,
      activeMutationToolCallId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    return storedSession;
  });
  const grantCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    storedGrant = { revokedAt: null, createdAt: new Date(), ...data };
    return storedGrant;
  });
  const tx = {
    $queryRaw: vi.fn(async () => [{ status: "running" }]),
    run: {
      findUnique: vi.fn(async () => ({
        id: currentScope.runId,
        projectId: currentScope.projectId,
        threadId: currentScope.threadId,
        createdById: currentScope.principalId,
        status: "running",
      })),
    },
    board: {
      findUnique: vi.fn(async () => ({
        id: currentScope.snapshot!.boardId,
        projectId: currentScope.projectId,
        revision: currentScope.snapshot!.boardRevision,
        nodes: [firstReference, secondReference].map((reference, index) => ({
          id: `row-${index + 1}`,
          nodeKey: reference.boardNodeId,
          artifactId: reference.artifactId,
          artifactVersionId: reference.artifactVersionId,
          kind: "artifact",
          data: { nodeType: "artifact", screenId: reference.screenId },
        })),
      })),
    },
    runtimeAttempt: {
      findUnique: vi.fn(async () => ({
        id: currentScope.runtimeAttemptId,
        runId: currentScope.runId,
        attempt: currentScope.attempt,
        status: "running",
      })),
    },
    artifactVersion: {
      findMany: vi.fn(async () => [firstReference, secondReference].map((reference) => ({
        id: reference.artifactVersionId,
        artifactId: reference.artifactId,
        status: "ready",
        content: {},
        contentBlobId: null,
        artifact: { kind: "image" },
      }))),
    },
    canvasAgentSession: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => (
        storedSession ? { ...storedSession, grant: storedGrant } : null
      )),
      create: sessionCreate,
    },
    canvasToolGrant: { create: grantCreate },
  };
  const db = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  const issuer = new PrismaCanvasToolGrantIssuer(db as never, {
    endpoint: "https://workbench.example.com/runtime/canvas/tools/execute",
    secret: Buffer.alloc(32, 7),
    maximumTtlSeconds: 300,
  });
  return {
    grantCreate,
    get grant() {
      if (!storedGrant) throw new Error("TEST_GRANT_MISSING");
      return storedGrant;
    },
    async issue(input: CanvasToolGrantScope) {
      currentScope = input;
      return issuer.issue(input);
    },
    sessionCreate,
    get session() {
      if (!storedSession) throw new Error("TEST_SESSION_MISSING");
      return storedSession;
    },
  };
}

function reorderedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reorderedObject(entry)]),
  );
}

const snapshotMutations: Array<[
  string,
  (value: CanvasSnapshot) => CanvasSnapshot,
]> = [
  ["board revision", (value) => ({ ...value, boardRevision: value.boardRevision + 1 })],
  ["Canvas state revision", (value) => ({ ...value, canvasStateRevision: value.canvasStateRevision + 1 })],
  ["viewport", (value) => ({ ...value, viewport: { ...value.viewport, zoom: 2 } })],
  ["selected screens", (value) => ({ ...value, selectedScreens: [secondReference] })],
  ["visible screens", (value) => ({ ...value, visibleScreens: [secondReference] })],
  ["screen content at the same revision", (value) => ({
    ...value,
    screens: value.screens.map((screen, index) => (
      index === 0 ? { ...screen, name: "Changed Home" } : screen
    )),
  })],
  ["client session", (value) => ({ ...value, clientSessionId: "canvas-client-2" })],
  ["project session generation", (value) => ({
    ...value,
    projectSessionGeneration: value.projectSessionGeneration + 1,
  })],
  ["capture time", (value) => ({
    ...value,
    capturedAt: new Date(Date.parse(value.capturedAt) - 1_000).toISOString(),
  })],
  ["expiry", (value) => ({
    ...value,
    expiresAt: new Date(Date.parse(value.expiresAt) + 1_000).toISOString(),
  })],
];

describe("Canvas grant complete snapshot binding", () => {
  it("persists one canonical snapshot digest on both the session and grant and replays exactly", async () => {
    const harness = grantHarness();
    const original = scope();
    const expectedSha256 = canonicalCanvasSnapshotSha256(original.snapshot!);

    const first = await harness.issue(original);
    const replay = await harness.issue(original);

    expect(replay).toEqual(first);
    expect(harness.sessionCreate).toHaveBeenCalledTimes(1);
    expect(harness.grantCreate).toHaveBeenCalledTimes(1);
    expect(harness.sessionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        snapshotSha256: expectedSha256,
        boardRevision: original.snapshot!.boardRevision,
        canvasStateRevision: original.snapshot!.canvasStateRevision,
        viewport: original.snapshot!.viewport,
        selectedNodeIds: [firstReference.boardNodeId],
        visibleNodeIds: [firstReference.boardNodeId],
        profile: "read",
      }),
    });
    expect(harness.grantCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ snapshotSha256: expectedSha256 }),
    });
  });

  it("canonicalizes object key insertion order but preserves semantic array order", () => {
    const original = snapshot();
    const reordered = reorderedObject(original) as CanvasSnapshot;
    const reorderedScreens = { ...original, screens: [...original.screens].reverse() };

    expect(canonicalCanvasSnapshotSha256(reordered))
      .toBe(canonicalCanvasSnapshotSha256(original));
    expect(canonicalCanvasSnapshotSha256(reorderedScreens))
      .not.toBe(canonicalCanvasSnapshotSha256(original));
  });

  it.each(snapshotMutations)("rejects replay after mutating %s", async (_label, mutate) => {
    const harness = grantHarness();
    const original = scope();
    await harness.issue(original);

    const changed = {
      ...original,
      snapshot: mutate(structuredClone(original.snapshot!)),
    };
    await expect(harness.issue(changed)).rejects.toThrow(
      "CANVAS_AGENT_SESSION_SCOPE_CONFLICT",
    );
    expect(harness.sessionCreate).toHaveBeenCalledTimes(1);
    expect(harness.grantCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["session snapshot digest", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.snapshotSha256 = "f".repeat(64);
    }],
    ["grant snapshot digest", (harness: ReturnType<typeof grantHarness>) => {
      harness.grant.snapshotSha256 = "f".repeat(64);
    }],
    ["board revision", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.boardRevision += 1;
    }],
    ["Canvas state revision", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.canvasStateRevision += 1;
    }],
    ["viewport", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.viewport = { x: 0, y: 0, zoom: 4 };
    }],
    ["selected node IDs", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.selectedNodeIds = [secondReference.boardNodeId];
    }],
    ["visible node IDs", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.visibleNodeIds = [secondReference.boardNodeId];
    }],
    ["profile", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.profile = "multi";
    }],
    ["declared tools", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.declaredTools = ["quick_edit"];
    }],
    ["declaration hash", (harness: ReturnType<typeof grantHarness>) => {
      harness.session.declarationHash = "f".repeat(64);
    }],
  ] as const)("rejects replay when the persisted %s drifts", async (_label, mutate) => {
    const harness = grantHarness();
    const original = scope();
    await harness.issue(original);
    mutate(harness);

    await expect(harness.issue(original)).rejects.toThrow(
      "CANVAS_AGENT_SESSION_SCOPE_CONFLICT",
    );
  });

  it.each([
    ["Run", (original: CanvasToolGrantScope) => ({ ...original, runId: "run-2" })],
    ["Project", (original: CanvasToolGrantScope) => ({
      ...original,
      projectId: "project-2",
      snapshot: { ...original.snapshot!, projectId: "project-2" },
    })],
  ] as const)("rejects replay across another %s", async (_label, mutate) => {
    const harness = grantHarness();
    const original = scope();
    await harness.issue(original);

    await expect(harness.issue(mutate(original))).rejects.toThrow(
      "CANVAS_AGENT_SESSION_SCOPE_CONFLICT",
    );
  });
});
