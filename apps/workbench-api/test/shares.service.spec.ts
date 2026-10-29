import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { canonicalSha256, type ReleaseRecord } from "../src/modules/releases/release.mapper.js";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { UnsatisfiedByteRangeProblem } from "../src/common/byte-content.js";
import {
  PublicSharesController,
  ShareGrantsController,
} from "../src/modules/shares/shares.controller.js";
import { SharesService, hashShareToken } from "../src/modules/shares/shares.service.js";

const now = new Date("2026-07-13T00:00:00.000Z");
const checksum = createHash("sha256").update("shareobj").digest("hex");
const assetChecksum = checksum;

function objectStorage() {
  return {
    getObject: vi.fn().mockResolvedValue({
      body: Readable.from("shareobj"),
      byteSize: 8,
      mediaType: "image/png",
      contentRange: null,
    }),
  };
}

function shareRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "share_1",
    releaseId: "release_1",
    artifactVersionId: "version_1",
    createdById: "principal_1",
    tokenHash: "b".repeat(64),
    scope: "view" as const,
    status: "active" as const,
    revision: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function releaseRecord(): ReleaseRecord {
  const boardSnapshot = {
    id: "board_1",
    projectId: "project_1",
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  };
  const boardChecksum = canonicalSha256(boardSnapshot);
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: "project_1",
    releaseVersion: 1,
    board: { id: "board_1", revision: 1, checksum: boardChecksum },
    artifacts: [],
  };
  return {
    id: "release_1",
    projectId: "project_1",
    version: 1,
    status: "ready",
    createdById: "principal_internal",
    boardId: "board_1",
    boardRevision: 1,
    boardSnapshot,
    boardChecksum,
    manifest,
    manifestSha256: canonicalSha256(manifest),
    failureCode: null,
    failureDetail: null,
    createdAt: now,
    finishedAt: now,
    updatedAt: now,
    artifactPins: [],
  };
}

function pinnedRelease(kind: "data" | "prototype"): ReleaseRecord {
  const asset = {
    artifactVersionId: "version_1",
    artifactId: "artifact_1",
    projectId: "project_1",
    assetId: "hero-image",
    kind: "image",
    blobId: "blob_asset_internal",
    mediaType: "image/png",
    byteSize: 8n,
    sha256: assetChecksum,
    metadata: { width: 2, height: 2 },
    blob: { id: "blob_asset_internal", status: "ready", deletedAt: null },
  };
  const assets = kind === "prototype" ? [asset] : [];
  const publicAssets = assets.map((item) => ({
    assetId: item.assetId,
    kind: item.kind,
    blobId: item.blobId,
    mediaType: item.mediaType,
    byteSize: Number(item.byteSize),
    sha256: item.sha256,
    metadata: item.metadata,
  }));
  const manifestPin = {
    position: 0,
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    title: kind === "prototype" ? "Prototype" : "Data",
    kind,
    version: 2,
    schemaVersion: 1,
    checksum,
    assets: publicAssets,
  };
  const boardSnapshot = {
    id: "board_1",
    projectId: "project_1",
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  };
  const boardChecksum = canonicalSha256(boardSnapshot);
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: "project_1",
    releaseVersion: 1,
    board: { id: "board_1", revision: 1, checksum: boardChecksum },
    artifacts: [manifestPin],
  };
  return {
    ...releaseRecord(),
    boardSnapshot,
    boardChecksum,
    manifest,
    manifestSha256: canonicalSha256(manifest),
    artifactPins: [{
      position: manifestPin.position,
      artifactId: manifestPin.artifactId,
      artifactVersionId: manifestPin.artifactVersionId,
      title: manifestPin.title,
      kind,
      artifactVersion: {
        id: "version_1",
        artifactId: "artifact_1",
        projectId: "project_1",
        version: 2,
        schemaVersion: 1,
        status: "ready",
        checksum,
        artifact: { id: "artifact_1", projectId: "project_1" },
        assets,
      },
    }],
  };
}

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const nodeBase = (id: string, parentId: string | null) => ({
    id,
    screenId: "screen-home",
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "flex" as const,
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
      radii: { topLeft: literal(0), topRight: literal(0), bottomRight: literal(0), bottomLeft: literal(0) },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
  });
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-document",
    title: "Prototype",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "frame-root",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [
      { ...nodeBase("frame-root", null), kind: "frame", childIds: ["image-hero"], clipContent: true },
      { ...nodeBase("image-hero", "frame-root"), kind: "image", assetId: "hero-image", fit: "cover", alt: "Hero" },
    ],
    tokens: [],
    assets: [{
      id: "hero-image",
      kind: "image",
      name: "Hero",
      blobId: "blob_asset_internal",
      mediaType: "image/png",
      byteSize: 8,
      sha256: assetChecksum,
      width: 2,
      height: 2,
    }],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

