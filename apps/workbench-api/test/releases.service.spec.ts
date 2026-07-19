import { boardNodeProtocol } from "@workbench/workbench-contracts";
import { hashRequest } from "../src/common/idempotency.js";
import {
  canonicalSha256,
  mapProjectRelease,
  mapPublicProjectRelease,
  type ReleaseRecord,
} from "../src/modules/releases/release.mapper.js";
import { ReleasesService } from "../src/modules/releases/releases.service.js";
import { buildProjectArtifactPins } from "../src/modules/releases/project-snapshot.js";

const checksum = "a".repeat(64);
const now = new Date("2026-07-13T00:00:00.000Z");

function artifactNodeData(
  title: string,
  artifactKind: "prototype" | "data",
  screenId?: string,
) {
  return {
    protocol: boardNodeProtocol,
    nodeType: "artifact" as const,
    title,
    artifactKind,
    ...(screenId === undefined ? {} : { screenId }),
  };
}

function releaseRecord(): ReleaseRecord & { requestHash: string } {
  const boardSnapshot = {
    id: "board_1",
    projectId: "project_1",
    revision: 7,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{
      id: "node_1",
      kind: "artifact",
      parentNodeId: null,
      order: 0,
      position: { x: 10, y: 20 },
      size: null,
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      data: artifactNodeData("Prototype", "prototype"),
    }],
    edges: [],
  };
  const pins = [{
    position: 0,
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    title: "Prototype",
    kind: "prototype",
    version: 2,
    schemaVersion: 1,
    checksum,
    assets: [],
  }];
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: "project_1",
    releaseVersion: 1,
    board: { id: "board_1", revision: 7, checksum: canonicalSha256(boardSnapshot) },
    artifacts: pins,
  };
  return {
    id: "release_1",
    projectId: "project_1",
    version: 1,
    status: "ready",
    createdById: "principal_1",
    requestHash: hashRequest({ boardId: "board_1", boardRevision: 7 }),
    boardId: "board_1",
    boardRevision: 7,
    boardSnapshot,
    boardChecksum: canonicalSha256(boardSnapshot),
    manifest,
    manifestSha256: canonicalSha256(manifest),
    failureCode: null,
    failureDetail: null,
    createdAt: now,
    finishedAt: now,
    updatedAt: now,
    artifactPins: [{
      position: 0,
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      title: "Prototype",
      kind: "prototype",
      artifactVersion: {
        id: "version_1",
        artifactId: "artifact_1",
        projectId: "project_1",
        version: 2,
        schemaVersion: 1,
        status: "ready",
        checksum,
        assets: [],
        artifact: { id: "artifact_1", projectId: "project_1" },
      },
    }],
  };
}

