import { createHash } from "node:crypto";
import type { Response } from "express";
import {
  canonicalJson,
  computePrototypeScreenProjectionChecksum,
  projectPrototypeScreen,
} from "@workbench/workbench-contracts";
import { PrototypePatchCheckpointsController } from "../src/modules/prototype-patches/prototype-patch-checkpoints.controller.js";
import { PrototypePatchCheckpointsService } from "../src/modules/prototype-patches/prototype-patch-checkpoints.service.js";

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const frame = (id: string, screenId: string) => ({
    id,
    screenId,
    parentId: null,
    name: id,
    kind: "frame" as const,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: null,
      stroke: null,
      radii: {
        topLeft: literal(0),
        topRight: literal(0),
        bottomRight: literal(0),
        bottomLeft: literal(0),
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
    childIds: [],
    clipContent: true,
  });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "document-1",
    title: "Prototype",
    revision: 1,
    screens: [
      {
        id: "screen-home",
        name: "Home",
        route: "/",
        rootNodeId: "root-home",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
      {
        id: "screen-success",
        name: "Success",
        route: "/success",
        rootNodeId: "root-success",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
    ],
    nodes: [frame("root-home", "screen-home"), frame("root-success", "screen-success")],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function checkpointRow(overrides: Record<string, unknown> = {}) {
  const document = prototypeDocument();
  const row = {
    projectId: "project_1",
    runId: "run_1",
    requestId: "request_1",
    attempt: 2,
    runtimeAttemptId: "attempt_2",
    artifactIndex: 0,
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    status: "staging",
    document,
    documentChecksum: sha256Canonical(document),
    lastSequence: 17,
    screenId: "screen-home",
    screenRevision: 3,
    screenChecksum: screenChecksum(document, "screen-home", 3),
    ...overrides,
  };
  if (
    !Object.prototype.hasOwnProperty.call(overrides, "screenChecksum")
    && (overrides.screenId !== undefined || overrides.screenRevision !== undefined)
  ) {
    row.screenChecksum = screenChecksum(
      document,
      String(row.screenId),
      Number(row.screenRevision),
    );
  }
  return row;
}

describe("PrototypePatchCheckpointsService", () => {
  it("returns one coherent checkpoint snapshot and scopes the SQL to the principal", async () => {
    const rows = [
      checkpointRow(),
      checkpointRow({
        screenId: "screen-success",
        screenRevision: 1,
      }),
    ];
    const db = { $queryRaw: vi.fn().mockResolvedValue(rows) };
    const service = new PrototypePatchCheckpointsService(db as never);

    await expect(service.get(
      "principal_1",
      "run_1",
      "version_1",
    )).resolves.toEqual({
      protocol: "workbench.prototype-patch-checkpoint.v1",
      projectId: "project_1",
      runId: "run_1",
      requestId: "request_1",
      attempt: 2,
      runtimeAttemptId: "attempt_2",
      artifactIndex: 0,
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      status: "staging",
      document: rows[0]!.document,
      documentChecksum: rows[0]!.documentChecksum,
      screens: [
        { screenId: "screen-home", revision: 3, checksum: rows[0]!.screenChecksum },
        { screenId: "screen-success", revision: 1, checksum: rows[1]!.screenChecksum },
      ],
      lastSequence: 17,
    });

    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const query = db.$queryRaw.mock.calls[0]![0] as { values: unknown[] };
    expect(query.values).toEqual(expect.arrayContaining([
      "principal_1",
      "run_1",
      "version_1",
    ]));
  });

  it("returns exactly the requested screen from a filtered checkpoint query", async () => {
    const row = checkpointRow();
    const db = { $queryRaw: vi.fn().mockResolvedValue([row]) };
    const service = new PrototypePatchCheckpointsService(db as never);

    await expect(service.get(
      "principal_1",
      "run_1",
      "version_1",
      "screen-home",
    )).resolves.toMatchObject({
      document: row.document,
      screens: [{
        screenId: "screen-home",
        revision: 3,
        checksum: row.screenChecksum,
      }],
    });

    const query = db.$queryRaw.mock.calls[0]![0] as { values: unknown[] };
    expect(query.values).toContain("screen-home");
  });

  it("hides missing or unauthorized checkpoints behind 404", async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const service = new PrototypePatchCheckpointsService(db as never);

    await expect(service.get("principal_2", "run_1", "version_1"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("fails closed for a corrupt document checksum or a mixed SQL snapshot", async () => {
    const corruptDb = {
      $queryRaw: vi.fn().mockResolvedValue([
        checkpointRow({ documentChecksum: "f".repeat(64) }),
      ]),
    };
    const corrupt = new PrototypePatchCheckpointsService(corruptDb as never);
    await expect(corrupt.get("principal_1", "run_1", "version_1"))
      .rejects.toMatchObject({
        status: 409,
        response: { code: "PROTOTYPE_PATCH_CHECKPOINT_DOCUMENT_DIVERGED" },
      });

    const mixedDb = {
      $queryRaw: vi.fn().mockResolvedValue([
        checkpointRow(),
        checkpointRow({ screenId: "screen-success", lastSequence: 18 }),
      ]),
    };
    const mixed = new PrototypePatchCheckpointsService(mixedDb as never);
    await expect(mixed.get("principal_1", "run_1", "version_1"))
      .rejects.toMatchObject({
        status: 409,
        response: { code: "PROTOTYPE_PATCH_CHECKPOINT_SCOPE_DIVERGED" },
      });
  });

  it("rejects a forged screen checksum and an incomplete unfiltered screen set", async () => {
    const forgedDb = {
      $queryRaw: vi.fn().mockResolvedValue([
        checkpointRow({ screenChecksum: "e".repeat(64) }),
      ]),
    };
    const forged = new PrototypePatchCheckpointsService(forgedDb as never);
    await expect(forged.get("principal_1", "run_1", "version_1", "screen-home"))
      .rejects.toMatchObject({
        status: 409,
        response: { code: "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_DIVERGED" },
      });

    const incompleteDb = { $queryRaw: vi.fn().mockResolvedValue([checkpointRow()]) };
    const incomplete = new PrototypePatchCheckpointsService(incompleteDb as never);
    await expect(incomplete.get("principal_1", "run_1", "version_1"))
      .rejects.toMatchObject({
        status: 409,
        response: { code: "PROTOTYPE_PATCH_CHECKPOINT_SCREEN_SET_DIVERGED" },
      });
  });
});

describe("PrototypePatchCheckpointsController", () => {
  it("delegates the current principal and prevents checkpoint caching", async () => {
    const checkpoint = { protocol: "workbench.prototype-patch-checkpoint.v1" };
    const service = { get: vi.fn().mockResolvedValue(checkpoint) };
    const controller = new PrototypePatchCheckpointsController(service as never);
    const response = { setHeader: vi.fn() };

    await expect(controller.get(
      { id: "principal_1" } as never,
      "run_1",
      "version_1",
      { screenId: "screen-home" },
      response as unknown as Response,
    )).resolves.toBe(checkpoint);

    expect(service.get).toHaveBeenCalledWith(
      "principal_1",
      "run_1",
      "version_1",
      "screen-home",
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function screenChecksum(
  document: ReturnType<typeof prototypeDocument>,
  screenId: string,
  revision: number,
) {
  return computePrototypeScreenProjectionChecksum(
    projectPrototypeScreen(document, screenId, revision),
    (value) => createHash("sha256").update(value).digest("hex"),
  );
}