describe("ShareGrant security and lifecycle", () => {
  it("returns the contract's 200 status for semantic revocation", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ShareGrantsController.prototype.revoke)).toBe(200);
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      ShareGrantsController.prototype.revokeProjectShares,
    )).toBe(200);
  });

  it("reports the complete active count independently of the paginated audit page", async () => {
    const db = {
      shareGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          shareRecord({ id: "share_new", createdAt: new Date("2026-07-13T02:00:00.000Z") }),
          shareRecord({ id: "share_old", createdAt: new Date("2026-07-13T01:00:00.000Z") }),
        ]),
        count: vi.fn().mockResolvedValue(125),
      },
    };
    const access = { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) };
    const service = new SharesService(db as never, access as never, objectStorage() as never);

    await expect(service.list("principal_1", "project_1", undefined, 1)).resolves.toMatchObject({
      items: [{ id: "share_new" }],
      activeCount: 125,
      nextCursor: expect.any(String),
    });
    expect(db.shareGrant.count).toHaveBeenCalledWith({
      where: { projectId: "project_1", status: "active" },
    });
  });

  it("atomically expires elapsed grants, revokes every remaining active grant, and is repeat-safe", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      shareGrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((callback) => callback(db));
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    await expect(service.revokeProjectShares("principal_1", "project_1")).resolves.toEqual({
      projectId: "project_1",
      activeGrantCount: 0,
    });
    await expect(service.revokeProjectShares("principal_1", "project_1")).resolves.toEqual({
      projectId: "project_1",
      activeGrantCount: 0,
    });

    const lock = db.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    expect(lock.strings?.join(" ")).toContain("FOR UPDATE");
    expect(db.shareGrant.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        status: "active",
        expiresAt: { lte: expect.any(Date) },
        projectId: "project_1",
      },
      data: { status: "expired", revision: { increment: 1 } },
    });
    expect(db.shareGrant.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: "active",
        projectId: "project_1",
      },
      data: {
        status: "revoked",
        revokedAt: expect.any(Date),
        revision: { increment: 1 },
      },
    });
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "ReadCommitted" },
    );
  });

  it("checks current Project ownership under the exclusive lock before bulk revocation", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      shareGrant: {
        updateMany: vi.fn(),
        count: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((callback) => callback(db));
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    await expect(service.revokeProjectShares("principal_editor", "project_1"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.shareGrant.updateMany).not.toHaveBeenCalled();
    expect(db.shareGrant.count).not.toHaveBeenCalled();
  });

  it("rotates atomically, stores the command receipt and token hash, and returns raw token once", async () => {
    let createData: Record<string, unknown> | undefined;
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      projectRelease: { findFirst: vi.fn().mockResolvedValue(pinnedRelease("prototype")) },
      shareGrant: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 2 }),
        create: vi.fn().mockImplementation(({ data }) => {
          createData = data;
          return shareRecord({ tokenHash: data.tokenHash });
        }),
        count: vi.fn().mockResolvedValue(1),
      },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((callback) => callback(db));
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    const request = {
      releaseId: "release_1",
      scope: "view",
      expiresAt: null,
    } as const;
    const result = await service.rotate(
      "principal_1",
      "project_1",
      "share:rotate:12345678",
      request,
    );

    expect(result.token).toMatch(/^wbs_[A-Za-z0-9_-]{43}$/);
    expect(result.revokedGrantCount).toBe(2);
    expect(result.share.artifactVersionId).toBe("version_1");
    expect(createData).toMatchObject({
      projectId: "project_1",
      releaseId: "release_1",
      createdById: "principal_1",
      artifactVersionId: "version_1",
      idempotencyKey: "share:rotate:12345678",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(createData!.tokenHash).toBe(hashShareToken(result.token));
    expect(Object.keys(createData!)).not.toContain("token");
    expect(JSON.stringify(result.share)).not.toContain("tokenHash");
    const lock = db.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    expect(lock.strings?.join(" ")).toContain("FOR UPDATE");
    expect(db.shareGrant.updateMany).toHaveBeenNthCalledWith(2, {
      where: { projectId: "project_1", status: "active" },
      data: {
        status: "revoked",
        revokedAt: expect.any(Date),
        revision: { increment: 1 },
      },
    });
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "ReadCommitted" },
    );
  });

  it("rejects an Idempotency-Key reused with another rotation request before revoking anything", async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      projectRelease: { findFirst: vi.fn() },
      shareGrant: {
        findFirst: vi.fn().mockResolvedValue({
          createdById: "principal_1",
          requestHash: "0".repeat(64),
        }),
        updateMany: vi.fn(),
        create: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((callback) => callback(db));
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    await expect(service.rotate("principal_1", "project_1", "share:rotate:12345678", {
      releaseId: "release_1",
      scope: "view",
      expiresAt: null,
    })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
    expect(db.projectRelease.findFirst).not.toHaveBeenCalled();
    expect(db.shareGrant.updateMany).not.toHaveBeenCalled();
    expect(db.shareGrant.create).not.toHaveBeenCalled();
  });

  it("public projection removes principal and storage internals", async () => {
    const token = `wbs_${"A".repeat(43)}`;
    const db = {
      shareGrant: {
        findUnique: vi.fn().mockResolvedValue({
          ...shareRecord({ tokenHash: hashShareToken(token) }),
          release: pinnedRelease("prototype"),
        }),
      },
    };
    const service = new SharesService(db as never, {} as never, objectStorage() as never);
    const result = await service.getPublic(token);
    const wire = JSON.stringify(result.share);

    expect(result.share.release).not.toHaveProperty("createdById");
    expect(wire).not.toContain("principal_internal");
    expect(wire).not.toContain("tokenHash");
    expect(wire).not.toContain("storageKey");
    expect(wire).not.toContain("blobId");
  });

  it("shares real prototype canvas nodes in public order without private frames", async () => {
    const token = `wbs_${"K".repeat(43)}`;
    const release = pinnedRelease("prototype");
    const board = {
      id: "board_1", projectId: "project_1", revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: "private-frame", parentNodeId: null, order: 0, kind: "frame", position: { x: 0, y: 0 },
          size: { width: 1000, height: 1000 }, artifactId: null, artifactVersionId: null,
          data: { protocol: "workbench.board-node.v1", nodeType: "frame", title: "PRIVATE_FRAME_TEXT", fill: null, stroke: "#000000" } },
        ...[7, 9].map((order, index) => ({
          id: `prototype-node-${index}`, parentNodeId: "private-frame", order, kind: "artifact",
          position: { x: index * 400, y: 100 }, size: null, artifactId: "artifact_1", artifactVersionId: "version_1",
          data: { protocol: "workbench.board-node.v1", nodeType: "artifact", artifactKind: "prototype", title: `Screen ${index}`, screenId: `screen-${index}` },
        })),
      ],
      edges: [{ id: "private-edge", sourceNodeId: "private-frame", targetNodeId: "prototype-node-0", kind: "related", data: {} }],
    };
    release.boardSnapshot = board;
    release.boardChecksum = canonicalSha256(board);
    const manifest = release.manifest as { board: { checksum: string } };
    manifest.board.checksum = release.boardChecksum;
    release.manifestSha256 = canonicalSha256(manifest);
    const before = JSON.stringify(release.boardSnapshot);
    const service = new SharesService({ shareGrant: { findUnique: vi.fn().mockResolvedValue({ ...shareRecord(), release }) } } as never, {} as never, objectStorage() as never);
    const { share } = await service.getPublic(token);
    expect(share.release.boardSnapshot.nodes.map(({ id, parentNodeId, order }) => ({ id, parentNodeId, order }))).toEqual([
      { id: "prototype-node-0", parentNodeId: null, order: 0 },
      { id: "prototype-node-1", parentNodeId: null, order: 1 },
    ]);
    expect(share.release.boardSnapshot.edges).toEqual([]);
    expect(JSON.stringify(share)).not.toContain("sortOrder");
    expect(JSON.stringify(share)).not.toContain("PRIVATE_FRAME_TEXT");
    expect(share.release.boardChecksum).toBe(canonicalSha256(share.release.boardSnapshot));
    expect(JSON.stringify(release.boardSnapshot)).toBe(before);
  });

  it("does not expose other artifacts in the same immutable Release", async () => {
    const token = `wbs_${"H".repeat(43)}`;
    const release = pinnedRelease("prototype");
    const privateRelease = pinnedRelease("data");
    const privatePin = privateRelease.artifactPins[0]!;
    privatePin.artifactId = "artifact-private";
    privatePin.artifactVersionId = "version-private";
    privatePin.title = "Private business requirements";
    privatePin.position = 1;
    privatePin.artifactVersion = {
      ...privatePin.artifactVersion, id: privatePin.artifactVersionId, artifactId: privatePin.artifactId,
      artifact: { id: privatePin.artifactId, projectId: release.projectId },
    };
    release.artifactPins.push(privatePin);
    const manifest = release.manifest as { artifacts: Record<string, unknown>[] };
    const otherManifest = privateRelease.manifest as { artifacts: Record<string, unknown>[] };
    manifest.artifacts.push({
      ...otherManifest.artifacts[0], artifactId: privatePin.artifactId,
      artifactVersionId: privatePin.artifactVersionId, title: privatePin.title, position: 1,
    });
    release.manifestSha256 = canonicalSha256(manifest);
    const storage = objectStorage();
    const db = {
      shareGrant: { findUnique: vi.fn().mockResolvedValue({ ...shareRecord(), release }) },
      artifactVersion: { findFirst: vi.fn() },
      artifactVersionAsset: { findFirst: vi.fn() },
    };
    const service = new SharesService(db as never, {} as never, storage as never);
    const result = await service.getPublic(token);
    expect(result.share.release.artifactPins).toHaveLength(1);
    expect(result.share.release.artifactPins[0]?.artifactVersionId).toBe("version_1");
    expect(JSON.stringify(result)).not.toContain("Private business requirements");
    expect(JSON.stringify(result)).not.toContain("version-private");
    await expect(service.getPublicArtifactVersion(token, "artifact-private", "version-private"))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.getPublicArtifactContent(token, "artifact-private", "version-private"))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.getPublicArtifactAssetContent(token, "artifact-private", "version-private", "hero-image"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findFirst).not.toHaveBeenCalled();
    expect(db.artifactVersionAsset.findFirst).not.toHaveBeenCalled();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("rejects remix scope and unpinned legacy public links", async () => {
    const db = { shareGrant: { findUnique: vi.fn().mockResolvedValue({
      ...shareRecord({ artifactVersionId: null }), release: pinnedRelease("prototype"),
    }) } };
    const service = new SharesService(db as never, {} as never, objectStorage() as never);
    await expect(service.rotate("principal_1", "project_1", "share:rotate:12345678", {
      releaseId: "release_1", scope: "remix", expiresAt: null,
    })).rejects.toMatchObject({ status: 400 });
    await expect(service.getPublic(`wbs_${"J".repeat(43)}`)).rejects.toMatchObject({ status: 404 });
  });

  it("expires a stale public token atomically and returns the same opaque 404 as an invalid token", async () => {
    const token = `wbs_${"B".repeat(43)}`;
    const expired = shareRecord({
      tokenHash: hashShareToken(token),
      expiresAt: new Date("2026-07-12T00:00:00.000Z"),
      release: releaseRecord(),
    });
    const db = {
      shareGrant: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(expired)
          .mockResolvedValueOnce(shareRecord({ status: "expired", revision: 1 })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    await expect(service.getPublic(token)).rejects.toMatchObject({ status: 404 });
    expect(db.shareGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "share_1", status: "active", revision: 0 }),
      data: { status: "expired", revision: { increment: 1 } },
    }));
    await expect(service.getPublic("invalid")).rejects.toMatchObject({ status: 404 });
  });

  it("revokes semantically with compare-and-swap and never deletes the audit row", async () => {
    const active = shareRecord();
    const revoked = shareRecord({
      status: "revoked",
      revision: 1,
      revokedAt: now,
    });
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      projectRelease: { findUnique: vi.fn().mockResolvedValue({ projectId: "project_1" }) },
      shareGrant: {
        findFirst: vi.fn().mockResolvedValue(active),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(active),
        findUniqueOrThrow: vi.fn().mockResolvedValue(revoked),
        delete: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((callback) => callback(db));
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    await expect(service.revoke("principal_1", "share_1", 0)).resolves.toMatchObject({
      status: "revoked",
      revision: 1,
    });
    expect(db.shareGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "share_1", status: "active", revision: 0 },
    }));
    expect(db.shareGrant.delete).not.toHaveBeenCalled();
  });

  it("returns only the exact Release-pinned public ArtifactVersion projection", async () => {
    const token = `wbs_${"C".repeat(43)}`;
    const release = pinnedRelease("prototype");
    const db = {
      shareGrant: {
        findUnique: vi.fn().mockResolvedValue({
          ...shareRecord({ tokenHash: hashShareToken(token) }),
          release,
        }),
      },
      artifactVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "version_1",
          artifactId: "artifact_1",
          projectId: "project_1",
          version: 2,
          schemaVersion: 1,
          status: "ready",
          content: prototypeDocument(),
          checksum,
          citations: [],
          createdAt: now,
          contentBlob: null,
        }),
      },
    };
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    const result = await service.getPublicArtifactVersion(token, "artifact_1", "version_1");
    expect(result.detail).toMatchObject({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      kind: "prototype",
      contentMode: "inline",
      content: { title: "Prototype" },
    });
    expect(result.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const wire = JSON.stringify(result.detail);
    expect(wire).not.toContain("blobId");
    expect(wire).not.toContain("createdByRunId");
    expect(wire).not.toContain("knowledgeReleaseId");
    expect(db.artifactVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "version_1",
        artifactId: "artifact_1",
        projectId: "project_1",
        releasePins: { some: { releaseId: "release_1" } },
      }),
    }));

    await expect(service.getPublicArtifactVersion(token, "artifact_1", "version_not_pinned"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findFirst).toHaveBeenCalledTimes(1);
  });

  it("serves only exact pinned Prototype assets with digest ETag and a single byte range", async () => {
    const token = `wbs_${"D".repeat(43)}`;
    const release = pinnedRelease("prototype");
    const storage = objectStorage();
    const db = {
      shareGrant: {
        findUnique: vi.fn().mockResolvedValue({
          ...shareRecord({ tokenHash: hashShareToken(token) }),
          release,
        }),
      },
      artifactVersionAsset: {
        findFirst: vi.fn().mockResolvedValue({
          kind: "image",
          mediaType: "image/png",
          byteSize: 8n,
          sha256: assetChecksum,
          blob: {
            storageKey: "private/prototype/hero.png",
            sha256: assetChecksum,
            byteSize: 8n,
            mediaType: "image/png",
            status: "ready",
            deletedAt: null,
          },
        }),
      },
    };
    const service = new SharesService(db as never, {} as never, storage as never);

    const partial = await service.getPublicArtifactAssetContent(
      token,
      "artifact_1",
      "version_1",
      "hero-image",
      "bytes=1-4",
    );
    expect(partial).toMatchObject({
      notModified: false,
      etag: `"${assetChecksum}"`,
      byteSize: 4,
      mediaType: "image/png",
      range: { start: 1, end: 4 },
      contentRange: "bytes 1-4/8",
    });
    expect(storage.getObject).toHaveBeenCalledWith({ key: "private/prototype/hero.png" });
    expect(db.artifactVersionAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        artifactVersionId: "version_1",
        artifactId: "artifact_1",
        assetId: "hero-image",
        blobId: "blob_asset_internal",
      }),
    }));

    await expect(service.getPublicArtifactAssetContent(
      token,
      "artifact_1",
      "version_1",
      "hero-image",
      undefined,
      `"${assetChecksum}"`,
    )).resolves.toMatchObject({ notModified: true, etag: `"${assetChecksum}"` });
    expect(storage.getObject).toHaveBeenCalledTimes(1);

    await expect(service.getPublicArtifactAssetContent(
      token,
      "artifact_1",
      "version_1",
      "asset_not_pinned",
    )).rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersionAsset.findFirst).toHaveBeenCalledTimes(2);
  });

  it("serves only exact Release-pinned blob Artifact content with immutable byte semantics", async () => {
    const token = `wbs_${"G".repeat(43)}`;
    const release = pinnedRelease("prototype");
    const storage = objectStorage();
    const db = {
      shareGrant: {
        findUnique: vi.fn().mockResolvedValue({
          ...shareRecord({ tokenHash: hashShareToken(token) }),
          release,
        }),
      },
      artifactVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "version_1",
          artifactId: "artifact_1",
          projectId: "project_1",
          version: 2,
          schemaVersion: 1,
          status: "ready",
          checksum,
          contentBlobId: "blob_content_internal",
          contentBlob: {
            id: "blob_content_internal",
            storageKey: "private/artifacts/data.bin",
            sha256: checksum,
            byteSize: 8n,
            mediaType: "image/png",
            status: "ready",
            deletedAt: null,
          },
        }),
      },
    };
    const service = new SharesService(db as never, {} as never, storage as never);

    const partial = await service.getPublicArtifactContent(
      token,
      "artifact_1",
      "version_1",
      "bytes=1-4",
    );
    expect(partial).toMatchObject({
      notModified: false,
      etag: `"${checksum}"`,
      byteSize: 4,
      mediaType: "image/png",
      range: { start: 1, end: 4 },
      contentRange: "bytes 1-4/8",
    });
    expect(storage.getObject).toHaveBeenCalledWith({ key: "private/artifacts/data.bin" });
    expect(db.artifactVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "version_1",
        artifactId: "artifact_1",
        projectId: "project_1",
        contentBlobId: { not: null },
        releasePins: { some: { releaseId: "release_1" } },
      }),
    }));

    await expect(service.getPublicArtifactContent(
      token,
      "artifact_1",
      "version_1",
      undefined,
      `"${checksum}"`,
    )).resolves.toMatchObject({ notModified: true, etag: `"${checksum}"` });
    expect(storage.getObject).toHaveBeenCalledTimes(1);

    await expect(service.getPublicArtifactContent(
      token,
      "artifact_1",
      "version_not_pinned",
    )).rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findFirst).toHaveBeenCalledTimes(2);
  });

  it("projects a pinned Prototype document without its internal asset Blob ids", async () => {
    const token = `wbs_${"F".repeat(43)}`;
    const db = {
      shareGrant: {
        findUnique: vi.fn().mockResolvedValue({
          ...shareRecord({ tokenHash: hashShareToken(token) }),
          release: pinnedRelease("prototype"),
        }),
      },
      artifactVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "version_1",
          artifactId: "artifact_1",
          projectId: "project_1",
          version: 2,
          schemaVersion: 1,
          status: "ready",
          content: prototypeDocument(),
          checksum,
          citations: [],
          createdAt: now,
          contentBlob: null,
        }),
      },
    };
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    const result = await service.getPublicArtifactVersion(token, "artifact_1", "version_1");
    expect(result.detail).toMatchObject({
      kind: "prototype",
      contentMode: "inline",
      content: {
        assets: [{
          id: "hero-image",
          kind: "image",
          mediaType: "image/png",
          sha256: assetChecksum,
        }],
      },
    });
    expect(JSON.stringify(result.detail)).not.toContain("blob_asset_internal");
    expect(JSON.stringify(result.detail)).not.toContain("blobId");
  });

  it("does not touch Artifact persistence for a revoked public capability", async () => {
    const token = `wbs_${"E".repeat(43)}`;
    const db = {
      shareGrant: {
        findUnique: vi.fn().mockResolvedValue({
          ...shareRecord({ tokenHash: hashShareToken(token), status: "revoked" }),
          release: pinnedRelease("data"),
        }),
      },
      artifactVersion: { findFirst: vi.fn() },
    };
    const service = new SharesService(db as never, {} as never, objectStorage() as never);

    await expect(service.getPublicArtifactVersion(token, "artifact_1", "version_1"))
      .rejects.toMatchObject({ status: 404 });
    expect(db.artifactVersion.findFirst).not.toHaveBeenCalled();
  });
});