describe("ProjectRelease integrity", () => {
  it("recomputes canonical Board and manifest digests on every projection", () => {
    const record = releaseRecord();
    expect(mapProjectRelease(record)).toMatchObject({
      id: "release_1",
      boardChecksum: canonicalSha256(record.boardSnapshot),
      manifestSha256: canonicalSha256(record.manifest),
    });

    expect(() => mapProjectRelease({
      ...record,
      boardSnapshot: { ...record.boardSnapshot as object, revision: 8 },
    })).toThrow("PROJECT_RELEASE_BOARD_CHECKSUM_MISMATCH");
    expect(() => mapProjectRelease({
      ...record,
      manifest: { ...record.manifest as object, releaseVersion: 2 },
    })).toThrow("PROJECT_RELEASE_MANIFEST_CHECKSUM_MISMATCH");
  });

  it("rejects a relational pin that does not belong to the immutable release project", () => {
    const record = releaseRecord();
    expect(() => mapProjectRelease({
      ...record,
      artifactPins: [{
        ...record.artifactPins[0]!,
        artifactVersion: {
          ...record.artifactPins[0]!.artifactVersion,
          projectId: "other_project",
        },
      }],
    })).toThrow("PROJECT_RELEASE_ARTIFACT_PIN_MISMATCH");
  });

  it("pins binary assets in stable order while removing Blob identity from the public projection", () => {
    const record = releaseRecord();
    const assetDto = {
      assetId: "asset_logo",
      kind: "image",
      blobId: "blob_internal",
      mediaType: "image/png",
      byteSize: 128,
      sha256: "b".repeat(64),
      metadata: { id: "asset_logo", kind: "image", blobId: "blob_internal" },
    };
    record.artifactPins[0]!.artifactVersion.assets = [{
      artifactVersionId: "version_1",
      artifactId: "artifact_1",
      projectId: "project_1",
      ...assetDto,
      byteSize: 128n,
      blob: { id: "blob_internal", status: "ready", deletedAt: null },
    }];
    const manifest = {
      ...record.manifest as Record<string, unknown>,
      artifacts: [{
        position: 0,
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        title: "Prototype",
        kind: "prototype",
        version: 2,
        schemaVersion: 1,
        checksum,
        assets: [assetDto],
      }],
    };
    record.manifest = manifest;
    record.manifestSha256 = canonicalSha256(manifest);

    const internal = mapProjectRelease(record);
    expect(internal.artifactPins[0]!.assets[0]).toMatchObject({
      assetId: "asset_logo",
      blobId: "blob_internal",
      sha256: "b".repeat(64),
    });
    const publicRelease = mapPublicProjectRelease(record);
    expect(publicRelease.artifactPins[0]).not.toHaveProperty("assets");
    expect(publicRelease.manifest.artifacts[0]).not.toHaveProperty("assets");
    expect(JSON.stringify(publicRelease)).not.toContain("blob_internal");
    expect(publicRelease.boardChecksum).toBe(canonicalSha256(publicRelease.boardSnapshot));
    expect(publicRelease.manifestSha256).toBe(canonicalSha256(publicRelease.manifest));
  });

  it("builds the snapshot and both digests in the locked creation transaction", async () => {
    let createData: Record<string, unknown> | undefined;
    const board = {
      id: "board_1",
      projectId: "project_1",
      revision: 7,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        nodeKey: "node_1",
        parentNodeKey: null,
        sortOrder: 0,
        kind: "artifact",
        position: { x: 10, y: 20 },
        size: null,
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        data: artifactNodeData("Prototype", "prototype", "screen-home"),
      }],
      edges: [],
    };
    const pin = releaseRecord().artifactPins[0]!;
    const version = {
      ...pin.artifactVersion,
      content: prototypeDocument(),
      contentBlobId: null,
      artifact: { ...pin.artifactVersion.artifact, kind: pin.kind },
    };
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "project_1" }])
        .mockResolvedValueOnce([{ id: "board_1", revision: 7 }])
        .mockResolvedValueOnce([{ id: "artifact_1", title: "Prototype", currentVersionId: "version_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      board: { findUniqueOrThrow: vi.fn().mockResolvedValue(board) },
      artifactVersion: {
        findMany: vi.fn().mockResolvedValue([{ ...version, artifact: version.artifact }]),
      },
      projectRelease: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          createData = data;
          return { id: "release_1" };
        }),
        update: vi.fn().mockResolvedValue({}),
        findUniqueOrThrow: vi.fn().mockImplementation(() => ({
          ...releaseRecord(),
          boardSnapshot: createData!.boardSnapshot,
          boardChecksum: createData!.boardChecksum,
          manifest: createData!.manifest,
          manifestSha256: createData!.manifestSha256,
        })),
      },
    };
    const db = {
      projectRelease: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const access = { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) };
    const service = new ReleasesService(db as never, access as never);

    const result = await service.create(
      "principal_1",
      "project_1",
      7,
      "release:key:123",
      { boardId: "board_1", boardRevision: 7 },
    );

    expect(result.status).toBe("ready");
    expect(createData!.boardChecksum).toBe(canonicalSha256(createData!.boardSnapshot));
    expect(createData!.manifestSha256).toBe(canonicalSha256(createData!.manifest));
    expect(createData!.artifactPins).toEqual({
      create: [{
        position: 0,
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        title: "Prototype",
        kind: "prototype",
      }],
    });
  });

  it("rejects a Board screen that does not belong to the exact pinned ArtifactVersion", async () => {
    const record = releaseRecord();
    const pin = record.artifactPins[0]!;
    const board = {
      ...(record.boardSnapshot as Record<string, unknown>),
      nodes: [{
        ...(record.boardSnapshot as { nodes: Array<Record<string, unknown>> }).nodes[0]!,
        data: artifactNodeData("Prototype", "prototype", "screen-missing"),
      }],
    };
    const tx = {
      artifactVersion: {
        findMany: vi.fn().mockResolvedValue([{
          ...pin.artifactVersion,
          content: prototypeDocument(),
          contentBlobId: null,
          artifact: { ...pin.artifactVersion.artifact, kind: "prototype" },
        }]),
      },
    };
    await expect(buildProjectArtifactPins(tx as never, "project_1", board, [{
      id: "artifact_1",
      title: "Prototype",
      currentVersionId: "version_1",
    }])).rejects.toMatchObject({ status: 400 });
  });

  it("replays an identical release receipt and rejects key reuse by another request", async () => {
    const record = releaseRecord();
    const db = {
      projectRelease: { findUnique: vi.fn().mockResolvedValue(record) },
      $transaction: vi.fn(),
    };
    const access = { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) };
    const service = new ReleasesService(db as never, access as never);
    await expect(service.create(
      "principal_1", "project_1", 7, "release:key:123",
      { boardId: "board_1", boardRevision: 7 },
    )).resolves.toMatchObject({ id: "release_1" });
    await expect(service.create(
      "principal_1", "project_1", 8, "release:key:123",
      { boardId: "board_1", boardRevision: 8 },
    )).rejects.toMatchObject({ status: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

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
      { id: "screen-home", name: "Home", route: "/", rootNodeId: "root-home", initialStateId: null, viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: "root-success", initialStateId: null, viewport: { width: 390, height: 844 } },
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