describe("PublicSharesController capability responses", () => {
  function response() {
    const target = {
      setHeader: vi.fn(),
      status: vi.fn(),
    };
    target.status.mockReturnValue(target);
    return target;
  }

  it("returns shared asset ranges with the same byte response headers as private Artifact content", async () => {
    const body = Readable.from("hare");
    const shares = {
      getPublicArtifactAssetContent: vi.fn().mockResolvedValue({
        notModified: false,
        etag: `"${assetChecksum}"`,
        body,
        byteSize: 4,
        mediaType: "image/png",
        range: { start: 1, end: 4 },
        contentRange: "bytes 1-4/8",
      }),
    };
    const controller = new PublicSharesController(shares as never);
    const res = response();

    await controller.getArtifactAssetContent(
      `wbs_${"A".repeat(43)}`,
      "artifact_1",
      "version_1",
      "hero-image",
      "bytes=1-4",
      undefined,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith("ETag", `"${assetChecksum}"`);
    expect(res.setHeader).toHaveBeenCalledWith("Accept-Ranges", "bytes");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Range", "bytes 1-4/8");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(res.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });

  it("returns shared Artifact content ranges with nosniff and capability-safe caching", async () => {
    const body = Readable.from("hare");
    const shares = {
      getPublicArtifactContent: vi.fn().mockResolvedValue({
        notModified: false,
        etag: `"${checksum}"`,
        body,
        byteSize: 4,
        mediaType: "application/json",
        range: { start: 1, end: 4 },
        contentRange: "bytes 1-4/8",
      }),
    };
    const controller = new PublicSharesController(shares as never);
    const res = response();

    await controller.getArtifactContent(
      `wbs_${"A".repeat(43)}`,
      "artifact_1",
      "version_1",
      "bytes=1-4",
      undefined,
      res as never,
    );

    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith("ETag", `"${checksum}"`);
    expect(res.setHeader).toHaveBeenCalledWith("Accept-Ranges", "bytes");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Range", "bytes 1-4/8");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
    expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(res.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
  });

  it("preserves the mandatory Content-Range header on an unsatisfied shared asset range", async () => {
    const shares = {
      getPublicArtifactAssetContent: vi.fn().mockRejectedValue(new UnsatisfiedByteRangeProblem(8)),
    };
    const controller = new PublicSharesController(shares as never);
    const res = response();

    await expect(controller.getArtifactAssetContent(
      `wbs_${"A".repeat(43)}`,
      "artifact_1",
      "version_1",
      "hero-image",
      "bytes=9-10",
      undefined,
      res as never,
    )).rejects.toBeInstanceOf(UnsatisfiedByteRangeProblem);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Range", "bytes */8");
  });

  it("preserves the mandatory Content-Range header on unsatisfied shared Artifact content", async () => {
    const shares = {
      getPublicArtifactContent: vi.fn().mockRejectedValue(new UnsatisfiedByteRangeProblem(8)),
    };
    const controller = new PublicSharesController(shares as never);
    const res = response();

    await expect(controller.getArtifactContent(
      `wbs_${"A".repeat(43)}`,
      "artifact_1",
      "version_1",
      "bytes=9-10",
      undefined,
      res as never,
    )).rejects.toBeInstanceOf(UnsatisfiedByteRangeProblem);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Range", "bytes */8");
  });
});
